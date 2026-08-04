import express from 'npm:express'

import { auth_request, authenticate, getUserByReq, isOwner } from '../../yonban/core/functions/security/auth.mjs'
import { loadPart } from '../parts_loader.mjs'
import { partConfigWriteNeedsOwner } from '../../yonban/core/functions/security/security_policy.mjs'
// [0722 解环] 注册表本体下沉 parts_router_registry.mjs 叶子（parts_loader↔本文件互引是启动大环一段，
//   共享状态下沉后两侧单向）。此处 re-export 保外部旧 import 路径不断。
import { peekPartRouter } from './parts_router_registry.mjs'
export { getPartRouter, deletePartRouter } from './parts_router_registry.mjs'

/**
 * 处理特定部件请求的主路由器。
 * @type {import('npm:express').Router}
 */
export const PartsRouter = express.Router()
// Regex to match /(api|ws|virtual_files)/parts/<partpath>/<apipath> where partpath may contain colons
const partsAPIregex = /^\/(api|ws|virtual_files)\/parts\/([^/]+)/

// 这些错误表示当前加载能力暂不可用（退避/熔断/协调占用/超时），
// HTTP 层统一映射 503；其余加载错误保持 500 且传导原 code/message。
const PART_LOAD_UNAVAILABLE_CODES = new Set([
	'E_PART_LOAD_BACKOFF',
	'E_PART_LOAD_BLOCKED',
	'E_PART_LOAD_CIRCUIT',
	'E_PART_LOAD_BUSY',
	'E_PART_LOAD_COORDINATION',
	'E_PART_LOAD_CANCELLED',
	'E_PART_LOAD_REVISION_CHANGED',
	'E_PART_LOAD_TIMEOUT',
	'E_PART_LIFECYCLE_TIMEOUT',
	'E_PART_USER_QUIESCING',
	'E_PART_USER_QUIESCE_TIMEOUT',
	'ECONNREFUSED',
	'ECONNRESET',
	'ETIMEDOUT',
	'EAI_AGAIN',
	'ENETUNREACH',
	'EHOSTUNREACH',
	'EPIPE',
	'UND_ERR_CONNECT_TIMEOUT',
])

/** 纯协议转换：保留 loader 的结构字段，不用统一 500 覆盖真实原因。 */
export function serializePartLoadHttpError(error, partpath) {
	const code = typeof error?.code === 'string' && error.code ? error.code : 'E_PART_LOAD_FAILED'
	const unavailable = error?.retryable === true || error?.classification === 'transient' ||
		PART_LOAD_UNAVAILABLE_CODES.has(code) || /(?:BACKOFF|CIRCUIT|TIMEOUT)/.test(code)
	const retryAfterMsValue = error?.retryAfterMs == null ? NaN : Number(error.retryAfterMs)
	const retryAfterMs = Number.isFinite(retryAfterMsValue) && retryAfterMsValue >= 0
		? Math.ceil(retryAfterMsValue)
		: null
	const failureCountValue = error?.failureCount == null ? NaN : Number(error.failureCount)
	const failureCount = Number.isFinite(failureCountValue) && failureCountValue >= 0
		? Math.trunc(failureCountValue)
		: null
	const message = error?.message || String(error)
	const body = {
		success: false,
		code,
		partpath,
		message,
	}
	if (unavailable) {
		Object.assign(body, {
			retryable: error?.retryable !== false,
			retryAfterMs,
			failureCount,
			lastCause: error?.lastCause ?? null,
		})
	}
	return {
		status: unavailable ? 503 : 500,
		retryAfterSeconds: retryAfterMs == null ? null : Math.max(1, Math.ceil(retryAfterMs / 1000)),
		body,
	}
}

