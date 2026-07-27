/**
 * autoCapture.js — 桌宠自截图(AI 自主/游戏陪伴截图,Electron 主进程模块)
 *
 * 功能链(完整移植 beilu_eye.py auto_capture_and_send + start_gc_poll,消息/元数据格式逐字对齐,AI 侧提示词零改动):
 *   startGcPolling → 5s GET /api/eye/getdata(x-pet-token) → captureRequested=true
 *     → autoCaptureAndSend: 截屏(targetWindow 配置时截指定窗口,否则全屏)
 *       → 降采样(captureResolution,默认1080 clamp 480~2160)
 *       → L1 dHash 去重(汉明距离<dedupHammingThreshold=静止帧跳过,省 token 核心)
 *       → L2 自适应块级差分(8x8 网格,change_score=变化块占比;关闭时用 dHash 距离归一估)
 *       → L3 变化分级 + 时序元数据(timestamp/elapsed/sequence,按 eye_config 开关)
 *       → JPEG(质量=eye_config.captureJpegQuality,默认60) → POST /api/eye/inject {image,message,mode:passive,window_title,capture_meta}
 *
 * why(为什么在 Electron 重造而不是继续用 python 眼):
 *   凛倾 2026-07-12"已经废弃的beilu eye……我们这个是直接替换beilueye"——桌宠进程接管截图全链,
 *   python 眼(beilu_eye.py)随后摘除(托盘图标即凛倾所指残留)。捕捉/去重算法 1:1 移植不重新设计。
 *
 * 关联链:
 *   ← main.js require 并在 app ready 后 startGcPolling(BEILU 常量/令牌经参数注入,不重复取 env)
 *   → /api/eye/getdata(captureRequested=gameCompanion 写 _gc_capture_request.json;节奏=captureFrequency 秒级定时轮询,
 *     gameCompanion.mjs:94-95。凛倾 2026-06-16"每输出20字符截图"设计截至 2026-07-12 未落地,全仓无字符计数触发)
 *   → /api/eye/inject(后端安全门:黑/白名单 fail-closed 需 window_title→经 koffi GetForegroundWindow 提供)
 *   ← eye_config.json(data/users/<user>/;T5#10 2026-07-13 起按 getdata 回传 username 寻址,未知时回退扫第一个有配置的目录)
 *
 * 影响范围:纯新增模块,不碰既有 crop/dialog/orb 链;去重状态模块级(进程生命周期=会话)。
 */

const { desktopCapturer, screen, nativeImage } = require('electron')
const path = require('path')
const http = require('http')
const fs = require('fs')

// ── 前台窗口标题(koffi FFI;后端黑白名单 fail-closed 必需 window_title) ──
// koffi 加载失败(依赖缺失/平台不支持)=诚实降级:返回空串,配置了名单的用户注入会被后端 400 拒绝并留日志,不静默旁路安全门。
let _getForegroundTitle = () => ''
try {
	const koffi = require('koffi')
	const u32 = koffi.load('user32.dll')
	const GetForegroundWindow = u32.func('void* GetForegroundWindow()')
	const GetWindowTextW = u32.func('int GetWindowTextW(void*, _Out_ char16_t*, int)')
	_getForegroundTitle = () => {
		try {
			const h = GetForegroundWindow()
			if (!h) return ''
			const buf = Buffer.alloc(1024)
			const n = GetWindowTextW(h, buf, 512)
			return n > 0 ? buf.toString('utf16le').slice(0, n) : ''
		} catch { return '' }
	}
} catch (e) {
	console.warn('[autoCapture] koffi 不可用,窗口标题降级为空(配置名单的用户注入将被后端拒绝):', e.message)
}

