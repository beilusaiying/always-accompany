import { loadJsonFileIfExists } from '../../../../../scripts/json_loader.mjs'
import { GetPartPath, getPartList, loadPart, notifyPartInstall } from '../../../../../server/parts_loader.mjs'
import { loadData, saveData } from '../../../../../server/setting_loader.mjs'
import { skip_report } from '../../../../../server/server.mjs'

/**
 * 获取导入处理器列表。
 * @param {string} username - 用户名。
 * @returns {Array<string>} - 导入处理器列表。
 */
function getImportHandlerList(username) {
	return getPartList(username, 'ImportHandlers').map(
		name => ({
			name,
			order: loadJsonFileIfExists(GetPartPath(username, 'ImportHandlers/' + name) + '/order.txt', 0),
		})
	).sort((a, b) => b.order - a.order).map(a => a.name)
}
/**
 * 导入部件。
 * @param {string} username - 用户名。
 * @param {any} data - 数据。
 * @returns {Promise<void>}
 */
export async function importPart(username, data) {
	const ImportHandlers = getImportHandlerList(username)
	const errors = []

	for (const importHandler of ImportHandlers) try {
		const handler = await loadPart(username, 'ImportHandlers/' + importHandler)
		const installedParts = await handler.interfaces.import.ImportAsData(username, data)
		for (const partpath of installedParts)
			if (partpath) {
				notifyPartInstall(username, partpath)
				if (partpath.startsWith('chars/')) _autoAssignAIsource(username, partpath)
			}

		return installedParts
	} catch (err) {
		errors.push({ handler: importHandler, error: err.message || String(err) })
		console.log(`handler ${importHandler} failed:`, err)
	}

	// 如果所有导入处理器都失败，抛出包含所有错误的异常
	if (errors.length)
		throw skip_report(Object.assign(new Error('All handlers failed'), { errors }))
}

/**
 * 通过文本导入部件。
 * @param {string} username - 用户名。
 * @param {string} text - 文本。
 * @returns {Promise<void>}
 */
export async function importPartByText(username, text) {
	const ImportHandlers = getImportHandlerList(username)
	const errors = []

	for (const importHandler of ImportHandlers) try {
		const handler = await loadPart(username, 'ImportHandlers/' + importHandler)
		const installedParts = await handler.interfaces.import.ImportByText(username, text)
		if (installedParts && installedParts.length)
			for (const partpath of installedParts)
				if (partpath)
					notifyPartInstall(username, partpath)

		return installedParts
	} catch (err) {
		errors.push({ handler: importHandler, error: err.message || String(err) })
		console.log(`handler ${importHandler} failed:`, err)
	}

	if (errors.length) throw skip_report(Object.assign(new Error('All handlers failed'), { errors }))
}

function _autoAssignAIsource(username, partpath) {
	try {
		const parts_config = loadData(username, 'parts_config')
		if (parts_config[partpath]?.AIsource) return
		let defaultAIsource = ''
		for (const [key, val] of Object.entries(parts_config)) {
			if (key.startsWith('chars/') && key !== partpath && val?.AIsource) { defaultAIsource = val.AIsource; break }
		}
		if (!defaultAIsource) {
			for (const [key, val] of Object.entries(parts_config)) {
				if (key.startsWith('serviceSources/AI/') && val?.generator === 'proxy') { defaultAIsource = key.replace('serviceSources/AI/', ''); break }
			}
		}
		if (defaultAIsource) {
			parts_config[partpath] = { ...(parts_config[partpath] || {}), AIsource: defaultAIsource }
			saveData(username, 'parts_config')
			console.log(`[install] 自动配置 AIsource: "${defaultAIsource}" → ${partpath}`)
		}
	} catch (e) { console.warn('[install] 自动配置 AIsource 失败:', e.message) }
}
