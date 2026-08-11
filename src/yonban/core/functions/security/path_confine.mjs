/**
 * path_confine.mjs — SEC-T2 统一路径围栏（病根③单一权威源）
 *
 * 背景：beilu 多处用 "username + charName/serverName/partpath/任意 path" 拼 filesystem 路径，
 *   各点各写校验、口径不一，导致目录穿越（逃出本应所在目录 → 跨账号读写 / 任意读写）。
 *   本模块把 _sanitizeChatId(api_v1_router.mjs) 那条"防得很好"的口径抽成单一权威源，全项目复用。
 *
 * 两个原语：
 *   - confinePath(root, userPath)：userPath 解析后必须落在 root 内（消化 ..、绝对路径注入、同形点、null 字节、可选 symlink），
 *     允许含合法子目录/点（如 char.v2），仅拦穿越。越界抛错。
 *   - confineSegment(seg)：扁平单段名（charName/serverName 等不应含分隔符的），删 / \ . 与控制字符（对齐 _sanitizeChatId）。
 *
 * 可配置（凛倾："全部安全行为可由用户自己设置"，安全默认 + owner 可覆盖）：
 *   环境变量 BEILU_DEPLOY_MODE = 'local'（默认，单用户本地）| 'server'（多用户）。
 *   server 模式下额外开启 symlink 实路径校验（防软链逃逸），local 默认关（owner 自己机器，软链常为合法快捷方式）。
 *
 * 链路：调用方 → confinePath(root, userPath) / confineSegment(seg) / getDeployMode() / deployGatedAllow(...)
 * 影响：fs.realpathSync（仅 confinePath server 模式 symlink 校验）；fs.readFileSync（readConfigFlag 读 config.json）
 * 相交：← 17 处 import（安全体系底座，被 auth/safe_fetch/secret_box/beilu-files/endpoints/parts_loader 等全项目引用）
 *       → whitebox.mjs(wbTrace,wbDetect) / 无其他安全模块依赖（最底层，零循环）
 */
import path from 'node:path'
import fs from 'node:fs'

import { wbTrace, wbDetect } from '../../../../server/whitebox.mjs'

/**
 * 读取 data/config.json 中某个顶层字段（owner 可在安全中心面板设置并持久化）。
 * 纯磁盘读取（不 import server.mjs，避免 path_confine 这个底层模块与 server 形成循环依赖）。
 * 供需要"按部署/owner 配置取安全开关"的底层模块复用（如 change-prompt 的 ${} eval 闸）。
 * @param {string} key - config.json 顶层键名。
 * @returns {any} 该字段值；读取/解析失败或缺字段 → undefined。
 */
export function readConfigFlag(key) {
	try {
		const dataDir = globalThis?.process?.env?.BEILU_DATA_DIR
			|| path.resolve(import.meta.dirname, '..', '..', '..', '..', '..', 'data')
		const raw = fs.readFileSync(path.join(dataDir, 'config.json'), 'utf-8')
		const j = JSON.parse(raw)
		return j?.[key]
	} catch { return undefined }
}

/**
 * 读取 data/config.json 中的 deployMode（owner 可在安全中心面板设置并持久化）。
 * 解析失败/缺字段 → '' → 由 getDeployMode 落安全默认 local。
 * @returns {string} config.deployMode 的小写值，或 ''。
 */
function _readDeployModeFromConfig() {
	return String(readConfigFlag('deployMode') ?? '').trim().toLowerCase()
}

/**
 * @returns {'local'|'server'} 部署模式（安全默认 local；多用户部署显式设 server 收紧）。
 * 优先级：env BEILU_DEPLOY_MODE > config.deployMode（安全中心面板写入）> 默认 'local'。
 * env 仍为最高，保证临时/CI 覆盖；config 持久化由 owner 在面板设置。
 */
export function getDeployMode() {
	// SEC-R2 fail-safe：显式设了非法值（拼写错如 'prod'/'production'）→ 落【最严 server】而非 local
	//   （旧版 `=== 'server' ? server : local` 把任何非 server 串落 local = fail-open，配错即全开闸）。
	//   仅"未设/空"才取安全默认 local（单用户本地，常见场景）。
	const envM = (globalThis?.process?.env?.BEILU_DEPLOY_MODE || '').trim().toLowerCase()
	if (envM === 'server' || envM === 'local') return envM
	if (envM) return 'server' // env 显式非法值 → fail-safe
	const cfgM = _readDeployModeFromConfig()
	if (cfgM === 'server' || cfgM === 'local') return cfgM
	if (cfgM) return 'server' // config 显式非法值 → fail-safe
	return 'local' // 未设 = 默认单用户本地
}

