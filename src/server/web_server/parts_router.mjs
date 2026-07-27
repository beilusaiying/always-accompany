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

	// Load the part
	await loadPart(username, partpath).catch(e => {
		console.error(`Failed to load part ${partpath} for user ${username}:`, e)
	})

	const partRouter = peekPartRouter(username, partpath)
	if (partRouter)
		return partRouter(req, res, next)
	return next()
})
// （getPartRouter/deletePartRouter/用户删除改名清扫 已下沉 parts_router_registry.mjs，见顶部 re-export）
