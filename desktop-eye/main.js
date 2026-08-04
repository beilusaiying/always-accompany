/**
 * 桌面截图工具 (Electron 主进程)
 *
 * 功能：
 * 1. 系统托盘 ✦ 图标
 * 2. 全局快捷键 Alt+Shift+S 触发框选截图
 * 3. 桌面全屏截图 → 透明窗口框选 → 裁剪 → 发送对话框
 * 4. HTTP POST 发送到 beilu 后端 (localhost:1314)
 */

// ============================================================
// 安全防护：确保 Electron 内建模块可用
// ============================================================

// 修复 node_modules/electron/index.js 遮蔽内建模块的问题
// npm 的 electron 包导出的是路径字符串，不是 API 对象
// 这里在 require('electron') 之前修复模块解析
;(() => {
	const Module = require('module')
	const origResolve = Module._resolveFilename
	Module._resolveFilename = function (request, parent, isMain, options) {
		if (request === 'electron' && process.versions.electron) {
			// 检查原始解析是否返回 node_modules 路径（npm 包遮蔽）
			try {
				const resolved = origResolve.call(this, request, parent, isMain, options)
				if (typeof resolved === 'string' && resolved.includes('node_modules')) {
					// npm 包遮蔽了内建模块，抛出错误让 Electron 的内建解析接管
					const err = new Error('Bypassing npm electron package')
					err.code = 'MODULE_NOT_FOUND'
					throw err
				}
				return resolved
			} catch (e) {
				if (e.code === 'MODULE_NOT_FOUND') throw e
				throw e
			}
		}
		return origResolve.call(this, request, parent, isMain, options)
	}
})()

const {
	app,
	BrowserWindow,
	Tray,
	Menu,
	globalShortcut,
	screen,
	nativeImage,
	ipcMain,
	dialog,
	desktopCapturer,
	Notification,
	shell,
} = require('electron')

const path = require('path')
const http = require('http')
const fs = require('fs')

// PARAM_FUZZY_MAP 必须在下方早退 return 之前求值(const 非 hoist;早退后其定义不再执行→TDZ)。
// 导入期参数自动建议表(非运行时情绪硬编码):6 个追踪抽象键 → 模型实际参数候选别名(优先级有序)。克隆 Live2DPet/src/main/model-import.js:7-14。
const PARAM_FUZZY_MAP = {
	angleX: ['ParamAngleX', 'ParamX', 'Angle_X', 'PARAM_ANGLE_X', 'AngleX'],
	angleY: ['ParamAngleY', 'ParamY', 'Angle_Y', 'PARAM_ANGLE_Y', 'AngleY'],
	angleZ: ['ParamAngleZ', 'ParamZ', 'Angle_Z', 'PARAM_ANGLE_Z', 'AngleZ'],
	bodyAngleX: ['ParamBodyAngleX', 'BodyAngleX', 'PARAM_BODY_ANGLE_X', 'ParamBodyX'],
	eyeBallX: ['ParamEyeBallX', 'EyeBallX', 'PARAM_EYE_BALL_X', 'ParamEyeX'],
	eyeBallY: ['ParamEyeBallY', 'EyeBallY', 'PARAM_EYE_BALL_Y', 'ParamEyeY'],
}

// 非 Electron 上下文(纯 Node require,如白盒测试/导入深扫描复用)：npm 的 electron 包导出路径字符串而非 API 对象,
// 故 destructure 出的 app 为 undefined。此时只导出纯 fs 工具函数(scanModelInfo 等,函数声明已 hoist),
// 立即 return 不跑下方 Electron 主进程 bootstrap(否则 app.disableHardwareAcceleration() 立即 TypeError)。
// 供 web 端点/白盒脚本 require 复用扫描逻辑。注意:此 return 必须在任何 app.xxx 调用之前。
if (typeof app === 'undefined' || !app || typeof app.disableHardwareAcceleration !== 'function') {
	if (typeof module !== 'undefined' && module.exports) {
		module.exports = { scanModelInfo, scanUserModels, suggestParamMapping }
	}
	return
}

// 禁用 GPU 硬件加速 — 避免某些系统上 Chromium 初始化崩溃
app.disableHardwareAcceleration()
// 禁用沙箱 — 按需使用，减少权限限制
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-gpu-sandbox')

// ============================================================
// 配置
// ============================================================

// beilu 端口默认 1314；允许 env 覆盖(非默认部署/本机多实例/运行时验证指向 stub)。
const BEILU_PORT = Number(process.env.BEILU_PORT) || 1314
const BEILU_HOST = 'localhost'
const INJECT_ENDPOINT = '/api/eye/inject'

// orb per-user 鉴权令牌(beilu-eye/main.mjs 拉起时经 env 注入,绑定本桌宠拥有者 username)。
// orb 请求(orb-consume)带 header x-pet-token → 端点反解 username,只取该 user 的 orb 槽。
// 缺失(直跑/旧拉起)=空字符串,端点缺 token → 403(隔离生效);单用户经 beilu-eye 拉起恒有令牌。
// 后端重启时旧 Electron 可以继续存活；新监督者通过 Electron 单例 second-instance
// 把新令牌交给既有实例，因此令牌必须可原子替换，不能烙死为启动期 const。
let PET_TOKEN = process.env.BEILU_PET_TOKEN || ''
let _autoCaptureContext = null

// ============================================================
// 全局变量
// ============================================================

let tray = null
let cropWindow = null
let dialogWindow = null
let petWindow = null
let petBubbleWindow = null
let currentScreenshot = null

// 桌宠布局：角色窗在上(完整体型)、对话框窗紧贴其下(凛倾决策:完整体型+下方对话窗)。
// 角色窗宽度按模型【原始画布宽高比】算(每个角色大小不同;页面加载后经 IPC 'pet-ratio' 上报)。
const PET_GROUP = {
	defaultH: 440, // 角色窗出厂高度【单点】(charH 初值/大小复位/托盘档位共用;petHeight=0 语义"回默认"即回此值)
	charH: 0, // 角色窗高度(可缩放;宽度随比例算)——初值=defaultH,对象定义后赋(字面量内不可自引用,禁双写 440)
	bubbleH: 92, // 对话框窗高度
	margin: 8, // 距屏幕右/下边缘
	gap: 2, // 角色窗与对话框窗之间留缝
	ratio: 0.7, // 角色窗宽高比(默认≈竖向半身;模型上报后覆盖)
	minH: 220, // 缩放下限(离线兜底;在线被 caps.petWinLimits.charH 覆盖=单源,_applyCapsLimits)
	maxH: 820, // 缩放上限(同上)
	stepH: 56, // 每档滚轮缩放步进
	cx: null, // 角色中心 x(屏幕px;null=未初始化→首次贴右下角)
	bottom: null, // 角色【底边】y(屏幕px;缩放时固定底边=角色从脚下长高)
}
PET_GROUP.charH = PET_GROUP.defaultH
// 悬浮菜单尺寸单源(凛倾 0722"拖动放大是对话框的问题"——DPI 漂移环修):内容高 CSS px,
// renderer pet-menu-action resize 上报=唯一写点;窗口实际宽高由 layoutPetGroup 派生(只写不读 bounds)。
let _petMenuContentH = 120
// 悬浮菜单跟随角色缩放(凛倾 0722"不会跟随角色变大变小"):因子锚定出厂高 defaultH,clamp 防极端。
function _petMenuZoom() { return Math.max(0.5, Math.min(2, PET_GROUP.charH / PET_GROUP.defaultH)) }
let _petDrag = null // 拖拽态:{ sx, sy, cx, bottom } 起点
let _lastCaptureTitle = '' // 框选开始时的前台窗口标题(手动截图链带给安全门;发送时前台已是对话框故须此刻抓)

