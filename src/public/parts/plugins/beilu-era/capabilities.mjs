/**
 * capabilities.mjs — ERA 能力谱装配（凛倾 0731「你在用硬编码」终返工：代码零内容）。
 *
 * 分家铁则：
 *   【内容】（字符/颜色/文案模板/参照词表/房型档/地形/方位字——一切用户创作观感值）
 *     唯一家=数据文件：出厂模板 plugins/beilu-era/defaults/era_config.default.json（照
 *     default_memory_presets.json 先例：内容住数据资产，代码只搬运）；用户覆盖层
 *     <dataRoot>/era_config.json；AI 还可在 era-map 拓扑里 inline 覆盖（palette/terrain 等）。
 *   【机制】（网格几何域/层开关/渲染模式/动效开关/超时——结构参数）住本文件常量。
 *
 * 合并链（键级深合并）：机制骨架 ← 出厂内容模板(插件目录自锚) ← data/era_config.json ← per-user config。
 * 任何消费方（era_pipeline.py / eraRenderer.mjs / main.mjs）零本地内容副本。
 */
import fs from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 出厂内容模板路径（同目录 defaults/）。 */
const DEFAULTS_FILE = join(dirname(fileURLToPath(import.meta.url)), 'defaults', 'era_config.default.json')

/**
 * ERA 机制骨架（仅结构参数，零内容值——内容见 DEFAULTS_FILE 数据模板）。
 * @type {object}
 */
export const ERA_CAPABILITIES = {
	// 地图格子域：w×h 基准网格；margin=占位安全隙；corridorGap=房间走廊距；
	// autoGrow=按需求面积确定性放大（上限 maxW×maxH）；maxFloors=楼层上限（3轴 z 域）
	grid: { w: 56, h: 30, margin: 1, corridorGap: 2, autoGrow: true, maxW: 140, maxH: 70, maxFloors: 8 },

	// 三渲染层独立开关（地图/人物/动态）
	layers: { map: true, char: true, dyn: true },

	// 渲染模式与参数：mode='grid'|'ascii'；roadWidth=道路带宽（格）
	render: { mode: 'grid', cellPx: 14, labelRooms: true, roadWidth: 2 },

	// 地形纹理层机制开关（内容=chars/color 全在数据模板/AI inline）
	terrain: { enabled: true, bandWidth: 4 },

	// 方位标注机制开关（方位字在数据模板）
	compass: { enabled: true },

	// 动态效果开关
	dynEffects: { enabled: true, glow: true, flicker: true, pulse: true, respectReducedMotion: true },

	// 容错：未知 patch op 跳过记 errors
	fallback: { unknownOpSkip: true },

	// python 管线调用（cmd 空=按系统自动；照 beilu-ppt pythonCmd 范式）
	python: { cmd: '', timeoutMs: 20000 },

	// 内容键占位（空——由数据模板/覆盖层填充；消费方缺值=诚实降级不画）
	roomSizes: {},
	palette: {},
	symbols: {},
	charset: {},
	placement: {},
	prompt: {},
}

function _readJsonSafe(file) {
	try {
		if (fs.existsSync(file)) {
			const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
		}
	} catch (e) {
		console.warn('[beilu-era] 读取失败:', file, e.message)
	}
	return {}
}

/**
 * 读全局 ERA 能力谱：机制骨架 ← 出厂内容模板(zh 原文基准) ← 语言差量层 ← <dataRoot>/era_config.json。
 * 多语言照 beilu 覆盖式 i18n 定案（中文原文默认，外语=差量覆盖；terrain/placement 键为增补
 * 并集共存——AI 用任何语言的词都命中）。语言差量文件=defaults/era_config.lang.<lang>.json（纯数据）。
 * 惰性读文件(函数体内)，顶层零调用——避开 TDZ(禁止项16)。
 * @param {string} dataRoot - 数据根（core.eraDataRoot()）
 * @param {string} [lang] - 语言码（如 'en-UK'/'ja-JP'；缺省/zh 系=原文基准零差量）
 * @returns {object}
 */
export function loadEraCapabilities(dataRoot, lang) {
	let caps = _deepMerge(ERA_CAPABILITIES, _readJsonSafe(DEFAULTS_FILE))
	const globalOverride = _readJsonSafe(join(dataRoot, 'era_config.json'))
	// 语言层：入参 > data 覆盖层 lang 键；仅语言码白名单字符防路径注入
	const effLang = String(lang || globalOverride.lang || '')
	if (effLang && /^[A-Za-z-]+$/.test(effLang) && !/^zh/i.test(effLang)) {
		caps = _deepMerge(caps, _readJsonSafe(join(dirname(DEFAULTS_FILE), `era_config.lang.${effLang}.json`)))
	}
	caps = _deepMerge(caps, globalOverride)
	return caps
}

/**
 * era 私有键级深合并：普通对象递归合并；数组/原始值整体替换。
 * @param {object} base
 * @param {object} override
 * @returns {object} 新对象（两入参均不被 mutate）
 */
function _deepMerge(base, override) {
	if (!override || typeof override !== 'object' || Array.isArray(override)) return base
	const out = Array.isArray(base) ? [...base] : { ...base }
	for (const k of Object.keys(override)) {
		if (k.startsWith('_')) continue // 数据模板注释键（_说明）不进谱
		const bv = out[k]
		const ov = override[k]
		if (bv && ov && typeof bv === 'object' && typeof ov === 'object' && !Array.isArray(bv) && !Array.isArray(ov)) {
			out[k] = _deepMerge(bv, ov)
		} else {
			out[k] = ov
		}
	}
	return out
}

/**
 * 解析某 user 的【有效 era 能力谱】= 全局谱 深merge 个人覆盖层。
 * @param {string} dataRoot - 数据根（core.eraDataRoot()）
 * @param {object} [userConfig] - per-user 差异键（main.mjs getStore(user).config）
 * @returns {object}
 */
export function resolveEffectiveEra(dataRoot, userConfig) {
	const global = loadEraCapabilities(dataRoot)
	return _deepMerge(global, userConfig || {})
}
