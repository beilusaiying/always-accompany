/**
 * [STPlugin ImportHandler] 酒馆插件导入器 — 导入框架适配层（薄）。
 *
 * 【定位】用户在导入界面（install shell：拖拽/贴文本）贴 git 仓库 URL → 本处理器识别 →
 *   委托 beilu-st-host 的 installFromGitUrl（clone → manifest 校验 → 失败回滚）。
 *   域逻辑（识别规则/下载/校验/回滚/落盘位置）全部收口在宿主 main.mjs，本文件零业务逻辑——
 *   照 MCP 薄壳范式：修宿主即修所有入口，不留第二份实现。
 *
 * 【让位规则】Installer_handler 按 order 降序轮询处理器，先认先得（本器 order=50，MCP=100，角色卡=0）：
 *   - 文件类 URL（.png/.json/.zip = 角色卡等其他导入器的输入）在 looksLikeGitRepoUrl 里显式排除；
 *   - 二进制数据（ImportAsData）一律抛错让位——酒馆插件一期只走 URL 安装（设计定：不做 zip 回退）。
 *
 * 【安全】ST 插件是任意 js，启用后跑在主页面 → 返回 needsConsent 提醒（仿角色卡导入范式，
 *   SillyTavern/main.mjs:270-273 同款），且安装后默认禁用，需用户在宿主管理面显式启用。
 *
 * 【功能链】install shell(贴URL) → importPartByText → 本文件 ImportByText → installFromGitUrl(宿主)
 *   → data/users/<u>/st-plugins/<name>/ → 宿主 discover/toggle → host-loader 注入。
 */
import { installFromGitUrl, looksLikeGitRepoUrl } from '../../plugins/beilu-st-host/main.mjs'

import info from './info.json' with { type: 'json' }

/**
 * 二进制导入：不是本器的输入（酒馆插件一期只接 URL），立即抛错让位给下一个处理器。
 */
async function ImportAsData(_username, _data) {
	throw new Error('[STPlugin] 只接受 git 仓库 URL 文本导入，二进制数据请交给其他导入器')
}

/**
 * 文本导入：逐行识别 git 仓库 URL，逐个安装。全部行都不像仓库 URL 时返回 []（= 未接收此输入，让位）。
 * @returns {Promise<Array<string>>} 安装成功时返回 ['plugins/beilu-st-host']（宿主 partpath，
 *   notifyPartInstall 以此广播刷新）；附 needsConsent 提醒。
 */
async function ImportByText(username, text) {
	const lines = String(text || '').split('\n').map(s => s.trim()).filter(Boolean)
	const urls = lines.filter(looksLikeGitRepoUrl)
	if (!urls.length) return []

	const installedNames = []
	const errors = []
	for (const url of urls) try {
		const { name, manifest } = await installFromGitUrl(username, url)
		installedNames.push(manifest?.display_name || name)
	} catch (err) {
		errors.push(`${url} → ${err?.message || err}`)
	}

	// 有 URL 被识别但全部失败：这是"本器的输入但安装失败"，如实抛错（含每条原因），不静默让位
	if (!installedNames.length)
		throw new Error(`[STPlugin] 酒馆插件安装失败：\n${errors.join('\n')}`)

	const result = ['plugins/beilu-st-host']
	result.needsConsent = true
	result.consentMessage = `已下载酒馆插件：${installedNames.join('、')}${errors.length ? `（另有 ${errors.length} 条失败：${errors.join('；')}）` : ''}。插件是第三方代码，启用后将在页面中运行——默认已禁用，请仅在信任来源时到「酒馆插件接口」管理面启用。`
	return result
}

/**
 * @type {import('../../../../decl/import.ts').import_handler_t}
 */
export default {
	info,

	interfaces: {
		import: {
			ImportAsData,
			ImportByText,
		},
	},
}