// ── 配置读取(T5#10 2026-07-13 按用户寻址):getdata 响应带 pet-token 反解的 username,轮询处缓存到
// _configUsername → 优先读 data/users/<username>/eye_config.json(多用户时不再读错人)。
// 未拿到 username(beilu 未连过/旧后端)=回退原扫描(data/users 第一个有配置的目录,与 beilu_eye.py 同款离线兜底)。
const _USERS_DIR = path.resolve(__dirname, '..', 'data', 'users')
let _configUsername = '' // getdata 回传的本桌宠所属用户(空=未知,走扫描兜底)
function _readEyeConfig() {
	try {
		if (!fs.existsSync(_USERS_DIR)) return null
		if (_configUsername) {
			const up = path.join(_USERS_DIR, _configUsername, 'eye_config.json')
			if (fs.existsSync(up)) { try { return JSON.parse(fs.readFileSync(up, 'utf-8')) } catch { return null } }
		}
		for (const dir of fs.readdirSync(_USERS_DIR)) {
			const p = path.join(_USERS_DIR, dir, 'eye_config.json')
			if (fs.existsSync(p)) { try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { return null } }
		}
	} catch { /* 读不到=用默认 */ }
	return null
}
function _getCaptureResolution() {
	const c = _readEyeConfig()
	const v = c && c.captureResolution
	// 480/2160=离线兜底,与后端权威 PET_CAPABILITIES.captureResolutionLimits 同值(D5 分叉修 2026-07-13;分叉即病)
	if (typeof v === 'number' && v > 0) return Math.max(480, Math.min(2160, Math.round(v)))
	return 1080
}
function _getJpegQuality() {
	// JPEG 质量单源(凛倾 2026-07-13 去硬编码:原 q60 写死):eye_config.captureJpegQuality,权威默认=injection_state DEFAULT_EYE_CONFIG(60)。
	// clamp 1~100(nativeImage.toJPEG 合法域);缺失/非法=60 与原行为一致。
	const c = _readEyeConfig()
	const v = c && c.captureJpegQuality
	if (typeof v === 'number' && v >= 1 && v <= 100) return Math.round(v)
	return 60
}
function _getFilterConfig() {
	// 智能过滤 4 控件(前端 /api/eye/config 写):L1 阈值 + L2 区域差分 + L3 分级 + 时间戳。缺省=阈值5 三项全开(与 python 默认一致)。
	const cfg = { threshold: 5, l2: true, l3: true, ts: true }
	const c = _readEyeConfig()
	if (!c) return cfg
	const v = c.dedupHammingThreshold
	if (typeof v === 'number' && v >= 0) cfg.threshold = Math.max(0, Math.min(20, Math.round(v)))
	if (typeof c.l2RegionDiff === 'boolean') cfg.l2 = c.l2RegionDiff
	if (typeof c.l3Grading === 'boolean') cfg.l3 = c.l3Grading
	if (typeof c.metaTimestamp === 'boolean') cfg.ts = c.metaTimestamp
	return cfg
}
function _getTargetWindow() {
	// T5#4(2026-07-13):去 targetWindow 双读——权威键=captureWindow(DEFAULT_EYE_CONFIG/端点白名单/UI 全链同名);
	// targetWindow 全仓无写方(replyHandler:2764 已注明孤儿键),存量 eye_config 亦无此键,纯兼容读=命名分叉,删。
	const c = _readEyeConfig()
	return (c && c.captureWindow) || null
}

// ── 指纹算法(1:1 移植 beilu_eye.py:纯像素运算,输入源从 PIL 换 nativeImage.toBitmap BGRA) ──
const _DHASH_W = 9, _DHASH_H = 8
const _BLOCK_GRID = 8
const _BLOCK_DIFF_THRESHOLD = 12
function _grayAt(bgra, i) { return Math.round(0.114 * bgra[i] + 0.587 * bgra[i + 1] + 0.299 * bgra[i + 2]) }
function _computeDhash(img) {
	// 缩 9x8 灰度 → 每行比相邻像素 → 64 位(BigInt:JS 位运算 32 位截断,64 位指纹必须 BigInt)
	const small = img.resize({ width: _DHASH_W, height: _DHASH_H, quality: 'good' })
	const b = small.toBitmap()
	let bits = 0n, idx = 0n
	for (let y = 0; y < _DHASH_H; y++) {
		for (let x = 0; x < _DHASH_W - 1; x++) {
			const i1 = (y * _DHASH_W + x) * 4, i2 = (y * _DHASH_W + x + 1) * 4
			if (_grayAt(b, i1) > _grayAt(b, i2)) bits |= (1n << idx)
			idx++
		}
	}
	return bits
}
function _hammingDistance(a, b) {
	if (a === null || b === null) return 64
	let x = a ^ b, n = 0
	while (x) { n += Number(x & 1n); x >>= 1n }
	return n
}
function _computeBlockMeans(img) {
	// 8x8 网格每块平均灰度:自适应变化区域检测,不预设固定坐标(血条/对话框各游戏不同)
	const size = _BLOCK_GRID * 8
	const g = img.resize({ width: size, height: size, quality: 'good' })
	const b = g.toBitmap()
	const means = []
	for (let by = 0; by < _BLOCK_GRID; by++) {
		for (let bx = 0; bx < _BLOCK_GRID; bx++) {
			let total = 0
			for (let yy = 0; yy < 8; yy++) {
				for (let xx = 0; xx < 8; xx++) total += _grayAt(b, ((by * 8 + yy) * size + bx * 8 + xx) * 4)
			}
			means.push(Math.floor(total / 64))
		}
	}
	return means
}
function _changedBlocks(prev, cur) {
	if (!prev) return [Array.from(cur.keys()), 1.0]
	const changed = []
	for (let i = 0; i < cur.length; i++) if (Math.abs(cur[i] - prev[i]) > _BLOCK_DIFF_THRESHOLD) changed.push(i)
	return [changed, cur.length ? changed.length / cur.length : 0]
}

