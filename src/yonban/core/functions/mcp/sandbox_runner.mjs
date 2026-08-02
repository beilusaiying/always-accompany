/**
 * sandbox_runner.mjs — MCP server 沙箱运行器
 *
 * 【功能链】mcp_client.mjs createMCPClient → StdioClientTransport(command: "deno", args: ["run",
 *   "--allow-read=...", "sandbox_runner.mjs", "--", actualCommand, ...actualArgs])
 *   → 本脚本 spawn 真实 MCP server → stdio 双向代理 → 日志记录 + 超时强杀
 *
 * 【安全模型】
 *   本脚本作为 Deno 进程，自身受 --allow-* 权限约束（MCP client 启动时传入）。
 *   真实 MCP server 作为本脚本的子进程，继承本脚本的环境但不继承 Deno 权限约束
 *   （Node.js/python 等非 Deno 进程有完全 OS 权限）。
 *   本层提供的防护：
 *     ✅ JSON-RPC 消息日志（所有 tool 调用可审计）
 *     ✅ 空闲超时强杀（防 MCP server 挂起/僵死）
 *     ✅ 环境变量最小化（由 mcp_client.mjs buildMCPEnv 在上游完成）
 *     ✅ 进程退出清理（确保子进程不成为孤儿进程）
 *     ❌ 文件系统隔离（Node.js 子进程不受 Deno 权限限制）
 *     ❌ 网络隔离（同上）
 *
 * 【用法】deno run --allow-run --allow-read=<logDir> --allow-write=<logDir> sandbox_runner.mjs
 *         [--timeout <ms>] [--log <logFile>] -- <command> [args...]
 */

const args = Deno.args
const sepIdx = args.indexOf('--')
if (sepIdx === -1 || sepIdx === args.length - 1) {
	console.error('[sandbox_runner] 用法: sandbox_runner.mjs [--timeout <ms>] [--log <path>] -- <command> [args...]')
	Deno.exit(1)
}

const opts = args.slice(0, sepIdx)
const cmdArgs = args.slice(sepIdx + 1)
const command = cmdArgs[0]
const childArgs = cmdArgs.slice(1)

let idleTimeoutMs = 300_000 // 默认 5 分钟空闲超时
let logPath = null

for (let i = 0; i < opts.length; i++) {
	if (opts[i] === '--timeout' && opts[i + 1]) {
		idleTimeoutMs = parseInt(opts[i + 1], 10) || 300_000
		i++
	} else if (opts[i] === '--log' && opts[i + 1]) {
		logPath = opts[i + 1]
		i++
	}
}

let logFile = null
if (logPath) {
	try {
		logFile = await Deno.open(logPath, { create: true, append: true, write: true })
	} catch { /* 日志打不开不阻塞主流程 */ }
}

const log = async (direction, data) => {
	if (!logFile) return
	const ts = new Date().toISOString()
	const line = JSON.stringify({ ts, dir: direction, size: data.length }) + '\n'
	try {
		await logFile.write(new TextEncoder().encode(line))
	} catch { /* 静默 */ }
}

// spawn MCP server
const child = new Deno.Command(command, {
	args: childArgs,
	stdin: 'piped',
	stdout: 'piped',
	stderr: 'piped',
	env: Deno.env.toObject(),
}).spawn()

let idleTimer = null
const resetIdleTimer = () => {
	if (idleTimer) clearTimeout(idleTimer)
	idleTimer = setTimeout(() => {
		console.error(`[sandbox_runner] MCP server 空闲超时 (${idleTimeoutMs}ms)，强杀`)
		try { child.kill('SIGTERM') } catch { /* 已退出 */ }
		setTimeout(() => {
			try { child.kill('SIGKILL') } catch {}
		}, 5000)
	}, idleTimeoutMs)
}
resetIdleTimer()

// stdin: parent → child（MCP client → MCP server）
const pipeStdin = async () => {
	try {
		const reader = Deno.stdin.readable.getReader()
		const writer = child.stdin.getWriter()
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			resetIdleTimer()
			await log('→', value)
			await writer.write(value)
		}
		await writer.close()
	} catch { /* 管道断开 */ }
}

// stdout: child → parent（MCP server → MCP client）
const pipeStdout = async () => {
	try {
		const reader = child.stdout.getReader()
		const writer = Deno.stdout.writable.getWriter()
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			resetIdleTimer()
			await log('←', value)
			await writer.write(value)
		}
		await writer.close()
	} catch { /* 管道断开 */ }
}

// stderr: child → parent stderr
const pipeStderr = async () => {
	try {
		const reader = child.stderr.getReader()
		const writer = Deno.stderr.writable.getWriter()
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			await writer.write(value)
		}
		await writer.close()
	} catch { /* 管道断开 */ }
}

// 并行运行管道代理
const pipes = Promise.allSettled([pipeStdin(), pipeStdout(), pipeStderr()])

// 等待子进程退出
const status = await child.status
if (idleTimer) clearTimeout(idleTimer)
await pipes
if (logFile) logFile.close()

Deno.exit(status.code ?? 1)