// 用户模型目录(自定义最多;凛倾"开源必相对"→相对锚点,非绝对硬编码)。用户把 Live2D 模型文件夹丢这里即出现在桌宠可选。
const USER_MODELS_DIR = path.join(__dirname, 'user-models')
function _fileUrl(p) {
	const norm = p.replace(/\\/g, '/')
	return 'file:///' + encodeURI(norm).replace(/#/g, '%23').replace(/\?/g, '%3F')
}
// ============================================================
// Live2D 模型【导入深扫描】(T-C 债 A)
// 克隆参考项目 Live2DPet/src/main/model-import.js:7-29(PARAM_FUZZY_MAP[上方早退前定义]+suggestParamMapping)
//   + :73-153(scan-model-info 双源参数/双兜底表情动作/Moc·Textures 校验)。校验加严参 airi live2d-validator.ts。
// ============================================================
// 参数模糊→标准角色:每抽象键按候选别名顺序在模型实际 parameterIds 做大小写不敏感精确匹配,命中回填模型原始拼写,全不中给 null。
function suggestParamMapping(parameterIds) {
	const suggested = {}
	for (const [key, candidates] of Object.entries(PARAM_FUZZY_MAP)) {
		const match = candidates.find((c) => parameterIds.some((p) => p.toLowerCase() === c.toLowerCase()))
		suggested[key] = match
			? parameterIds.find((p) => p.toLowerCase() === match.toLowerCase())
			: null
	}
	return suggested
}
// MOC3 头审计(加严,参 airi live2d-validator.ts:52-67):读前 4 字节须 'MOC3',第 5 字节为 sub-version。返回 {ok,header,ver}。
function _auditMoc3Header(mocPath) {
	try {
		const fd = fs.openSync(mocPath, 'r')
		const buf = Buffer.alloc(5)
		fs.readSync(fd, buf, 0, 5, 0)
		fs.closeSync(fd)
		const header = buf.slice(0, 4).toString('latin1')
		return { ok: header === 'MOC3', header, ver: buf[4] }
	} catch { return { ok: false, header: '', ver: 0 } }
}
// basename 碰撞审计(加严,参 airi live2d-validator.ts:77-92):同 basename 出现在多个引用路径→碰撞(loader 按 basename 索引会丢数据)。
function _basenameCollisions(refPaths) {
	const seen = new Map()
	for (const p of refPaths) {
		if (!p) continue
		const base = String(p).split(/[\\/]/).pop()
		if (!seen.has(base)) seen.set(base, [])
		seen.get(base).push(p)
	}
	const collisions = []
	for (const [base, paths] of seen.entries()) if (paths.length > 1) collisions.push(base)
	return collisions
}
// 深扫描单个模型文件夹:解析 model3.json + cdi3 扒 参数/表情/动作 + 校验 + 参数自动建议。
// 返回 { success, modelName, parameterIds, expressions, motions, mocValid, texturesValid, mocHeaderValid, basenameCollisions, suggestedMapping, hitAreas } 或 { success:false, error }。
function scanModelInfo(folderPath, model3File) {
	try {
		const modelJsonPath = path.join(folderPath, model3File)
		if (!fs.existsSync(modelJsonPath)) return { success: false, error: 'model3.json 不存在: ' + modelJsonPath }
		const modelJson = JSON.parse(fs.readFileSync(modelJsonPath, 'utf-8'))
		const refs = modelJson.FileReferences || {}

		// (a) 参数双源去重: Groups[].Ids + DisplayInfo(cdi3).Parameters[].Id
		let parameterIds = []
		if (Array.isArray(modelJson.Groups)) modelJson.Groups.forEach((g) => { if (g && Array.isArray(g.Ids)) parameterIds.push(...g.Ids) })
		if (refs.DisplayInfo) {
			const cdiPath = path.join(folderPath, refs.DisplayInfo)
			try {
				if (fs.existsSync(cdiPath)) {
					const cdiJson = JSON.parse(fs.readFileSync(cdiPath, 'utf-8'))
					if (Array.isArray(cdiJson.Parameters)) parameterIds.push(...cdiJson.Parameters.map((p) => p.Id))
				}
			} catch { /* 缺 cdi3 静默,不影响 */ }
		}
		parameterIds = [...new Set(parameterIds)]

		// (b) 表情双路兜底: FileReferences.Expressions 缺则扫文件夹 .exp3.json
		let expressions = []
		if (Array.isArray(refs.Expressions)) expressions = refs.Expressions.map((e) => ({ name: e.Name, file: e.File }))
		if (expressions.length === 0) {
			try { expressions = fs.readdirSync(folderPath).filter((f) => f.endsWith('.exp3.json')).map((f) => ({ name: f.replace('.exp3.json', ''), file: f })) } catch {}
		}

		// (c) 动作双路兜底: FileReferences.Motions 缺则扫文件夹 .motion3.json 塞 Default 组
		let motions = {}
		if (refs.Motions && typeof refs.Motions === 'object') {
			for (const [group, entries] of Object.entries(refs.Motions)) motions[group] = (entries || []).map((e) => ({ file: e.File }))
		}
		if (Object.keys(motions).length === 0) {
			try {
				const motionFiles = fs.readdirSync(folderPath).filter((f) => f.endsWith('.motion3.json'))
				if (motionFiles.length) motions['Default'] = motionFiles.map((f) => ({ file: f }))
			} catch {}
		}

		// (d) 校验: Moc 存在性 + Textures 全存在性(克隆 Live2DPet:131-141) + MOC3 头/basename 碰撞(加严,参 airi)
		let mocValid = false
		let mocHeaderValid = false
		if (refs.Moc) {
			const mocPath = path.join(folderPath, refs.Moc)
			mocValid = fs.existsSync(mocPath)
			if (mocValid) mocHeaderValid = _auditMoc3Header(mocPath).ok
		}
		let texturesValid = false
		if (Array.isArray(refs.Textures)) texturesValid = refs.Textures.every((t) => fs.existsSync(path.join(folderPath, t)))
		const refPaths = []
		if (refs.Moc) refPaths.push(refs.Moc)
		if (Array.isArray(refs.Textures)) refPaths.push(...refs.Textures)
		if (refs.Physics) refPaths.push(refs.Physics)
		expressions.forEach((e) => { if (e.file) refPaths.push(e.file) })
		const basenameCollisions = _basenameCollisions(refPaths)

		return {
			success: true,
			modelName: model3File.replace('.model3.json', ''),
			parameterIds,
			expressions,
			motions,
			mocValid,
			texturesValid,
			mocHeaderValid,
			basenameCollisions,
			suggestedMapping: suggestParamMapping(parameterIds),
			hitAreas: modelJson.HitAreas || [],
		}
	} catch (e) { return { success: false, error: e.message } }
}

// 扫描用户模型目录:每个子目录找 *.model3.json → 生成默认 model_dict 条目(name=目录名,url=绝对file://;
// 其余留空靠 renderer 框架自动推导)。renderer _mergeUserModels 经 __BEILU_USER_MODELS 合并(不改内置)。
function scanUserModels() {
	const out = []
	try {
		if (!fs.existsSync(USER_MODELS_DIR)) { fs.mkdirSync(USER_MODELS_DIR, { recursive: true }); return out }
		for (const dir of fs.readdirSync(USER_MODELS_DIR)) {
			const sub = path.join(USER_MODELS_DIR, dir)
			let st; try { st = fs.statSync(sub) } catch { continue }
			if (!st.isDirectory()) continue
			const m3 = fs.readdirSync(sub).find((f) => f.toLowerCase().endsWith('.model3.json'))
			if (!m3) continue
			// 轻量附带 hasModel3/model3File(不破坏现有 {name,url,source};深扫描走 scanModelInfo/web 端点)。
			out.push({ name: dir, url: _fileUrl(path.join(sub, m3)), source: '用户导入', hasModel3: true, model3File: m3 })
		}
	} catch (e) { console.warn('[desktop-eye] 扫描用户模型失败:', e.message) }
	return out
}
// ── 图片包扫描(图片模式,任务②③ 2026-07-09):user-images/<包名>/pack.json 为包声明单源。 ──
//   条目与 model_dict 同构(format:"image" 供 renderer 路由到 imagePackRenderer),经 __BEILU_USER_MODELS
//   与 Live2D 用户模型同路注入合并(renderer _applyUserDict 不区分来源)。
const USER_IMAGES_DIR = path.join(__dirname, 'user-images')
function scanUserImagePacks() {
	const out = []
	try {
		if (!fs.existsSync(USER_IMAGES_DIR)) { fs.mkdirSync(USER_IMAGES_DIR, { recursive: true }); return out }
		for (const dir of fs.readdirSync(USER_IMAGES_DIR)) {
			const sub = path.join(USER_IMAGES_DIR, dir)
			let st; try { st = fs.statSync(sub) } catch { continue }
			if (!st.isDirectory()) continue
			if (!fs.existsSync(path.join(sub, 'pack.json'))) continue
			out.push({ name: dir, format: 'image', url: _fileUrl(path.join(sub, 'pack.json')), source: '图片包' })
		}
	} catch (e) { console.warn('[desktop-eye] 扫描图片包失败:', e.message) }
	return out
}
// 所有可选形象名(bundled model_dict + 用户模型 + 图片包);供托盘"桌宠模型"菜单。
function readModelNames() {
	const names = []
	try {
		const arr = JSON.parse(fs.readFileSync(path.join(BEILU_PUBLIC_DIR, 'vendor', 'live2d-models', 'model_dict.json'), 'utf-8'))
		if (Array.isArray(arr)) arr.forEach((m) => { if (m && m.name) names.push(m.name) })
	} catch (e) { /* 读不到 bundled 名单:静默 */ }
	scanUserModels().forEach((m) => { if (m.name && !names.includes(m.name)) names.push(m.name) })
	scanUserImagePacks().forEach((m) => { if (m.name && !names.includes(m.name)) names.push(m.name) })
	return names
}

// 桌宠对话框【用户设置】(凛倾需求:透明度 + 停留时间)。持久化到 userData/pet-settings.json。
// (单一权威源:托盘菜单/未来 web 设置中心都写这里;桌宠对话框窗经 IPC 'bubble-config' 接收应用。)
// charModels(D-2): 角色卡→模型名 映射 {charName: modelName}(单一权威源 beilu;web 设置页/角色卡填,桌宠按当前角色选模型)。
// emotionTag 不入本地默认(凛倾"散写"纠偏):值只经 beilu 同步(PET_SYNC_KEYS),离线缺失时消费端 _extractEmotion 白检自回退 'emotion'。
// orphanExitSec/hitPollMs/alphaHitThreshold(凛倾 2026-07-13"为什么要设置硬编码而不是用户可以自己关闭"):
//   原 45000/90/10 写死;默认=原值零行为变化;权威默认单源=injection_state PET_SETTINGS_DEFAULT,此处为离线兜底。
const PET_SETTINGS_DEFAULT = { bubbleOpacity: 0.95, bubbleDwellMs: 6000, bubbleColor: '', bubbleTextColor: '', bubbleRadius: -1, passthrough: false, idleExpression: '', modelName: '', dynamics: {}, charModels: {}, bannerEnabled: true, bannerMaxChars: 0, companionMaxChars: 0, petCorner: 'br', notifySound: false, orphanExitSec: 45, hitPollMs: 90, alphaHitThreshold: 10, captureHotkey: 'Alt+Shift+S', orbPollSec: 3, companionStreamPollMs: 200, voiceAlwaysOn: false, voiceQuickHotkey: 'Alt+Shift+V', voiceWakeWords: 'beilu,贝露', voiceCaptureWithQuestion: false, voiceActivationPeak: 0.02, voiceSilenceMs: 1000, voiceMinSpeechMs: 300, voiceMaxUtteranceSec: 20 }
let petSettings = { ...PET_SETTINGS_DEFAULT }
function _petSettingsPath() { return path.join(app.getPath('userData'), 'pet-settings.json') }
function loadPetSettings() {
	// 损坏保全(2026-07-10 审计C修):文件存在但解析失败≠不存在——先快照 .corrupt-<ts> 再回默认,
	//   否则下一次 savePetSettings 覆盖=本地历史设置无声蒸发(此前 catch 一把抓静默重置)。
	let text = null
	try { text = fs.readFileSync(_petSettingsPath(), 'utf-8') } catch { /* 不存在=首启 */ }
	if (text !== null) {
		try {
			petSettings = { ...PET_SETTINGS_DEFAULT, ...JSON.parse(text) }
			return
		} catch (e) {
			try { fs.writeFileSync(_petSettingsPath() + '.corrupt-' + Date.now(), text) } catch { /* 快照失败仍留日志 */ }
			console.error('[desktop-eye] pet-settings.json 损坏,已快照 .corrupt-* 供恢复:', e.message)
		}
	}
	petSettings = { ...PET_SETTINGS_DEFAULT }
}
function savePetSettings() {
	try { fs.writeFileSync(_petSettingsPath(), JSON.stringify(petSettings, null, 2)) }
	catch (e) { console.warn('[desktop-eye] pet-settings 保存失败:', e.message) }
}
function sendBubbleConfig() {
	if (petBubbleWindow && !petBubbleWindow.isDestroyed()) {
		// 哨兵值(空串/0/-1=用默认)时代入 caps.bubbleDefaults(单源,data/pet_capabilities.json 可覆盖);
		// caps 不可达→传哨兵/undefined,渲染端 CSS 地板兜底(与出厂同值)。2026-07-09 收口二批:否则默认覆盖只到 web 预览=半个功能。
		const D = (_petCapsCache && _petCapsCache.bubbleDefaults) || {}
		const _hexA = (h, a) => { const m = /^#(..)(..)(..)$/.exec(h || ''); return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${Number(a) || 1})` : h }
		try { petBubbleWindow.webContents.send('bubble-config', {
			opacity: petSettings.bubbleOpacity, dwellMs: petSettings.bubbleDwellMs,
			color: petSettings.bubbleColor, // 空=渲染端"主题琥珀×alpha"动态默认(带透明度联动),不可代入 D.bg 平色(会杀 alpha)
			textColor: petSettings.bubbleTextColor || D.textColor || '',
			radius: (Number(petSettings.bubbleRadius) >= 0) ? petSettings.bubbleRadius : (Number(D.radius) > 0 ? Number(D.radius) : petSettings.bubbleRadius),
			borderColor: petSettings.bubbleBorderColor || (D.borderColor ? _hexA(D.borderColor, D.borderAlpha || 1) : ''),
			shadow: petSettings.bubbleShadow, nameEnabled: petSettings.bubbleNameEnabled,
			nameText: petSettings.bubbleNameText || D.nameText || '',
			nameColor: petSettings.bubbleNameColor || D.nameColor || '',
			fontSize: (Number(petSettings.bubbleFontSize) > 0) ? petSettings.bubbleFontSize : (Number(D.fontSize) > 0 ? Number(D.fontSize) : petSettings.bubbleFontSize),
			tail: petSettings.bubbleTail,
		}) } catch {}
	}
}
// 角色窗配置(待机表情自定义)下发。
// D-2 当前说话角色名(由 orb-consume 的 charName 设;渲染层据此经 charModels 换模型)。瞬时态,不持久化(随聊天角色变)。
let _activeChar = ''
function sendPetConfig() {
	if (petWindow && !petWindow.isDestroyed()) {
		try { petWindow.webContents.send('pet-config', { idleExpression: petSettings.idleExpression, dynamics: petSettings.dynamics, modelName: petSettings.modelName, charModels: petSettings.charModels, activeChar: _activeChar, hitLimits: (_petCapsCache && _petCapsCache.hitLimits) || null, alphaHitThreshold: petSettings.alphaHitThreshold }) } catch {} // hitLimits=手势判据单源(caps);离线 null=只识别 click(诚实降级不编造);alphaHitThreshold=魔法棒阈值(手势开关三键已删:双击=热区手势,菜单只右键,凛倾 2026-07-13 纠偏)
	}
}
// 改设置:更新内存 + 持久化 + 下发对话框/角色 + 刷新托盘勾选 + 镜像到 beilu(双向:托盘改动→web 设置中心也反映)。
function setPetSetting(key, value) {
	petSettings[key] = value
	savePetSettings()
	sendBubbleConfig()
	sendPetConfig()
	if (tray) createTray() // 重建菜单使 radio 勾选跟随
	// 双写和解:把改动 POST 回 beilu 单一权威源,并更新基线(避免下次轮询把它当外部改动回灌)。
	if (PET_SYNC_KEYS.includes(key)) {
		_postPetSettingsToBeilu({ [key]: value }).catch(() => {})
		_lastBeiluSync = JSON.stringify(_displaySubset(petSettings))
	}
	if (key === 'voiceQuickHotkey') applyQuickVoiceHotkey()
	if (key === 'voiceAlwaysOn' || key.startsWith('voice') || key === 'sttDevice' || key === 'sttDenoise') _reconcileAlwaysVoice()
}

// 桌宠渲染资源根目录（beilu-chat 前端 public 目录）。
// desktop-eye 与 src 同为仓库根的兄弟目录，故 ../src/public/... 解析到 vendored 库 + 模型 + live2dRenderer.mjs。
// 仅复用（import）live2dRenderer.mjs，绝不编辑它（另一分身在改）。
const BEILU_PUBLIC_DIR = path.resolve(
	__dirname,
	'..',
	'src',
	'public',
	'parts',
	'shells',
	'beilu-chat',
	'public',
)

// ============================================================
// 应用初始化
// ============================================================

const HANDOFF_EXIT_CODE = 73
const gotLock = app.requestSingleInstanceLock({
	beiluPort: BEILU_PORT,
	petToken: PET_TOKEN,
})
if (!gotLock) {
	// app.quit() 只排队退出，旧实现仍继续进入 whenReady、创建窗口并注册快捷键，
	// 于是每次自愈都会撞快捷键/cache 后才退出。显式 exit + bootstrap guard 保证零窗口。
	console.log('[desktop-eye] 已有实例运行，新令牌已交接，当前进程退出')
	app.exit(HANDOFF_EXIT_CODE)
} else {
	app.on('second-instance', (_event, _argv, _workingDirectory, additionalData) => {
		const nextToken = typeof additionalData?.petToken === 'string' ? additionalData.petToken : ''
		if (!nextToken) return
		PET_TOKEN = nextToken
		if (_autoCaptureContext) _autoCaptureContext.token = nextToken
		_companionStreamSeq = 0
		_beiluLastOkAt = Date.now()
		console.log('[desktop-eye] 已接管新后端令牌，继续复用当前桌宠实例')
	})
	app.whenReady().then(() => {
	if (app.dock) app.dock.hide()
	loadPetSettings()
	createTray()
	createPetWindow()
	createPetBubbleWindow()
	layoutPetGroup()
	applyPetPosition() // 尊重持久化的桌宠角位(默认 br=右下,旧行为)
	applyPetSizes()    // 任务⑧:持久化窗尺寸(0=内建默认)
	registerShortcuts()
	startOrbMessagePolling()
	// 自截图(AI 自主/游戏陪伴):完整移植自 beilu_eye.py(凛倾 2026-07-12"直接替换beilueye"),
	// 5s 轮询 captureRequested → 截屏+去重+元数据 → inject。python 眼摘除后本模块是唯一消费者。
	try {
		_autoCaptureContext = { host: BEILU_HOST, port: BEILU_PORT, token: PET_TOKEN }
		require('./autoCapture.js').startGcPolling(_autoCaptureContext)
	} catch (e) { console.warn('[desktop-eye] 自截图模块加载失败:', e.message) }
	console.log('[desktop-eye] 桌面截图客户端已启动(悬浮球已删除)，快捷键: Alt+Shift+S')
	})
}

// ============================================================
// 悬浮球 AI 横幅 (orbMessage) polling
// ============================================================

let _orbPollTimer = null
let _companionStreamTimer = null
// 轮询秒数可配(C1 去硬编码 2026-07-13):petSettings.orbPollSec,clamp 1~30(=AI 消息上气泡最大延迟;
// 改动经 applyOrbPollInterval 重建定时器即时生效)。默认 3s=原 ORB_POLL_INTERVAL 值。
function _orbPollMs() {
	const v = Number(petSettings.orbPollSec)
	return (v >= 1 && v <= 30) ? Math.round(v * 1000) : 3000
}
function applyOrbPollInterval() {
	if (!_orbPollTimer) return // 尚未启动(startOrbMessagePolling 负责首启)
	clearInterval(_orbPollTimer)
	_orbPollTimer = setInterval(_orbPollTick, _orbPollMs())
}

// 桌宠能力/选项缓存(任务⑥单源):启动从 beilu 拉一次 pet-capabilities → 重建托盘(预设菜单用后端值)。
let _petCapsCache = null
function _fetchPetCapabilities() {
	const req = http.request(
		{ host: BEILU_HOST, port: BEILU_PORT, path: '/api/eye/pet-capabilities', method: 'GET', timeout: 2000 },
		(res) => {
			let body = ''
			res.on('data', (c) => { body += c })
			res.on('end', () => {
				try { const j = JSON.parse(body); if (j && typeof j === 'object') { _petCapsCache = j; _applyCapsLimits(); if (tray) createTray() } } catch { /* 静默:用兜底 */ }
			})
		},
	)
	req.on('error', () => {})
	req.on('timeout', () => { req.destroy() })
	req.end()
}
// caps 值域接线(2026-07-09 收口二批):窗高钳位/缩放上下限改读后端单源;本地字面量只剩离线兜底。
function _applyCapsLimits() {
	const lim = _petCapsCache && _petCapsCache.petWinLimits
	if (lim && lim.charH) {
		if (Number(lim.charH.min) > 0) PET_GROUP.minH = Number(lim.charH.min)
		if (Number(lim.charH.max) > 0) PET_GROUP.maxH = Number(lim.charH.max)
		if (Number(lim.charH.stepH) > 0) PET_GROUP.stepH = Number(lim.charH.stepH) // B2 去硬编码:滚轮步进随 caps 单源,本地 56 只剩离线兜底
	}
	applyPetSizes() // 值域可能变化 → 立即按新域重钳一次
	sendBubbleConfig() // caps 到达晚于气泡窗创建:补发一次使 bubbleDefaults 生效(哨兵值代入见 sendBubbleConfig)
}
function _bubbleHLimits() {
	const b = _petCapsCache && _petCapsCache.petWinLimits && _petCapsCache.petWinLimits.bubbleH
	return { min: (b && Number(b.min) > 0) ? Number(b.min) : 40, max: (b && Number(b.max) > 0) ? Number(b.max) : 300 }
}

function startOrbMessagePolling() {
	if (_orbPollTimer) return
	// 启动:与 beilu 单一权威源对账(web 在桌宠关闭时设的显示值要采纳),之后轮询拉取改动(web→桌宠实时生效)。
	_initPetSettingsFromBeilu()
	_fetchPetCapabilities() // 任务⑥:选项/预设单源拉取(失败=离线兜底)
	_orbPollTimer = setInterval(_orbPollTick, _orbPollMs())
	if (!_companionStreamTimer) {
		const ms = Math.max(100, Math.min(2000, Number(petSettings.companionStreamPollMs) || PET_SETTINGS_DEFAULT.companionStreamPollMs))
		_companionStreamTimer = setInterval(() => _consumeCompanionStream().catch(() => {}), ms)
	}
}
function _orbPollTick() {
	_consumeOrbMessage().catch(() => { /* 静默 */ })
	_syncPetSettingsFromBeilu().catch(() => { /* 静默 */ })
	// 孤儿自退(凛倾 2026-07-12"我关闭之后桌宠还是显示"断环):beilu 后端关闭时本进程是脱管子进程,
	// 桌宠/托盘留在桌面且一切控制面已死。持续失联 orphanExitSec 秒(默认45>正常 beilu 重启窗口)=判定宿主已关,整进程自退。
	// beilu 再启动时插件 ensurePetRunning/自愈会重新拉起=双向闭环。
	// 秒数可配可关(凛倾 2026-07-13 去硬编码):petSettings.orphanExitSec,0=关闭自退(桌宠常驻);每 tick 现读=改动即生效。
	const _oes = Number(petSettings.orphanExitSec)
	if (_oes > 0 && Date.now() - _beiluLastOkAt > _oes * 1000) {
		clearInterval(_orbPollTimer) // 防退场窗口内重复触发
		if (_companionStreamTimer) clearInterval(_companionStreamTimer)
		console.log('[desktop-eye] beilu 后端持续失联 ' + _oes + 's,桌宠随宿主退出')
		try { if (Notification.isSupported()) new Notification({ title: '桌宠已退出', body: 'beilu 已关闭;重新启动 beilu 会自动回来', silent: true }).show() } catch {}
		setTimeout(() => app.quit(), 1500)
	}
}

// ── 桌宠设置桥(web 设置中心 ↔ 桌宠):单一权威源 beilu data/pet_settings.json ──
// 显示子集(Electron 桌宠负责应用的字段;petEnabled 由插件管,不在此应用)。
// 2026-07-09 收口审计：从 PET_SETTINGS_DEFAULT 键派生（原 16 键手工清单与 DEFAULT 各自维护，新增字段漏加即漏同步）。
// emotionTag/对话框全项(任务④) 特例显式追加：凛倾"散写"纠偏拍板不入本地默认（:302），但值需经 beilu 同步——刻意在 DEFAULT 之外。
// (对话框新字段默认值单源=injection_state PET_SETTINGS_DEFAULT;此处 undefined 时 sendBubbleConfig 传 undefined,气泡窗类型守卫走内建默认=离线不分叉。)
const PET_SYNC_KEYS = [...Object.keys(PET_SETTINGS_DEFAULT), 'emotionTag', 'bubbleBorderColor', 'bubbleShadow', 'bubbleNameEnabled', 'bubbleNameText', 'bubbleNameColor', 'bubbleFontSize', 'bubbleTail', 'petHeight', 'petBubbleWinH',
	// 语音输入(凛倾 0722):web 语音设置段写入,桌宠 🎤 消费(sttDevice=录音设备/sttDenoise=降噪开关);menuHotkey=悬浮对话快捷键
	'sttDevice', 'sttDenoise', 'menuHotkey']
// 桌宠窗尺寸应用(任务⑧:PET_GROUP 写死去硬编码):>0 才覆盖内建默认;clamp 进 min/max 防离谱值。
function applyPetSizes() {
	const h = Number(petSettings.petHeight) || 0
	if (h > 0) PET_GROUP.charH = Math.max(PET_GROUP.minH, Math.min(PET_GROUP.maxH, h))
	const bh = Number(petSettings.petBubbleWinH) || 0
	if (bh > 0) { const bl = _bubbleHLimits(); PET_GROUP.bubbleH = Math.max(bl.min, Math.min(bl.max, bh)) }
	layoutPetGroup()
}
// 应用桌宠角位(设计⚙"位置";默认 br 右下=旧行为)。pet 组靠 cx/bottom(layoutPetGroup 含越界 clamp)。
// 悬浮球已删除(凛倾 2026-07-09:不想看到小球;截图功能由热键/托盘/面板/桌宠承载)。
function applyPetPosition() {
	// 拖动位优先(凛倾 2026-07-10"位置需要持久化记录"):petPosCx/petPosBottom=用户拖过的显式坐标(本地键,
	// 刻意不入 PET_SYNC_KEYS——屏幕坐标是本机/显示器属性,不上传 beilu)。此前本函数无条件按角落重摆,
	// 且被启动/web 同步链调用=重启丢位置+运行中改任意 web 设置都弹回角落。layoutPetGroup 内含 clamp,
	// 分辨率变小/显示器拔掉时自动拉回可见区。无显式坐标→按 petCorner 贴角(旧行为)。
	if (Number.isFinite(petSettings.petPosCx) && Number.isFinite(petSettings.petPosBottom)) {
		PET_GROUP.cx = petSettings.petPosCx
		PET_GROUP.bottom = petSettings.petPosBottom
		layoutPetGroup()
		return
	}
	const corner = petSettings.petCorner || 'br'
	const wa = screen.getPrimaryDisplay().workArea
	const charW = Math.round(PET_GROUP.charH * PET_GROUP.ratio)
	const isLeft = corner === 'bl' || corner === 'tl'
	const isTop = corner === 'tr' || corner === 'tl'
	PET_GROUP.cx = isLeft ? (wa.x + PET_GROUP.margin + Math.round(charW / 2)) : (wa.x + wa.width - PET_GROUP.margin - Math.round(charW / 2))
	PET_GROUP.bottom = isTop ? (wa.y + PET_GROUP.margin + PET_GROUP.charH) : (wa.y + wa.height - PET_GROUP.margin - PET_GROUP.bubbleH - PET_GROUP.gap)
	layoutPetGroup() // 内含 clamp,防越界
}
let _lastBeiluSync = null // 上次与 beilu 同步的显示子集 JSON(防回退打架)
function _displaySubset(s) { const o = {}; for (const k of PET_SYNC_KEYS) o[k] = s[k]; return o }

function _postPetSettingsToBeilu(patch) {
	return new Promise((resolve) => {
		const body = JSON.stringify(patch || {})
		const req = http.request(
			{ host: BEILU_HOST, port: BEILU_PORT, path: '/api/eye/pet-settings', method: 'POST', timeout: 2000, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
			(res) => { res.on('data', () => {}); res.on('end', () => resolve()) },
		)
		req.on('error', () => resolve())
		req.on('timeout', () => { req.destroy(); resolve() })
		req.write(body); req.end()
	})
}

// 启动对账:beilu 是单一权威源。经 ?raw=1 只拿盘上【显式设置过】的键(store 只存显式键,默认不落盘)——
// 显式键全采纳(含用户显式设成等于默认的值);raw 没有的键=从没设过,保留本地(托盘上次设的,存 userData)。
// why:旧法拿"值≠默认"猜"web 设过",用户把值改回默认时被误判,回写把 Electron 旧值灌回 beilu(2026-07-09 确诊回灌 bug)。
// 2026-07-10 审计 D1 修:启动【不回写】。原"合并后回写补齐 raw 缺的键"= 把 Electron 本地默认/托盘旧值
//   烙成盘上显式键,raw"缺键=用户从没设过"的判据从第二次启动起永久失真(回灌家族写侧残留,实盘已见孤儿键)。
//   写侧唯一合法入口=用户真实操作(托盘 setPetSetting:353 单键 patch);启动只读采纳+设基线。
function _initPetSettingsFromBeilu() {
	return new Promise((resolve) => {
		const req = http.request(
			{ host: BEILU_HOST, port: BEILU_PORT, path: '/api/eye/pet-settings?raw=1', method: 'GET', timeout: 2000 },
			(res) => {
				let body = ''
				res.on('data', (c) => { body += c })
				res.on('end', () => {
					try {
						const data = JSON.parse(body)
						let changed = false
						for (const k of PET_SYNC_KEYS) {
							if (data[k] === undefined) continue // raw 无此键=用户从没设过 → 保留本地
							if (JSON.stringify(petSettings[k]) !== JSON.stringify(data[k])) {
								petSettings[k] = data[k]; changed = true
								// 桌宠关着时用户在 web 改过角落 → 位置新意图,清本地拖动坐标(同轮询侧语义)
								if (k === 'petCorner') { delete petSettings.petPosCx; delete petSettings.petPosBottom }
							}
						}
						if (changed) { savePetSettings(); sendBubbleConfig(); sendPetConfig(); applyPetPassthrough(!!petSettings.passthrough); applyPetPosition(); applyPetSizes(); applyHitPollInterval(); applyCaptureHotkey(); applyMenuHotkey(); applyQuickVoiceHotkey(); applyOrbPollInterval() }
					} catch { /* beilu 无 store/解析失败:用本地 */ }
					// 只设基线不回写(基线口径=非 raw 轮询的 _displaySubset;写侧唯一入口=用户操作,见函数头注释)
					_lastBeiluSync = JSON.stringify(_displaySubset(petSettings))
					_reconcileAlwaysVoice()
					resolve()
				})
			},
		)
		req.on('error', () => { _lastBeiluSync = JSON.stringify(_displaySubset(petSettings)); _reconcileAlwaysVoice(); resolve() })
		req.on('timeout', () => { req.destroy(); _lastBeiluSync = JSON.stringify(_displaySubset(petSettings)); _reconcileAlwaysVoice(); resolve() })
		req.end()
	})
}

// 拉取 beilu 设置;与基线不同(=web/外部改动)则应用到桌宠并更新基线。
function _syncPetSettingsFromBeilu() {
	return new Promise((resolve) => {
		const req = http.request(
			{ host: BEILU_HOST, port: BEILU_PORT, path: '/api/eye/pet-settings', method: 'GET', timeout: 2000 },
			(res) => {
				let body = ''
				res.on('data', (c) => { body += c })
			res.on('end', () => {
				try {
					const data = JSON.parse(body)
					// 进程已被新后端接管时 petProcess 不再是当前 Deno 的 ChildProcess，
					// 仍以同一权威源完成关闭，避免再次留下跨重启孤儿。
					// [D5 结构版 2026-08-04] 退出判据升级为 effective desired（显式开关 || 互动租约）：
					//   互动会话临时开启的桌宠 petEnabled 恒为 false，只看 petEnabled 会被本轮询自杀。
					//   petEffectiveDesired 由后端 GET /api/eye/pet-settings 计算下发（非设置键，不进基线对账）；
					//   旧后端无此字段时回退旧判据 petEnabled===false（混版兼容，不留孤儿）。
					const _effOff = data.petEffectiveDesired === false ||
						(data.petEffectiveDesired === undefined && data.petEnabled === false)
					if (_effOff) {
						console.log('[desktop-eye] 后端已撤回桌宠运行意愿(显式关闭且无互动租约)，当前实例退出')
						app.quit()
						resolve()
						return
					}
					const js = JSON.stringify(_displaySubset(data))
						if (_lastBeiluSync !== null && js !== _lastBeiluSync) {
							_lastBeiluSync = js
							_applyBeiluSettings(data)
						}
					} catch { /* 静默 */ }
					resolve()
				})
			},
		)
		req.on('error', () => resolve())
		req.on('timeout', () => { req.destroy(); resolve() })
		req.end()
	})
}

// 应用从 beilu 拉到的显示设置(web 改的),只动有变化的键,下发桌宠 + 持久化 userData(双写和解)。
function _applyBeiluSettings(data) {
	let changed = false
	for (const k of PET_SYNC_KEYS) {
		if (data[k] === undefined) continue
		if (JSON.stringify(petSettings[k]) !== JSON.stringify(data[k])) {
			petSettings[k] = data[k]; changed = true
			// 用户在 web 选了新角落=位置新意图 → 清拖动显式坐标,applyPetPosition 回到贴角逻辑
			if (k === 'petCorner') { delete petSettings.petPosCx; delete petSettings.petPosBottom }
		}
	}
	if (!changed) return
	savePetSettings()
	sendBubbleConfig()
	sendPetConfig()
	applyPetPassthrough(!!petSettings.passthrough)
	applyPetPosition()
	applyPetSizes() // 任务⑧:窗尺寸随 web 设置即时生效
	applyHitPollInterval() // hitPollMs 随 web 设置即时生效(重建定时器)
	applyCaptureHotkey() // captureHotkey 随 web 设置即时重注册
	applyMenuHotkey() // menuHotkey 同步即时重注册(凛倾 0722 悬浮对话快捷键)
	applyQuickVoiceHotkey() // voiceQuickHotkey 同步即时重注册
	applyOrbPollInterval() // orbPollSec 随 web 设置即时重建轮询
	_reconcileAlwaysVoice()
	if (tray) createTray()
	console.log('[desktop-eye] 已应用 web 设置中心改动(对话框/动态/模型/穿透/位置/尺寸)')
}

// beilu 连接状态跟踪(2026-07-10 审计C修:断连全静默=用户无从分辨"AI 没回"还是"链路断",违诊断面原则)。
// 只在状态【翻转】时提示一次:曾在线→断=横幅+托盘 tooltip;恢复=横幅一条(仅曾提示过断线时)。
// 首启 beilu 本就未跑(用户单独用桌宠)不算翻转不打扰;探针=orb 轮询(最高频请求,~2s 新鲜度)。
let _beiluOnline = null, _beiluWasOnline = false, _beiluOfflineNotified = false
let _beiluLastOkAt = Date.now() // 最近一次连通时刻(孤儿自退判据;启动即置=给冷启动宽限)
function _noteBeiluConn(ok) {
	if (ok) _beiluLastOkAt = Date.now()
	if (ok === _beiluOnline) return
	_beiluOnline = ok
	try { if (tray) tray.setToolTip('桌面截图 ✦' + (ok ? '' : ' (beilu 未连接)')) } catch (e) { /* 托盘未建 */ }
	if (ok) {
		if (_beiluOfflineNotified) { _showOrbBanner('已重新连接 beilu 后端'); _beiluOfflineNotified = false }
		_beiluWasOnline = true
		// 时序修(凛倾 2026-07-13"注意时序问题"):caps 原只在启动拉一次——桌宠先于 beilu 启动时
		// _petCapsCache 永远 null(值域/托盘档位/手势判据全离线退化)。断→通翻转点补拉一次(翻转才拉,不高频重复)。
		if (!_petCapsCache) _fetchPetCapabilities()
	} else if (_beiluWasOnline && !_beiluOfflineNotified) {
		_beiluOfflineNotified = true
		_showOrbBanner('无法连接 beilu 后端:AI 消息与设置同步暂不可达')
	}
}

function _consumeOrbMessage() {
	return new Promise((resolve) => {
		const req = http.request(
			{ host: BEILU_HOST, port: BEILU_PORT, path: '/api/eye/orb-consume', method: 'GET', timeout: 2000, headers: { 'x-pet-token': PET_TOKEN } },
			(res) => {
				let body = ''
				res.on('data', (chunk) => { body += chunk })
				res.on('end', () => {
					_noteBeiluConn(true)
					try {
						const data = JSON.parse(body)
						if (data.hasPending && data.text) {
							// 后端 orb-consume 透传 {text, emotion}：emotion 是回复 <emotion> 标签的枚举值
							// (replyHandler 投2 捎带)，桌宠表情据此与聊天同步。
							_showOrbBanner(data.text, data.emotion)
						}
						// D-2: 当前说话角色名 → 渲染层按角色卡(charModels)换模型。仅角色变化时下发(避免重复 reload)。
						if (data.hasPending && data.charName && data.charName !== _activeChar) {
							_activeChar = data.charName
							sendPetConfig() // 透传 activeChar → onPetConfig → setCharacter(经 charModels 映射;无绑定则不动)
						}
					} catch { /* 静默 */ }
					resolve()
				})
			},
		)
		req.on('error', () => { _noteBeiluConn(false); resolve() })
		req.on('timeout', () => { req.destroy(); _noteBeiluConn(false); resolve() })
		req.end()
	})
}

let _companionStreamSeq = 0
function _consumeCompanionStream() {
	return new Promise((resolve) => {
		const req = http.request(
			{ host: BEILU_HOST, port: BEILU_PORT, path: '/api/eye/companion-stream?since=' + _companionStreamSeq, method: 'GET', timeout: 2000, headers: { 'x-pet-token': PET_TOKEN } },
			(res) => {
				let body = ''
				res.on('data', (chunk) => { body += chunk })
				res.on('end', () => {
					try {
						const data = JSON.parse(body)
						if (data.hasUpdate && Number(data.seq) > _companionStreamSeq) {
							_companionStreamSeq = Number(data.seq)
							if (data.charName && data.charName !== _activeChar) { _activeChar = data.charName; sendPetConfig() }
							if (data.text) _showOrbBanner(data.text, '', { stream: data.phase !== 'final', companion: true })
						}
					} catch { /* 下轮重试 */ }
					resolve()
				})
			},
		)
		req.on('error', () => resolve())
		req.on('timeout', () => { req.destroy(); resolve() })
		req.end()
	})
}

function _showOrbBanner(text, emotionFromServer, options = {}) {
	// 用户通知偏好(设计⚙通知,存 pet-settings,默认不改变行为):bannerEnabled=false 则不弹横幅/对话框;
	// 普通通知和陪伴正文分别使用 bannerMaxChars / companionMaxChars，避免短通知偏好截断完整回答。
	if (petSettings.bannerEnabled === false) return
	// AI 消息声音(设计⚙通知,默认关):开则系统提示音(shell.beep,OS 级可靠,无需音频资产/手势)。
	if (petSettings.notifySound === true && options.stream !== true) { try { shell.beep() } catch {} }
	// AI 对话【渲染】在桌宠角色下方的对话框窗(凛倾决策:不弹系统通知;悬浮球状态灯已随球删除)。
	// 路由到桌宠：emotion 优先用后端结构化字段(replyHandler 抽好的枚举)，回退到从文本剥 <emotion> 标签
	// (兼容 orbMessage 文本内嵌标签的旧形态)。clean=去标签纯文本。
	// (beilu 只做管道：emotion 名→表情映射在角色端 model_dict.emotionMap，此处不解释语义。)
	const ext = _extractEmotion(text)
	const emotion = emotionFromServer || ext.emotion
	let clean = ext.clean
	const _maxChars = Number(options.companion === true ? petSettings.companionMaxChars : petSettings.bannerMaxChars) || 0
	if (_maxChars > 0 && clean.length > _maxChars) clean = clean.slice(0, _maxChars) + '…'
	if (petWindow && !petWindow.isDestroyed()) {
		try { petWindow.webContents.send('pet-drive', { emotion, text: clean }) } catch {}
	}
	if (petBubbleWindow && !petBubbleWindow.isDestroyed() && clean) {
		try { petBubbleWindow.webContents.send('bubble-text', clean) } catch {}
	}
	// T9(凛倾 0722"通过这些窗口,或者点击触发的,都需要把ai输出的内容放到对话框"):
	// AI 回应单一出口在此——悬浮对话窗开着就同步进其对话区(语音/触碰/截图/输入触发的回应全经本函数)。
	if (petMenuWindow && !petMenuWindow.isDestroyed() && clean) {
		try { petMenuWindow.webContents.send('pet-chat-reply', clean) } catch {}
	}
}

// 纯消费端剥 <标签>xxx</标签>(最后一个为准)，返回 { emotion, clean }。框架级标签提取，不解释语义。
// 标签名可配置(凛倾 2026-07-09):petSettings.emotionTag(经 PET_SYNC_KEYS 随 beilu 同步),白检后进正则,不合法回退 emotion。
function _extractEmotion(raw) {
	const s = String(raw || '')
	const t = (typeof petSettings.emotionTag === 'string' && /^[\w\u4e00-\u9fff-]+$/.test(petSettings.emotionTag)) ? petSettings.emotionTag : 'emotion'
	let emotion = ''
	const m = s.match(new RegExp(`<${t}>\\s*([^<]+?)\\s*<\\/${t}>`, 'gi'))
	if (m && m.length) {
		emotion = m[m.length - 1].replace(new RegExp(`<\\/?${t}>`, 'gi'), '').trim()
	}
	const clean = s.replace(new RegExp(`<${t}>[^<]*<\\/${t}>`, 'gi'), '').trim()
	return { emotion, clean }
}

app.on('will-quit', () => {
	globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
	// 不退出，保持托盘
})

// ============================================================
// 系统托盘
// ============================================================

// 桌宠快捷设置项(托盘 + 角色右键复用):透明度/停留时间/游戏穿透/缩放复位。
// 动态/物理预设单源(任务⑥ 2026-07-09):权威=beilu pet-capabilities;离线退化只有"标准"(空覆盖),数值零本地副本。
function _dynPresets() {
	return (_petCapsCache && _petCapsCache.dynPresets && typeof _petCapsCache.dynPresets === 'object') ? _petCapsCache.dynPresets : { '': {} }
}
// 菜单选项数据单源(T8 凛倾 0722:悬浮菜单「系统/设置」页装下完整操作项):托盘菜单与悬浮菜单窗共用,
// 选项/档位零副本(caps 单源+离线兜底与后端出厂同值)。
function _menuOptionData() {
	const dwellOptions = (Array.isArray(_petCapsCache?.trayBubbleDwellOptions) && _petCapsCache.trayBubbleDwellOptions.length)
		? _petCapsCache.trayBubbleDwellOptions : [['停留 3 秒', 3000], ['停留 5 秒', 5000], ['停留 8 秒', 8000], ['常驻 (不自动消失)', 0]]
	// 待机表情选项=当前形象【真实表情集】(A4 硬编码收口:原 7 个写死词与模型实际表情脱节)。
	// 图片包=pack.json 表情键;Live2D=scanModelInfo 的 exp3 名;读不到=只留"默认"(setEmotion 空=模型默认)。
	const exprOptions = [['默认', '']]
	try {
		const _curName = petSettings.modelName || ''
		const _packJson = path.join(USER_IMAGES_DIR, _curName, 'pack.json')
		if (_curName && fs.existsSync(_packJson)) {
			const _pj = JSON.parse(fs.readFileSync(_packJson, 'utf-8'))
			for (const k of Object.keys(_pj.expressions || {})) exprOptions.push([k, k])
		} else if (_curName) {
			const _um = scanUserModels().find((m) => m.name === _curName)
			if (_um && _um.model3File) {
				const _info = scanModelInfo(path.join(USER_MODELS_DIR, _curName), _um.model3File)
				if (_info.success) for (const e of (_info.expressions || [])) if (e && e.name) exprOptions.push([String(e.name), String(e.name)])
			}
		}
	} catch (e) { /* 表情集读不到:只留默认 */ }
	return {
		dwellOptions, exprOptions, dynKeys: Object.keys(_dynPresets()),
		curDwell: petSettings.bubbleDwellMs, curExpr: petSettings.idleExpression || '',
	}
}

function buildPetMenuItems() {
	// 档位单源=caps(data/pet_capabilities.json 可覆盖);字面量只剩离线兜底(与后端出厂默认同值,分叉即病)。
	const _opOpts = (Array.isArray(_petCapsCache?.trayBubbleOpacityOptions) && _petCapsCache.trayBubbleOpacityOptions.length)
		? _petCapsCache.trayBubbleOpacityOptions : [['不透明 100%', 1.0], ['85%', 0.85], ['70%', 0.7], ['半透明 50%', 0.5]]
	const { dwellOptions: _dwOpts, exprOptions: _exprOpts } = _menuOptionData()
	const opacitySub = _opOpts.map(([label, v]) => ({
		label, type: 'radio', checked: Math.abs(petSettings.bubbleOpacity - v) < 0.001,
		click: () => setPetSetting('bubbleOpacity', v),
	}))
	const dwellSub = _dwOpts.map(([label, v]) => ({
		label, type: 'radio', checked: petSettings.bubbleDwellMs === v,
		click: () => setPetSetting('bubbleDwellMs', v),
	}))
	const exprSub = _exprOpts.map(([label, v]) => ({
		label, type: 'radio', checked: (petSettings.idleExpression || '') === v,
		click: () => setPetSetting('idleExpression', v),
	}))
	// 动态/物理预设(人工自主设置;写 pet-settings.dynamics → sendPetConfig → 桌宠 applyUserDynamics 实时生效)。
	const _dynSource = _dynPresets()
	const dynSub = Object.keys(_dynSource).map((k) => ({ label: k || '标准', click: () => setPetSetting('dynamics', _dynSource[k]) }))
	// 桌宠模型选择(含用户导入的;自定义最多)。空 modelName=默认首个。
	const _names = readModelNames()
	const _curModel = petSettings.modelName || _names[0]
	const modelSub = _names.map((n) => ({ label: n, type: 'radio', checked: n === _curModel, click: () => setPetSetting('modelName', n) }))
	return [
		{ label: '桌宠模型', submenu: modelSub.length ? modelSub : [{ label: '(无)', enabled: false }] },
		{ label: '对话框透明度', submenu: opacitySub },
		{ label: '对话框停留时间', submenu: dwellSub },
		{ label: '待机表情', submenu: exprSub },
		{ label: '动态/物理预设', submenu: dynSub },
		{ label: '游戏穿透 (桌宠不挡操作)', type: 'checkbox', checked: !!petSettings.passthrough, click: () => applyPetPassthrough(!petSettings.passthrough) },
		// 桌宠大小(2026-07-10 凛倾"没办法调整大小":此前唯一直接操控=滚轮,零提示+不持久;档位=值域几何派生零新字面量,
		// 勾选容差=半步进;设档走 setPetSetting('petHeight') 全链持久+镜像 beilu,web 面板输入框同源可见)
		{ label: '桌宠大小 (滚轮 / Ctrl+拖人物可调)', submenu: (() => {
			const _mid = Math.round((PET_GROUP.defaultH + PET_GROUP.maxH) / 2)
			return [['小', PET_GROUP.minH], ['标准', PET_GROUP.defaultH], ['大', _mid], ['特大', PET_GROUP.maxH]].map(([n, v]) => ({
				label: `${n} ${v}px`, type: 'radio', checked: Math.abs(PET_GROUP.charH - v) < PET_GROUP.stepH / 2,
				click: () => { PET_GROUP.charH = v; layoutPetGroup(); setPetSetting('petHeight', v) },
			}))
		})() },
		// 复位=清 petHeight(0=回默认语义,重启同效),非写显式默认值
		{ label: '大小复位', click: () => { PET_GROUP.charH = PET_GROUP.defaultH; layoutPetGroup(); setPetSetting('petHeight', 0) } },
	]
}

function createTray() {
	// tray 只建一次;后续 setPetSetting 调本函数仅重建菜单(刷新勾选),不重复 new Tray。
	if (!tray) {
		tray = new Tray(createDefaultIcon())
		tray.setToolTip('桌面截图 ✦')
		tray.on('click', () => startCropCapture())
	}

	const contextMenu = Menu.buildFromTemplate([
		{ label: '框选截图  (' + _hotkey() + ')', click: () => startCropCapture() },
		// 凛倾 2026-07-12"直接在托盘里加上就行了,隐藏直接打开":托盘=显示/隐藏直达闭环(窗口级,进程不动);
		// 标签随真实态翻转,不用勾选(勾选语义曾撒谎,直白动词更清楚)。进程级开关归 web 设置中心「启用桌宠」。
		{ label: (petWindow && !petWindow.isDestroyed()) ? '隐藏桌宠' : '打开桌宠', click: () => togglePetWindow() },
		...buildPetMenuItems(),
		{ type: 'separator' },
		{
			label: '关于',
			click: () => {
				dialog.showMessageBox({
					type: 'info',
					title: '桌面截图',
					message: '桌面截图工具 v0.1.0\n桌面截图 → 临时注入 AI 上下文\n桌宠: 拖动移动 / 滚轮缩放 / 右键快捷设置\n\n快捷键: ' + _hotkey(),
					buttons: ['好的'],
				})
			},
		},
		{ type: 'separator' },
		{ label: '退出', click: () => app.quit() },
	])

	tray.setContextMenu(contextMenu)
}

// 游戏穿透:开启时桌宠恒穿透(forward:false 断命中测试,不接管鼠标=不挡游戏/桌面操作)；关闭恢复命中测试拖拽。
function applyPetPassthrough(on) {
	petSettings.passthrough = !!on
	savePetSettings()
	if (petWindow && !petWindow.isDestroyed()) {
		petWindow.setIgnoreMouseEvents(true, { forward: !on })
		_petIgnoring = true // 同步穿透态缓存:两方向切换后实际都处于 ignore,悬停轮询按新语义接手
		_rbtnWasDown = false // 右键边沿基准复位(防切换瞬间残留按下态误弹)
		try { petWindow.webContents.send('pet-passthrough', !!on) } catch {}
	}
	if (tray) createTray() // 刷新勾选
}

function createDefaultIcon() {
	const size = 16
	const buf = Buffer.alloc(size * size * 4)
	const cx = size / 2
	const cy = size / 2
	const r = size / 2 - 1
	for (let i = 0; i < size * size; i++) {
		const x = i % size
		const y = Math.floor(i / size)
		const dist = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy))
		if (dist <= r) {
			buf[i * 4 + 0] = 0xd4
			buf[i * 4 + 1] = 0xa0
			buf[i * 4 + 2] = 0x17
			buf[i * 4 + 3] = 255
		}
	}
	return nativeImage.createFromBuffer(buf, { width: size, height: size })
}

// ============================================================
// 桌宠窗口 (Live2D 透明置顶 deskpet)
// 借 airi window-contract 硬化：穿透透明区 / 不抢焦点 / 防录屏 / 不进任务栏。
// 渲染核心复用 beilu-chat 的 live2dRenderer.mjs（禁改），事件经 file:// 局域 HTTP 桥接驱动。
// ============================================================

function createPetWindow() {
	if (petWindow) return

	// 尺寸/定位由 layoutPetGroup() 统一按角色比例计算；这里给个初值，ready 后立即被 layout 覆盖。
	petWindow = new BrowserWindow({
		width: Math.round(PET_GROUP.charH * PET_GROUP.ratio),
		height: PET_GROUP.charH,
		frame: false,
		transparent: true,
		alwaysOnTop: true,
		skipTaskbar: true,
		resizable: false,
		movable: false,
		hasShadow: false,
		focusable: false,
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			contextIsolation: true,
			nodeIntegration: false,
			// live2dRenderer.mjs 及 vendored 库以 file:// 从 beilu-chat public 目录加载，
			// 与本 HTML(desktop-eye/renderer) 不同目录 → 关 webSecurity 允许跨目录 file:// 取模块/模型。
			// 桌宠页只连本机 localhost(1314) + 读本地资源，不接外网，关 webSecurity 风险可控。
			webSecurity: false,
			backgroundThrottling: false,
		},
	})

	// 置顶层级拉到 screen-saver（airi 硬化）：盖过普通 alwaysOnTop 窗口，常驻最前。
	petWindow.setAlwaysOnTop(true, 'screen-saver')
	// 鼠标穿透透明区（airi 范式）：forward:true 仍把移动事件转发给页面（供未来 hover 检测/拖拽热区），
	// 但点击落到桌宠后面的窗口——桌宠不挡操作。比 orb 的 setIgnoreMouseEvents(false) 更适合大画幅透明窗。
	// 游戏穿透态持久化:开启时 forward:false 断命中测试(恒穿透)；否则 forward:true 允许命中测试拖拽。
	petWindow.setIgnoreMouseEvents(true, { forward: !petSettings.passthrough })
	// 防录屏/截屏（airi 硬化）：桌宠不出现在用户分享/录制画面里。
	try { petWindow.setContentProtection(true) } catch (e) { /* 部分平台不支持，忽略 */ }
	petWindow.setMenuBarVisibility(false)

	// 资源根目录经 query 传给页面，页面用它构造 <base href> 让 live2dRenderer 的相对 fetch/import 正确解析。
	const petUrl = `${path.join(__dirname, 'renderer', 'live2d-pet.html')}`
	petWindow.loadFile(petUrl, {
		// passthrough 经 query 同步传(页面 onPetPassthrough 在 await import 后注册,ready-to-show 推送会 race 丢失)。
		query: { publicDir: BEILU_PUBLIC_DIR, beiluPort: String(BEILU_PORT), passthrough: String(!!petSettings.passthrough), idleExpression: petSettings.idleExpression || '', dynamics: JSON.stringify(petSettings.dynamics || {}), userModels: JSON.stringify([...scanUserModels(), ...scanUserImagePacks()]), model: petSettings.modelName || '', charModels: JSON.stringify(petSettings.charModels || {}), },
	})

	// showInactive：显示但不抢焦点（不打断用户正在操作的窗口）。
	petWindow.once('ready-to-show', () => {
		try { petWindow.showInactive() } catch (e) { /* ignore */ }
	})

	// 主进程命中轮询启动(框架修:本机 forward 转发失效,见 _petHoverTick 头注释)。默认 90ms≈11Hz,悬停响应无感延迟。
	_petIgnoring = true
	_petHitRect = null
	applyHitPollInterval()

	petWindow.on('closed', () => {
		petWindow = null
		if (_petHoverTimer) { clearInterval(_petHoverTimer); _petHoverTimer = null }
		_petHitRect = null
		_petIgnoring = true
	})

	console.log('[desktop-eye] 桌宠角色窗已创建')
}

