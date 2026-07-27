import { Buffer } from 'node:buffer'
import path from 'node:path'

import { fileTypeFromBuffer } from 'npm:file-type'
import fs from 'npm:fs-extra'
import sanitizeFilename from 'npm:sanitize-filename'

import { saveJsonFile } from '../../../../scripts/json_loader.mjs'
import { readJsonSafe } from '../../../../scripts/safeJsonIO.mjs' // T019：损坏不静默重建，备份.corrupt.bak后抛错中止
import { parts_set } from '../../../../server/parts_loader.mjs'

import { downloadCharacter } from './char-download.mjs'
import data_reader from './data_reader.mjs'
import { GetV2CharDataFromV1 } from './engine/charData.mjs'
import info from './info.json' with { type: 'json' }
import { getAvailablePath } from './path.mjs'
/**
 * @typedef {import('../../../../decl/import.ts').import_handler_t} import_handler_t
 */

/**
 * 将对象中的 `\r\n` 和 `\r` 替换为 `\n`。
 * @param {any} obj - 要处理的对象。
 * @returns {any} - 处理后的对象。
 */
function RN2N(obj) {
	if (!obj) return obj
	if (Object(obj) instanceof String)
		return obj.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
	else if (Array.isArray(obj))
		return obj.map(RN2N)
	else if (Object(obj) instanceof Number || Object(obj) instanceof Boolean)
		return obj
	else
		return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, RN2N(v)]))
}

/**
 * 断言上传的角色卡载体是安全的真实 PNG 图片（F-D5 XSS 防护）。
 *
 * 通过 magic bytes 嗅探真实 MIME（不信扩展名/声明类型）：
 * - 只放行 image/png（SillyTavern 角色卡标准载体）。
 * - 显式拒绝 image/svg+xml（SVG 可内联 <script>/on*）。
 * - 拒绝 HTML/JS 等伪装成图片的 polyglot（fileTypeFromBuffer 对非图片返回 undefined 或非 image/*）。
 * 写盘前 data_reader.remove()(png-chunks-extract→encode) 还会重新序列化 PNG，
 * 丢弃 IEND 之后的尾随字节，进一步消除 PNG 头 + 尾部藏 HTML 的 polyglot。
 *
 * @param {Buffer} data - 上传的图片缓冲区。
 * @throws {Error} 非 PNG / SVG / 无法识别时抛错，终止导入。
 */
export async function assertSafeCharImage(data) {
	const ft = await fileTypeFromBuffer(data)
	if (!ft)
		throw new Error('角色卡导入被拒：无法识别文件类型（非合法 PNG，疑似伪装/polyglot）。')
	if (ft.mime === 'image/svg+xml')
		throw new Error('角色卡导入被拒：不接受 SVG（可内联脚本），角色卡载体只接 PNG。')
	if (ft.mime !== 'image/png')
		throw new Error(`角色卡导入被拒：载体必须是 PNG，实际为 ${ft.mime}。`)
}

/**
 * 将数据作为 SillyTavern 角色导入。
 * @param {string} username - 用户名。
 * @param {Buffer} data - 数据缓冲区。
 * @returns {Promise<Array<string>>} - 导入的部分路径数组（partpath）。
 */
