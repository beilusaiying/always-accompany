import process from 'node:process'

import { Client } from 'npm:@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from 'npm:@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from 'npm:@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from 'npm:@modelcontextprotocol/sdk/client/streamableHttp.js'
import { WebSocketClientTransport } from 'npm:@modelcontextprotocol/sdk/client/websocket.js'
import { CreateMessageRequestSchema, ListRootsRequestSchema } from 'npm:@modelcontextprotocol/sdk/types.js'

// SEC-F4/G#2（红方 round2，多用户）：远程 transport(url 模式)会让服务端连任意 URL → server 部署下拒内网。
import { assertSafeOutboundInServerMode } from '../security/safe_fetch.mjs' // T3a·3.5: 新位 4 级回溯（安全横切门禁保留）

/**
 * 创建并初始化 MCP 客户端
 * @param {object} config - MCP 配置对象
 * @param {string} [config.url] - SSE 模式下的服务器 URL
 * @param {string} [config.command] - Stdio 模式下的命令
 * @param {string[]} [config.args] - Stdio 模式下的参数
 * @param {object} [config.env] - Stdio 模式下的环境变量
 * @param {Array<string|object>} [config.roots] - 根目录列表
 * @param {Function} [config.samplingHandler] - 采样处理回调函数
 * @returns {Promise<object>} 封装后的客户端接口
 */
// beilu SEC-T3：MCP 子进程环境最小化。
// 默认 *不* 透传整个宿主 process.env（旧行为 {...process.env,...config.env} 会把
// 宿主里的 API 密钥/令牌/NPM_TOKEN 等暴露给第三方 MCP server）。改为只透传 allowlist
// 命中的宿主变量 + 显式 config.env。
// 安全默认 allowlist：进程启动/解析必需的路径类变量（命令查找、临时目录、平台标识）。
// owner 放宽：env BEILU_MCP_ENV_ALLOWLIST(逗号分隔) 或 config.envAllowlist(数组) 追加变量名；
//             也可在 mcpServers 配置里用 env 字段显式补充任意键值。
const MCP_DEFAULT_ENV_ALLOWLIST = [
	'PATH', 'Path', 'PATHEXT',           // 命令查找（Windows 下大小写不敏感，两者都带上）
	'HOME', 'USERPROFILE',               // 家目录
	'TMP', 'TEMP', 'TMPDIR',             // 临时目录
	'SystemRoot', 'windir', 'COMSPEC',   // Windows cmd/系统
	'LANG', 'LC_ALL', 'TZ',              // locale / 时区
	'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', // Windows 程序路径
	'SHELL', 'TERM', 'USER', 'LOGNAME',  // POSIX shell/用户
	'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', // Linux XDG 目录
]

/**
 * 构造 MCP stdio 子进程的环境变量（最小化透传）。
 * @param {object} [explicitEnv] - mcpServers 配置里的 env（显式键值，原样保留，优先级最高）。
 * @param {string[]} [extraAllowNames] - 本 server 额外放行的宿主变量名（config.envAllowlist）。
 * @returns {object} 仅含 allowlist 命中的宿主变量 + explicitEnv。
 */
function buildMCPEnv(explicitEnv, extraAllowNames) {
	const fromEnv = (process.env.BEILU_MCP_ENV_ALLOWLIST || '')
		.split(',').map(s => s.trim()).filter(Boolean)
	const allowlist = new Set([
		...MCP_DEFAULT_ENV_ALLOWLIST,
		...fromEnv,
		...(Array.isArray(extraAllowNames) ? extraAllowNames : []),
		...(Array.isArray(globalThis.beiluMcpEnvAllowlist) ? globalThis.beiluMcpEnvAllowlist : []),
	])
	const env = {}
	for (const key of allowlist)
		if (process.env[key] !== undefined) env[key] = process.env[key]
	return { ...env, ...(explicitEnv || {}) }
}

