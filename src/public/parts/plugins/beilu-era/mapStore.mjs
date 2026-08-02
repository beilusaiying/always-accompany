/**
 * mapStore.mjs — ERA 地图【只读侧】（凛倾 0731「改python,重写管线」后的分工）：
 *   写侧（布局/patch/落盘/摘要）唯一权威 = plugins/beilu-era/py/era_pipeline.py（经 core.mjs 桥调用）。
 *   本文件只剩读盘：GetRenderView（main.mjs）消费 loadMap/getActiveId/listMapIds。
 *
 * 契约（与 python 写侧逐字对齐，勿单侧改）：
 *   <eraDir>/maps/<encodeURIComponent(id)>.json（python 侧 quote safe 集 -_.!~*'() 与 JS 一致）
 *   <eraDir>/_active.json {"mapId"}
 * 路径单源：core.eraDirFor（era 域自锚，零跨域 import——凛倾 0731 高耦合裁决）。
 */
import fs from 'node:fs'
import { join } from 'node:path'
import { eraDirFor } from './core.mjs'

function _eraDir(username, charName) {
	return eraDirFor(username, charName)
}

function _readJson(file) {
	try {
		if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'))
	} catch (e) {
		console.warn('[beilu-era] 读取失败:', file, e.message)
	}
	return null
}

/** 读取地图。@returns {object|null} */
export function loadMap(username, charName, id) {
	if (!id) return null
	return _readJson(join(_eraDir(username, charName), 'maps', encodeURIComponent(String(id)) + '.json'))
}

/** 列出全部地图 id（解码回原名）。@returns {string[]} */
export function listMapIds(username, charName) {
	try {
		return fs.readdirSync(join(_eraDir(username, charName), 'maps'))
			.filter((f) => f.endsWith('.json'))
			.map((f) => decodeURIComponent(f.slice(0, -5)))
	} catch { return [] }
}

/** 当前激活地图 id。@returns {string|null} */
export function getActiveId(username, charName) {
	const data = _readJson(join(_eraDir(username, charName), '_active.json'))
	return (data && typeof data.mapId === 'string' && data.mapId) || null
}
