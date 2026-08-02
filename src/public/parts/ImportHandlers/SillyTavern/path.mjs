import fs from 'node:fs'
import path from 'node:path'

import { getUserDictionary } from '../../../../yonban/core/functions/security/auth.mjs'
import { uninstallPartBase } from '../../../../server/parts_loader.mjs'

/**
 * 解析部件的绝对路径。
 * @param {string} username - 用户名。
 * @param {string} type - 部件类型。
 * @param {string} name - 部件名称。
 * @returns {string} - 部件的绝对路径。
 */
export function resolvePath(username, type, name) {
	const userPath = getUserDictionary(username)
	const partPath = path.join(userPath, type, name)
	return partPath
}

/**
 * 获取一个可用的部件路径，如果已存在则先卸载。
 * @param {string} username - 用户名。
 * @param {string} type - 部件类型。
 * @param {string} name - 部件名称。
 * @returns {Promise<string>} - 可用的部件路径。
 */
export async function getAvailablePath(username, type, name) {
	const targetPath = resolvePath(username, type, name)
	if (fs.existsSync(targetPath))
		// [2026-08-01 严重bug修·参数错位]（扫描报告 scan_lifecycle_缓存陈旧.md 高#2）：
		// 旧调用 uninstallPartBase(username, type, name)——type("chars")落 partpath 位=卸载/trash
		// 目标变成整个容器目录，name 落 unLoadargs 位被当卸载参数；且缺省 pathGetter=GetPartPath
		// 可能回落到内置 src/public/parts 目录执行 trash（误删内置件）。
		// 正确：partpath=`${type}/${name}`（签名见 parts_loader.mjs uninstallPartBase）；
		// pathGetter 钉死本函数已解析且已确认存在的用户目录 targetPath——只删用户侧旧副本。
		await uninstallPartBase(username, `${type}/${name}`, undefined, undefined, { pathGetter: () => targetPath })
	return targetPath
}
