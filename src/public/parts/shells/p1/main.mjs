import info from './info.json' with { type: 'json' }
import { authenticate } from '../../../../yonban/core/functions/security/auth.mjs'

/**
 * [P1 召回服务 shell] — 薄 HTTP 传导层（002 2026-07-31 拍板：P1 从进程内 Deno 插件改为
 *   独立可插拔可独立运行的 Python 服务，本体不再承担 P1 的启动时间/内存占用）。
 *
 * 功能链：
 *   前端/p1Bridge → POST /api/parts/shells:p1/service/<action> → 本文件代理转发
 *     → Python 服务 http://127.0.0.1:<port>/<action>（service/p1_server.py，独立进程）
 *     → 返回原样透传。服务未运行 → 503 + 明确错误（诚实降级：调用方按 null/失败走 AI P1 降级链）。
 *
 * why 薄壳只做代理不做逻辑：插拔语义——拔掉 service 目录/停掉 Python 进程，本体所有链路不炸；
 *   P1 全部功能（管线/词库/配置）住 Python 侧，可脱离本体单独启动测试（拉线测试）。
 * 自动启动（0731 002："所以我连启动都要手动启动?"——插上就工作）：Load 时探测服务，不在则
 *   spawn python 拉起（已在跑=直接用不重复起；spawn 被安全软件拦=响亮日志+503 提示手动启动，诚实降级）。
 *   本体退出不杀 python（独立运行语义：下次启动探测到直接复用）。P1_AUTOSTART=off 可关。
 * 影响范围：新增 shell，不改任何既有文件；P1_SERVICE_PORT 环境变量可覆盖端口（默认 13150），
 *   PROXY_TIMEOUT_MS/健康检查超时同款 env 通道可覆盖（薄壳无自己的 config 文件，env 是其既有通道）。
 */

const P1_PORT = Number(globalThis.Deno?.env?.get?.('P1_SERVICE_PORT')) || 13150
const P1_BASE = `http://127.0.0.1:${P1_PORT}`
const PROXY_TIMEOUT_MS = Number(globalThis.Deno?.env?.get?.('P1_PROXY_TIMEOUT_MS')) || 30000
const HEALTH_TIMEOUT_MS = Number(globalThis.Deno?.env?.get?.('P1_HEALTH_TIMEOUT_MS')) || 3000
const AUTOSTART = (globalThis.Deno?.env?.get?.('P1_AUTOSTART') || 'on') !== 'off'

// service/ 与本文件同目录（file URL → Windows 路径：剥前导 / 保留盘符）
const SERVICE_DIR = decodeURIComponent(new URL('./service/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

let _lastSpawnAt = 0
const SPAWN_COOLDOWN_MS = 60000 // 服务中途死掉可再拉（自愈），冷却防 spawn 风暴
/** 服务不在则拉起（节流幂等：60s 内只尝试一次 spawn，防 Load 重入/探测抖动反复起进程） */
async function ensureServiceRunning() {
	try {
		const r = await fetch(`${P1_BASE}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
		if (r.ok) return 'already-running'
	} catch { /* 不在 → 下面拉起 */ }
	if (!AUTOSTART) return 'autostart-off'
	if (Date.now() - _lastSpawnAt < SPAWN_COOLDOWN_MS) return 'spawn-cooldown'
	_lastSpawnAt = Date.now()
	try {
		const cmd = new Deno.Command('python', {
			args: ['p1_server.py'],
			cwd: SERVICE_DIR,
			stdout: 'null', stderr: 'null', stdin: 'null',
		})
		const child = cmd.spawn()
		child.unref() // 本体退出不杀服务（独立运行语义）
		// 就绪等待：管线延迟加载，服务本身秒级起；最多探 10 次×1s
		for (let i = 0; i < 10; i++) {
			await new Promise((ok) => setTimeout(ok, 1000))
			try {
				const r = await fetch(`${P1_BASE}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
				if (r.ok) { console.log(`[shells:p1] P1 服务已自动启动 (${P1_BASE}, pid=${child.pid})`); return 'spawned' }
			} catch { /* 继续等 */ }
		}
		console.warn(`[shells:p1] P1 服务 spawn 后 10s 未就绪 (${P1_BASE})——查看 python 环境或手动启动: python ${SERVICE_DIR}p1_server.py`)
		return 'spawned-not-ready'
	} catch (e) {
		// 安全软件拦 spawn(EPERM)/python 不在 PATH 走这里：响亮一次，降级手动
		console.warn(`[shells:p1] 自动启动 P1 服务失败（${e?.message || e}）——手动启动: cd ${SERVICE_DIR} && python p1_server.py`)
		return 'spawn-failed'
	}
}

async function relay(req, res, action) {
	try {
		const upstream = await fetch(`${P1_BASE}/${action}`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				// python 侧只绑 127.0.0.1，username 由本体鉴权后注入（防伪造：覆盖而非透传 body 内值）
				'X-P1-Username': req.user?.username || '',
			},
			body: JSON.stringify(req.body ?? {}),
			signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
		})
		const text = await upstream.text()
		res.status(upstream.status).type('application/json').send(text)
	} catch (e) {
		// 连接失败/超时 = 服务未运行或未就绪：触发自愈重拉（节流），本次请求仍诚实报错（调用方走降级）
		ensureServiceRunning().catch(() => { /* 函数内自处理 */ })
		res.status(503).json({ success: false, error: `P1 服务未就绪 (${P1_BASE}): ${e?.message || e}。已尝试自动拉起，稍后重试；持续失败见宿主日志 [shells:p1]` })
	}
}

export default {
	info,
	Load: ({ router }) => {
		const base = '/api/parts/shells\\:p1'
		// 插上就工作：本体启动即拉起服务（fire-and-forget 不阻塞路由挂载；失败诚实降级见函数内日志）
		ensureServiceRunning().catch(() => { /* 函数内已自处理与日志，不会 reject 到这 */ })
		// 健康检查：探测 python 服务是否在（无鉴权——不含数据，只报可达性）
		router.get(base + '/health', async (_req, res) => {
			try {
				const r = await fetch(`${P1_BASE}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
				res.status(r.status).type('application/json').send(await r.text())
			} catch {
				res.status(503).json({ ok: false, service: P1_BASE, error: 'P1 服务未运行' })
			}
		})
		// 统一动作代理：action 与 python 服务路由一一对应（runP1/clearCaches/listVocabs/atBrowse/
		// getUserVocab/saveUserVocab/toggleUserVocab/deleteUserVocab/getConfig/setConfig...）
		router.post(base + '/service/:action', authenticate, (req, res) => relay(req, res, req.params.action))
		// 读路聚合快照（前端 sendAction getData 精确注册消费：config+meta+stats，面板纯渲染零硬编码）
		router.get(base + '/getdata', authenticate, (req, res) => relay(req, res, 'getData'))
	},
	interfaces: {
		web: {},
		invokes: {
			IPCInvokeHandler: async (user, args) => {
				// IPC 形状与 HTTP 一致：{action, ...payload}
				const { action, ...payload } = args || {}
				const r = await fetch(`${P1_BASE}/${action || 'health'}`, {
					method: action ? 'POST' : 'GET',
					headers: { 'Content-Type': 'application/json', 'X-P1-Username': user || '' },
					...(action ? { body: JSON.stringify(payload) } : {}),
					signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
				})
				return await r.json()
			},
		},
	},
}
