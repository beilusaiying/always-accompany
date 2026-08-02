/**
 * core.mjs — ERA 管线桥（JS→Python，凛倾 0731 拍板「改python,重写管线,不要用deno」）。
 *
 * 分层：
 *   py/era_pipeline.py（插件目录自包含）= 管线唯一权威：解析 <era-map>/<era-patch> → 确定性布局
 *     → 原子落盘 → 提示词摘要。可完全独立运行（python era_pipeline.py - < job.json）。
 *   本文件 = 薄桥：组 job → spawnSync 起 python（stdin JSON 进 / stdout JSON 出）→ 解析结果。
 *     用 node:child_process 而非 Deno.Command（凛倾「不要用deno」；node: 内建双运行时通用）。
 *   main.mjs = 集成层（auth 路由/setDefaultPart），只消费本文件三个导出，签名不变。
 *
 * python 调用范式照 beilu-ppt main.mjs:370-387：pythonCmd 可配空=按系统自动（win→python 其他→python3）、
 *   `-X utf8` + PYTHONIOENCODING=utf-8 双保险（CJK 路径/输出）。
 * spawnSync 陷阱防线（MEMORY 记档）：失败不 throw——必须查 r.error 与 r.status，禁把空 stdout
 *   JSON.parse 折叠成"零结果"；python 不可用=诚实报错进 errors，不吞不兜底假装成功。
 *
 * 解耦（凛倾 0731「除了前端需要依赖,其他如果需要依赖那么就是高耦合」+ 底部功能层三层图）：
 *   era 功能层【零跨域 import】——不 import memory/storage、不 import security。
 *   数据根 = 服务器级约定自锚：env BEILU_DATA_DIR ‖ <项目根>/data（与 server/index.mjs data_path 同语义），
 *   物理路径与 memory 域产物逐字一致（data/users/<u>/chars/<c>/memory/era），契约靠约定不靠 import。
 *   eraDir 在 JS 侧解析后显式传给 python——python 只在给定目录内读写（独立运行时测试台自给测试目录）。
 */
import { spawnSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const _SELF_DIR = dirname(fileURLToPath(import.meta.url))

/** py 管线脚本绝对路径（同目录 py/）。 */
const PIPELINE_PY = join(_SELF_DIR, 'py', 'era_pipeline.py')

/** 数据根（era 域自锚，零跨域 import）：env BEILU_DATA_DIR ‖ <项目根>/data。 */
export function eraDataRoot() {
	if (process.env.BEILU_DATA_DIR) return process.env.BEILU_DATA_DIR
	// plugins/beilu-era → 上 5 级=项目根
	return join(resolve(_SELF_DIR, '..', '..', '..', '..', '..'), 'data')
}

/** 目录名段安全化：拒路径穿越/分隔符（与 create-char 的字符校验同域；非法→回退兜底段）。 */
function _safeSeg(seg, fallback) {
	const s = (typeof seg === 'string' && seg) ? seg : fallback
	if (/[/\\:*?"<>|]/.test(s) || s.includes('..')) return fallback
	return s
}

/** 某 user+char 的 era 数据目录（物理位与 memory 域 chars/<c>/memory 逐字同约定；保证存在）。 */
export function eraDirFor(username, charName) {
	const u = _safeSeg(username, '_default')
	const c = _safeSeg(charName, '_global')
	const dir = join(eraDataRoot(), 'users', u, 'chars', c, 'memory', 'era')
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
	return dir
}

/** 某 user 的 era per-user 配置文件路径（main.mjs 集成层消费）。 */
export function eraConfigFileFor(username) {
	return join(eraDataRoot(), 'users', _safeSeg(username, '_default'), 'era', 'config.json')
}

/**
 * 起 python 跑一个管线 job（同步；ReplyHandler 本身是同步遍历成员）。
 * @param {object} job - {action, content?, topology?, eraDir?, caps, enabled?}
 * @param {object} caps - era 能力谱（读 caps.python.cmd/timeoutMs）
 * @returns {object} python 的 result（{ok, touched?, errors?, layout?}）；起进程失败→{ok:false, errors:[...]}
 */
export function runEraJob(job, caps) {
	const pyCfg = caps?.python || {}
	const pythonCmd = pyCfg.cmd || (process.platform === 'win32' ? 'python' : 'python3')
	const timeout = Math.max(1000, Number(pyCfg.timeoutMs) || 20000)
	const r = spawnSync(pythonCmd, ['-X', 'utf8', PIPELINE_PY, '-'], {
		input: JSON.stringify(job),
		encoding: 'utf-8',
		timeout,
		env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
		windowsHide: true,
	})
	// spawnSync 失败不 throw：r.error=起进程失败(ENOENT/EPERM)，r.status=非零退出——逐项显式判，禁折叠
	if (r.error) {
		return { ok: false, errors: [`python 管线不可用(${pythonCmd}): ${r.error.message}`] }
	}
	const stdout = r.stdout || ''
	let parsed = null
	try {
		parsed = stdout ? JSON.parse(stdout) : null
	} catch {
		parsed = null
	}
	if (parsed && typeof parsed === 'object') {
		// python 顶层护栏已把异常包成 {ok:false,errors}；status!=0 且能解析时直接透传其错误
		return parsed
	}
	return {
		ok: false,
		errors: [`python 管线输出不可解析(status=${r.status})${r.stderr ? ': ' + String(r.stderr).slice(0, 300) : ''}`],
	}
}

/**
 * 处理一段含 era 指令的内容（ReplyHandler 核心入口）：桥到 python 全链。
 * @param {string} content
 * @param {{username:string, charName:string, caps:object, enabled?:boolean}} ctx
 * @returns {{touched:{id:string,rev:number}|null, errors:string[]}}
 */
export function processEraContent(content, ctx) {
	if (typeof content !== 'string' || !/<era-(map|patch|ui)\b/.test(content)) {
		return { touched: null, errors: [] }
	}
	const result = runEraJob({
		action: 'process',
		content,
		eraDir: eraDirFor(ctx.username, ctx.charName),
		caps: ctx.caps,
		enabled: ctx.enabled !== false,
	}, ctx.caps)
	return {
		touched: result?.touched || null,
		errors: Array.isArray(result?.errors) ? result.errors : (result?.ok ? [] : ['python 管线未知错误']),
	}
}

/** 从显示内容剥掉 era 指令块（显示态文本操作住 JS 侧；照 hideAirpCommands 语义）。 */
export function hideEraCommands(content) {
	if (typeof content !== 'string') return content
	let cleaned = content
		.replace(/<era-map\b[^>]*>[\s\S]*?<\/era-map>/g, '')
		.replace(/<era-patch\b[^>]*>[\s\S]*?<\/era-patch>/g, '')
		.replace(/<era-ui\b[^>]*>[\s\S]*?<\/era-ui>/g, '')
	cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim()
	return cleaned
}

/** 开关/配置变更后重算该 user 全部 char 的摘要（逐 char 桥 python regenerate）。 */
export function regenerateAllSummaries(username, caps, enabled) {
	try {
		const charsRoot = join(eraDataRoot(), 'users', _safeSeg(username, '_default'), 'chars')
		if (!fs.existsSync(charsRoot)) return
		for (const c of fs.readdirSync(charsRoot)) {
			if (!fs.existsSync(join(charsRoot, c, 'memory', 'era'))) continue
			const r = runEraJob({ action: 'regenerate', eraDir: eraDirFor(username, c), caps, enabled: enabled !== false }, caps)
			if (!r?.ok) console.warn(`[beilu-era] 摘要重算失败(${c}):`, (r?.errors || []).join('; '))
		}
	} catch (e) {
		console.warn('[beilu-era] 批量摘要重算失败:', e.message)
	}
}