async function ImportAsData(username, data) {
	// ★ F-D5 XSS：导入前断言上传内容的真实 MIME。角色卡载体只接 PNG，
	//   拒绝 SVG(内联脚本) / 伪装图片的 HTML/JS polyglot。fileTypeFromBuffer 读 magic bytes，
	//   不信任文件扩展名/声明的 content-type。
	await assertSafeCharImage(data)
	const chardata = GetV2CharDataFromV1(RN2N(JSON.parse(data_reader.read(data))))

	// make an dir for the character
	// copy directory
	const templateDir = path.join(import.meta.dirname, 'Template')
	const dirname = sanitizeFilename(chardata.name || 'unknown')
	const targetPath = await getAvailablePath(username, 'chars', dirname)

	await fs.copy(templateDir, targetPath)
	saveJsonFile(path.join(targetPath, 'beilu-part.json'), { type: 'chars', dirname })
	// write chardata to the character
	const chardataPath = path.join(targetPath, 'chardata.json')
	saveJsonFile(chardataPath, chardata)
	// save image to the character
	const image = data_reader.remove(data)
	const publicDir = path.join(targetPath, 'public')
	await fs.ensureDir(publicDir)
	const imagePath = path.join(publicDir, 'image.png')
	await fs.writeFile(imagePath, image)
	// ── 迁移角色卡内嵌正则脚本进 beilu-regex 运行时存储 ──
	// 根因（2026-06-24 S6 诊断）：链A导入只存 chardata.json，不迁移进 beilu-regex 的
	// config_data.json.rules（in-memory pluginData），导致 beilu-regex 插件 UI 不可见、
	// beilu 扩展功能（全局正则等）不适用。虽然链A模板内联的 runRegex 直接读 chardata 可生效，
	// 但与链B口径不一致。框架级修：与 beilu-home/main.mjs:567-637 同模式下沉到导入阶段。
	// 口径：boundCharName = dirname（文件系统目录名），与链B finalName 一致。
	// 幂等：先 removeByChar 清旧再导入，防重名/重复导入累积。
	try {
		const stRegexScripts = chardata?.extensions?.regex_scripts
		if (Array.isArray(stRegexScripts) && stRegexScripts.length > 0) {
			const regexPlugin = parts_set[username]?.['plugins/beilu-regex']
			if (regexPlugin?.interfaces?.config?.SetData) {
				// 插件已加载：走插件 action（importFromSTFormat 单一权威转换 + saveConfigToDisk，
				// 同时更新 in-memory pluginData 让运行中的 app 立即可见）。先清后导保证幂等。
				// [0719 错桶修·病族] regex SetData 读第二参 args.username 分桶（T065）——漏传=写 _default 桶
				//   （同文件下方 worldbook 段 :188/:191 早已带 {username}，本段是上次收口的漏网点）
				await regexPlugin.interfaces.config.SetData({
					_action: 'removeByChar',
					charName: dirname,
				}, { username })
				const imp = await regexPlugin.interfaces.config.SetData({
					_action: 'importST',
					scripts: stRegexScripts,
					scope: 'scoped',
					boundCharName: dirname,
				}, { username })
				console.log(
					`[SillyTavern-ImportHandler] 角色 "${dirname}" 迁移 ${imp?._result?.count ?? stRegexScripts.length} 条正则进 beilu-regex（in-memory）`,
				)
			} else {
				// 插件未加载到 parts_set：直接落盘迁移（与链B磁盘 fallback 对称）。
				// 复用 beilu-regex 导出的 importFromSTFormat，避免另写一份 placement 映射副本。
				const { importFromSTFormat } = await import(
					'../../plugins/beilu-regex/main.mjs'
				)
				const regexConfigPath = path.join(
					import.meta.dirname,
					'../../plugins',
					'beilu-regex',
					'config_data.json',
				)
				// T019：损坏→readJsonSafe 备份.corrupt.bak 后抛错，本段迁移中止（外层catch报错），
				// 绝不以空库顶上写回清空用户已有正则；不存在→首装默认。
				const regexData = await readJsonSafe(regexConfigPath, { rules: [], enabled: true })
				if (!Array.isArray(regexData.rules)) regexData.rules = []
				// 幂等：先清掉该 dirname 已有 scoped 规则
				regexData.rules = regexData.rules.filter(
					(r) => r.boundCharName !== dirname,
				)
				const converted = importFromSTFormat(
					stRegexScripts,
					'scoped',
					dirname,
					'',
				)
				regexData.rules.push(...converted)
				await fs.writeFile(
					regexConfigPath,
					JSON.stringify(regexData, null, 2),
					'utf-8',
				)
				console.log(
					`[SillyTavern-ImportHandler] 角色 "${dirname}" 迁移 ${converted.length} 条正则进 beilu-regex（磁盘 fallback，插件未加载）`,
				)
			}
		}
	} catch (e) {
		console.warn(
			`[SillyTavern-ImportHandler] 迁移角色 "${dirname}" 正则进 beilu-regex 失败:`,
			e.message,
		)
	}

	// ── 迁移角色卡内嵌世界书（character_book）进 beilu-worldbook 运行时存储 ──
	// 根因（2026-06-24 S6 诊断）：同正则，链A导入只存 chardata.json，不迁移进 beilu-worldbook 的
	// config_data.json.worldbooks。虽然链A模板内联 promptBuilder 直接读 chardata.character_book 可生效，
	// 但与链B口径不一致，beilu-worldbook 插件 UI 不可见。
	// 框架级修：与 beilu-home/main.mjs:652-747 同模式下沉到导入阶段。
	// character_book 可能位于 chardata.character_book 或 chardata.extensions.character_book。
	// 绑定书 enabled=false：靠 boundMatch(getAllEnabledEntries)私有注入到本角色；
	// enabled=true 会经 globalEnabled 泄漏进所有角色。
	try {
		const charBook = chardata?.character_book || chardata?.extensions?.character_book
		if (
			charBook?.entries &&
			(Array.isArray(charBook.entries)
				? charBook.entries.length > 0
				: Object.keys(charBook.entries).length > 0)
		) {
			const bookName = `${dirname} 世界书`
			const worldbookPlugin = parts_set[username]?.['plugins/beilu-worldbook']
			const entryCount = Array.isArray(charBook.entries)
				? charBook.entries.length
				: Object.keys(charBook.entries).length
			if (worldbookPlugin?.interfaces?.config?.SetData) {
				// 插件已加载：走插件 action（import_worldbook 内部 convertSTEntries +
				// saveConfigToDisk，同时更新 in-memory per-user store 让运行中的 app 立即可见）。
				// [T074] 必须传 { username } ctx，否则 SetData 落 _default store（写错用户目录，导入的世界书该用户看不到）。
				// 先 removeByChar 保证幂等（按 boundCharName 清该 char 旧绑定世界书）。
				await worldbookPlugin.interfaces.config.SetData({
					removeByChar: { charName: dirname },
				}, { username })
				await worldbookPlugin.interfaces.config.SetData({
					import_worldbook: {
						json: charBook,
						name: bookName,
						boundCharName: dirname,
					},
				}, { username })
				console.log(
					`[SillyTavern-ImportHandler] 角色 "${dirname}" 迁移 ${entryCount} 条内嵌世界书进 beilu-worldbook（in-memory，绑定 "${dirname}"）`,
				)
			} else {
				// 插件未加载到 parts_set：直接落盘迁移（与链B磁盘 fallback 对称）。
				// 复用 beilu-worldbook 导出的 convertSTEntries，避免另写一份转换副本。
				const { convertSTEntries } = await import(
					'../../plugins/beilu-worldbook/main.mjs'
				)
				// [T074 per-user] 磁盘 fallback 也必须落到导入用户的 per-user 目录，
				//   与实现体 configFileFor(username)=data/users/<user>/worldbooks/config_data.json 同口径。
				//   旧行为写全局 plugins/beilu-worldbook/config_data.json → per-user 化后用户读不到（错位）。
				//   路径：SillyTavern/ 上 5 级到项目根（SillyTavern→ImportHandlers→parts→public→src→root）。
				const worldbookConfigPath = path.join(
					import.meta.dirname,
					'..', '..', '..', '..', '..',
					'data', 'users', username || '_default',
					'worldbooks',
					'config_data.json',
				)
				await fs.ensureDir(path.dirname(worldbookConfigPath))
				// T019：损坏→备份.corrupt.bak 后抛错中止，绝不空库顶上写回清空其他世界书。
				const worldbookData = await readJsonSafe(worldbookConfigPath, {
					active_worldbook: '',
					worldbooks: {},
				})
				if (
					!worldbookData.worldbooks ||
					typeof worldbookData.worldbooks !== 'object'
				) {
					worldbookData.worldbooks = {}
				}
				// 幂等：先清掉该 dirname 已绑定的世界书（与插件 removeByChar 同口径）
				for (const [wbName, wb] of Object.entries(
					worldbookData.worldbooks,
				)) {
					if (wb?.boundCharName === dirname) {
						delete worldbookData.worldbooks[wbName]
					}
				}
				const convertedEntries = convertSTEntries(charBook.entries)
				worldbookData.worldbooks[bookName] = {
					entries: convertedEntries,
					// 绑定书默认 enabled=false：靠 boundMatch(getAllEnabledEntries)私有注入到本角色；
					// enabled=true 会经 globalEnabled 泄漏进所有角色。
					enabled: false,
					boundCharName: dirname,
				}
				// S11纠察ISSUE-2修正：不强制覆盖active_worldbook（与in-memory路径对齐）
				await fs.writeFile(
					worldbookConfigPath,
					JSON.stringify(worldbookData, null, 2),
					'utf-8',
				)
				console.log(
					`[SillyTavern-ImportHandler] 角色 "${dirname}" 迁移 ${Object.keys(convertedEntries).length} 条内嵌世界书进 beilu-worldbook（磁盘 fallback，插件未加载，绑定 "${dirname}"）`,
				)
			}
		}
	} catch (e) {
		console.warn(
			`[SillyTavern-ImportHandler] 迁移角色 "${dirname}" 内嵌世界书进 beilu-worldbook 失败:`,
			e.message,
		)
	}

	// SEC（红方 round2，凛倾定"卡=外部导入给个提醒"）：不做字段中性化/信任降级（按设计卡作者=可信通道），
	//   但外部卡含作者可控的高优先级字段（system_prompt/mes_example/lorebook 等）会注入 AI 上下文，
	//   导入时打提醒标志（仿 MCP consent 范式），供前端弹"仅导入你信任来源的卡"（前端接收归后续）。
	console.warn(`[SEC][char-import] 用户 ${username} 导入外部角色卡 "${dirname}"：卡含作者可控高优先级字段（system_prompt 等），仅导入可信来源。`)
	const result = [`chars/${dirname}`]
	result.needsConsent = true
	result.consentMessage = '外部角色卡含作者可控的高优先级字段（system_prompt 等），将注入 AI 上下文。请仅导入你信任来源的卡。'
	return result
}

/**
 * 通过文本导入 SillyTavern 角色。
 * @param {string} username - 用户名。
 * @param {string} text - 包含角色 URL 的文本。
 * @returns {Promise<Array<string>>} - 导入的部分路径数组（partpath）。
 */
async function ImportByText(username, text) {
	const lines = text.split('\n').filter(line => line)
	const importedParts = []
	for (const line of lines)
		if (line.startsWith('http')) {
			const arrayBuffer = await downloadCharacter(line)
			const buffer = Buffer.from(arrayBuffer)
			importedParts.push(...await ImportAsData(username, buffer))
		}
	// 提醒标志在 spread 后会丢，这里补回（与 ImportAsData 同口径）
	if (importedParts.length) {
		importedParts.needsConsent = true
		importedParts.consentMessage = '外部角色卡含作者可控的高优先级字段（system_prompt 等），将注入 AI 上下文。请仅导入你信任来源的卡。'
	}
	return importedParts
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
		}
	}
}
