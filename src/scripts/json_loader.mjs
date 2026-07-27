import fs from 'node:fs'

import { nicerWriteFileSync } from './nicerWriteFile.mjs'

/**
 * 容错语义单源（框架级，禁各处加 if/try-catch）：
 *   - loadJsonFile(无 fallback)        = 严格。损坏文件备份+告警后【抛】。用于关键配置
 *     (config.json/user.json/locale)、part 发现的 mergeBeiluPart（其自身 try/catch 降级跳过）。
 *   - loadJsonFileIfExists(有 default) = 容错。调用方既已声明 fallback，损坏==不可用，
 *     备份+告警后【回退 default】不崩。修「容错看似加了实则没加」：旧版损坏会绕过 default 抛。
 */
function backupCorruptedJson(filename, e) {
	const bak = filename + '.corrupted_' + Date.now()
	try { fs.copyFileSync(filename, bak) } catch {}
	console.error(`[json_loader] JSON 解析失败: ${filename} (已备份为 ${bak})`, e.message)
}

/**
 * 加载一个 JSON 文件（严格：损坏即抛）。
 * @param {string} filename - 要加载的文件的名称。
 * @returns {any} 解析后的 JSON 数据。
 */
export function loadJsonFile(filename) {
	try {
		return JSON.parse(fs.readFileSync(filename, 'utf8'))
	} catch (e) {
		backupCorruptedJson(filename, e)
		throw e
	}
}

/**
 * loadJsonFile 的异步等价版（同严格语义：损坏备份+告警后【抛】，容错单源不分叉）。
 * [0719] 供大文件热路径用（chatStorage.loadChat 的 MB 级对话文件）：readFileSync 阻塞
 * Deno 主线程使全部并发请求排队（YonBan「每处延迟都不一样」的后端贡献源之一），异步读让出事件循环。
 * @param {string} filename - 要加载的文件的名称。
 * @returns {Promise<any>} 解析后的 JSON 数据。
 */
export async function loadJsonFileAsync(filename) {
	try {
		return JSON.parse(await fs.promises.readFile(filename, 'utf8'))
	} catch (e) {
		backupCorruptedJson(filename, e)
		throw e
	}
}

/**
 * 如果 JSON 文件存在且可解析，则加载它，否则返回默认值（容错：缺失或损坏都回退 default）。
 * @param {string} filename - 要加载的文件的名称。
 * @param {any} [defaultvalue={}] - 文件不存在或损坏时返回的默认值。
 * @returns {any} 解析后的 JSON 数据或默认值。
 */
export function loadJsonFileIfExists(filename, defaultvalue = {}) {
	if (!fs.existsSync(filename)) return defaultvalue
	try {
		return JSON.parse(fs.readFileSync(filename, 'utf8'))
	} catch (e) {
		backupCorruptedJson(filename, e)
		return defaultvalue
	}
}

/**
 * 将 JSON 数据保存到文件。
 * @param {string} filename - 要保存的文件的名称。
 * @param {any} json - 要保存的 JSON 数据。
 * @returns {void}
 */
export function saveJsonFile(filename, json) {
	try {
		nicerWriteFileSync(filename, JSON.stringify(json, null, '\t') + '\n', { encoding: 'utf8' })
	}
	catch (error) {
		console.error('Error saving JSON file:', filename, error)
		throw error
	}
}