// 桌宠【对话框窗】：紧贴角色窗下方的独立透明窗口，只显示 AI 文本(凛倾决策:对话在角色下方不浮盖)。
function createPetBubbleWindow() {
	if (petBubbleWindow) return

	petBubbleWindow = new BrowserWindow({
		width: Math.round(PET_GROUP.charH * PET_GROUP.ratio),
		height: PET_GROUP.bubbleH,
		frame: false,
		transparent: true,
		alwaysOnTop: true,
		skipTaskbar: true,
		resizable: false,
		movable: false,
		hasShadow: false,
		focusable: false,
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			contextIsolation: true,
			nodeIntegration: false,
			backgroundThrottling: false,
		},
	})

	petBubbleWindow.setAlwaysOnTop(true, 'screen-saver')
	petBubbleWindow.setIgnoreMouseEvents(true, { forward: true })
	try { petBubbleWindow.setContentProtection(true) } catch (e) { /* 忽略 */ }
	petBubbleWindow.setMenuBarVisibility(false)

	petBubbleWindow.loadFile(path.join(__dirname, 'renderer', 'pet-bubble.html'))

	petBubbleWindow.once('ready-to-show', () => {
		try { petBubbleWindow.showInactive() } catch (e) { /* ignore */ }
		sendBubbleConfig() // 下发用户设置(透明度/停留时间)
	})

	petBubbleWindow.on('closed', () => {
		petBubbleWindow = null
	})

	console.log('[desktop-eye] 桌宠对话框窗已创建')
}

