import fs from 'node:fs'
import path from 'node:path'

import sanitize from 'npm:sanitize-filename'

import { saveJsonFile } from '../../../../../scripts/json_loader.mjs'
import { getUserDictionary } from '../../../../../yonban/core/functions/security/auth.mjs'
import { initPart, isPartLoaded, loadPart } from '../../../../../server/parts_loader.mjs'
import { loadData, saveData } from '../../../../../server/setting_loader.mjs'
import { safeTrash } from '../../../../../yonban/core/functions/rollback/safeDelete.mjs' // T026: AI源删除默认进回收站

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

/**
 * 构造部件根目录。
 * @param {string} username - 用户名
 * @param {string} serviceSourcePath - 服务源路径
 * @param {string} fileName - 部件名
 * @returns {string} - 拼接后的目录
 */
function getServiceSourceDir(username, serviceSourcePath, fileName) {
	const safePath = normalizeServiceSourcePath(serviceSourcePath)
	return path.join(getUserDictionary(username), safePath, sanitize(fileName))
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
			dirname: fileName
		})

	const mainPath = path.join(baseDir, 'main.mjs')
	if (!fs.existsSync(mainPath)) {
		const mainContent = `\
import path from 'node:path'

import { loadJsonFileIfExists, saveJsonFile } from '../../../../../../src/scripts/json_loader.mjs'
import { loadPart } from '../../../../../../src/server/parts_loader.mjs'
import { loadData, saveData } from '../../../../../../src/server/setting_loader.mjs'

function setPartData(username, partpath, data) {
	const parts_config = loadData(username, 'parts_config')
	parts_config[partpath] = { ...data }
	saveData(username, 'parts_config')
}

const configPath = import.meta.dirname + '/config.json'
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
				if (new_data.generator) data.generator = new_data.generator
				if (new_data.config) { // 保持config对象不变，确保saveConfig有效
					for (const key in data.config ??= {}) delete data.config[key]
					Object.assign(data.config, new_data.config)
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
			SaveConfig: () => setPartData(username, \`${normalizedServiceSourcePath}/\${my_name}\`, data)
		}))
		Object.assign(this.interfaces, defaultInterfaces)
	},
	interfaces: defaultInterfaces
}
`
		await fs.promises.writeFile(mainPath, mainContent)
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
	const partpath = `${normalizedServicePath}/${sanitize(fileName)}`
	const baseDir = getServiceSourceDir(username, normalizedServicePath, fileName)
	const configPath = getConfigPath(baseDir)

	// 如果文件不存在，返回默认配置
	if (!fs.existsSync(configPath))
		return buildDefaultConfig()


	// 加载part并通过GetData获取数据
	const part = await loadPart(username, partpath)
	const data = await part.interfaces.config.GetData()
	return data
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

/**
 * 保存服务源配置。
 * @param {string} username - 用户名
 * @param {string} fileName - 文件名
 * @param {object} data - 数据
 * @param {string} serviceSourcePath - 服务源路径
 * @returns {Promise<void>}
 */
export async function saveServiceSourceFile(username, fileName, data, serviceSourcePath) {
	const normalizedServicePath = normalizeServiceSourcePath(serviceSourcePath)
	const baseDir = getServiceSourceDir(username, normalizedServicePath, fileName)
	const partpath = `${normalizedServicePath}/${sanitize(fileName)}`

	// 确保文件结构存在（如果不存在则创建）
	await createScaffold(baseDir, normalizedServicePath, fileName)

	// 加载现有数据以进行合并
	const part = await loadPart(username, partpath)
	const existingData = await part.interfaces.config.GetData()

	// 准备要保存的数据，合并现有数据
	const dataToSave = { ...existingData, ...data }

	// 通过part的SetData接口保存数据
	await part.interfaces.config.SetData(dataToSave)

	// 更新parts_config
	const parts_config = loadData(username, 'parts_config')
	parts_config[partpath] = { ...dataToSave }
	saveData(username, 'parts_config')

	if (isPartLoaded(username, partpath)) await initPart(username, partpath)
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
	const partpath = `${normalizedServicePath}/${sanitize(fileName)}`

	// 创建文件结构
	await createScaffold(baseDir, normalizedServicePath, fileName)

	// 准备初始数据
	const initialData = buildDefaultConfig()

	// 通过part的SetData接口设置初始数据
	const part = await loadPart(username, partpath)
	await part.interfaces.config.SetData(initialData)

	// 更新parts_config
	const parts_config = loadData(username, 'parts_config')
	parts_config[partpath] = { ...initialData }
	saveData(username, 'parts_config')
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