/**
 * SEC：统一「部署模式门 + owner 覆盖」安全开关判定（单一权威源，DRY 掉各处复制的同款逻辑）。
 *   安全默认随部署模式：local（单用户本地，owner 自己机器）→ 恒放行；
 *   server（多用户）→ 默认【关闭】，仅当 owner 显式开启时放行。owner 覆盖两路（env 优先）：
 *     1) 环境变量 `envVar` === 'on'（最高优先，便于临时/CI 覆盖）；
 *     2) config.json 顶层 `configKey` === true（安全中心面板写入并持久化）。
 *   被 T12(change-prompt ${} eval)、T13(用户插件子进程 spawn) 等"server 下高危、owner 可解锁"的闸复用。
 * @param {string} configKey - config.json 顶层布尔键（如 'allowPromptEval'）。
 * @param {string} envVar - 强制放行环境变量名（如 'BEILU_PROMPT_EVAL'，值 'on' 放行）。
 * @returns {boolean} 是否放行。
 */
export function deployGatedAllow(configKey, envVar) {
	const _mode = getDeployMode()
	if (_mode !== 'server') { wbTrace(null, 'deploy', 'deployGatedAllow:local_pass', { mode: _mode, configKey }); return true } // 本地：owner 自己机器，放行
	if (String(globalThis?.process?.env?.[envVar] || '').toLowerCase() === 'on') { wbTrace(null, 'deploy', 'deployGatedAllow:server_env_on', { configKey, envVar }); return true }
	const _ok = readConfigFlag(configKey) === true // owner 在面板/config 显式开启
	if (_ok) wbTrace(null, 'deploy', 'deployGatedAllow:server_owner_on', { configKey })
	else wbDetect(null, 'deploy', 'deployGatedAllow:server_deny', false, 'server模式下闸未开,拒绝高危操作', { mode: _mode, configKey, envVar })
	return _ok
}

/**
 * 规范化用户提供的路径片段：NFKC 归一（杀同形点 U+FF0E 等）、去 null 字节。
 * @param {string} s
 * @returns {string}
 */
function _normalizeInput(s) {
	let v = String(s ?? '')
	if (v.includes('\0')) throw new Error('path contains null byte')
	try { v = v.normalize('NFKC') } catch { /* 老 runtime 无 normalize 时跳过 */ }
	return v
}

/**
 * 把 userPath 限制在 root 目录内。
 * @param {string} root - 沙箱根（绝对路径；调用方保证可信，如用户数据目录/工作区根）。
 * @param {string} userPath - 用户/AI 提供的路径（相对则锚到 root，绝对则必须仍落在 root 内）。
 * @param {object} [opts]
 * @param {boolean} [opts.realpath] - 是否对已存在路径做 symlink 实路径校验（默认随部署模式：server=true）。
 * @returns {string} 规范化后的绝对安全路径。
 * @throws {Error} 越界（穿越/逃出 root）时抛错。
 */
