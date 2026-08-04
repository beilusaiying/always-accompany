import fs from 'node:fs'
import path from 'node:path'

import sanitize from 'npm:sanitize-filename'

import { loadJsonFile, loadJsonFileIfExists, saveJsonFile } from '../../../../../scripts/json_loader.mjs'
import { getUserDictionary } from '../../../../../yonban/core/functions/security/auth.mjs'
import { baseloadPart, getAllDefaultParts, getPartList, isPartLoaded, loadPart, notifyPartInstall, setDefaultPart, unloadPart, unsetDefaultPart } from '../../../../../server/parts_loader.mjs'
import { loadData, saveData } from '../../../../../server/setting_loader.mjs'
import { safeTrash, safeUnlink } from '../../../../../yonban/core/functions/rollback/safeDelete.mjs' // T026: AI源删除默认进回收站

/**
 * 确保服务源路径合法。
 * @param {string} serviceSourcePath - 服务源路径
 * @returns {string} - 规范化后的服务源路径
 */
function normalizeServiceSourcePath(serviceSourcePath) {
	if (!serviceSourcePath?.startsWith('serviceSources/'))
		throw new Error('serviceSourcePath must start with "serviceSources/".')
	return serviceSourcePath
}

export function normalizeServiceSourceFileName(fileName) {
	const requestedName = typeof fileName === 'string' ? fileName : ''
	const safeName = sanitize(requestedName)
	if (!safeName) throw new Error('Service source name must contain at least one valid filename character.')
	if (safeName !== requestedName)
		throw new Error('Service source name contains unsupported filename characters.')
	return safeName
}

/**
 * 构造部件根目录。
 * @param {string} username - 用户名
 * @param {string} serviceSourcePath - 服务源路径
 * @param {string} fileName - 部件名
 * @returns {string} - 拼接后的目录
 */
function getServiceSourceDir(username, serviceSourcePath, fileName) {
	const safePath = normalizeServiceSourcePath(serviceSourcePath)
	return path.join(getUserDictionary(username), safePath, normalizeServiceSourceFileName(fileName))
}

/**
 * 获取配置文件路径。
 * @param {string} baseDir - 部件根目录
 * @returns {string} - 配置文件路径
 */
function getConfigPath(baseDir) {
	return path.join(baseDir, 'config.json')
}

/**
 * 生成默认配置结构。
 * @returns {{generator: string, config: object}} - 默认配置
 */
function buildDefaultConfig() {
	return {
		generator: '',
		config: {}
	}
}

function cloneConfigData(data) {
	return JSON.parse(JSON.stringify(data))
}

function saveServiceSourcePartConfig(username, partpath, data) {
	const parts_config = loadData(username, 'parts_config')
	parts_config[partpath] = cloneConfigData(data)
	saveData(username, 'parts_config')
}

function restoreServiceSourcePartConfig(username, partpath, hadPrevious, previousData) {
	const parts_config = loadData(username, 'parts_config')
	if (hadPrevious) parts_config[partpath] = cloneConfigData(previousData)
	else delete parts_config[partpath]
	saveData(username, 'parts_config')
}

async function validateServiceSourceConfig(username, serviceSourcePath, data) {
	const manager = await loadPart(username, serviceSourcePath)
	const loader = manager?.interfaces?.serviceSourceType?.loadFromConfigData
	if (typeof loader !== 'function')
		throw new Error(`Service source manager "${serviceSourcePath}" cannot validate config data.`)
	// 使用真实构造链验证候选配置，但 SaveConfig 必须为空操作：验证阶段不能提前落盘。
	await loader(username, cloneConfigData(data), { SaveConfig: () => {} })
}

function readServiceSourceConfigOnDisk(username, fileName, serviceSourcePath) {
	const baseDir = getServiceSourceDir(username, serviceSourcePath, fileName)
	const configPath = getConfigPath(baseDir)
	if (!fs.existsSync(configPath)) return null
	// config.json 是服务源管理、setup-status 与运行时加载共同的配置真值。
	// 已存在但损坏时必须抛错，不能回退成空 generator 后再被 parts_config 覆盖回磁盘。
	return loadJsonFile(configPath)
}