// ── 去重/时序会话状态(模块级,与 python 同语义:只与"最后真正发出"的帧比,防缓慢漂移逃过滤) ──
let _lastSentDhash = null
let _lastSentBlocks = null
let _captureSequence = 0
let _lastSentAt = null

// ── 截屏(desktopCapturer 缩略图即成图;targetWindow 配置时按窗口名匹配截该窗,匹配不到回退全屏) ──
async function _capture(targetW) {
	const primary = screen.getPrimaryDisplay()
	const ratio = targetW / (primary.size.width * primary.scaleFactor)
	const thumbW = Math.min(targetW, Math.round(primary.size.width * primary.scaleFactor))
	const thumbH = Math.max(1, Math.round(primary.size.height * primary.scaleFactor * Math.min(1, ratio)))
	const target = _getTargetWindow()
	if (target) {
		try {
			const wins = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: thumbW, height: thumbH } })
			const hit = wins.find((s) => s.name && s.name.includes(target))
			if (hit && !hit.thumbnail.isEmpty()) return { img: hit.thumbnail, windowTitle: hit.name }
		} catch { /* 窗口枚举失败:回退全屏 */ }
	}
	const screens = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: thumbW, height: thumbH } })
	if (!screens || !screens.length || screens[0].thumbnail.isEmpty()) return null
	return { img: screens[0].thumbnail, windowTitle: _getForegroundTitle() }
}

