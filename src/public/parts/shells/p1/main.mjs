import info from './info.json' with { type: 'json' }
import { authenticate, getUserDictionary } from '../../../../yonban/core/functions/security/auth.mjs'
import {
	P1_SERVICE_BASE,
	probeP1Service,
	requestP1Service,
	warmP1Service,
} from '../../../../yonban/core/functions/memory/p1/serviceRuntime.mjs'

/**
 * [P1 召回服务 shell] — 薄 HTTP 传导层（002 2026-07-31 拍板：P1 从进程内 Deno 插件改为
 *   独立可插拔可独立运行的 Python 服务，本体不再承担 P1 的启动时间/内存占用）。
 *
 * 功能链：
 *   前端 → POST /api/parts/shells:p1/service/<action> → 本文件代理适配；生产 p1Bridge
 *     直接复用同一个 serviceRuntime；两路最终到 Python 服务
 *     http://127.0.0.1:<port>/<action>（service/p1_server.py，独立进程）
 *     → 返回原样透传。服务未运行 → 统一 runtime 单飞启动并等待健康，同一首次请求再转发；
 *       启动失败才返回带 code 的 503（调用方据此走 AI P1 降级链）。
 *
 * why 薄壳只做代理不做逻辑：插拔语义——拔掉 service 目录/停掉 Python 进程，本体所有链路不炸；
 *   P1 全部功能（管线/词库/配置）住 Python 侧，可脱离本体单独启动测试（拉线测试）。
 * 自动启动（0731 002："所以我连启动都要手动启动?"——插上就工作）：Load 时探测服务，不在则
 *   spawn python 拉起（已在跑=直接用不重复起；spawn 被安全软件拦=响亮日志+503 提示手动启动，诚实降级）。
 *   本轮本体自动 spawn 并通过 PID 健康握手认领的实例随本体受控退出；启动前已存在的手工/其他
 *   宿主实例只复用、不夺取退出所有权。P1_AUTOSTART=off 可关。
 * 生命周期单源在 serviceRuntime.mjs；P1_SERVICE_PORT/超时/自启动均沿用环境变量通道。
 */

async function relay(req, res, action) {
	const request = {
		body: req.body ?? {},
		// python 侧只绑 127.0.0.1，username 由本体鉴权后注入（防伪造：覆盖而非透传 body 内值）
		username: req.user?.username || '',
		memoryRoot: getUserDictionary(req.user?.username || ''),
	}
	const upstream = action === 'warmup'
		? await warmP1Service(request)
		: await requestP1Service(action, request)
	if (!upstream.transportOk) {
		return res.status(upstream.status || 503).json({
			success: false,
			code: upstream.code || 'E_P1_TRANSPORT',
			error: upstream.error || `P1 服务未就绪 (${P1_SERVICE_BASE})`,
		})
	}
	res.status(upstream.status).type(upstream.contentType || 'application/json').send(upstream.text)
}

export default {
	info,
	Load: ({ router }) => {
		const base = '/api/parts/shells\\:p1'
		// 插上就工作：启动和重资源预热均为单飞、fire-and-forget，不阻塞路由挂载。
		warmP1Service().then((result) => {
			if (!result?.readyForRecall) console.warn('[shells:p1] Load 预热未就绪:', {
				code: result?.code, error: result?.error, warmup: result?.data?.warmup,
			})
		}).catch((error) => console.warn('[shells:p1] Load 自动预热失败:', error?.message || error))
		// 健康检查：探测 python 服务是否在（无鉴权——不含数据，只报可达性）
		router.get(base + '/health', async (_req, res) => {
			const health = await probeP1Service()
			if (!health.transportOk) return res.status(503).json({ ok: false, service: P1_SERVICE_BASE, code: health.code, error: health.error })
			res.status(health.status).type(health.contentType || 'application/json').send(health.text)
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
				if (!action) {
					const health = await probeP1Service()
					return health.data || { ok: false, service: P1_SERVICE_BASE, code: health.code, error: health.error }
				}
				const request = {
					body: payload,
					username: user || '',
					memoryRoot: getUserDictionary(user || ''),
				}
				const result = action === 'warmup'
					? await warmP1Service(request)
					: await requestP1Service(action, request)
				return result.data || {
					success: false,
					status: result.status,
					code: result.code || 'E_P1_INVALID_RESPONSE',
					error: result.error || 'P1 服务未返回 JSON',
				}
			},
		},
	},
}