/**
 * 仅判断「已写入、可被默认选择器安全加载」的最小结构，不访问第三方 API。
 * 连接是否可用由真正发送链报告；这里不能把目录、空壳或运行时 fallback 当成已配置。
 */
export function isUsableAIServiceSourceConfig(data) {
	if (!data || typeof data.generator !== 'string' || !data.generator.trim()) return false
	const config = data.config
	if (!config || typeof config !== 'object' || Array.isArray(config)) return false
	if (Array.isArray(config.sources) && config.sources.length > 0) return true
	if (config.base_source) return true
	const hasModel = typeof config.model === 'string' && config.model.trim().length > 0
	const hasEndpoint = ['url', 'base_url', 'host'].some((key) => typeof config[key] === 'string' && config[key].trim().length > 0)
	return hasModel && hasEndpoint
}

/**
 * 读取 AI 源的真实落盘状态。
 *
 * `configured` 仍严格表示「发送链可从默认选择器取得完整源」；但引导不能把
 * 「已保存可用源、缺默认绑定」错误说成「未配置」。因此同时返回全部可用源与
 * 精确状态，供 UI 给出正确的下一步，而不是猜测或静默回退。
 */
export function getAIServiceSourceSetupStatus(username) {
	const parent = 'serviceSources/AI'
	const sourceNames = getPartList(username, parent)
	const usableSourceNames = []
	const invalidSourceNames = []
	const sourceDataByName = new Map()
	for (const name of sourceNames) {
		const data = readServiceSourceConfigOnDisk(username, name, parent)
		sourceDataByName.set(name, data)
		if (isUsableAIServiceSourceConfig(data)) usableSourceNames.push(name)
		else invalidSourceNames.push(name)
	}
	const defaultSourceNames = getAllDefaultParts(username, parent)
	const usableDefaultNames = []
	const invalidDefaultNames = []
	for (const name of defaultSourceNames) {
		const data = sourceDataByName.get(name) ?? readServiceSourceConfigOnDisk(username, name, parent)
		if (isUsableAIServiceSourceConfig(data)) usableDefaultNames.push(name)
		else invalidDefaultNames.push(name)
	}
	const configured = usableDefaultNames.length > 0 && invalidDefaultNames.length === 0
	const status = configured
		? 'ready'
		: invalidDefaultNames.length > 0
			? 'invalid_default'
			: usableSourceNames.length > 0
				? 'default_missing'
				: sourceNames.length > 0
					? 'source_incomplete'
					: 'missing'
	// 唯一完整源时，缺默认或夹有失效默认项都可无歧义修复；多源绝不替用户猜选。
	const repairableDefaultSourceName = usableSourceNames.length === 1
		&& (usableDefaultNames.length === 0 || invalidDefaultNames.length > 0)
		? usableSourceNames[0]
		: null
	return {
		configured,
		status,
		sourceNames,
		usableSourceNames,
		invalidSourceNames,
		defaultSourceNames,
		usableDefaultNames,
		invalidDefaultNames,
		repairableDefaultSourceName,
	}
}

/**
 * 兼容旧配置：历史版本曾允许源已保存但没有默认绑定。
 *
 * 只在唯一完整源时补默认或清除失效默认项，不会覆盖多源用户的选择，也不从 GET 状态查询产生写副作用。
 */
export function repairSingleUsableDefaultAIServiceSource(username) {
	const before = getAIServiceSourceSetupStatus(username)
	if (!before.repairableDefaultSourceName) return { ...before, autoRepaired: false }
	const repairedDefaultSourceName = before.repairableDefaultSourceName
	for (const invalidName of before.invalidDefaultNames)
		unsetDefaultPart(username, 'serviceSources/AI', invalidName)
	if (before.usableDefaultNames.length === 0)
		setDefaultPart(username, 'serviceSources/AI', repairedDefaultSourceName)
	return { ...getAIServiceSourceSetupStatus(username), autoRepaired: true, repairedDefaultSourceName }
}

/**
 * 首次保存一个完整 AI 源时才建立默认绑定；已有可用默认源绝不被快速配置覆盖。
 * 先剔除默认列表里的空壳，避免运行时随机挑到「看似默认、实际不能生成」的源。
 */