// ── 主流程(消息/元数据字段与 beilu_eye.py auto_capture_and_send 逐字对齐) ──
let _running = false
async function autoCaptureAndSend(ctx) {
	if (_running) return { sent: false, skipped: true, reason: 'busy' }
	_running = true
	try {
		const shot = await _capture(_getCaptureResolution())
		if (!shot) return { sent: false, skipped: false, reason: 'capture_failed' }
		const { img, windowTitle } = shot

		const fcfg = _getFilterConfig()
		const curDhash = _computeDhash(img)
		const dist = _hammingDistance(_lastSentDhash, curDhash)
		let changedIdxs = [], changeRatio = dist / 64
		let curBlocks = null
		if (fcfg.l2) {
			curBlocks = _computeBlockMeans(img)
			;[changedIdxs, changeRatio] = _changedBlocks(_lastSentBlocks, curBlocks)
		}
		const changeScore = Math.round(changeRatio * 10000) / 10000

		if (_lastSentDhash !== null && dist < fcfg.threshold) {
			console.log(`[autoCapture] 自动截图相似(汉明距离=${dist}<${fcfg.threshold}),跳过不发`)
			return { sent: false, skipped: true, change_score: changeScore, hamming: dist, reason: 'similar' }
		}

		const now = Date.now()
		const elapsed = _lastSentAt !== null ? Math.round((now - _lastSentAt) / 10) / 100 : null
		const seq = _captureSequence + 1
		const d = new Date()
		const tsStr = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
		const meta = { hamming_distance: dist }
		if (fcfg.ts) { meta.timestamp = tsStr; meta.elapsed_since_last = elapsed; meta.sequence = seq }
		if (fcfg.l3) { meta.change_score = changeScore; meta.changed_blocks = changedIdxs.length }

		const msgParts = [`[自动截图] 用户正在: ${windowTitle}`]
		if (fcfg.ts) msgParts.push(`${tsStr} 第${seq}张` + (elapsed !== null ? `(距上张${elapsed}秒)` : '(首张)'))
		if (fcfg.l3) msgParts.push(`变化${Math.round(changeScore * 100)}%`)

		const body = JSON.stringify({
			image: img.toJPEG(_getJpegQuality()).toString('base64'),
			message: msgParts.join(' | '),
			mode: 'passive',
			window_title: windowTitle,
			capture_meta: meta,
		})
		const result = await new Promise((resolve, reject) => {
			const req = http.request(
				{ host: ctx.host, port: ctx.port, path: '/api/eye/inject', method: 'POST', timeout: 10000, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-pet-token': ctx.token } },
				(res) => {
					let b = ''
					res.on('data', (c) => { b += c })
					res.on('end', () => { try { resolve(JSON.parse(b)) } catch { resolve({}) } })
				},
			)
			req.on('error', reject)
			req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
			req.write(body); req.end()
		})
		if (result && result.blocked) {
			// 被安全门拦截:不更新基准/序号(这张没真正"已发送"给 AI)
			console.log('[autoCapture] 自动截图被黑名单阻止:', result.reason || '')
			return { sent: false, skipped: false, blocked: true, change_score: changeScore, reason: 'blocked' }
		}
		_lastSentDhash = curDhash
		_lastSentBlocks = curBlocks
		_captureSequence = seq
		_lastSentAt = now
		console.log(`[autoCapture] 自动截图已发送 (窗口: ${String(windowTitle).slice(0, 50)}, 第${seq}张, 变化${Math.round(changeScore * 100)}%)`)
		return { sent: true, skipped: false, blocked: false, change_score: changeScore, reason: 'sent' }
	} catch (e) {
		console.warn('[autoCapture] 自动截图失败:', e.message)
		return { sent: false, skipped: false, reason: 'error: ' + e.message }
	} finally {
		_running = false
	}
}

// ── captureRequested 轮询(默认与 beilu_eye.py start_gc_poll 同节奏 5s;写入方自己 unlink) ──
// 间隔可配(A1 去硬编码 2026-07-13):eye_config.capturePollSec,clamp 2~60(过小=空转,过大=captureNow/陪伴请求错过 TTL)。
// 只在启动时读一次(改间隔重启桌宠生效;运行中热调不值得为它加一条对表链)。
function _getPollMs() {
	const c = _readEyeConfig()
	const v = c && Number(c.capturePollSec)
	if (Number.isFinite(v) && v >= 2 && v <= 60) return Math.round(v) * 1000
	return 5000
}
let _pollTimer = null
function startGcPolling(ctx) {
	if (_pollTimer) return
	_pollTimer = setInterval(() => {
		const req = http.request(
			{ host: ctx.host, port: ctx.port, path: '/api/eye/getdata', method: 'GET', timeout: 3000, headers: { 'x-pet-token': ctx.token } },
			(res) => {
				let b = ''
				res.on('data', (c) => { b += c })
				res.on('end', () => {
					try {
						const data = JSON.parse(b)
						if (typeof data.username === 'string' && data.username) _configUsername = data.username // T5#10:配置寻址按本用户
						if (data.captureRequested) {
							console.log('[autoCapture] 收到截图请求(captureRequested),自动截图...')
							autoCaptureAndSend(ctx)
						}
					} catch { /* 静默:响应异常下轮再试 */ }
				})
			},
		)
		req.on('error', () => { /* beilu 不可达:静默,orb 轮询已负责连接状态提示 */ })
		req.on('timeout', () => req.destroy())
		req.end()
	}, _getPollMs())
	console.log('[autoCapture] 自截图轮询已启动(' + Math.round(_getPollMs() / 1000) + 's,captureRequested)')
}
function stopGcPolling() {
	if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null }
}

module.exports = { startGcPolling, stopGcPolling, autoCaptureAndSend, _getForegroundTitle: () => _getForegroundTitle() }