// 按角色比例 + 当前位置(cx/bottom)布局两窗：角色窗在上(完整体型)、对话框窗紧贴其下。
// 位置可被拖拽(改 cx/bottom)/缩放(改 charH，固定底边)更新；首次未初始化时贴屏幕右下角。
function layoutPetGroup() {
	const charW = Math.round(PET_GROUP.charH * PET_GROUP.ratio)
	// 首次初始化：贴主屏右下角(workArea 含 x/y 原点,多屏正确)。
	const primary = screen.getPrimaryDisplay().workArea
	if (PET_GROUP.cx === null) PET_GROUP.cx = primary.x + primary.width - PET_GROUP.margin - Math.round(charW / 2)
	if (PET_GROUP.bottom === null) PET_GROUP.bottom = primary.y + primary.height - PET_GROUP.margin - PET_GROUP.bubbleH - PET_GROUP.gap

	// 拖动出屏 clamp:整组(角色 charH + gap + 对话框 bubbleH)夹在【角色中心所在显示器】workArea 内,
	// 防止桌宠被拖到屏幕外丢失。多屏:nearest 跟随角色,可跨屏移动。
	const disp = screen.getDisplayNearestPoint({ x: Math.round(PET_GROUP.cx), y: Math.round(PET_GROUP.bottom) }).workArea
	let left = Math.round(PET_GROUP.cx - charW / 2)
	left = Math.max(disp.x, Math.min(disp.x + disp.width - charW, left))
	PET_GROUP.cx = left + charW / 2
	if (PET_GROUP.bottom - PET_GROUP.charH < disp.y) PET_GROUP.bottom = disp.y + PET_GROUP.charH
	if (PET_GROUP.bottom + PET_GROUP.gap + PET_GROUP.bubbleH > disp.y + disp.height) PET_GROUP.bottom = disp.y + disp.height - PET_GROUP.gap - PET_GROUP.bubbleH

	const x = Math.round(PET_GROUP.cx - charW / 2)
	const charY = Math.round(PET_GROUP.bottom - PET_GROUP.charH)
	const bubbleY = Math.round(PET_GROUP.bottom + PET_GROUP.gap)
	if (petWindow && !petWindow.isDestroyed()) {
		petWindow.setBounds({ x, y: charY, width: charW, height: PET_GROUP.charH })
	}
	if (petBubbleWindow && !petBubbleWindow.isDestroyed()) {
		petBubbleWindow.setBounds({ x, y: bubbleY, width: charW, height: PET_GROUP.bubbleH })
	}
	// 悬浮菜单跟随角色(凛倾 0722"对话框不会跟着角色拖动而拖动"):拖动/缩放/跨屏 clamp 全经本函数,
	// 在此吸附=单一重排收口;位=角色脚下(与 togglePetMenu 初始位同公式)。
	// 尺寸单源修复(凛倾 0722"拖动放大是对话框的问题,角色没变"根因):原 getBounds 读回自身宽高再
	// setBounds——非整数 DPI(150%)下 DIP↔物理取整每往返漂移,拖动时每个 mousemove 经本函数一次=
	// 悬浮窗持续变大。现宽=角色宽派生、高=renderer 上报内容高×缩放,只写不读 bounds,漂移环拆除。
	// 跟随角色变大变小(凛倾 0722):内容经 setZoomFactor 随角色高度等比缩放,窗宽高同步派生。
	if (petMenuWindow && !petMenuWindow.isDestroyed()) {
		const z = _petMenuZoom()
		const mw = Math.max(Math.round(330 * z), charW)
		const menuY = charY + PET_GROUP.charH + 2
		let mh = Math.max(60, Math.round(_petMenuContentH * z))
		// 屏内余量上限(原 resize 处 360→屏幕边逻辑随迁至此,单点):内容多长到屏边为止,零截断字面量。
		try { const wa = screen.getDisplayNearestPoint({ x: Math.round(PET_GROUP.cx), y: menuY }).workArea; mh = Math.min(mh, Math.max(60, wa.y + wa.height - menuY)) } catch { /* 显示器信息不可得:不设屏内上限 */ }
		petMenuWindow.setBounds({ x: Math.round(PET_GROUP.cx - mw / 2), y: menuY, width: mw, height: mh })
		try { petMenuWindow.webContents.setZoomFactor(z) } catch { /* 未就绪:did-finish-load 再设 */ }
	}
}