export function ensureUsableDefaultAIServiceSource(username, fileName) {
	const statusBefore = getAIServiceSourceSetupStatus(username)
	for (const invalidName of statusBefore.invalidDefaultNames)
		unsetDefaultPart(username, 'serviceSources/AI', invalidName)
	const saved = readServiceSourceConfigOnDisk(username, fileName, 'serviceSources/AI')
	if (statusBefore.usableDefaultNames.length === 0 && isUsableAIServiceSourceConfig(saved))
		setDefaultPart(username, 'serviceSources/AI', normalizeServiceSourceFileName(fileName))
	return getAIServiceSourceSetupStatus(username)
}

export function serviceSourceExists(username, fileName, serviceSourcePath) {
	return fs.existsSync(getConfigPath(getServiceSourceDir(username, serviceSourcePath, fileName)))
}

/**
 * 为新部件创建必需的文件结构（beilu-part.json 与 main.mjs）。
 * @param {string} baseDir - 目标根目录
 * @param {string} serviceSourcePath - 服务源路径
 * @param {string} fileName - 部件名称
 * @returns {Promise<void>} - 写入完成
 */
async function createScaffold(baseDir, serviceSourcePath, fileName) {
	const normalizedServiceSourcePath = normalizeServiceSourcePath(serviceSourcePath)
	await fs.promises.mkdir(baseDir, { recursive: true })

	const beiluPartPath = path.join(baseDir, 'beilu-part.json')
	if (!fs.existsSync(beiluPartPath))
		saveJsonFile(beiluPartPath, {
			type: normalizedServiceSourcePath,
			dirname: fileName,
			configContract: 'state'
		})

	const mainPath = path.join(baseDir, 'main.mjs')
	if (!fs.existsSync(mainPath)) {
		const mainContent = `\
import path from 'node:path'

import { loadJsonFileIfExists, saveJsonFile } from '@beilu/scripts/json_loader.mjs'
import { loadPart } from '@beilu/server/parts_loader.mjs'
import { loadData, saveData } from '@beilu/server/setting_loader.mjs'

const configPath = import.meta.dirname + '/config.json'

function setPartData(username, partpath, data) {
	const parts_config = loadData(username, 'parts_config')
	parts_config[partpath] = { ...data }
	saveData(username, 'parts_config')
}

const data = loadJsonFileIfExists(configPath, { generator: '', config: {} })
const defaultInterfaces = {
	config: {
		/**
		 * 获取配置数据。
		 * @returns {Promise<any>} - 配置数据。
		 */
		async GetData() {
			return data
		},
		/**
		 * 设置配置数据。
		 * @param {any} data - 要设置的配置数据。
		 * @returns {Promise<void>}
		 */
		async SetData(new_data) {
			if (new_data !== data) {
				// {} 表示生命周期镜像尚未建立，不覆盖 config.json 真值；一旦字段明确出现，
				// 则连空值也必须应用，事务回滚才能从候选 generator 恢复到旧草稿状态。
				if (Object.hasOwn(new_data, 'generator')) data.generator = new_data.generator
				if (Object.hasOwn(new_data, 'config')) { // 保持config对象不变，确保saveConfig有效
					for (const key in data.config ??= {}) delete data.config[key]
					Object.assign(data.config, new_data.config ?? {})
				}
			}
			saveJsonFile(configPath, data)
		},
		/**
		 * 获取配置显示内容。
		 * @returns {Promise<{ html: string, js: string }>} - 显示内容。
		 */
		async GetConfigDisplayContent() {
			return { html: '', js: '' }
		}
	}
}

const my_name = path.basename(import.meta.dirname)

export default {
	filename: my_name,
	async Load({ username }) {
		const manager = await loadPart(username, '${normalizedServiceSourcePath}')
		Object.assign(this, await manager.interfaces.serviceSourceType.loadFromConfigData(username, data, {
			// generator 运行期若更新 config，只能从这里同时提交主文件与生命周期镜像。
			SaveConfig: () => {
				saveJsonFile(configPath, data)
				setPartData(username, \`${normalizedServiceSourcePath}/\${my_name}\`, data)
			}
		}))
		Object.assign(this.interfaces, defaultInterfaces)
	},
	interfaces: defaultInterfaces
}
`
		await fs.promises.writeFile(mainPath, mainContent)
	}
	else {
		// 用户数据目录不在仓库内；旧脚手架用相对 ../../src 导入会把它解析到用户目录，
		// 导致「文件已保存、首次加载 500」。只迁移三条本脚手架特征导入，不覆盖用户自定义 main.mjs。
		const previous = await fs.promises.readFile(mainPath, 'utf8')
		const migrated = previous
			.replace("from '../../../../../../src/scripts/json_loader.mjs'", "from '@beilu/scripts/json_loader.mjs'")
			.replace("from '../../../../../../src/server/parts_loader.mjs'", "from '@beilu/server/parts_loader.mjs'")
			.replace("from '../../../../../../src/server/setting_loader.mjs'", "from '@beilu/server/setting_loader.mjs'")
			// 旧脚手架的 generator.SaveConfig 只写 parts_config，会让 config.json 与运行时镜像分叉。
			// 只替换本项目生成器的精确形态，不覆盖用户自定义保存实现。
			.replace(
				/SaveConfig: \(\) => setPartData\(username, (`[^`]+`), data\)/,
				'SaveConfig: () => { saveJsonFile(configPath, data); setPartData(username, $1, data) }'
			)
			// 旧脚手架只接受 truthy generator/config，事务回滚无法恢复空值。仅迁移精确生成模板。
			.replace(
				/if \(new_data\.generator\) data\.generator = new_data\.generator\s+if \(new_data\.config\) \{ \/\/ 保持config对象不变，确保saveConfig有效\s+for \(const key in data\.config \?\?= \{\}\) delete data\.config\[key\]\s+Object\.assign\(data\.config, new_data\.config\)\s+\}/,
				`if (Object.hasOwn(new_data, 'generator')) data.generator = new_data.generator
				if (Object.hasOwn(new_data, 'config')) { // 保持config对象不变，确保saveConfig有效
					for (const key in data.config ??= {}) delete data.config[key]
					Object.assign(data.config, new_data.config ?? {})
				}`
			)
		if (migrated !== previous) await fs.promises.writeFile(mainPath, migrated)
	}
}

/**
 * 读取服务源配置。
 * @param {string} username - 用户名
 * @param {string} fileName - 文件名
 * @param {string} serviceSourcePath - 服务源路径
 * @returns {Promise<object>} - 服务源文件内容
 */
export async function getServiceSourceFile(username, fileName, serviceSourcePath) {
	const normalizedServicePath = normalizeServiceSourcePath(serviceSourcePath)
	const baseDir = getServiceSourceDir(username, normalizedServicePath, fileName)
	const configPath = getConfigPath(baseDir)

	// 管理读取不能为了展示一个损坏/未完成配置而先装载运行时部件；
	// 否则空 generator 的运行时失败会把用户锁死在无法修复配置的 500 页面。
	if (!fs.existsSync(configPath)) return buildDefaultConfig()
	return loadJsonFile(configPath)
}

/**
 * 从服务源路径推断生成器路径。
 * @param {string} serviceSourcePath - 服务源路径（如 'serviceSources/AI'）。
 * @returns {string} - 推断的生成器路径。
 */
function inferGeneratorPath(serviceSourcePath) {
	const segments = serviceSourcePath.split('/').filter(Boolean)
	const type = segments[segments.length - 1] || 'AI'
	return `serviceGenerators/${type}`
}

// 同一用户同一服务源的保存必须串行；否则两个“各自可回滚”的事务交错后，
// 较早请求的失败回滚仍可能覆盖较晚请求已提交的真值。
const serviceSourceSaveInflight = new Map()

/**
 * 保存服务源配置。
 * @param {string} username - 用户名
 * @param {string} fileName - 文件名
 * @param {object} data - 数据
 * @param {string} serviceSourcePath - 服务源路径
 * @returns {Promise<void>}
 */
async function saveServiceSourceFileTransaction(username, fileName, data, serviceSourcePath) {
	const normalizedServicePath = normalizeServiceSourcePath(serviceSourcePath)
	const baseDir = getServiceSourceDir(username, normalizedServicePath, fileName)
	const safeFileName = normalizeServiceSourceFileName(fileName)
	const partpath = `${normalizedServicePath}/${safeFileName}`
	const configPath = getConfigPath(baseDir)
	const mainPath = path.join(baseDir, 'main.mjs')
	const beiluPartPath = path.join(baseDir, 'beilu-part.json')
	const baseDirExisted = fs.existsSync(baseDir)
	const configExisted = fs.existsSync(configPath)
	const mainExisted = fs.existsSync(mainPath)
	const beiluPartExisted = fs.existsSync(beiluPartPath)
	const existingOnDisk = configExisted ? loadJsonFile(configPath) : buildDefaultConfig()
	const dataToSave = { ...existingOnDisk, ...data }
	const partsConfig = loadData(username, 'parts_config')
	const hadPreviousPartConfig = Object.hasOwn(partsConfig, partpath)
	const previousPartConfig = hadPreviousPartConfig ? cloneConfigData(partsConfig[partpath]) : undefined
	const partsInit = loadData(username, 'parts_init')
	const hadPreviousPartInit = Object.hasOwn(partsInit, partpath)
	const previousPartInit = hadPreviousPartInit ? cloneConfigData(partsInit[partpath]) : undefined
	const wasLoaded = isPartLoaded(username, partpath)

	// 先走与运行时相同的 manager → generator → GetSource 构造链。候选无效时不碰双存储和旧实例。
	await validateServiceSourceConfig(username, normalizedServicePath, dataToSave)

	let partModule
	let mutationStarted = false
	try {
		mutationStarted = true
		await createScaffold(baseDir, normalizedServicePath, safeFileName)
		// 配置 owner 一次提交主文件与生命周期镜像，再允许 Part 读取。禁止先 loadPart 让旧
		// parts_config 经框架 SetData 覆盖刚写的 config.json，之后再二次补写的竞态窗口。
		saveJsonFile(configPath, dataToSave)
		saveServiceSourcePartConfig(username, partpath, dataToSave)

		// Deno 的 ESM import 有模块缓存，unloadPart 不会重新执行 main.mjs 顶层读取。
		// 完整 Load 前显式更新脚手架闭包真值，然后只重跑一次完整生命周期。
		partModule = await baseloadPart(username, partpath)
		await partModule.interfaces.config.SetData(dataToSave)
		if (isPartLoaded(username, partpath)) await unloadPart(username, partpath)
		await loadPart(username, partpath)
	}
	catch (saveError) {
		if (!mutationStarted) throw saveError
		const rollbackErrors = []
		// 不保留可能已由候选配置构造出的实例；旧实例原先存在时在恢复数据后重新装载。
		try {
			if (isPartLoaded(username, partpath)) await unloadPart(username, partpath)
		}
		catch (error) { rollbackErrors.push(error) }
		try {
			// scaffold 若在 main.mjs 创建前就失败，没有模块 DTO 需要恢复，也不能为了回滚再制造一次加载错误。
			if (partModule || fs.existsSync(mainPath)) {
				partModule ??= await baseloadPart(username, partpath)
				await partModule.interfaces.config.SetData(configExisted ? existingOnDisk : buildDefaultConfig())
			}
		}
		catch (error) { rollbackErrors.push(error) }
		try {
			if (configExisted) saveJsonFile(configPath, existingOnDisk)
			restoreServiceSourcePartConfig(username, partpath, hadPreviousPartConfig, previousPartConfig)
			const currentPartsInit = loadData(username, 'parts_init')
			if (hadPreviousPartInit) currentPartsInit[partpath] = cloneConfigData(previousPartInit)
			else delete currentPartsInit[partpath]
			saveData(username, 'parts_init')
		}
		catch (error) { rollbackErrors.push(error) }
		if (wasLoaded) {
			try { await loadPart(username, partpath) }
			catch (error) { rollbackErrors.push(error) }
		}
		try {
			if (!baseDirExisted && fs.existsSync(baseDir)) {
				if (fs.lstatSync(baseDir).isSymbolicLink())
					throw new Error(`Refusing to recursively remove symlink during service source rollback: ${baseDir}`)
				const result = await safeTrash(baseDir, `service-source-save-rollback-${safeFileName}`)
				if (!result.success) throw new Error(result.error || `Failed to remove new service source directory: ${baseDir}`)
			}
			else if (baseDirExisted) {
				for (const [existed, filePath] of [[configExisted, configPath], [mainExisted, mainPath], [beiluPartExisted, beiluPartPath]]) {
					if (existed || !fs.existsSync(filePath)) continue
					const result = await safeUnlink(filePath, `service-source-save-rollback-${safeFileName}`)
					if (!result.success) throw new Error(result.error || `Failed to remove transaction-created file: ${filePath}`)
				}
			}
		}
		catch (error) { rollbackErrors.push(error) }
		if (rollbackErrors.length) {
			const error = new AggregateError(rollbackErrors, `Service source save failed and rollback was incomplete: ${saveError?.message || saveError}`)
			error.code = 'E_SERVICE_SOURCE_SAVE_ROLLBACK_FAILED'
			error.cause = saveError
			throw error
		}
		throw saveError
	}
}

export async function saveServiceSourceFile(username, fileName, data, serviceSourcePath) {
	const normalizedServicePath = normalizeServiceSourcePath(serviceSourcePath)
	const lockKey = `${username}\0${normalizedServicePath}\0${normalizeServiceSourceFileName(fileName)}`
	const dataSnapshot = cloneConfigData(data)
	const previous = serviceSourceSaveInflight.get(lockKey) ?? Promise.resolve()
	const current = previous
		.catch(() => {})
		.then(() => saveServiceSourceFileTransaction(username, fileName, dataSnapshot, normalizedServicePath))
	serviceSourceSaveInflight.set(lockKey, current)
	try {
		return await current
	}
	finally {
		if (serviceSourceSaveInflight.get(lockKey) === current)
			serviceSourceSaveInflight.delete(lockKey)
	}
}

/**
 * 添加服务源部件。
 * @param {string} username - 用户名
 * @param {string} fileName - 文件名
 * @param {string} serviceSourcePath - 服务源路径
 * @returns {Promise<void>}
 */
export async function addServiceSourceFile(username, fileName, serviceSourcePath) {
	const normalizedServicePath = normalizeServiceSourcePath(serviceSourcePath)
	const baseDir = getServiceSourceDir(username, normalizedServicePath, fileName)
	const partpath = `${normalizedServicePath}/${normalizeServiceSourceFileName(fileName)}`

	// 创建文件结构
	await createScaffold(baseDir, normalizedServicePath, fileName)

	// 仅创建可编辑草稿，不加载无 generator 的运行时 Part，也不把空壳写入 parts_config。
	// 真正可运行的首次创建必须走 saveServiceSourceFile，一次提交 generator + config。
	const configPath = getConfigPath(baseDir)
	if (!fs.existsSync(configPath)) saveJsonFile(configPath, buildDefaultConfig())
	notifyPartInstall(username, partpath)
}

/**
 * 删除服务源部件。
 * @param {string} username - 用户名
 * @param {string} fileName - 文件名
 * @param {string} serviceSourcePath - 服务源路径
 * @returns {Promise<void>}
 */
export async function deleteServiceSourceFile(username, fileName, serviceSourcePath, mode = 'trash') {
	const baseDir = getServiceSourceDir(username, serviceSourcePath, fileName)
	const partpath = `${normalizeServiceSourcePath(serviceSourcePath)}/${normalizeServiceSourceFileName(fileName)}`
	// 内存 owner 必须先确认卸载成功；失败时保留默认绑定、配置和目录，禁止形成“盘已删、旧实例仍服务”的分叉。
	if (isPartLoaded(username, partpath)) {
		try { await unloadPart(username, partpath) }
		catch (cause) {
			const error = new Error(`删除 API 源 ${fileName} 前无法安全卸载运行实例`)
			error.code = 'E_SERVICE_SOURCE_UNLOAD_FAILED'
			error.partpath = partpath
			error.retryable = cause?.code === 'E_PART_UNLOAD_TIMEOUT'
			Object.defineProperty(error, 'cause', { value: cause, enumerable: false })
			throw error
		}
	}
	// [2026-08-01 严重bug修·删源三漏]（扫描报告 严重bug扫描_20260801_0340/scan_lifecycle_缓存陈旧.md 高#3）：
	// ② 清 parts_config 残留——permanent 模式对用户宣称"防留痕"，但 apikey 等整套 config 副本
	//   留在 settings/parts_config.json（saveServiceSourceFile:204-206 写入的），必须一并删除。
	const parts_config = loadData(username, 'parts_config')
	const hadPartConfig = Object.hasOwn(parts_config, partpath)
	const previousPartConfig = hadPartConfig ? cloneConfigData(parts_config[partpath]) : undefined
	try {
		if (hadPartConfig) { delete parts_config[partpath]; saveData(username, 'parts_config') }
	} catch (cause) {
		if (hadPartConfig) parts_config[partpath] = previousPartConfig
		const error = new Error(`删除 API 源 ${fileName} 时无法清理生命周期配置`)
		error.code = 'E_SERVICE_SOURCE_CONFIG_CLEANUP_FAILED'
		error.partpath = partpath
		Object.defineProperty(error, 'cause', { value: cause, enumerable: false })
		throw error
	}
	// 默认列表是运行时随机选择器的输入；仅在实例卸载与配置清理均确认成功后解除。
	unsetDefaultPart(username, normalizeServiceSourcePath(serviceSourcePath), normalizeServiceSourceFileName(fileName))
	if (!fs.existsSync(baseDir)) return
	// T026 凛倾原话：「询问用户是否让api等的数据进回收站还是说直接完全删除，防止留痕」
	// 默认 trash=进系统回收站（safeTrash 失败自带 _trash_fallback 兜底，绝不静默硬删）；
	// permanent=彻底删（防留痕，用户在前端弹窗显式选择后才走这里）。
	if (mode === 'permanent') {
		await fs.promises.rm(baseDir, { recursive: true, force: true })
		return
	}
	const r = await safeTrash(baseDir, `aisource_${fileName}`)
	if (!r?.success) throw new Error(`移入回收站失败: ${r?.error || '未知错误'}`)
}

/**
 * 获取配置模板。
 * @param {string} username - 用户名
 * @param {string} generatorname - 生成器名称
 * @param {string} serviceSourcePath - 服务源路径
 * @returns {Promise<object>} - 配置模板
 */
export async function getConfigTemplate(username, generatorname, serviceSourcePath) {
	if (!generatorname) return {}
	const generatorPath = inferGeneratorPath(serviceSourcePath)
	const generator = await loadPart(username, `${generatorPath}/${generatorname}`)
	return await generator.interfaces.serviceGenerator.GetConfigTemplate()
}

/**
 * 获取渠道元数据（provider 枚举 + label/默认URL/坑提示），供前端渠道下拉构建。
 * 单源=proxy 生成器的 apiAdapters（GetProviderMeta 接口）；gemini/ollama 两个非 proxy 生成器的
 * 默认地址取各自 GetConfigTemplate（同为生成器单源），本层只转发不定义任何 URL/文案。
 * @param {string} username - 用户名
 * @param {string} serviceSourcePath - 服务源路径
 * @returns {Promise<{enum: string[], meta: object, generators: object}>}
 */
export async function getProviderMeta(username, serviceSourcePath) {
	const generatorPath = inferGeneratorPath(serviceSourcePath)
	const proxy = await loadPart(username, `${generatorPath}/proxy`)
	const pm = await proxy.interfaces.serviceGenerator.GetProviderMeta?.() ?? { enum: [], meta: {} }
	const generators = {}
	for (const g of ['gemini', 'ollama']) {
		try {
			const t = await (await loadPart(username, `${generatorPath}/${g}`)).interfaces.serviceGenerator.GetConfigTemplate()
			// gemini 模板字段=base_url，ollama=host；取不到=回填空（前端「恢复默认」填空可见，不阻塞渠道表）
			generators[g] = { defaultUrl: t?.base_url ?? t?.host ?? '' }
		} catch (err) {
			generators[g] = { defaultUrl: '', error: String(err?.message || err) }
		}
	}
	return { ...pm, generators }
}

/**
 * 获取配置显示。
 * @param {string} username - 用户名
 * @param {string} generatorname - 生成器名称
 * @param {string} serviceSourcePath - 服务源路径
 * @returns {Promise<object>} - 配置显示
 */
export async function getConfigDisplay(username, generatorname, serviceSourcePath) {
	if (!generatorname) return { html: '', js: '' }
	const generatorPath = inferGeneratorPath(serviceSourcePath)
	const generator = await loadPart(username, `${generatorPath}/${generatorname}`)
	return await generator.interfaces.serviceGenerator?.GetConfigDisplayContent?.() || { html: '', js: '' }
}
