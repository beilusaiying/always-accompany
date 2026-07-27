/**
 * [safeJsonIO] — JSON 读取安全原语（T019 数据覆盖销毁批，2026-07-05）。
 *
 * 病根：全库 13+ 处「JSON.parse 损坏 → catch 静默 → 空/默认结构顶上 → 写回」＝一个字节损坏
 * 静默清空用户数据（正则/世界书/变量/词频/设置）。逐处 try-catch 兜底会漏且不一致，
 * 故收口为共享原语：损坏永不静默销毁，先备份再抛错，上层流程中止报错（错误是诊断面）。
 *
 * 行为契约：
 *   · 文件不存在 → 返回调用方 defaultValue（合法首装路径，与旧行为一致）
 *   · 存在但 JSON 损坏 → copyFileSync 到 `<path>.corrupt.<时间戳>.bak` 后抛 CorruptJsonError
 *     （含文件路径+parse 错误+备份路径），原文件不做任何改动
 *   · 正常文件 → 返回解析结果
 *   · 其他 IO 错误（EACCES 等）→ 原样上抛，不吞
 *
 * 链路：ImportHandlers/SillyTavern/main.mjs、beilu-chat/endpoints.mjs、beilu-home/main.mjs、
 *       api_v1_router.mjs、screenshot/injection_state.mjs、getPromptHandler.mjs、
 *       axisLearning.mjs、beilu-files/main.mjs、dataSystem.mjs(_readJson) ← 调用
 * 本层为 src/scripts 零依赖共享层（禁放 dataSystem——会循环依赖）。node:fs 在 Deno 下可用
 * （与 beilu-files F6 范式同），Node/Deno 两上下文通用。原子写用同层 nicerWriteFile.mjs。
 */
import fs from 'node:fs'

export class CorruptJsonError extends Error {
	constructor(filePath, parseError, bakPath) {
		const bakNote = bakPath ? `已备份为 ${bakPath}，原文件未改动` : '备份失败，原文件未改动'
		super(`JSON 损坏: ${filePath} — ${parseError?.message || parseError}（${bakNote}）`)
		this.name = 'CorruptJsonError'
		this.code = 'ERR_JSON_CORRUPT'
		this.filePath = filePath
		this.bakPath = bakPath
		this.parseError = parseError?.message || String(parseError)
	}
}

/** 损坏文件改名保留（copy 不 move：原文件留在原位供人工修复/AI 修）。备份失败不阻断抛错。
 *  [0716] 导出供 storage.loadJsonFileIfExists 复用（损坏→备份后回退默认的温和范式），备份逻辑单源。 */
export function bakCorruptFile(filePath) { return _bakCorrupt(filePath) }
function _bakCorrupt(filePath) {
	try {
		const ts = new Date().toISOString().replace(/[:.]/g, '-')
		const bak = `${filePath}.corrupt.${ts}.bak`
		fs.copyFileSync(filePath, bak)
		return bak
	} catch { return null }
}

/**
 * 同步安全读 JSON。
 * @param {string} filePath
 * @param {any} defaultValue - 文件不存在时返回（首装默认结构）
 * @returns {any} 解析结果或 defaultValue
 * @throws {CorruptJsonError} 文件存在但 JSON 损坏（已先备份 .corrupt.bak）
 */
export function readJsonSafeSync(filePath, defaultValue) {
	if (!fs.existsSync(filePath)) return defaultValue
	const raw = fs.readFileSync(filePath, 'utf-8')
	try { return JSON.parse(raw) }
	catch (e) { throw new CorruptJsonError(filePath, e, _bakCorrupt(filePath)) }
}

/**
 * 异步安全读 JSON（行为同 readJsonSafeSync）。
 * @param {string} filePath
 * @param {any} defaultValue
 * @returns {Promise<any>}
 * @throws {CorruptJsonError}
 */
export async function readJsonSafe(filePath, defaultValue) {
	if (!fs.existsSync(filePath)) return defaultValue
	const raw = await fs.promises.readFile(filePath, 'utf-8')
	try { return JSON.parse(raw) }
	catch (e) { throw new CorruptJsonError(filePath, e, _bakCorrupt(filePath)) }
}
