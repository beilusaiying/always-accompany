// beilu: 移除了 Sentry 和 sentrytunnel
import express from 'npm:express'

import { WsAbleApp, WsAbleRouter } from '../../scripts/WsAbleRouter.mjs'
import { auth_request } from '../../yonban/core/functions/security/auth.mjs'
import { __dirname } from '../base.mjs'

import { registerMonitorRoutes, installConsoleHook } from '../monitor.mjs'
import { registerEndpoints } from './endpoints.mjs'
import { registerV1Routes } from './api_v1_router.mjs'
import { registerEsmFallback, registerEsmProxy } from './esmProxy.mjs'
import { registerMiddleware } from './middleware.mjs'
import { getDeployMode } from '../../yonban/core/functions/security/path_confine.mjs'
import { PartsRouter } from './parts_router.mjs'
import { registerYonbanBridge } from './yonban_bridge.mjs'
import { betterSendFile, registerResources } from './resources.mjs'
import { registerWellKnowns } from './well-knowns.mjs'

/**
 * 主 Express 应用程序实例。
 * @type {import('npm:express').Application}
 */
export const app = WsAbleApp()
app.disable('x-powered-by')
const mainRouter = WsAbleRouter()
const FinalRouter = express.Router()

// 定义路由器的顺序
app.use(mainRouter)
app.use(PartsRouter)
app.use(FinalRouter)

// beilu: sentrytunnel 端点已移除

// 在主路由器上设置中间件
registerMiddleware(mainRouter)

// 在主路由器上设置 API、well-known 和资源端点
registerEndpoints(mainRouter)
// 监控路由须先于 v1 通配鉴权挂载：api_v1_router 挂在 /api/v1 且 router.use(apiKeyAuth)。
//   若 v1 先注册，/api/v1/monitor/* 会先命中 v1 前缀挂载撞 apiKeyAuth → 匿名 errors/report
//   (登录前页面 base.mjs _reportError 上报)被 401。monitor 具体路由先注册即优先命中：
//   errors/report 匿名可达(自带 rateLimit+size cap 防灌盘)，其余 monitor 路由各自 authenticate(原就有,
//   非靠 v1 兜底)；非 monitor 的 /api/v1/* 与之路径不相交，仍落 api_v1_router。
registerMonitorRoutes(mainRouter) // 后台监控系统
installConsoleHook() // 拦截 console.error/warn 写入监控
registerYonbanBridge(mainRouter) // 中间站桥：/api/yonban/dispatch 统一入口（粒子原样过桥→dispatch）
registerV1Routes(mainRouter)
registerWellKnowns(mainRouter)
registerEsmProxy(mainRouter) // ESM 缓存代理（解决大陆 esm.sh 超时）
registerResources(mainRouter)

// ESM 回退代理 — 兜住那些直接请求 /pkg@version 的 esm.sh 子依赖
registerEsmFallback(FinalRouter)

// /version — 静默处理（某些角色卡脚本会请求 SillyTavern 的版本端点）
FinalRouter.get('/version', (_req, res) => {
	res.json({ version: '0.0.0', agent: 'beilu-always-accompany' })
})

// 设置最终处理程序（404、错误）
FinalRouter.use(async (req, res) => {
	const is_api = req.path.startsWith('/api/') || req.path.startsWith('/ws/')
	const is_part = req.path.startsWith('/parts/') || req.path.startsWith('/api/parts/') || req.path.startsWith('/ws/parts/')

	// 降噪：已知的无害 404 不打日志（角色卡图片/头像/版本端点等）
	const isSilent = /\.(png|jpg|jpeg|gif|webp|svg|ico)$/i.test(req.path) ||
		req.path === '/version' ||
		req.path.endsWith('/avatar%7D') || req.path.endsWith('/avatar}')
	if (!isSilent) {
		if (!is_part || await auth_request(req, res))
			console.warn('404 Not found:', req.path)
	}

	if (is_api) return res.status(404).json({ message: 'API Not found' })
	if (req.accepts('html')) return betterSendFile(res.status(404), __dirname + '/src/public/pages/404/index.html')
	res.status(404).type('txt').send('Not found')
})
/**
 * 应用程序的主错误处理程序。
 * @param {Error} err - 错误对象。
 * @param {import('npm:express').Request} req - Express 请求对象。
 * @param {import('npm:express').Response} res - Express 响应对象。
 * @param {import('npm:express').NextFunction} next - 下一个中间件函数。
 * @returns {void}
 */
const errorHandler = (err, req, res, next) => {
	// ECONNABORTED: 客户端在请求体读取完成前关闭了 TCP 连接（keepAliveTimeout 竞态或客户端超时取消）。
	// 此时 res 已不可写，静默跳过即可——不 console.error 避免大量堆栈刷屏。
	if (err?.code === 'ECONNABORTED' || err?.type === 'request.aborted') {
		return;
	}
	console.error(err)
	if (res.headersSent) return;
	if (getDeployMode() === 'server') {
		res.status(500).json({ message: 'Internal Server Error' })
	} else {
		res.status(500).json({ message: 'Internal Server Error', errors: err.errors, error: err.message || err.cause?.message || String(err) })
	}
}

PartsRouter.use(errorHandler)
FinalRouter.use(errorHandler)
app.use(errorHandler)