export function confinePath(root, userPath, opts = {}) {
	const absRoot = path.resolve(_normalizeInput(root))
	const raw = _normalizeInput(userPath)
	// 相对路径锚到 root；绝对路径原样 resolve（下面边界检查会拦逃逸）
	const resolved = path.resolve(absRoot, raw)

	// Windows 大小写不敏感：统一比较口径（与 beilu-files isPathAllowed 同口径）
	const norm = (p) => process.platform === 'win32' ? p.toLowerCase() : p
	const nRoot = norm(absRoot)
	const nResolved = norm(resolved)
	if (nResolved !== nRoot && !nResolved.startsWith(nRoot + path.sep)) {
		wbDetect(null, 'deploy', 'confinePath:escape', false, '路径越界:逃出沙箱根', { root: absRoot, userPath, resolved })
		throw new Error(`path escapes confinement root: ${userPath}`)
	}

	// symlink/junction 实路径校验：根和目标必须进入同一 physical canonical 域。
	// 目标不存在时，解析最近的已存在祖先，再把未存在后缀接到该祖先的真实路径下。
	// 任何 realpath 权限/竞态/文件系统错误都 fail closed；不再回落到仅字符串边界。
	const useReal = opts.realpath ?? (getDeployMode() === 'server')
	if (!useReal) return resolved

	const realpathSync = fs.realpathSync.native ?? fs.realpathSync
	let realRoot
	try {
		realRoot = realpathSync(absRoot)
	} catch (e) {
		wbDetect(null, 'deploy', 'confinePath:root_realpath_failed', false, '沙箱根实路径解析失败,拒绝放行', { root: absRoot, userPath, error: e?.message || String(e) })
		throw new Error(`confinement root realpath failed: ${absRoot}: ${e?.message || e}`)
	}

	let probe = resolved
	let realProbe
	while (true) {
		try {
			realProbe = realpathSync(probe)
			break
		} catch (e) {
			// ENOENT: 目标/某级父目录尚未创建；ENOTDIR: 未存在后缀经过一个文件。
			// 两者可继续向上找最深已存在祖先，其余错误一律拒绝。
			if (e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') {
				wbDetect(null, 'deploy', 'confinePath:target_realpath_failed', false, '目标实路径解析失败,拒绝放行', { root: absRoot, userPath, probe, error: e?.message || String(e) })
				throw new Error(`target realpath failed: ${probe}: ${e?.message || e}`)
			}
			const parent = path.dirname(probe)
			if (parent === probe) {
				wbDetect(null, 'deploy', 'confinePath:target_ancestor_missing', false, '无法找到目标的已存在祖先,拒绝放行', { root: absRoot, userPath, resolved })
				throw new Error(`target has no resolvable existing ancestor: ${userPath}`)
			}
			probe = parent
		}
	}

	const unresolvedSuffix = path.relative(probe, resolved)
	const physicalTarget = path.resolve(realProbe, unresolvedSuffix)
	const nRealRoot = norm(realRoot)
	const nPhysicalTarget = norm(physicalTarget)
	if (nPhysicalTarget !== nRealRoot && !nPhysicalTarget.startsWith(nRealRoot + path.sep)) {
		wbDetect(null, 'deploy', 'confinePath:symlink_escape', false, '路径越界:软链或目录联接指向沙箱根外', { root: absRoot, realRoot, userPath, physicalTarget })
		throw new Error(`path escapes confinement root via symlink or junction: ${userPath}`)
	}

	return physicalTarget
}

/**
 * 扁平单段名净化：删 / \ . 及控制字符（对齐 _sanitizeChatId 口径），杜绝 ..、隐藏文件、分隔符注入。
 * 用于不应含路径分隔符的标识（charName 当作单段时、serverName 等）。
 * @param {string} seg
 * @returns {string}
 */
export function confineSegment(seg) {
	// [0806 根修] 原实现返回「NFKC 归一 + 删除全部点」的结果，而创建侧（import-char →
	//   sanitizeFilename）既不归一也保留点：磁盘目录是 "刀劍神域－進擊篇 Progressive V5.1.1_1"，
	//   本函数把查找键净化成 "刀劍神域-進擊篇 Progressive V511_1"（全角－被归一成 ASCII-、点被删）
	//   → 带点或全角字符的角色卡导入后 char-data / update-char / delete-char / 建对话全部 404
	//   （僵尸卡：看得见、改不了、删不掉；GitHub 外部用户实报，另一例 "龙族v7.8"→"龙族v78"）。
	//   净化口径必须与创建侧一致，否则读写不同源。
	// 【安全性不靠删点/归一】单段名内部的 "." 与全角字符都无害，危险的只有路径分隔符与整段
	//   "."/".."：①删 ASCII 分隔符与控制字符（保持原净化语义，a/b→ab）②NFKC 探针只做危险
	//   形态判定（整段点段、全角／＼归一后现形的分隔符），命中返回 '' 让调用方走 404/invalid
	//   ③返回值用原始码位（未归一），才能命中按原名创建的目录。
	// eslint-disable-next-line no-control-regex
	const v = String(seg ?? '').replace(/[/\\\u0000-\u001f]/g, '')
	let probe = v
	try { probe = v.normalize('NFKC') } catch { /* 老 runtime 无归一能力：按原文判定 */ }
	const t = probe.trim()
	if (t === '.' || t === '..') return '' // 整段点段=自引用/上跳，拒绝
	if (/[/\\]/.test(probe)) return '' // 同形分隔符（全角／＼归一后现形），拒绝
	return v
}