// 角色页加载模型后上报【原始画布宽高比】→ 按角色比例重排两窗(每个角色大小不同)。
ipcMain.on('pet-ratio', (_event, ratio) => {
	if (typeof ratio === 'number' && ratio > 0.2 && ratio < 3) {
		PET_GROUP.ratio = ratio
		layoutPetGroup()
	}
})

// 渲染层就绪后主动拉配置:补回启动时(渲染器加载模型耗时数秒,onPetConfig 未注册)丢失的 push。
//   此刻主进程已跑过 _initPetSettingsFromBeilu 对账,petSettings 是采纳 beilu 后的权威值。
ipcMain.on('request-pet-config', () => { sendBubbleConfig(); sendPetConfig() })

// 角色【自由移动/缩放】(凛倾需求)。airi 式命中测试:角色页判断光标是否在角色不透明区，
//   在 → setIgnoreMouseEvents(false) 让窗口接管鼠标(可拖/可滚)；离开 → 恢复穿透(不挡桌面操作)。
ipcMain.on('pet-interactive', (_event, on) => {
	if (!petWindow || petWindow.isDestroyed()) return
	if (petSettings.passthrough) { petWindow.setIgnoreMouseEvents(true, { forward: false }); _petIgnoring = true; return } // 游戏穿透:恒不接管
	_petIgnoring = !on
	if (on) petWindow.setIgnoreMouseEvents(false)
	else petWindow.setIgnoreMouseEvents(true, { forward: true })
})
// ── 主进程命中轮询(2026-07-12 框架修) ──
// 根因:本机(Electron 28/Win11/150%缩放) setIgnoreMouseEvents(true,{forward:true}) 完全不转发 mousemove
// (受控探针实测:穿透+forward 组 count=0,对照 setIgnoreMouseEvents(false) 组正常收到)——
// 上方 renderer 侧命中测试(_overChar)永远等不到第一个 mousemove,交互总闸常闭,拖/缩/点/右键全废。
// 框架级修:不再依赖 forward 转发。主进程周期读全局光标(screen.getCursorScreenPoint,DIP 与 getBounds 同系),
// 对照窗口 bounds + renderer 上报的角色实际命中盒(图片包=alpha 不透明包围盒)切换穿透。
// renderer 的 mousemove 命中逻辑保留:窗口接管后事件正常送达,拖拽/抚摸/滚轮照旧走原链。
let _petHitRect = null // renderer 上报的角色命中盒(窗口内 client px;null=无可命中内容→不接管)
let _petHoverTimer = null
let _petIgnoring = true // 穿透态缓存(每 tick 只在状态翻转时调 setIgnoreMouseEvents)
// 轮询间隔可配(凛倾 2026-07-13 去硬编码):petSettings.hitPollMs,clamp 30~1000 防离谱值(0/负=回默认90)。
// 窗口创建时启动;beilu 同步改动经 applyHitPollInterval 重建定时器即时生效。
function _hitPollMs() {
	const v = Number(petSettings.hitPollMs)
	return (v >= 30 && v <= 1000) ? Math.round(v) : 90
}
function applyHitPollInterval() {
	if (_petHoverTimer) { clearInterval(_petHoverTimer); _petHoverTimer = null }
	if (!petWindow || petWindow.isDestroyed()) return
	_petHoverTimer = setInterval(_petHoverTick, _hitPollMs())
}
ipcMain.on('pet-hit-rect', (_event, r) => {
	_petHitRect = (r && Number(r.w) > 0 && Number(r.h) > 0) ? { x: Number(r.x), y: Number(r.y), w: Number(r.w), h: Number(r.h) } : null
})
// ── 像素级命中二级判定(T3,凛倾 tasks#11) ──
// 包围盒是矩形,Live2D 四肢间/立绘透明边的大片透明区也算"盒内"→窗口接管鼠标挡住桌面点击。
// 二级细化:盒内每 tick 追发一枚探针(webContents.send 单向,穿透态照样送达),渲染层读该点单点 alpha
// (live2d=gl.readPixels/图片包=canvas 采样,阈值=pet_settings.alphaHitThreshold 同源)回报存 _petPixelOpaque。
// latest-wins 异步回报,判定用上一枚结果=至多 1 tick(默认90ms)延迟,与包围盒轮询同数量级,无新硬编码节奏。
// null=渲染层无法判定(兜底小生物/canvas 异常/模型未就绪)→按包围盒(现行为),诚实降级不编造。
let _petPixelOpaque = null // true=光标点不透明/false=透明/null=未知(降级包围盒)
ipcMain.on('pet-pixel-hit', (_event, v) => {
	_petPixelOpaque = (v === true || v === false) ? v : null
})
function _sendPixelProbe() {
	if (!petWindow || petWindow.isDestroyed()) return
	try {
		const c = screen.getCursorScreenPoint()
		const b = petWindow.getBounds()
		petWindow.webContents.send('pet-pixel-probe', { x: c.x - b.x, y: c.y - b.y }) // DIP=renderer client px(与 pet-hit-rect 同坐标系)
	} catch { /* 探针失败:保持现值=包围盒行为 */ }
}
// 穿透态右键检测(凛倾 2026-07-12"选择穿透之后,右键还是需要可以选择的.不然切换不回来.注意操作逻辑闭环"):
// 穿透=窗口不接管任何鼠标事件,renderer 的 contextmenu 永远收不到 → 必须在主进程侧检测。
// 用 GetAsyncKeyState(VK_RBUTTON=0x02) 轮询边沿:光标在角色命中盒内 + 右键从抬到按 → 弹快捷菜单。
// 不装钩子不拦事件:游戏照常收到该右键,只是菜单同时弹出——闭环优先,干扰面最小。koffi 缺失=托盘菜单仍是兜底回路。
let _getRButtonDown = null
try {
	const koffi = require('koffi')
	const GetAsyncKeyState = koffi.load('user32.dll').func('int16 GetAsyncKeyState(int)')
	_getRButtonDown = () => (GetAsyncKeyState(0x02) & 0x8000) !== 0
} catch (e) { console.warn('[desktop-eye] koffi 不可用,穿透态右键菜单降级(托盘菜单可切回):', e.message) }
let _rbtnWasDown = false
function _cursorInsideHitRect() {
	if (!_petHitRect || !petWindow || petWindow.isDestroyed()) return false
	const c = screen.getCursorScreenPoint()
	const b = petWindow.getBounds()
	if (c.x < b.x || c.x >= b.x + b.width || c.y < b.y || c.y >= b.y + b.height) return false
	const lx = c.x - b.x, ly = c.y - b.y
	return lx >= _petHitRect.x && lx <= _petHitRect.x + _petHitRect.w && ly >= _petHitRect.y && ly <= _petHitRect.y + _petHitRect.h
}
function _petHoverTick() {
	if (!petWindow || petWindow.isDestroyed()) return
	if (petSettings.passthrough) {
		// 游戏穿透:恒不接管鼠标,但保留唯一回路——角色上右键(边沿)弹菜单,菜单里能关穿透(操作闭环)。
		// 菜单只可以右键(凛倾 2026-07-13 定调),右键=菜单唯一手势入口,固定不可关。
		if (_getRButtonDown) {
			try {
				const down = _getRButtonDown()
				if (down && !_rbtnWasDown && _cursorInsideHitRect()) showPetContextMenu()
				_rbtnWasDown = down
			} catch { /* FFI 异常:本 tick 跳过 */ }
		}
		return
	}
	if (_petDrag) return // 拖拽中恒接管,tick 不许抢回穿透(光标可能瞬时越出命中盒)
	let inside = false
	try {
		inside = _cursorInsideHitRect()
	} catch { return }
	if (inside) {
		// 像素级二级判定(T3):盒内追问渲染层该点 alpha(异步回报,下一 tick 生效);明确"透明"才收回接管。
		// 穿透态右键回路(上方 passthrough 分支)不做像素细化:恢复入口宽松优先,防判定误差锁死操作闭环。
		_sendPixelProbe()
		if (_petPixelOpaque === false) inside = false
	} else if (_petPixelOpaque !== null) {
		_petPixelOpaque = null // 离盒复位:下次进盒先按包围盒基线,等像素回报再细化
	}
	if (inside !== !_petIgnoring) {
		_petIgnoring = !inside
		if (inside) petWindow.setIgnoreMouseEvents(false)
		else petWindow.setIgnoreMouseEvents(true, { forward: true })
	}
}
ipcMain.on('pet-drag-start', (_event, p) => {
	if (!p) return
	// mode(2026-07-10 凛倾"放大为什么只有滚轮?为什么不可以拖动人物?"):拖拽协议拆两模式——
	//   'move'=整组移动(原行为);'scale'=Ctrl+拖人物缩放(向上拖大/向下拖小,桌宠惯例;无边框透明窗无系统 resize 边,
	//   此前拖拽通道被移动独占=拖不出缩放)。h0=起点高度,增量算绝对值防漂移。
	_petDrag = { sx: p.sx, sy: p.sy, cx: PET_GROUP.cx, bottom: PET_GROUP.bottom, mode: p.mode === 'scale' ? 'scale' : 'move', h0: PET_GROUP.charH }
})
ipcMain.on('pet-drag-move', (_event, p) => {
	if (!_petDrag || !p) return
	if (_petDrag.mode === 'scale') {
		// 向上拖=放大(sy 减小→高度增),底边固定(layoutPetGroup 按 bottom 排)=从脚下长高,与滚轮同几何
		PET_GROUP.charH = Math.max(PET_GROUP.minH, Math.min(PET_GROUP.maxH, _petDrag.h0 + (_petDrag.sy - p.sy)))
		layoutPetGroup()
		return
	}
	// 整组(角色+对话框)随光标屏幕坐标增量移动。
	PET_GROUP.cx = _petDrag.cx + (p.sx - _petDrag.sx)
	PET_GROUP.bottom = _petDrag.bottom + (p.sy - _petDrag.sy)
	layoutPetGroup()
})
ipcMain.on('pet-drag-end', () => {
	if (_petDrag) {
		if (_petDrag.mode === 'scale' && PET_GROUP.charH !== _petDrag.h0) {
			// 缩放松手=持久化(与滚轮同链:落盘+镜像 beilu petHeight+基线+托盘勾选)
			setPetSetting('petHeight', PET_GROUP.charH)
		} else if (_petDrag.mode === 'move' && (PET_GROUP.cx !== _petDrag.cx || PET_GROUP.bottom !== _petDrag.bottom)) {
			// 移动松手=位置持久化(凛倾 2026-07-10 拍板)。只写本地(savePetSettings),不走 setPetSetting——
			// petPos 不入 SYNC(本机坐标),也不必重建托盘/下发气泡。
			petSettings.petPosCx = PET_GROUP.cx
			petSettings.petPosBottom = PET_GROUP.bottom
			savePetSettings()
		}
	}
	_petDrag = null
})
// 触碰热区 say(凛倾 2026-07-09 用户自制触碰反馈):台词=用户在热区编辑器配置,经既有气泡链显示(守卫/截断/声音复用)。
// 长度限值唯一执行点=web 编辑器 maxlength(caps 单源),此处不复制限值(副本即分叉);气泡窗自身溢出截断。
ipcMain.on('pet-hit-say', (_event, text) => {
	const t = typeof text === 'string' ? text.trim() : ''
	if (t) _showOrbBanner(t)
})
// 触碰热区 send(触碰设计②):用户预设内容 → beilu /api/eye/pet-message(pet-token 反解 user)→ 陪伴触碰轮
// → AI 回应经既有 orb-consume→气泡链回来。失败(陪伴未运行/beilu 不在)=reason 上气泡,诚实反馈不静默。
// 悬浮菜单「对话」输入与触碰热区共用本函数(同一后端通道,不造第二条)。
function _postPetMessage(t, options = {}) {
	return new Promise((resolve) => {
		const body = JSON.stringify({ text: t, captureNow: options.captureNow === true })
		const req = http.request(
			{ host: BEILU_HOST, port: BEILU_PORT, path: '/api/eye/pet-message', method: 'POST', timeout: 130000, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-pet-token': PET_TOKEN } },
			(res) => {
				let b = ''
				res.on('data', (c) => { b += c })
				res.on('end', () => {
					try {
						const j = JSON.parse(b)
						if (!j.success) _showOrbBanner(j.reason || j.error || '发送失败')
						resolve(j)
					} catch {
						const result = { success: false, error: '发送响应无法解析' }
						_showOrbBanner(result.error)
						resolve(result)
					}
				})
			},
		)
		req.on('error', () => { const result = { success: false, error: '发送失败:beilu 未运行' }; _showOrbBanner(result.error); resolve(result) })
		req.on('timeout', () => { req.destroy(); const result = { success: false, error: '发送超时' }; _showOrbBanner(result.error); resolve(result) })
		req.write(body); req.end()
	})
}
ipcMain.on('pet-hit-send', (_event, text) => {
	const t = typeof text === 'string' ? text.trim() : ''
	if (t) _postPetMessage(t)
})
// ── 桌宠语音输入(凛倾 0722 完整链):悬浮菜单/截图对话框 🎤 → 本机 STT 服务(127.0.0.1:7861,
//    与 beilu「额外插件→语音转录」同一服务,系统麦直采绕开浏览器音频栈)→ stop 后自动转录
//    (denoise=降噪+拾音管线)→ 'stt-result' 回填调用窗输入框 → 用户点发送走各窗既有发送链
//    (悬浮菜单=pet-message / 截图框=inject)。同机直连不经 beilu(Electron 主进程无 CORS)。
const STT_PORT = 7861
function sttRequest(method, pathname, bodyObj, timeoutMs, cb) {
	const body = bodyObj ? JSON.stringify(bodyObj) : null
	const req = http.request(
		{ host: '127.0.0.1', port: STT_PORT, path: pathname, method, timeout: timeoutMs,
			headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {} },
		(res) => {
			let data = ''
			res.on('data', (d) => { data += d })
			res.on('end', () => { let j = null; try { j = JSON.parse(data) } catch {} cb(null, res.statusCode, j) })
		},
	)
	req.on('error', (e) => cb(e))
	req.on('timeout', () => req.destroy(new Error('timeout')))
	if (body) req.write(body)
	req.end()
}
// 语音自动连接(凛倾 0722"需要自动连接.而不是手动连接"):ECONNREFUSED → 经 beilu
// /api/eye/stt-ensure(pet-token)让插件自动拉起服务(spawn+等模型加载,~10s+),成功后自动开录。
function sttEnsureViaBeilu(cb) {
	const body = JSON.stringify({ port: STT_PORT })
	const req = http.request(
		{ host: BEILU_HOST, port: BEILU_PORT, path: '/api/eye/stt-ensure', method: 'POST', timeout: 130000,
			headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-pet-token': PET_TOKEN } },
		(res) => {
			let data = ''
			res.on('data', (d) => { data += d })
			res.on('end', () => { let j = null; try { j = JSON.parse(data) } catch {} cb(null, res.statusCode, j) })
		},
	)
	req.on('error', (e) => cb(e))
	req.on('timeout', () => req.destroy(new Error('timeout')))
	req.write(body); req.end()
}
ipcMain.on('stt-record', (event, cmd) => {
	const reply = (r) => { try { event.sender.send('stt-result', r) } catch {} }
	const doStart = (retried, ensured) => {
		if (_quickVoicePhase !== 'idle') return reply({ phase: 'error', error: '快速语音正在使用麦克风' })
		if (_alwaysVoiceActive || _alwaysVoicePolling) return reply({ phase: 'error', error: '常开语音正在使用麦克风，请先关闭常开模式' })
		// device:petSettings.sttDevice(网页设置中心可配)缺省=系统默认输入
		sttRequest('POST', '/record/start', { device: (petSettings && petSettings.sttDevice) ?? null }, 5000, (err, code, j) => {
			if (code === 409 && !retried) {
				// 单槽残留(窗口失焦关闭没停):先停旧录音再重试一次
				return sttRequest('POST', '/record/stop', {}, 8000, () => doStart(true, ensured))
			}
			if (err && !ensured) {
				// 服务没起:自动拉起(经 beilu,模型加载需十几秒)后重试
				reply({ phase: 'starting', note: 'STT 服务启动中(模型加载约10~20s)…' })
				return sttEnsureViaBeilu((e2, c2, j2) => {
					if (e2 || c2 !== 200) return reply({ phase: 'error', error: '服务自动启动失败: ' + ((j2 && j2.error) || (e2 && e2.message) || ('HTTP ' + c2)) })
					doStart(false, true)
				})
			}
			if (err || code !== 200) return reply({ phase: 'error', error: (j && j.error) || (err && err.message) || ('HTTP ' + code) })
			reply({ phase: 'recording', device: j && j.device_name })
		})
	}
	if (cmd === 'start') return doStart(false, false)
	if (cmd === 'stop') {
		sttRequest('POST', '/record/stop', {}, 8000, (err, code, j) => {
			if (err || code !== 200) return reply({ phase: 'error', error: (j && j.error) || (err && err.message) || ('HTTP ' + code) })
			reply({ phase: 'transcribing', audio: j && j.audio })
			sttRequest('POST', '/record/transcribe', { language: 'auto', denoise: petSettings.sttDenoise !== false, max_new_tokens: 2048 }, 120000, (err2, code2, j2) => {
				if (err2 || code2 !== 200) return reply({ phase: 'error', error: (j2 && j2.error) || (err2 && err2.message) || ('HTTP ' + code2) })
				const text = ((j2.segments || []).map((s) => s.text).join(' ').trim()) || String(j2.raw_text || '').replace(/\[[^\]]*\]/g, '').trim()
				reply({ phase: 'done', text })
			})
		})
	}
})

// ── 常开语音：STT 服务拥有录音/VAD，Electron 只持 lifecycle、唤醒词和陪伴消息路由。 ──
let _alwaysVoiceEpoch = 0
let _alwaysVoicePollTimer = null
let _alwaysVoiceRetryTimer = null
let _alwaysVoiceActive = false
let _alwaysVoiceErrorShown = ''

function _sttPromise(method, pathname, body, timeout) {
	return new Promise((resolve, reject) => sttRequest(method, pathname, body, timeout, (err, code, data) => {
		if (err) return reject(err)
		if (code < 200 || code >= 300) return reject(new Error((data && data.error) || ('HTTP ' + code)))
		resolve(data || {})
	}))
}
function _sttEnsurePromise() {
	return new Promise((resolve, reject) => sttEnsureViaBeilu((err, code, data) => {
		if (err) return reject(err)
		if (code !== 200) return reject(new Error((data && data.error) || ('HTTP ' + code)))
		resolve(data || {})
	}))
}
function _wakeQuestion(text) {
	const raw = String(text || '').trim()
	const words = String(petSettings.voiceWakeWords || '').split(/[,，;；\n]/).map((x) => x.trim()).filter(Boolean)
	const lower = raw.toLocaleLowerCase()
	for (const word of words) {
		const idx = lower.indexOf(word.toLocaleLowerCase())
		// 唤醒词应出现在句首附近；避免普通对话中偶然提及名字也触发。
		if (idx < 0 || idx > 8) continue
		const question = raw.slice(idx + word.length).replace(/^[\s,，。.!！?？:：、]+/, '').trim()
		if (question) return { wakeWord: word, question }
	}
	return null
}
function _clearAlwaysVoiceTimers() {
	if (_alwaysVoicePollTimer) clearInterval(_alwaysVoicePollTimer)
	if (_alwaysVoiceRetryTimer) clearTimeout(_alwaysVoiceRetryTimer)
	_alwaysVoicePollTimer = null
	_alwaysVoiceRetryTimer = null
}
function _scheduleAlwaysVoiceRetry(epoch) {
	if (epoch !== _alwaysVoiceEpoch || petSettings.voiceAlwaysOn !== true) return
	if (_alwaysVoiceRetryTimer) clearTimeout(_alwaysVoiceRetryTimer)
	_alwaysVoiceRetryTimer = setTimeout(() => _startAlwaysVoiceCycle(epoch), 3000)
}
async function _startAlwaysVoiceCycle(epoch = _alwaysVoiceEpoch, ensured = false) {
	if (epoch !== _alwaysVoiceEpoch || petSettings.voiceAlwaysOn !== true) return
	_clearAlwaysVoiceTimers()
	try {
		await _sttPromise('POST', '/record/start', {
			device: petSettings.sttDevice ?? null,
			continuous: true,
			peak_threshold: Number(petSettings.voiceActivationPeak) || PET_SETTINGS_DEFAULT.voiceActivationPeak,
			silence_ms: Number(petSettings.voiceSilenceMs) || PET_SETTINGS_DEFAULT.voiceSilenceMs,
			min_speech_ms: Number(petSettings.voiceMinSpeechMs) || PET_SETTINGS_DEFAULT.voiceMinSpeechMs,
			max_utterance_s: Number(petSettings.voiceMaxUtteranceSec) || PET_SETTINGS_DEFAULT.voiceMaxUtteranceSec,
			pre_roll_s: 0.5,
		}, 5000)
		if (epoch !== _alwaysVoiceEpoch) return
		_alwaysVoiceActive = true
		_alwaysVoiceErrorShown = ''
		_alwaysVoicePollTimer = setInterval(() => _pollAlwaysVoice(epoch), 150)
	} catch (e) {
		if (!ensured && /ECONNREFUSED|connect/i.test(e.message || '')) {
			try { await _sttEnsurePromise(); return _startAlwaysVoiceCycle(epoch, true) } catch (ensureErr) { e = ensureErr }
		}
		_alwaysVoiceActive = false
		if (_alwaysVoiceErrorShown !== e.message) { _alwaysVoiceErrorShown = e.message; _showOrbBanner('常开语音暂不可用: ' + e.message) }
		_scheduleAlwaysVoiceRetry(epoch)
	}
}
let _alwaysVoicePolling = false
async function _pollAlwaysVoice(epoch) {
	if (_alwaysVoicePolling || epoch !== _alwaysVoiceEpoch || petSettings.voiceAlwaysOn !== true) return
	_alwaysVoicePolling = true
	let cycleEnded = false
	try {
		const status = await _sttPromise('GET', '/record/status', null, 2000)
		if (epoch !== _alwaysVoiceEpoch || petSettings.voiceAlwaysOn !== true) return
		if (!status.utterance_ready) return
		cycleEnded = true
		_clearAlwaysVoiceTimers()
		_alwaysVoiceActive = false
		await _sttPromise('POST', '/record/stop', {}, 8000)
		if (epoch !== _alwaysVoiceEpoch || petSettings.voiceAlwaysOn !== true) return
		const tr = await _sttPromise('POST', '/record/transcribe', {
			language: petSettings.sttLanguage || 'auto',
			hotwords: petSettings.voiceWakeWords || '',
			denoise: petSettings.sttDenoise !== false,
			max_new_tokens: 2048,
		}, 120000)
		if (epoch !== _alwaysVoiceEpoch || petSettings.voiceAlwaysOn !== true) return
		const text = ((tr.segments || []).map((s) => s.text).join(' ').trim()) || String(tr.raw_text || '').replace(/\[[^\]]*\]/g, '').trim()
		const hit = _wakeQuestion(text)
		if (hit) _postPetMessage(hit.question, { captureNow: petSettings.voiceCaptureWithQuestion === true })
	} catch (e) {
		// 用户关闭常开模式或切到快速语音后，旧 epoch 不得再停掉新录音/发错误气泡。
		if (epoch !== _alwaysVoiceEpoch) return
		cycleEnded = true
		_alwaysVoiceActive = false
		try { await _sttPromise('POST', '/record/stop', {}, 3000) } catch {}
		if (_alwaysVoiceErrorShown !== e.message) { _alwaysVoiceErrorShown = e.message; _showOrbBanner('常开语音处理失败: ' + e.message) }
	} finally {
		_alwaysVoicePolling = false
		if (cycleEnded && epoch === _alwaysVoiceEpoch && petSettings.voiceAlwaysOn === true) _startAlwaysVoiceCycle(epoch)
	}
}
function _reconcileAlwaysVoice() {
	const enabled = petSettings.voiceAlwaysOn === true
	if (!enabled) {
		// 无论当前处于录音、轮询还是转写 await，都切 epoch；旧轮完成后不能再发送最后一条。
		++_alwaysVoiceEpoch
		_clearAlwaysVoiceTimers()
		const wasUsingRecorder = _alwaysVoiceActive || _alwaysVoicePolling
		_alwaysVoiceActive = false
		if (wasUsingRecorder) _sttPromise('POST', '/record/stop', {}, 5000).catch(() => {})
		return
	}
	// 快速语音临时独占 STT 单槽；完成后会再次 reconcile 恢复常开。
	if (_quickVoicePhase !== 'idle') return
	if (!_alwaysVoiceActive && !_alwaysVoicePollTimer && !_alwaysVoiceRetryTimer) {
		const epoch = ++_alwaysVoiceEpoch
		_startAlwaysVoiceCycle(epoch)
	}
}

