/**
 * parts_router_registry.mjs — 部件路由注册表叶子（0722 启动大环解环拆出）。
 *
 * 【为什么拆】原注册表（PartsRouters 表 + get/delete + 用户删除/改名清扫）住在 parts_router.mjs，
 *   而 parts_loader 需要 get/delete（部件装卸时建/清路由）、parts_router 需要 loadPart（请求期懒加载）
 *   —— parts_loader ↔ parts_router 互 import 是 11 成员启动环的一段。共享状态（注册表）下沉叶子：
 *   两侧各自单向 import 本文件，互引消除。
 * 【铁律】本文件禁止 import parts_loader/parts_router/server 等启动链模块
 *   （允许：WsAbleRouter/events 叶子）；tests/check_import_cycles.mjs 守卫。
 * 【功能链】parts_loader（部件 Load 建路由/Unload 清路由）与 parts_router（请求分发查表）同源消费；
 *   兼容面：parts_router.mjs re-export getPartRouter/deletePartRouter，外部旧 import 路径不断。
 */
import { WsAbleRouter } from '../../scripts/WsAbleRouter.mjs'
import { events } from '../events.mjs'

const PartsRouters = {}

/**
 * 获取特定部件的路由器（不存在则创建）。
 * @param {string} username - 用户的用户名。
 * @param {string} partpath - 部件的路径。
 * @returns {import('../../scripts/WsAbleRouter.mjs').WsAbleRouter} 部件的路由器。
 */
export function getPartRouter(username, partpath) {
	PartsRouters[username] ??= {}
	return PartsRouters[username][partpath] ??= new WsAbleRouter()
}

/**
 * 只查不建（parts_router 请求分发用：未注册 → next()，不预创建空路由）。
 * @param {string} username - 用户的用户名。
 * @param {string} partpath - 部件的路径。
 * @returns {import('../../scripts/WsAbleRouter.mjs').WsAbleRouter|undefined}
 */
export function peekPartRouter(username, partpath) {
	return PartsRouters[username]?.[partpath]
}

/**
 * 删除特定部件的路由器。
 * @param {string} username - 用户的用户名。
 * @param {string} partpath - 部件的路径。
 * @returns {void}
 */
export function deletePartRouter(username, partpath) {
	delete PartsRouters[username]?.[partpath]
	if (PartsRouters[username] && !Object.keys(PartsRouters[username]).length) delete PartsRouters[username]
}

events.on('AfterUserDeleted', ({ username }) => {
	delete PartsRouters[username]
})

// 改名传导链（20260706）：旧名路由表清扫（parts_loader BeforeUserRenamed 卸载时 deletePartRouter
//   已逐 part 清，这里兜底清整键，与删号处理对称）。新名路由随首次请求 loadPart 懒重建。
events.on('AfterUserRenamed', ({ oldUsername }) => {
	delete PartsRouters[oldUsername]
})
