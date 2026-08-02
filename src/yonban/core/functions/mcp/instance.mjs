/**
 * instance.mjs — MCP 插件实例实现体（工厂）
 *
 * 【why 本文件存在】原实现整份写在 ImportHandlers/MCP/Template/main.mjs，用户每导入一个 MCP
 *   就把 393 行代码**拷贝**一份到 data/users/<u>/plugins/mcp_x/main.mjs。后果（模板自己的注释
 *   记过一次事故）：修一个 bug 要挨个同步 N 份拷贝，漏一份就是长期潜伏的旧版实例。
 *   现改为 beilu-regex 同款范式——实现体在本体（本文件），部署实例只留薄壳 re-export，
 *   以后任何修复对**所有已导入实例自动生效**。
 *
 * 【功能链】导入 MCP → 拷贝薄壳 main.mjs + data.json 到用户插件目录 → parts_loader Load
 *   → createMcpPart(pluginDir) 读同目录 data.json → initializeMCP 连 server（命令型需 owner 批准）
 *   → GetPrompt 每轮注入「提示词(用户可改) + 工具清单(代码拼的数据)」
 *   → AI 输出 <mcp-tool>/<mcp-prompt>/<mcp-resource> → ReplyHandler 解析执行 → 结果入 ideClient 池
 *
 * 【注入分层·凛倾 0727 定案】「一个是数据,一个是提示词」：
 *   · 数据 = 工具/Prompts/Resources 清单，由代码从 server 实时拼（buildToolsData），用户不需要维护；
 *   · 提示词 = 怎么调用的引导文案，**用户自己填**（data.promptText，面板可编辑）；
 *     代码只持默认值 DEFAULT_PROMPT（铁律：进对话的文本必须用户可配，代码只持缺省）。
 *   · 二者用 {{mcp_tools}} 宏拼接——用户在提示词里写这个宏决定数据插在哪；没写就数据追加在后面。
 *
 * 【相交】← ImportHandlers/MCP/Template/main.mjs（薄壳，导入时被拷贝）
 *   → engine/mcp_client.mjs（连接/调用）→ ideClient.pendingResults（结果回灌）
 *   → injectTexts（半失败反馈文案单源）→ stream.mjs defineToolUseBlocks（流式预览块）
 */
import fs from 'node:fs'
import path from 'node:path'

import { createMCPClient } from '../../../../public/parts/ImportHandlers/MCP/engine/mcp_client.mjs'
import { defineToolUseBlocks } from '../../../../public/parts/shells/beilu-chat/src/stream.mjs'
import { saveJsonFile } from '../../../../scripts/json_loader.mjs'
import { loadPart } from '../../../../server/parts_loader.mjs'
import { authenticate } from '../security/auth.mjs'
import { reduceMcpRuntimeHealth, registerMcpRuntime } from './runtimeRegistry.mjs'

/** @typedef {import('../../../../decl/pluginAPI.ts').pluginAPI_t} pluginAPI_t */

/**
 * 默认调用协议提示词（**仅缺省值**——用户在 MCP 面板「提示词」页可整段改写/清空）。
 * {{mcp_tools}} = 工具清单数据的插入位（不写则数据追加到末尾）。
 *
 * 【与全局退役宏同名但不是一回事·勿混】getPromptHandler.mjs:719 有个全局
 *   `.replace(/\{\{mcp_tools\}\}/g, "")` —— 那个宏 0716 被退役替空，理由是"扫静态快照 =
 *   stale 双通道，MCP 清单的真路径是各插件每轮 listTools 的活数据"。
 *   本处的 {{mcp_tools}} 正是**那条被判定为正确的活数据路径**：它只是本插件 promptText 内部的
 *   占位符，在本文件 getDesc() 里用当轮 listTools 结果就地替换，替换完才进 plugin_prompts。
 *   顺序上也安全：全局那行清理跑在后面，此时字面量已不存在；未连接时 getDesc 整段返回空串，
 *   同样不会有字面量漏到全局层。命名保持一致是为了用户直觉（他看到的就是"工具清单"）。
 */