// ── 快速语音发送：按钮/全局快捷键共用一个状态机。按一次录音，再按一次停止→转写→自动发送。 ──
let _quickVoicePhase = 'idle'
let _quickVoiceTask = null
function _emitQuickVoiceStatus(payload) {
	try {
		if (petMenuWindow && !petMenuWindow.isDestroyed()) petMenuWindow.webContents.send('quick-voice-status', { phase: _quickVoicePhase, ...payload })
	} catch {}
}
async function _pauseAlwaysVoiceForQuick() {
	const wasUsingRecorder = _alwaysVoiceActive || _alwaysVoicePolling
	++_alwaysVoiceEpoch
	_clearAlwaysVoiceTimers()
	_alwaysVoiceActive = false
	if (wasUsingRecorder) {
		try { await _sttPromise('POST', '/record/stop', {}, 5000) } catch {}
		// 让旧轮看到 epoch 已变化并退出，避免它随后 stop 掉快速录音。
		for (let i = 0; i < 40 && _alwaysVoicePolling; i++) await new Promise((resolve) => setTimeout(resolve, 50))
	}
}
async function _beginQuickVoice() {
	_quickVoicePhase = 'starting'
	_emitQuickVoiceStatus({ note: '正在连接语音服务…' })
	await _pauseAlwaysVoiceForQuick()
	const start = async () => _sttPromise('POST', '/record/start', { device: petSettings.sttDevice ?? null }, 5000)
	let result
	try {
		result = await start()
	} catch (e) {
		if (!/ECONNREFUSED|connect/i.test(e.message || '')) throw e
		_emitQuickVoiceStatus({ note: 'STT 服务启动中（首次约10~20秒）…' })
		await _sttEnsurePromise()
		result = await start()
	}
	_quickVoicePhase = 'recording'
	_emitQuickVoiceStatus({ device: result.device_name || '默认设备' })
	_showOrbBanner(_registeredQuickVoiceHotkey
		? '快速语音：录音中，再按 ' + _registeredQuickVoiceHotkey + ' 结束并发送'
		: '快速语音：录音中，再点麦克风按钮结束并发送')
}
async function _finishQuickVoice() {
	_quickVoicePhase = 'transcribing'
	_emitQuickVoiceStatus({ note: '正在转文字…' })
	_showOrbBanner('快速语音：正在转文字…')
	await _sttPromise('POST', '/record/stop', {}, 8000)
	const tr = await _sttPromise('POST', '/record/transcribe', {
		language: petSettings.sttLanguage || 'auto',
		hotwords: petSettings.voiceWakeWords || '',
		denoise: petSettings.sttDenoise !== false,
		max_new_tokens: 2048,
	}, 120000)
	const text = ((tr.segments || []).map((s) => s.text).join(' ').trim()) || String(tr.raw_text || '').replace(/\[[^\]]*\]/g, '').trim()
	if (!text) throw new Error('未识别到语音内容')
	_quickVoicePhase = 'sending'
	_emitQuickVoiceStatus({ text, note: '已转文字，正在发送…' })
	const sent = await _postPetMessage(text, { captureNow: petSettings.voiceCaptureWithQuestion === true })
	if (!sent?.success) throw new Error(sent?.error || sent?.reason || '发送失败')
	_emitQuickVoiceStatus({ phase: 'sent', text, accepted: sent.accepted === true, queued: sent.queued === true })
	_showOrbBanner(sent.queued ? '快速语音已排队' : '快速语音已发送，正在回复…')
}
function _toggleQuickVoice() {
	if (_quickVoicePhase === 'starting' || _quickVoicePhase === 'transcribing' || _quickVoicePhase === 'sending') {
		_showOrbBanner('快速语音正在' + (_quickVoicePhase === 'starting' ? '连接' : _quickVoicePhase === 'transcribing' ? '转文字' : '发送') + '，请稍候')
		return
	}
	if (_quickVoiceTask) return
	const work = _quickVoicePhase === 'recording' ? _finishQuickVoice : _beginQuickVoice
	_quickVoiceTask = work().catch(async (e) => {
		if (_quickVoicePhase === 'recording' || _quickVoicePhase === 'transcribing') {
			try { await _sttPromise('POST', '/record/stop', {}, 3000) } catch {}
		}
		_emitQuickVoiceStatus({ phase: 'error', error: e.message || String(e) })
		_showOrbBanner('快速语音失败: ' + (e.message || e))
	}).finally(() => {
		// 开始动作成功时必须停在 recording，等待第二次按键；其余动作回 idle。
		if (_quickVoicePhase !== 'recording') {
			_quickVoicePhase = 'idle'
			_emitQuickVoiceStatus({})
			// 快速录音期间用户也可能刚打开常开模式；结束后一律按当前权威设置对账，而非只看开始时快照。
			if (petSettings.voiceAlwaysOn === true) _reconcileAlwaysVoice()
		}
		_quickVoiceTask = null
	})
}
ipcMain.on('voice-quick-toggle', () => _toggleQuickVoice())
let _petScaleSaveTimer = null
ipcMain.on('pet-scale', (_event, dir) => {
	// 滚轮缩放:固定角色底边(从脚下长高/缩矮)，对话框跟随。
	const next = PET_GROUP.charH + (dir > 0 ? PET_GROUP.stepH : -PET_GROUP.stepH)
	PET_GROUP.charH = Math.max(PET_GROUP.minH, Math.min(PET_GROUP.maxH, next))
	layoutPetGroup()
	// 持久化(2026-07-10 凛倾"没办法调整大小"追查:滚轮调完只在内存,重启即丢=半接线)。
	// 停轮 800ms 后走 setPetSetting 全链(落盘+镜像 beilu petHeight+基线+托盘勾选),连滚不刷盘。
	clearTimeout(_petScaleSaveTimer)
	_petScaleSaveTimer = setTimeout(() => setPetSetting('petHeight', PET_GROUP.charH), 800)
})
// 角色【右键】=直接打开悬浮对话(凛倾 2026-07-22:"右键是悬浮对话";原 context menu 全部操作项
// 迁入悬浮菜单「系统」页,不再弹系统级菜单;「快速对话(打开 beilu)」凛倾拍板"没有用,直接删除")。
// 保留函数名与两个入口:非穿透态 renderer contextmenu IPC / 穿透态 _petHoverTick 右键检测直调。
function showPetContextMenu() {
	if (!petWindow || petWindow.isDestroyed()) return
	togglePetMenu()
}
ipcMain.on('pet-context-menu', () => showPetContextMenu())

