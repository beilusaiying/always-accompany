/**
 * security_policy.mjs — 安全策略单一权威（SEC-R1 框架根治）
 *
 * 病根（红方实战 + 主AI 审计坐实）：beilu 单进程多用户下，插件的 `config/setdata` 写的是
 *   【进程级全局状态】，而该端点只校验"已登录"——任一注册用户即可翻全局安全开关：
 *     - beilu-files allowExec=true → 开服务端命令执行
 *     - beilu-files rootPath/workspaceRoot → 改全局文件沙箱根
 *     - beilu-ejs sandboxOptOut=true → 全员关 EJS 沙箱 → SSTI→RCE
 *     - beilu-regex regexGuard.enabled=false → 全局关 ReDoS 护栏
 *   逐个 effect-gate 是打补丁（散、易漏）。框架根治 = 在 parts_router 的【config 写入 seam】
 *   统一对"安全敏感的插件配置写"强制 owner（本模块是这份清单 + 判定的单一权威）。
 *
 * 设计：
 *   - 只拦【安全敏感字段/动作】，不动同插件的 per-user 合法操作（如 beilu-regex 改自己的
 *     rules、beilu-memory 的 env-tools 等 _action 数据操作）——故按"命中敏感写"判定，非一刀切。
 *   - 数据注入类通道（plugin-host /api/user-plugins/push、eye /api/eye/* localhost+token、
 *     browser pushPage）走各自独立端点/鉴权，本清单不含 → 天然不受影响。
 *   - 判定异常一律保守要 owner（fail-safe，不 fail-open）。
 *
 * 链路：parts_router.mjs 中间件 → partConfigWriteNeedsOwner(partpath, body) → true 则要求 isOwner
 * 影响：无磁盘/状态副作用（纯判定函数）
 * 相交：← parts_router.mjs（唯一消费方，config/setdata seam 处调用）
 *       → whitebox.mjs(wbTrace,wbDetect)
 */

import { wbTrace, wbDetect } from '../../../../server/whitebox.mjs'

/**
 * 安全敏感的插件 config/setdata 写：partpath → (body)=>bool。
 * 命中 = 该写会改全局安全态，server 多用户下须 owner（local 单用户 owner=本人，自然通过）。
 * 扩展新插件的安全开关时，只改这一处。
 * @type {Record<string, (body:object)=>boolean>}
 */
export const OWNER_ONLY_PART_CONFIG_WRITE = {
	'plugins/beilu-files': (b) =>
		['allowExec', 'rootPath', 'workspaceRoot', 'allowChannelBExec', 'commandGate'].some(k => b?.[k] !== undefined),
	'plugins/beilu-ejs': (b) => b?.sandboxOptOut !== undefined,
	'plugins/beilu-regex': (b) => b?.regexGuard !== undefined || b?._action === 'setGuardConfig',
}

/**
 * 判定某插件的 config 写是否触及安全敏感项（须 owner）。
 * @param {string} partpath - 部件路径（如 'plugins/beilu-files'）。
 * @param {object} body - 请求体（已由 mainRouter 的 json 解析；PartsRouter 在其后）。
 * @returns {boolean} true=须 owner。
 */
export function partConfigWriteNeedsOwner(partpath, body) {
	// SEC-R1b（红方 round2 E3）：Express/部分平台路由大小写不敏感，partpath 段可能以 `PLUGINS:beilu-files`
	//   等变体到达且仍被 loadPart 解析（Windows 大小写不敏感 FS）。清单 key 均为小写规范形，
	//   故查表前把 partpath 归一小写，避免变体 miss → fail-open 放行安全敏感写。
	const pred = OWNER_ONLY_PART_CONFIG_WRITE[String(partpath || '').toLowerCase()]
	if (!pred) return false
	try {
		const _hit = !!pred(body || {})
		if (_hit) wbTrace(null, 'sec', 'partConfigWriteNeedsOwner:sensitive_hit', { partpath })
		return _hit
	}
	catch {
		// 判定异常 → 保守要 owner（fail-safe）。安全保守分支,上面板。
		wbDetect(null, 'sec', 'partConfigWriteNeedsOwner:failsafe_owner', false, '敏感写判定异常,fail-safe要求owner', { partpath })
		return true
	}
}