PartsRouter.use(async (req, res, next) => {
	const match = partsAPIregex.exec(req.path)
	if (!match) return next()
	if (!await auth_request(req, res)) {
		// 传导链修复（20260706 删号卡死根因层）：match 已确定这是 parts API 请求，auth 失败后 next()
		//   没有任何后续路由能服务它——唯一效果是把"未认证"翻译成 404，绕过前端 apiFetch 的 401
		//   统一跳登录出口（api-client.mjs:73）→ 会话失效（删号/过期/被踢）后整壳无限 404 卡死。
		//   api 类复用既有认证中间件 authenticate（auth.mjs 结构化 401+wbDetect 观测单源，不另拼响应）；
		//   ws/virtual_files 保留原 skip（升级请求与虚拟文件各有自己的失败路径）。
		if (match[1] === 'api')
			return authenticate(req, res)
		console.error(`skip part router because auth failed: ${req.method} ${req.path}`)
		return next()
	}
	const { username } = await getUserByReq(req)
	if (!username) return next()

	const partpath = match[2].replace(/:/g, '/')
	if (partpath.split(/[/\\]/).some(s => s === '..' || s === '.' || s.includes('\0')))
		return res.status(400).json({ message: 'invalid partpath' })

	// SEC-R1（框架根治）：插件 config/setdata 在多用户下写的是进程级全局安全态。安全敏感写（清单见
	//   security_policy.mjs 单一权威）统一在此 seam 强制 owner——非 owner 一律 403，杜绝任一注册用户
	//   翻 allowExec/sandboxOptOut/regexGuard/workspaceRoot 等全局开关（RCE/沙箱逃逸面）。
	//   local 单用户：owner=本人，自然通过；per-user 合法操作（不在清单）不受影响。
	// SEC-R1b（红方 round2 E1/E3 坐实）：Express 5 默认大小写不敏感路由，part 自注册的
	//   `/config/setdata` 路由会命中 `/config/SETDATA` 等大小写变体；而本 seam 原用大小写敏感
	//   正则 + 精确 partpath 查表，与路由口径不一致 → 变体短路 gate 但仍命中 SetData（绕 owner 闸）。
	//   修（框架级）：path 测试加 `i` 标志、partpath 在 partConfigWriteNeedsOwner 内归一小写，
	//   令"seam 识别为安全敏感写"的集合 ⊇ "Express 实际会路由到 setdata"的集合，消除 desync 绕过类。
	if (req.method === 'POST' && /\/config\/setdata\/?$/i.test(req.path) &&
		partConfigWriteNeedsOwner(partpath, req.body) && !isOwner(username)) {
		console.warn(`[SEC-R1] 拒绝非 owner(${username}) 修改 ${partpath} 的安全敏感配置: ${req.path}`)
		return res.status(403).json({ success: false, message: '仅实例 owner 可修改该插件的安全敏感配置' })
	}

	// 请求已被明确识别为本 part 的 API。加载失败必须在这里终止并反馈真实原因；
	// 旧代码 catch 后 next()，会把 Init/Load/SetData 的失败伪装成“接口不存在”的 404。
	try {
		await loadPart(username, partpath)
	}
	catch (error) {
		console.error(`Failed to load part ${partpath} for user ${username}:`, error)
		const failure = serializePartLoadHttpError(error, partpath)
		if (failure.retryAfterSeconds != null) res.set('Retry-After', String(failure.retryAfterSeconds))
		return res.status(failure.status).json(failure.body)
	}

	const partRouter = peekPartRouter(username, partpath)
	if (partRouter)
		return partRouter(req, res, next)
	// 成功完成生命周期却没有注册本请求的路由，属于该 part 的明确缺口，不能泄漏到其他全局路由。
	return res.status(404).json({
		success: false,
		code: 'E_PART_ROUTE_UNAVAILABLE',
		partpath,
		message: '部件已加载，但没有注册此请求对应的路由',
	})
})
// （getPartRouter/deletePartRouter/用户删除改名清扫 已下沉 parts_router_registry.mjs，见顶部 re-export）