export async function createMCPClient(config) {
	// SEC-F4/G#2：server 部署下，远程 MCP transport 目标不可指内网（local 模式本地 MCP server 不受影响）。
	if (config.url) await assertSafeOutboundInServerMode(config.url)
	const transport = config.url
		? config.url.startsWith('ws') ? new WebSocketClientTransport(new URL(config.url))
			: new StreamableHTTPClientTransport(new URL(config.url))
		: new StdioClientTransport({
			command: config.command,
			args: config.args || [],
			// SEC-T3：只传 allowlist 命中的宿主 env + 显式 config.env，不再 {...process.env}
			env: buildMCPEnv(config.env, config.envAllowlist)
		})

	const MCP_CONNECT_TIMEOUT_MS = 30000;
	const MCP_REQUEST_TIMEOUT_MS = 60000;
	// T024 超时错误结构化：server 名从 config.serverName 取（Template 建连处传 data.name），
	// 缺省回退 url/command 标识——超时错误必须能回答"是哪个 server 的哪个工具"（T021 弹出档消费 e.message）
	const _srvName = config.serverName || (config.url ? String(config.url) : config.command) || "unknown";
	// SDK RequestTimeout 错误码 -32001（@modelcontextprotocol/sdk McpError）；兼容 message 文案判定
	const _isTimeoutErr = (e) => e?.code === -32001 || /timed?\s?out|超时/i.test(String(e?.message || e));
	const client = new Client(
		{ name: 'beilu-mcp-client', version: '1.0.0' },
		{ capabilities: { sampling: {}, roots: { listChanged: true } }, requestTimeoutMs: MCP_REQUEST_TIMEOUT_MS }
	)

	if (config.roots)
		client.setRequestHandler(ListRootsRequestSchema, () => ({
			roots: config.roots.map(r => Object(r) instanceof String ? { uri: r.startsWith('file:') ? r : `file://${r}`, name: r.split(/\//).pop() || r } : r)
		}))

	if (config.samplingHandler)
		client.setRequestHandler(CreateMessageRequestSchema, async (req) => ({
			role: 'assistant',
			content: { type: 'text', text: await config.samplingHandler(req.params) },
			model: 'default', stopReason: 'endTurn'
		}))

	const _connectWithTimeout = (t) => Promise.race([
		client.connect(t),
		new Promise((_, rej) => setTimeout(() => rej(new Error(`MCP connect 超时 (server=${_srvName}, ${MCP_CONNECT_TIMEOUT_MS}ms)`)), MCP_CONNECT_TIMEOUT_MS)), // T024：含 server 名
	]);
	try {
		await _connectWithTimeout(transport)
	}
	catch (e) {
		if (config.url) {
			const sseTransport = new SSEClientTransport(new URL(config.url))
			await _connectWithTimeout(sseTransport)
		} else {
			throw e
		}
	}

	return {
		/**
		 * 获取底层 SDK 客户端实例
		 * @returns {Client} SDK Client 实例
		 */
		get rawClient() { return client },

		/**
		 * 停止客户端连接
		 * @returns {Promise<void>} Promise
		 */
		stop: () => client.close(),

		/**
		 * 获取工具列表
		 * @returns {Promise<Array>} 工具数组
		 */
		listTools: async () => (await client.listTools()).tools,

		/**
		 * 调用工具
		 * T024：超时错误结构化——SDK requestTimeoutMs 触发的超时（守卫本就存在）抛通用错误无上下文，
		 * 此处只丰富错误内容（server+tool+超时值，原错误挂 cause），不造第二套超时；非超时错误原样透传。
		 * @param {string} name - 工具名称
		 * @param {object} [args] - 工具参数
		 * @returns {Promise<object>} 调用结果
		 */
		callTool: async (name, args) => {
			try {
				return await client.callTool({ name, arguments: args || {} })
			} catch (e) {
				if (_isTimeoutErr(e)) throw new Error(`MCP callTool 超时 (server=${_srvName}, tool=${name}, ${MCP_REQUEST_TIMEOUT_MS}ms)`, { cause: e })
				throw e
			}
		},

		/**
		 * 获取提示词列表
		 * @returns {Promise<Array>} 提示词数组
		 */
		listPrompts: async () => (await client.listPrompts()).prompts,

		/**
		 * 获取特定提示词
		 * @param {string} name - 提示词名称
		 * @param {object} [args] - 提示词参数
		 * @returns {Promise<object>} 提示词内容
		 */
		getPrompt: (name, args) => client.getPrompt({ name, arguments: args || {} }),

		/**
		 * 获取资源列表
		 * @returns {Promise<Array>} 资源数组
		 */
		listResources: async () => (await client.listResources()).resources,

		/**
		 * 读取资源内容
		 * @param {string} uri - 资源 URI
		 * @returns {Promise<object>} 资源内容
		 */
		readResource: (uri) => client.readResource({ uri }),

		/**
		 * 获取服务器信息
		 * @returns {object} 服务器能力和版本信息
		 */
		getServerInfo: () => ({
			capabilities: client.getServerCapabilities(),
			version: client.getServerVersion()
		}),

		/**
		 * 更新根目录列表并通知服务器
		 * @param {Array} newRoots - 新的根目录列表
		 * @returns {Promise<void>} Promise
		 */
		setRoots: async (newRoots) => {
			config.roots = newRoots
			await client.sendRootsListChanged()
		}
	}
}