// ── 悬浮设置菜单窗(凛倾 2026-07-12"打开悬浮窗直接设置""参考这个游戏"——萝莉斯桌宠标签条形态) ──
// 触发:角色双击 / 右键菜单「悬浮菜单」。focusable(对话输入要键盘焦点),blur 自关(游戏同款轻量退场)。
// 所有动作映射既有链,不造新后端;窗位=角色脚下(盖住气泡区,关菜单即还)。
let petMenuWindow = null
function togglePetMenu() {
	if (petMenuWindow && !petMenuWindow.isDestroyed()) { petMenuWindow.close(); return }
	if (!petWindow || petWindow.isDestroyed()) return
	// 尺寸单源(0722 DPI 漂移环修):初值按 PET_GROUP 权威态派生(不读窗口 bounds),ready 后 layoutPetGroup 统一接管。
	const _z0 = _petMenuZoom()
	const _charW0 = Math.round(PET_GROUP.charH * PET_GROUP.ratio)
	const w = Math.max(Math.round(330 * _z0), _charW0)
	petMenuWindow = new BrowserWindow({
		x: Math.round(PET_GROUP.cx - w / 2), y: Math.round(PET_GROUP.bottom + 2), width: w, height: Math.max(60, Math.round(_petMenuContentH * _z0)),
		frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
		resizable: false, movable: false, hasShadow: false, focusable: true,
		webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
	})
	petMenuWindow.setAlwaysOnTop(true, 'screen-saver')
	petMenuWindow.setMenuBarVisibility(false)
	// 窗口组置顶一致性(凛倾 0722"角色不是置顶设置,对话框是置顶设置"):菜单窗 focusable,获焦被系统
	// raise 到本层级最前;角色/气泡窗 focusable:false+穿透不会跟随=体感"对话框在顶、角色被盖"。
	// 组内同步 moveTop:菜单显示/获焦时把角色+气泡一并提到同层级顶部,三窗恒为一组。
	const _groupTop = () => { try { if (petWindow && !petWindow.isDestroyed()) petWindow.moveTop(); if (petBubbleWindow && !petBubbleWindow.isDestroyed()) petBubbleWindow.moveTop() } catch { /* 窗口竞态:忽略 */ } }
	petMenuWindow.on('focus', _groupTop)
	petMenuWindow.on('show', _groupTop)
	petMenuWindow.loadFile(path.join(__dirname, 'renderer', 'pet-menu.html'))
	petMenuWindow.webContents.on('did-finish-load', () => {
		try { petMenuWindow.webContents.setZoomFactor(_petMenuZoom()) } catch { /* 跟随角色缩放:失败留 1.0 */ }
		try {
			petMenuWindow.webContents.send('pet-menu-init', {
				models: readModelNames(),
				currentModel: petSettings.modelName || '',
				scalePercent: (PET_GROUP.charH / PET_GROUP.defaultH) * 100,
				bubbleOpacity: Number(petSettings.bubbleOpacity) || 0.95,
				passthrough: !!petSettings.passthrough,
				chatDraft: _petMenuDraft, // blur 关窗前未发送的输入(凛倾 2026-07-13"3做":重开恢复,不丢字)
				// D1/D3 分叉修(2026-07-13):滑条值域按真实 PET_GROUP 限值(caps 接管后)换算,不再写死 50~186;
				// 输入限值=caps.hitLimits.sayMaxChars 单源(原 maxlength=500 副本);快捷键文案随真值(B1)。
				scaleMinPct: Math.round(PET_GROUP.minH / PET_GROUP.defaultH * 100),
				scaleMaxPct: Math.round(PET_GROUP.maxH / PET_GROUP.defaultH * 100),
				sayMaxChars: Number(_petCapsCache?.hitLimits?.sayMaxChars) > 0 ? Number(_petCapsCache.hitLimits.sayMaxChars) : 500,
				hotkey: _hotkey(),
				menuHotkey: _menuHotkey(),
				quickVoiceHotkey: _registeredQuickVoiceHotkey,
				quickVoiceConfiguredHotkey: _quickVoiceHotkey(),
				quickVoicePhase: _quickVoicePhase,
				// T8(凛倾 0722):设置页装下完整操作项——停留时间/待机表情/动态预设选项数据(与托盘同源)
				menu: _menuOptionData(),
			})
		} catch { /* 初始化推送失败:面板用默认占位 */ }
	})
	// 真实常驻(凛倾 2026-07-22:"对话悬浮框常驻需要真实常驻,而不是点击其他地方就消失"):
	// blur 自关已删;关闭出口=菜单✕按钮 / 右键再点 / 快捷键再按(toggle)。草稿链保留(关窗重开不丢字)。
	petMenuWindow.on('closed', () => { petMenuWindow = null })
}
ipcMain.on('pet-menu-toggle', () => togglePetMenu())
// 悬浮菜单对话草稿(凛倾 2026-07-13"3做":blur 自关会丢正在输入的字——草稿实时上报存主进程,
// 重开菜单经 pet-menu-init 恢复;发送成功即清。窗口生命周期短暂,主进程变量=最简单可靠的暂存位)。
let _petMenuDraft = ''
ipcMain.on('pet-menu-action', (_event, msg) => {
	const a = msg && msg.action
	if (a === 'draft') { _petMenuDraft = typeof msg.value === 'string' ? msg.value : ''; return }
	if (a === 'resize') {
		// 面板切换按内容收缩窗高(renderer 上报 scrollHeight,CSS px)。
		// 尺寸单源(0722 DPI 漂移环修):本处只记内容高(唯一写点);缩放换算+屏内余量上限(原 360→屏幕边
		// 的 D4 逻辑)全在 layoutPetGroup 单点——原地 getBounds 读回+setBounds 的漂移路径删除。
		_petMenuContentH = Math.max(60, Math.round(Number(msg.value) || 120))
		if (petMenuWindow && !petMenuWindow.isDestroyed()) layoutPetGroup()
		return
	}
	if (a === 'dismiss') { if (petMenuWindow && !petMenuWindow.isDestroyed()) petMenuWindow.close(); return }
	if (a === 'chat-send') { const t = typeof msg.value === 'string' ? msg.value.trim() : ''; if (t) { _postPetMessage(t); _petMenuDraft = '' } return }
	if (a === 'set-model') { if (typeof msg.value === 'string' && msg.value) setPetSetting('modelName', msg.value); return }
	if (a === 'set-scale') {
		// 按比例缩放(凛倾 2026-07-12):百分比锚定出厂高 defaultH,几何与滚轮/Ctrl拖同(固定底边),停 800ms 持久化 petHeight。
		const p = Number(msg.value)
		if (!Number.isFinite(p)) return
		PET_GROUP.charH = Math.max(PET_GROUP.minH, Math.min(PET_GROUP.maxH, Math.round(PET_GROUP.defaultH * p / 100)))
		layoutPetGroup()
		clearTimeout(_petScaleSaveTimer)
		_petScaleSaveTimer = setTimeout(() => setPetSetting('petHeight', PET_GROUP.charH), 800)
		return
	}
	if (a === 'set-opacity') { const v = Number(msg.value); if (Number.isFinite(v) && v > 0 && v <= 1) setPetSetting('bubbleOpacity', v); return }
	// T8(凛倾 0722)悬浮菜单设置页完整操作项:停留时间/待机表情/动态预设/大小复位(值域与托盘同源)
	if (a === 'set-dwell') { const v = Number(msg.value); if (Number.isFinite(v) && v >= 0) setPetSetting('bubbleDwellMs', v); return }
	if (a === 'set-expr') { setPetSetting('idleExpression', typeof msg.value === 'string' ? msg.value : ''); return }
	if (a === 'set-dyn') { const p = _dynPresets(); if (typeof msg.value === 'string' && msg.value in p) setPetSetting('dynamics', p[msg.value]); return }
	if (a === 'size-reset') { PET_GROUP.charH = PET_GROUP.defaultH; layoutPetGroup(); setPetSetting('petHeight', 0); return }
	if (a === 'toggle-passthrough') {
		applyPetPassthrough(!petSettings.passthrough)
		try { if (petMenuWindow && !petMenuWindow.isDestroyed()) petMenuWindow.webContents.send('pet-menu-init', { passthrough: !!petSettings.passthrough }) } catch {}
		return
	}
	if (a === 'crop') { if (petMenuWindow && !petMenuWindow.isDestroyed()) petMenuWindow.close(); startCropCapture(); return }
	if (a === 'autoshot') {
		if (petMenuWindow && !petMenuWindow.isDestroyed()) petMenuWindow.close()
		// 用户显式点击“快速截图”=立即作为一条视觉消息送入当前 AI 对话；只有后台定时/陪伴
		// requestId 截图保持 passive，由各自轮次精确消费。force 避免用户主动截图被静止帧去重吞掉。
		try { require('./autoCapture.js').autoCaptureAndSend({ host: BEILU_HOST, port: BEILU_PORT, token: PET_TOKEN }, { mode: 'active', force: true }) } catch (e) { console.warn('[desktop-eye] 自截图触发失败:', e.message) }
		return
	}
	if (a === 'hide') { if (petMenuWindow && !petMenuWindow.isDestroyed()) petMenuWindow.close(); togglePetWindow(); return }
	if (a === 'open-web') { try { shell.openExternal(`http://${BEILU_HOST}:${BEILU_PORT}/parts/shells:beilu-chat/`) } catch {} return }
	if (a === 'close-pet') { if (petMenuWindow && !petMenuWindow.isDestroyed()) petMenuWindow.close(); setPetEnabledEverywhere(false); return }
})

