/**
 * 桌面截图 — Preload 脚本
 * 通过 contextBridge 暴露安全的 IPC 通道给渲染进程
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopEye', {
	// 截图框选完成 → 通知主进程
	cropDone: (cropData) => ipcRenderer.send('crop-done', cropData),
	// 取消框选
	cropCancel: () => ipcRenderer.send('crop-cancel'),
	// 发送截图到 beilu 后端
	sendScreenshot: (data) => ipcRenderer.send('send-screenshot', data),
	// 取消发送
	sendCancel: () => ipcRenderer.send('send-cancel'),

	// 接收主进程消息
	onSetScreenshot: (callback) => {
		ipcRenderer.on('set-screenshot', (_event, dataUrl) => callback(dataUrl))
	},
	onSetPreview: (callback) => {
		ipcRenderer.on('set-preview', (_event, dataUrl) => callback(dataUrl))
	},

	// 桌宠角色窗：上报模型原始画布宽高比(主进程按角色比例 resize 窗口)。
	reportPetRatio: (ratio) => ipcRenderer.send('pet-ratio', ratio),
	// 桌宠角色窗：接收主进程推来的 {emotion, text}(驱动表情/口型)。
	onPetDrive: (callback) => {
		ipcRenderer.on('pet-drive', (_event, payload) => callback(payload))
	},
	// 桌宠对话框窗：接收主进程推来的文本(显示气泡)。
	onBubbleText: (callback) => {
		ipcRenderer.on('bubble-text', (_event, text) => callback(text))
	},
	// 桌宠对话框窗：接收用户设置(透明度/停留时间)。
	onBubbleConfig: (callback) => {
		ipcRenderer.on('bubble-config', (_event, cfg) => callback(cfg))
	},

	// 桌宠角色【移动/缩放】(命中测试在角色页判定，主进程执行)。
	setPetInteractive: (on) => ipcRenderer.send('pet-interactive', !!on),
	// 角色实际命中盒上报(2026-07-12 框架修):本机 forward:true 不转发 mousemove(实测探针 count=0),
	// renderer 侧命中检测收不到事件 → 改由主进程光标轮询判命中,判据=此处上报的角色边界(窗口内 client px;null=无内容)。
	reportPetHitRect: (r) => ipcRenderer.send('pet-hit-rect', r || null),
	// 像素级命中二级判定(T3):主进程光标在命中盒内时下发探针{x,y}(窗内 client px)→渲染层回报该点
	// true 不透明/false 透明/null 无法判定(主进程降级按包围盒)。
	onPetPixelProbe: (callback) => { ipcRenderer.on('pet-pixel-probe', (_event, p) => callback(p)) },
	reportPetPixelHit: (opaque) => ipcRenderer.send('pet-pixel-hit', opaque === true ? true : (opaque === false ? false : null)),
	petDragStart: (sx, sy, mode) => ipcRenderer.send('pet-drag-start', { sx, sy, mode: mode === 'scale' ? 'scale' : 'move' }), // mode:'move'整组移动/'scale'=Ctrl+拖缩放
	petDragMove: (sx, sy) => ipcRenderer.send('pet-drag-move', { sx, sy }),
	petDragEnd: () => ipcRenderer.send('pet-drag-end'),
	petScale: (dir) => ipcRenderer.send('pet-scale', dir),
	// 角色右键 → 主进程弹快捷设置菜单。
	petContextMenu: () => ipcRenderer.send('pet-context-menu'),
	// 触碰热区 say 台词 → 主进程气泡显示(长度限值唯一执行点=web 编辑器 maxlength,此处不复制限值)。
	petHitSay: (text) => ipcRenderer.send('pet-hit-say', String(text || '')),
	// 触碰热区 send → 主进程 POST beilu /api/eye/pet-message(用户预设内容发给 AI,回应走气泡链)。
	petHitSend: (text) => ipcRenderer.send('pet-hit-send', String(text || '')),
	// 游戏穿透态变更 → 角色页停/启命中测试。
	onPetPassthrough: (callback) => {
		ipcRenderer.on('pet-passthrough', (_event, on) => callback(!!on))
	},
	// 角色窗配置(待机表情自定义)运行时变更。
	onPetConfig: (callback) => {
		ipcRenderer.on('pet-config', (_event, cfg) => callback(cfg))
	},
	// 渲染层就绪后主动拉当前配置:initLive2dRenderer 加载模型耗时数秒,期间 onPetConfig 监听器尚未注册,
	//   启动时 _initPetSettingsFromBeilu 的 push 会丢;就绪后 pull 一次补回(此时主进程已完成后端对账)。
	requestPetConfig: () => ipcRenderer.send('request-pet-config'),

	// 悬浮设置菜单(凛倾 2026-07-12 参考游戏标签条):单动作通道 + 初始化推送 + 角色双击开关。
	petMenuAction: (action, value) => ipcRenderer.send('pet-menu-action', { action, value }),
	onPetMenuInit: (callback) => { ipcRenderer.on('pet-menu-init', (_event, cfg) => callback(cfg)) },
	petMenuToggle: () => ipcRenderer.send('pet-menu-toggle'),

	// 语音输入(凛倾 0722 完整链):'start'/'stop' → 主进程直连本机 STT 服务录音+转文字;
	// 结果经 'stt-result' 回本窗({phase:'recording'|'transcribing'|'done'|'error', text?, error?})。
	sttRecord: (cmd) => ipcRenderer.send('stt-record', String(cmd || '')),
	onSttResult: (callback) => { ipcRenderer.on('stt-result', (_event, r) => callback(r)) },
	// 悬浮对话窗:AI 回应同步进对话区(T9 凛倾 0722;与气泡同源 _showOrbBanner 单一出口)。
	onPetChatReply: (callback) => { ipcRenderer.on('pet-chat-reply', (_event, text) => callback(text)) },
})