export const DEFAULT_PROMPT = `{{mcp_tools}}

Usage: To call a tool, use this XML format:
<mcp-tool name="...">
	<param>val</param>
</mcp-tool>

Example:
<mcp-tool name="echo">
	<message>Hello World</message>
</mcp-tool>`

/**
 * 建一个 MCP 插件实例（一份 data.json = 一个实例）。
 * @param {string} pluginDir - 实例目录（薄壳传 import.meta.dirname），data.json 与薄壳同目录
 * @returns {pluginAPI_t} 插件导出对象
 */
export function createMcpPart(pluginDir) {
	const dataPath = path.join(pluginDir, 'data.json')
	// [0722 排雷] 裸 JSON.parse 时 data.json 缺失/损坏抛无路径 SyntaxError（load_failed 不可诊断）。
	//   仍然失败（无配置的 MCP 实例无法工作，诚实 fail），但错误带路径+原因。
	let data
	try {
		data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'))
	} catch (e) {
		throw new Error(`[MCP] data.json 读取/解析失败（MCP 插件实例无法加载）: ${dataPath}: ${e?.message || e}`)
	}

	let mcpClient = null
	let tools = null
	let samplingAIsource = null
	let username = null
	let mcpConnected = false
	/** 最近一次连接失败原因（GetData 暴露给面板做诊断；null=无错） */
	let mcpError = null
	let runtimeToolCount = 0
	let clientGeneration = 0

	const runtimeTransport = () => data?.config?.command
		? 'stdio'
		: data?.config?.url
			? String(data.config.url).toLowerCase().startsWith('ws') ? 'websocket' : 'http'
			: null
	const runtimeBase = () => {
		const configured = !!(data?.config?.command || data?.config?.url)
		return {
			key: `${username || ''}:${path.basename(pluginDir)}`,
			username,
			name: data?.name || path.basename(pluginDir),
			transport: runtimeTransport(),
			configured,
			approved: configured && (!data?.config?.command || data?._mcpApproved === true),
		}
	}
	/** @type {ReturnType<typeof registerMcpRuntime>|null} */
	let runtimeRegistration = null
	const ensureRuntimeRegistration = () => {
		if (!runtimeRegistration)
			runtimeRegistration = registerMcpRuntime({
				username,
				pluginIdentity: path.resolve(pluginDir),
			}, {
				...runtimeBase(),
				connected: mcpConnected,
				error: mcpError,
				toolCount: runtimeToolCount,
			})
		return runtimeRegistration
	}
	const applyRuntimeEvent = (event) => {
		const next = reduceMcpRuntimeHealth({
			connected: mcpConnected,
			error: mcpError,
			toolCount: runtimeToolCount,
		}, event)
		mcpConnected = next.connected
		mcpError = next.error
		runtimeToolCount = next.toolCount
		ensureRuntimeRegistration().update({ ...runtimeBase(), ...next })
		return next
	}
	const isActiveGeneration = (generation) => generation === clientGeneration
	const classifyRequestFailure = (error, client) => {
		const code = error?.code ?? error?.cause?.code
		if (code === -32000 || !client?.rawClient?.transport || /connection\s+closed|transport\s+closed|not\s+connected/i.test(String(error?.message || error)))
			return 'transport'
		if (code === -32001 || /timed?\s*out|超时/i.test(String(error?.message || error)))
			return 'timeout'
		return 'application'
	}
	const applyCatalog = (catalog, generation = clientGeneration) => {
		if (!isActiveGeneration(generation)) return false
		tools = Array.isArray(catalog) ? catalog : []
		applyRuntimeEvent({ type: 'catalog_succeeded', toolCount: tools.length })
		return true
	}
	const applyCatalogFailure = (error, generation = clientGeneration) => {
		if (!isActiveGeneration(generation)) return false
		tools = []
		applyRuntimeEvent({ type: 'catalog_failed', error })
		return true
	}
	const refreshToolCatalog = async (client = mcpClient, generation = clientGeneration) => {
		if (!client) throw new Error('MCP client is not connected')
		try {
			const catalog = await client.listTools()
			applyCatalog(catalog, generation)
			return catalog
		} catch (error) {
			applyCatalogFailure(error, generation)
			throw error
		}
	}
	const executeHealthyRequest = async (client, operation, generation = clientGeneration) => {
		try {
			const result = await operation()
			if (isActiveGeneration(generation)) applyRuntimeEvent({ type: 'request_succeeded' })
			return result
		} catch (error) {
			if (isActiveGeneration(generation))
				applyRuntimeEvent({
					type: 'request_failed',
					error,
					failureKind: classifyRequestFailure(error, client),
				})
			throw error
		}
	}
	const detachCurrentClient = async () => {
		const client = mcpClient
		clientGeneration += 1
		mcpClient = null
		try { await client?.stop() } catch {}
		tools = []
		applyRuntimeEvent({ type: 'reset' })
	}

	/**
	 * Sampling 处理器
	 * @param {object} params - Sampling 参数对象
	 * @param {Array} params.messages - 消息历史
	 * @param {string} [params.systemPrompt] - 系统提示词
	 * @returns {Promise<string>} AI 生成的文本
	 */
	const handleSampling = async ({ messages, systemPrompt }) => {
		if (!samplingAIsource) throw new Error('Sampling source not configured')
		const chat_log = [
			...systemPrompt ? [{ role: 'system', content: systemPrompt }] : [],
			...messages.map(m => ({
				role: m.role === 'user' ? 'user' : m.role === 'assistant' ? 'char' : 'system',
				content: m.content?.text || m.content || ''
			}))
		]
		try {
			const res = await samplingAIsource.StructCall({
				chat_log, user_prompt: { text: [] }, char_prompt: { text: [] },
				world_prompt: { text: [] }, other_chars_prompt: {}, plugin_prompts: {}
			})
			return res.content
		} catch (err) {
			console.error('[MCP Sampling] Failed:', err)
			throw err
		}
	}

	/**
	 * 初始化 MCP 客户端
	 * @returns {Promise<void>} 无返回值
	 */
	async function initializeMCP() {
		// SEC-MCP（RCE-2 根治）：命令型(stdio) MCP server 会 spawn 宿主进程执行任意命令——
		//   导入恶意 MCP 配置即 RCE。默认【不 spawn】，需 owner 显式批准(data._mcpApproved===true)。
		//   本闸是导入时(reloadPart/import)与重启时(parts_loader Load)两条 spawn 路径的共同汇聚点。
		if (data?.config?.command && data?._mcpApproved !== true) {
			console.warn(`[SEC-MCP] 命令型 MCP server "${data?.name}" 未批准，跳过 spawn（command: ${data?.config?.command}）。owner 在安全中心批准(置 data._mcpApproved)后方可启动。`)
			tools = []
			applyRuntimeEvent({ type: 'reset' })
			return
		}

		if (data.samplingAIsource && username && !samplingAIsource)
			try {
				samplingAIsource = await loadPart(username, 'serviceSources/AI/' + data.samplingAIsource)
			} catch (e) { console.warn('[MCP] Sampling load failed:', e) }

		const generation = ++clientGeneration
		const client = await createMCPClient({
			...data.config,
			sandbox: data.sandbox || null,
			serverName: data.name, // T024：超时错误结构化需 server 名
			roots: data.roots || [],
			samplingHandler: samplingAIsource ? handleSampling : null,
			toolsChangedHandler: (error, catalog) => {
				if (error) applyCatalogFailure(error, generation)
				else applyCatalog(catalog, generation)
			},
			lifecycleHandler: ({ error }) => {
				if (!isActiveGeneration(generation)) return
				tools = []
				applyRuntimeEvent({ type: 'transport_failed', error })
			},
		})
		if (!isActiveGeneration(generation)) {
			try { await client.stop() } catch {}
			return
		}
		mcpClient = client
		await refreshToolCatalog(client, generation)
	}

	/**
	 * 简易类型转换
	 * @param {string} val - 原始字符串值
	 * @param {string} [type] - 目标类型
	 * @returns {any} 转换后的值
	 */
	const parseVal = (val, type) => {
		val = val.trim()
		if (!type) return val
		if (type === 'boolean') return val === 'true'
		if (['integer', 'number'].includes(type)) { const num = Number(val); return !Number.isNaN(num) ? num : val }
		if (['array', 'object'].includes(type)) try { return JSON.parse(val) } catch { return val }
		return val
	}

	/**
	 * 格式化结果内容
	 * @param {object} res - MCP 响应结果
	 * @returns {string} 格式化后的字符串
	 */
	const fmtRes = (res) => res?.content?.map(i =>
		i.type === 'text' ? i.text : `[${i.type}: ${i.mimeType || i.uri || ''}]`
	).join('\n') || JSON.stringify(res, null, 2)

	/**
	 * 解析 XML 调用
	 * @param {string} content - 回复内容
	 * @returns {Promise<Array<object>>} 解析出的调用列表
	 */
	async function parseCalls(content) {
		const calls = []
		/**
		 * 解析参数
		 * @param {string} body - XML 标签体
		 * @param {object} [schemaProps] - 参数 Schema
		 * @returns {object} 参数对象
		 */
		const parseParams = (body, schemaProps = {}) => {
			const args = {}
			const matches = [...body.matchAll(/<([\w-]+)(?:\s+[^>]*)?>([\S\s]*?)<\/\1>/g)]
			for (const [, key, val] of matches) args[key] = parseVal(val, schemaProps[key]?.type)
			return args
		}

		// 解析 Tool 和 Prompt
		for (const type of ['tool', 'prompt']) {
			const matches = [...content.matchAll(new RegExp(`<mcp-${type}\\s+name="([^"]+)">([\\s\\S]*?)<\\/mcp-${type}>`, 'g'))]
			for (const [fullMatch, name, body] of matches) {
				const toolDef = tools?.find(t => t.name === name)
				const schemaProps = toolDef?.inputSchema?.properties || {}
				calls.push({ type, name, args: parseParams(body, schemaProps), fullMatch })
			}
		}
		// 解析 Resource
		for (const [fullMatch, uri] of content.matchAll(/<mcp-resource\s+uri="([^"]+)"\s*\/>/g))
			calls.push({ type: 'resource', uri, fullMatch })
		return calls
	}

	/**
	 * 构建**数据**部分：server 上有哪些工具/Prompts/Resources（凛倾 0727「一个是数据」）。
	 * 纯清单，不含任何引导文案——引导归 data.promptText（用户域）。
	 * @returns {Promise<string>} 清单文本（未连接/无内容时空串）
	 */
	async function buildToolsData() {
		if (!mcpClient) return ''
		let tl
		try {
			tl = await refreshToolCatalog()
		} catch (e) {
			return ''
		}
		const [pl, rl] = await Promise.all([
			mcpClient.listPrompts().catch(() => []),
			mcpClient.listResources().catch(() => [])
		])
		// SEC-T8: name/description 由远程 MCP server 提供(不可信)，逐字段中性化尖括号，
		//   防其重建 <mcp-tool>/<ideToolCall> 协议标签冒充本体指令。
		const _nz = (s) => String(s ?? '').replace(/</g, '＜').replace(/>/g, '＞')
		const fmtItem = (items, label) => {
			if (!items?.length) return ''
			const list = items.map(i => {
				const args = (i.inputSchema?.properties ? Object.entries(i.inputSchema.properties) : i.arguments || [])
					.map(([k, v]) => `  - ${_nz(k)}: ${_nz(v.description || '')}`).join('\n') || '  No params'
				return `### ${_nz(i.name)}\n${_nz(i.description || '')}\n**Params:**\n${args}`
			}).join('\n\n')
			return `## Available ${label}\n${list}`
		}
		return [
			`# MCP Server: ${_nz(data.name)}`,
			_nz(data.description || ''),
			fmtItem(tl, 'Tools'),
			fmtItem(pl, 'Prompts'),
			rl.length ? `## Resources\n${rl.map(r => `- ${_nz(r.name)}: \`${_nz(r.uri)}\``).join('\n')}` : ''
		].filter(Boolean).join('\n\n')
	}

	/**
	 * 生成最终注入文本 = 用户提示词 ⊕ 工具清单数据。
	 * 【规则】提示词里写了 {{mcp_tools}} → 数据替换到该位置（用户控制位置）；
	 *   没写 → 数据追加在提示词后（保证 AI 总能看到有哪些工具）；
	 *   提示词为空串（用户显式清空）→ 只给数据，不替用户补任何引导文案。
	 * @returns {Promise<string>} 注入文本
	 */
	const getDesc = async () => {
		if (!mcpClient) return ''
		const toolsData = await buildToolsData()
		// undefined/null = 用户从没设置过 → 用缺省；"" = 用户显式清空 → 尊重，不补文案
		const prompt = (data.promptText === undefined || data.promptText === null) ? DEFAULT_PROMPT : String(data.promptText)
		if (!prompt.trim()) return toolsData
		if (prompt.includes('{{mcp_tools}}')) return prompt.replaceAll('{{mcp_tools}}', toolsData)
		return `${prompt}\n\n${toolsData}`.trim()
	}

	/** @type {pluginAPI_t} */
	const pluginExport = {
		info: {
			'': {
				name: data?.name || 'mcp_plugin',
				avatar: data?.avatar || 'https://modelcontextprotocol.io/favicon.svg',
				description: data?.description || 'MCP Client',
				version: data?.version || '0.0.0',
				tags: ['mcp', ...data?.tags || []]
			}
		},
		/**
		 * 加载插件
		 * @param {object} stat - 状态对象
		 * @returns {Promise<void>} Promise
		 */
		Load: async (stat) => {
			runtimeRegistration?.remove()
			runtimeRegistration = null
			username = stat?.username
			applyRuntimeEvent({ type: 'reset' })
			// 断链批（20260704）：connect 失败不炸整个 part 装载——错误存 mcpError 由 GetData 带给面板显示
			//   （错误是诊断面，不该变成路由消失）。
			try { await initializeMCP() }
			catch (e) {
				await detachCurrentClient()
				applyCatalogFailure(e)
				console.warn(`[MCP] "${data?.name}" 连接失败（面板保持可用，可在面板重试）:`, mcpError)
			}
			const router = stat?.router
			if (router) {
				router.get(/\/config\/getdata$/, authenticate, (req, res) => {
					try { res.json(pluginExport.interfaces.config.GetData()) }
					catch (e) { res.status(500).json({ error: e.message }) }
				})
				router.post(/\/config\/setdata$/, authenticate, async (req, res) => {
					try {
						const result = await pluginExport.interfaces.config.SetData(req.body || {})
						res.json(result || { success: true })
					} catch (e) { res.status(500).json({ error: e.message }) }
				})
			}
		},
		/**
		 * 卸载插件
		 * @returns {Promise<void>} Promise
		 */
		Unload: async () => {
			try { await detachCurrentClient() }
			finally {
				runtimeRegistration?.remove()
				runtimeRegistration = null
			}
		},
		interfaces: {
			config: {
				/**
				 * 获取配置（附只读诊断字段 + 注入面预览字段，面板只读不回写）
				 * @returns {object} 配置对象 + _mcpConnected/_mcpError/_promptDefault
				 */
				GetData: () => ({
					...data,
					_mcpConnected: mcpConnected,
					_mcpError: mcpError,
					// 面板「提示词」页的占位/恢复默认用（缺省值单源在本文件，面板不复制一份）
					_promptDefault: DEFAULT_PROMPT,
				}),
				/**
				 * 设置配置
				 * @param {object} newData - 新配置 / 带 _action 的动作请求
				 * @returns {Promise<object|void>} 动作结果或 void
				 */
				SetData: async (newData) => {
					if (newData._action === 'listTools') {
						if (!mcpClient) return { _result: { success: false, error: 'MCP Server 未连接' } }
						const client = mcpClient
						const generation = clientGeneration
						try {
							const tl = await refreshToolCatalog(client, generation)
							const [pl, rl] = await Promise.all([
								client.listPrompts().catch(() => []),
								client.listResources().catch(() => []),
							])
							return { _result: { success: true, tools: tl, prompts: pl, resources: rl } }
						} catch (e) {
							return { _result: { success: false, error: e?.message || String(e) } }
						}
					}
					// [0727 凛倾「实际内容和提示词点击展开」] 面板「数据」页取实时清单、
					//   「提示词」页预览最终注入文本——同一函数出，杜绝面板自己拼第二份。
					if (newData._action === 'previewInject') {
						if (!mcpClient) return { _result: { success: false, error: 'MCP Server 未连接' } }
						try {
							return { _result: { success: true, data: await buildToolsData(), final: await getDesc(), promptDefault: DEFAULT_PROMPT } }
						} catch (e) {
							return { _result: { success: false, error: e.message } }
						}
					}
					if (newData._action === 'testTool') {
						if (!mcpClient) return { _result: { success: false, error: 'MCP Server 未连接' } }
						const client = mcpClient
						const generation = clientGeneration
						try {
							const result = await executeHealthyRequest(
								client,
								() => client.callTool(newData.toolName, newData.args || {}),
								generation,
							)
							return { _result: { success: true, result: fmtRes(result) } }
						} catch (e) {
							return { _result: { success: false, error: e?.message || String(e) } }
						}
					}
					// [0727] 提示词单独存：整包覆盖写会把面板没带的字段抹掉（同下方 _mcpApproved 教训），
					//   故给它独立动作。空串=用户显式清空（尊重，不补默认）。
					if (newData._action === 'setPrompt') {
						data.promptText = typeof newData.promptText === 'string' ? newData.promptText : ''
						saveJsonFile(dataPath, data)
						return { _result: { success: true } }
					}
					if (newData._action) return { _result: { success: false, error: '未知action: ' + newData._action } }
					if (!Object.keys(newData).length) return
					// [凛倾 0722 散写审计收口] 整包覆盖写的两处语义漏洞：
					// ① _mcpApproved(SEC-MCP RCE 闸)归 /api/security/mcp-approve 写口，本入口不得代写也不得抹掉：
					//    command 未变时保留既有批准；command 变了=要 spawn 的命令换了，批准作废须重批。
					// ② GetData 回显的 _mcpConnected/_mcpError/_promptDefault 是瞬时/派生态，回传会污染持久层，剥离后再落盘。
					// ③ [0727] promptText（用户填的注入提示词）同属"本入口不该代写"的字段：面板保存连接配置时
					//    根本不带它，整包覆盖 = 用户辛苦填的提示词被静默抹掉（与 ① 同型病，凛倾 0727
					//    「写入,储存,刷新,同步,给我注意好」）。调用方显式带了才认（提示词页保存走独立
					//    _action:setPrompt，正常不会走到这里）。
					const { _mcpConnected: _tc, _mcpError: _te, _mcpApproved: _ta, _promptDefault: _tp, ...cleanData } = newData
					const _cmdUnchanged = data?.config?.command === cleanData?.config?.command
					const _keptPrompt = Object.prototype.hasOwnProperty.call(cleanData, 'promptText') ? undefined : data?.promptText
					data = (_cmdUnchanged && data?._mcpApproved === true) ? { ...cleanData, _mcpApproved: true } : cleanData
					if (_keptPrompt !== undefined) data.promptText = _keptPrompt
					saveJsonFile(dataPath, data)
					await detachCurrentClient()
					// 同 Load 解耦：配置已写盘=保存成功是事实；重连失败作诊断字段返回，不让 500 谎报失败。
					try { await initializeMCP() }
					catch (e) {
						await detachCurrentClient()
						applyCatalogFailure(e)
						return { success: true, _mcpError: mcpError }
					}
				}
			},
			chat: {
				/**
				 * 获取 Prompt（注入 = 用户提示词 ⊕ 工具清单数据）
				 * @param {object} args - 上下文参数
				 * @returns {Promise<object>} Prompt 结构
				 * ⚠ [铁律] GetPrompt 禁止硬编码提示词文本。引导文案走 injectTexts/fillInjectText，操作说明走 INJ 条目。DEFAULT_PROMPT 是用户可覆盖的缺省值（面板可改写/清空），合规。
				 */
				GetPrompt: async (args) => ({
					text: [{ content: await getDesc(args), important: 0 }],
					additional_chat_log: [], extension: {}
				}),
				GetReplyPreviewUpdater: defineToolUseBlocks([
					{ start: /<mcp-tool[^>]*>/, end: '</mcp-tool>' },
					{ start: /<mcp-prompt[^>]*>/, end: '</mcp-prompt>' },
					{ start: /<mcp-resource[^>]*/, end: '\\>' }
				]),
				/**
				 * 处理回复
				 * @param {object} reply - 回复对象
				 * @param {object} args - 处理参数
				 * @returns {Promise<boolean>} 是否产生变更
				 */
				ReplyHandler: async (reply, args) => {
					if (!reply.content || !reply.content.includes('<mcp-')) return false
					const calls = await parseCalls(reply.content)
					if (!calls.length) {
						// [0717 半失败反馈] 有 <mcp- 字样但解析出 0 个调用（标签不闭合/截断）——
						//   原静默 return false 零反馈。入池失败结果让 AI 下轮自纠；文案走 injectTexts（用户可配）。
						try {
							const { ideClient: _ic } = await import('../../transport/ideClient.mjs')
							const { getInjectText: _git } = await import('../injectTexts/main.mjs')
							let _cid0 = null
							const _cn0 = args?.chat_name || ''
							if (_cn0.startsWith('common_chat_')) _cid0 = _cn0.slice('common_chat_'.length)
							_ic.enqueuePendingResult({ chatid: _cid0, ownerUsername: username, tool: 'mcp:parse', params: {}, timestamp: new Date().toISOString(), result: { success: false, error: _git('mcp.call_incomplete') } })
						} catch (_fbErr) { console.warn('[MCP] 半失败反馈入池失败:', _fbErr?.message) }
						return false
					}

					// [0717 范式迁移] 结果入 ideClient.pendingResults 池 → generation 回合末统一落盘 system 条
					//   (_opType=ide_tool_result，继承压缩保护/续轮/熔断/worker 回灌)。
					//   调用原文(<mcp-*>)留在 reply.content 落盘；SEC-T8 不可信包裹(fmtRes)原样保留在结果文本内。
					const { ideClient } = await import('../../transport/ideClient.mjs')
					let _chatid = null
					try {
						const _cn = args?.chat_name || ''
						if (_cn.startsWith('common_chat_')) _chatid = _cn.slice('common_chat_'.length)
						if (!_chatid) {
							const { getAmbientChatId } = await import('../../../../server/whitebox.mjs')
							_chatid = getAmbientChatId?.() || null
						}
					} catch { /* chatid 解析失败 → null 广播项 */ }

					for (const call of calls) {
						let _entry
						try {
							let result
							const client = mcpClient
							const generation = clientGeneration
							if (call.type === 'tool')
								result = await executeHealthyRequest(client, () => client.callTool(call.name, call.args), generation)
							else if (call.type === 'prompt')
								result = await executeHealthyRequest(client, () => client.getPrompt(call.name, call.args), generation)
							else
								result = await executeHealthyRequest(client, () => client.readResource(call.uri), generation)
							_entry = { chatid: _chatid, tool: `mcp:${call.name || call.uri}`, params: call.args || {}, timestamp: new Date().toISOString(), result: { success: true, result: `${call.type} result for ${call.name || call.uri}:\n${fmtRes(result)}` } }
						} catch (err) {
							console.error('MCP call error:', err)
							_entry = { chatid: _chatid, tool: `mcp:${call.name || call.uri}`, params: call.args || {}, timestamp: new Date().toISOString(), result: { success: false, error: `Error calling ${call.type} "${call.name || call.uri}": ${err.message}` } }
						}
						ideClient.enqueuePendingResult({ ..._entry, ownerUsername: username })
					}

					return false
				}
			}
		}
	}

	return pluginExport
}
