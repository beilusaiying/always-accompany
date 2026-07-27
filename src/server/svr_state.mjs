/**
 * svr_state.mjs — 服务器环境态叶子（0722 启动大环解环拆出）。
 *
 * 【为什么拆】config/data_path/save_config/restartor/skip_report/setDefaultStuff 原住 server.mjs
 *   （编排者），下层模块（ratelimit/timers/jobs/auth/parts_loader）要环境态就得 import 编排者——
 *   把 11 成员启动环焊死。环境态与编排解耦：本文件只持状态与其读写，不 import 任何环成员；
 *   server.mjs init() 经 _initServerState/loadServerConfig 装配，并 re-export 本文件保环外兼容面。
 * 【铁律】本文件禁止 import server/parts_loader/auth/jobs/timers 等启动链模块
 *   （允许：base/info/json_loader/i18n_core 叶子与 npm/node 内建）；tests/check_import_cycles.mjs 守卫。
 * 【功能链】index.mjs→server.init()→_initServerState+loadServerConfig 装配 → 全后端读 config/save_config。
 */
import fs from 'node:fs'
import process from 'node:process'

import supportsAnsi from 'npm:supports-ansi'

import { console } from '../scripts/i18n_core.mjs'
import { loadJsonFile, saveJsonFile } from '../scripts/json_loader.mjs'

import { __dirname } from './base.mjs'
import { info } from './info.mjs'

/**
 * 应用程序数据目录的路径。
 * @type {string}
 */
export let data_path

/**
 * 应用程序的配置，从 `config.json` 加载。
 * @type {object}
 */
export let config

/**
 * 重启应用程序的函数。
 * @type {Function}
 */
export let restartor

/**
 * init() 装配入口：进程启动参数注入环境态（仅 server.mjs init 调用）。
 * @param {{data_path: string, restartor: Function}} p
 */
export function _initServerState({ data_path: dp, restartor: r }) {
	data_path = dp
	restartor = r
}

/**
 * 配置 schema 自愈:老用户 config 缺新版本引入的键 → 从默认配置补齐(仅补"键不存在",
 * 不碰用户已有值——null 也是用户值,用 in 判缺不用真值判)。对象递归下钻,数组当叶子。
 * why:此前无此机制,新键全靠各消费点散兜底,漏兜=运行期 undefined(2026-07-19 对照酒馆
 * post-install addMissingConfigValues 补上)。
 * @param {object} target - 用户配置(就地补)。
 * @param {object} defaults - 默认配置。
 * @returns {boolean} 是否发生了补键。
 */
function fillMissingConfigKeys(target, defaults) {
	let changed = false
	for (const key of Object.keys(defaults)) {
		if (!(key in target)) {
			target[key] = structuredClone(defaults[key])
			changed = true
		}
		else if (
			target[key] && typeof target[key] === 'object' && !Array.isArray(target[key]) &&
			defaults[key] && typeof defaults[key] === 'object' && !Array.isArray(defaults[key])
		)
			if (fillMissingConfigKeys(target[key], defaults[key])) changed = true
	}
	return changed
}

/**
 * 确保配置文件存在（不存在则从默认配置创建）并加载进 config live binding（仅 init 调用一次）。
 * @returns {object} 加载的配置对象。
 */
export function loadServerConfig() {
	if (!fs.existsSync(data_path + '/config.json')) {
		try { fs.mkdirSync(data_path, { recursive: true }) } catch (e) { console.error("[server] data 目录创建失败:", data_path, e.message); }
		fs.copyFileSync(__dirname + '/default/config.json', data_path + '/config.json')
	}

	const loaded = loadJsonFile(data_path + '/config.json')
	try {
		const defaults = loadJsonFile(__dirname + '/default/config.json')
		if (fillMissingConfigKeys(loaded, defaults)) {
			saveJsonFile(data_path + '/config.json', loaded)
			console.log('[server] 配置自愈:已补齐新版本默认键(用户已有值未动)')
		}
	} catch (e) { console.warn('[server] 配置自愈跳过(默认配置读取失败):', e.message) }
	config = loaded
	return config
}

/**
 * 将当前配置对象保存到其文件。
 * @returns {void}
 */
export function save_config() {
	saveJsonFile(data_path + '/config.json', config)
}

/**
 * 标记一个错误对象以便跳过报告。
 * @param {Error} err - 错误对象。
 * @returns {Error} 修改后的错误对象。
 */
export function skip_report(err) {
	err.skip_report = true
	return err
}

/**
 * 设置终端窗口的标题。
 * @param {string} title - 窗口的期望标题。
 */
export function setWindowTitle(title) {
	if (supportsAnsi && process.stdout.writable) process.stdout.write(`\x1b]2;${title}\x1b\x5c`)
}

/**
 * 设置应用程序的默认窗口标题。
 * @returns {void}
 */
export function setDefaultStuff() {
	setWindowTitle(info.title)
}