function togglePetWindow() {
	if (petWindow && !petWindow.isDestroyed()) {
		petWindow.close()
		petWindow = null
		if (petBubbleWindow && !petBubbleWindow.isDestroyed()) {
			petBubbleWindow.close()
			petBubbleWindow = null
		}
		if (petMenuWindow && !petMenuWindow.isDestroyed()) { petMenuWindow.close(); petMenuWindow = null }
		// 恢复入口可见化(凛倾 2026-07-12"隐藏之后没有地方进行恢复"):隐藏时明示托盘回路。
		try { if (Notification.isSupported()) new Notification({ title: '桌宠已隐藏', body: '托盘 ✦ 图标菜单 →「打开桌宠」可恢复', silent: true }).show() } catch {}
	} else {
		createPetWindow()
		createPetBubbleWindow()
		layoutPetGroup()
	}
	// 托盘"桌宠"勾选跟随真实窗口态(操作闭环审计 2026-07-12:checked 在建菜单时求值,不重建=状态撒谎——
	// 隐藏后勾选仍亮,用户以为没点上再点=又拉起,来回打架)。
	if (tray) createTray()
}

// 关闭/开启桌宠【统一开关】(凛倾 2026-07-12"选择隐藏之后没有地方进行恢复"):
// 旧"隐藏桌宠"只关本地窗口——web 设置中心仍显示"启用中",两边状态分裂,用户找不到恢复入口(断环)。
// 统一到 petEnabled 单一权威源:本地即时关窗(UX 快) + POST petEnabled 回 beilu → 插件 reconcile 管进程生杀。
// 恢复入口=web 设置中心「启用桌宠」开关(可见可发现);进程死后托盘随之消失,web 是唯一且诚实的回路。
// petEnabled 刻意不入 PET_SYNC_KEYS(既有围栏:进程生命周期归后端插件,不混显示同步链)。
function setPetEnabledEverywhere(on) {
	const hasWin = petWindow && !petWindow.isDestroyed()
	if (on && !hasWin) togglePetWindow()
	if (!on && hasWin) togglePetWindow()
	_postPetSettingsToBeilu({ petEnabled: !!on }).catch(() => {})
	if (!on && Notification.isSupported()) {
		new Notification({ title: '桌宠已关闭', body: '可在 beilu 网页 设置中心 →「启用桌宠」重新打开', silent: true }).show()
	}
}

// ============================================================
// 快捷键
// ============================================================

// 快捷键可配(B1 去硬编码 2026-07-13):petSettings.captureHotkey(Electron accelerator),改动经 applyCaptureHotkey
// 重注册即时生效;非法/被占用=回退默认 Alt+Shift+S 并横幅告知(诚实降级不静默)。
let _registeredHotkey = ''
function _hotkey() {
	const v = petSettings.captureHotkey
	return (typeof v === 'string' && v.trim()) ? v.trim() : 'Alt+Shift+S'
}
function applyCaptureHotkey() {
	const want = _hotkey()
	if (want === _registeredHotkey) return
	if (_registeredHotkey) { try { globalShortcut.unregister(_registeredHotkey) } catch {} }
	_registeredHotkey = ''
	let ok = false
	try { ok = globalShortcut.register(want, () => { console.log('[desktop-eye] ' + want + ' 触发'); startCropCapture() }) } catch { ok = false }
	if (ok) { _registeredHotkey = want; return }
	console.error('[desktop-eye] 快捷键注册失败:', want)
	if (want !== 'Alt+Shift+S') {
		try { if (globalShortcut.register('Alt+Shift+S', () => startCropCapture())) _registeredHotkey = 'Alt+Shift+S' } catch {}
		_showOrbBanner('截图快捷键「' + want + '」注册失败(格式非法或被占用),已回退 Alt+Shift+S')
	}
}
// 悬浮对话快捷键(凛倾 0722"绑定一个按键可以快速召唤悬浮对话"):petSettings.menuHotkey 可配,
// 缺省 Alt+Shift+D;注册失败回退默认并气泡提示(与截图快捷键同范式)。
let _registeredMenuHotkey = ''
function _menuHotkey() {
	const v = petSettings.menuHotkey
	return (typeof v === 'string' && v.trim()) ? v.trim() : 'Alt+Shift+D'
}
function applyMenuHotkey() {
	const want = _menuHotkey()
	if (want === _registeredMenuHotkey) return
	if (_registeredMenuHotkey) { try { globalShortcut.unregister(_registeredMenuHotkey) } catch {} }
	_registeredMenuHotkey = ''
	let ok = false
	try { ok = globalShortcut.register(want, () => togglePetMenu()) } catch { ok = false }
	if (ok) { _registeredMenuHotkey = want; return }
	console.error('[desktop-eye] 悬浮对话快捷键注册失败:', want)
	if (want !== 'Alt+Shift+D') {
		try { if (globalShortcut.register('Alt+Shift+D', () => togglePetMenu())) _registeredMenuHotkey = 'Alt+Shift+D' } catch {}
		_showOrbBanner('悬浮对话快捷键「' + want + '」注册失败(格式非法或被占用),已回退 Alt+Shift+D')
	}
}
// 快速语音发送快捷键：第一次开始录音，第二次停止、转写并自动送入陪伴主链。
let _registeredQuickVoiceHotkey = ''
function _quickVoiceHotkey() {
	const v = petSettings.voiceQuickHotkey
	return typeof v === 'string' ? v.trim() : PET_SETTINGS_DEFAULT.voiceQuickHotkey
}
function applyQuickVoiceHotkey() {
	const want = _quickVoiceHotkey()
	if (want === _registeredQuickVoiceHotkey) return
	if (!want) {
		if (_registeredQuickVoiceHotkey) { try { globalShortcut.unregister(_registeredQuickVoiceHotkey) } catch {} }
		_registeredQuickVoiceHotkey = ''
		_showOrbBanner('快速语音全局快捷键已关闭；仍可点击对话台麦克风使用')
		return
	}
	const previous = _registeredQuickVoiceHotkey
	let ok = false
	try { ok = globalShortcut.register(want, () => _toggleQuickVoice()) } catch { ok = false }
	if (ok) {
		if (previous) { try { globalShortcut.unregister(previous) } catch {} }
		_registeredQuickVoiceHotkey = want
		_showOrbBanner('快速语音快捷键已设为 ' + want)
		return
	}
	console.error('[desktop-eye] 快速语音快捷键注册失败:', want)
	_showOrbBanner('快速语音快捷键「' + want + '」注册失败（格式非法或已被占用）' +
		(previous ? '；仍保留 ' + previous : '；当前没有全局快捷键'))
}
function registerShortcuts() { applyCaptureHotkey(); applyMenuHotkey(); applyQuickVoiceHotkey() }

// ============================================================
// 截图 + 框选
// ============================================================

async function startCropCapture() {
	if (cropWindow) {
		cropWindow.close()
		cropWindow = null
	}

	// 框选开始时抓前台窗口标题(发送时前台已是发送对话框自己,只有此刻标题真实):
	// 后端安全门 fail-closed——用户配了黑/白名单后 window_title 必填,缺失=手动截图也被 400 拒。
	try { _lastCaptureTitle = require('./autoCapture.js')._getForegroundTitle() } catch { _lastCaptureTitle = '' }

	try {
		const primaryDisplay = screen.getPrimaryDisplay()
		const displaySize = primaryDisplay.size
		const scaleFactor = primaryDisplay.scaleFactor

		const sources = await desktopCapturer.getSources({
			types: ['screen'],
			thumbnailSize: {
				width: Math.round(displaySize.width * scaleFactor),
				height: Math.round(displaySize.height * scaleFactor),
			},
		})

		if (!sources || sources.length === 0) {
			console.error('[desktop-eye] 无法获取桌面截图源')
			return
		}

		const thumbnail = sources[0].thumbnail
		if (thumbnail.isEmpty()) {
			console.error('[desktop-eye] 截图为空')
			return
		}

		currentScreenshot = thumbnail.toDataURL()
		createCropWindow(displaySize.width, displaySize.height)
	} catch (err) {
		console.error('[desktop-eye] 截图失败:', err)
	}
}

function createCropWindow(w, h) {
	cropWindow = new BrowserWindow({
		x: 0,
		y: 0,
		width: w,
		height: h,
		fullscreen: true,
		frame: false,
		transparent: false,
		alwaysOnTop: true,
		skipTaskbar: true,
		resizable: false,
		movable: false,
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			contextIsolation: true,
			nodeIntegration: false,
		},
	})

	cropWindow.loadFile(path.join(__dirname, 'renderer', 'capture.html'))
	cropWindow.setMenuBarVisibility(false)

	cropWindow.webContents.on('did-finish-load', () => {
		cropWindow.webContents.send('set-screenshot', currentScreenshot)
	})

	cropWindow.on('closed', () => {
		cropWindow = null
	})
}

// ============================================================
// IPC
// ============================================================

ipcMain.on('crop-done', (event, cropData) => {
	if (cropWindow) {
		cropWindow.close()
		cropWindow = null
	}
	if (cropData && cropData.dataUrl) {
		openSendDialog(cropData.dataUrl)
	}
})

ipcMain.on('crop-cancel', () => {
	if (cropWindow) {
		cropWindow.close()
		cropWindow = null
	}
})

ipcMain.handle('send-screenshot', async (_event, data) => {
	// 由 renderer 等待真实后端回执；失败时保留窗口、截图和输入，用户可直接重试。
	// 旧 on 通道先关窗再 await，插件接线一抖就把唯一草稿和截图一起丢失。
	return await sendToBeilu(data?.imageBase64 || '', data?.message || '', data?.mode || 'active')
})

ipcMain.on('send-cancel', () => {
	if (dialogWindow) {
		dialogWindow.close()
		dialogWindow = null
	}
})

// ============================================================
// 发送对话框
// ============================================================

function openSendDialog(imageDataUrl) {
	if (dialogWindow) dialogWindow.close()

	const primaryDisplay = screen.getPrimaryDisplay()
	const workArea = primaryDisplay.workAreaSize

	dialogWindow = new BrowserWindow({
		width: 480,
		height: 520,
		x: Math.round(workArea.width / 2 - 240),
		y: Math.round(workArea.height / 2 - 260),
		frame: false,
		alwaysOnTop: true,
		skipTaskbar: true,
		resizable: false,
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			contextIsolation: true,
			nodeIntegration: false,
		},
	})

	dialogWindow.loadFile(path.join(__dirname, 'renderer', 'dialog.html'))
	dialogWindow.setMenuBarVisibility(false)

	dialogWindow.webContents.on('did-finish-load', () => {
		dialogWindow.webContents.send('set-preview', imageDataUrl)
	})

	dialogWindow.on('closed', () => {
		dialogWindow = null
	})
}

// ============================================================
// HTTP 发送到 beilu
// ============================================================

function sendToBeilu(imageBase64, message, mode) {
	return new Promise((resolve, reject) => {
		const base64Data = imageBase64.includes(',')
			? imageBase64.split(',')[1]
			: imageBase64

		const body = JSON.stringify({
			image: base64Data,
			message: message || '',
			mode: mode || 'active',
			// 框选开始时抓的前台窗口标题(安全门 fail-closed:配名单后必填;空串=没抓到,门按缺失拒,不编造)
			window_title: _lastCaptureTitle || undefined,
		})

		const options = {
			hostname: BEILU_HOST,
			port: BEILU_PORT,
			path: INJECT_ENDPOINT,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(body),
				'x-pet-token': PET_TOKEN,  // A4: inject per-user 鉴权令牌(缺失→端点 403)
			},
			timeout: 10000,
		}

		const req = http.request(options, (res) => {
			let responseData = ''
			res.on('data', (chunk) => { responseData += chunk })
			res.on('end', () => {
				let payload = null
				try { payload = JSON.parse(responseData) } catch { /* 非 JSON 不能证明注入成功 */ }
				const statusOk = Number(res.statusCode) >= 200 && Number(res.statusCode) < 300
				if (statusOk && payload?.success === true && payload?.blocked !== true) {
					console.log('[desktop-eye] 截图已发送到 beilu，模式:', mode)
					if (Notification.isSupported()) {
						const notifyBody = mode === 'passive'
							? '✦ 截图已分享'
							: '✦ 已发送，等待回复...'
						new Notification({
							title: '桌面截图',
							body: notifyBody,
							silent: true,
						}).show()
					}
					resolve(payload)
				} else {
					const detail = payload?.reason || payload?.error || payload?.message || responseData || ('HTTP ' + res.statusCode)
					console.error('[desktop-eye] 发送失败:', res.statusCode, detail)
					reject(new Error('截图注入未确认成功: ' + detail))
				}
			})
		})

		req.on('error', (err) => {
			console.error('[desktop-eye] 截图未送达主服务:', err.message)
			reject(new Error('截图未送达主服务: ' + err.message))
		})

		req.on('timeout', () => {
			req.destroy()
			reject(new Error('截图注入等待超时'))
		})

		req.write(body)
		req.end()
	})
}
