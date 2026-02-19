/**
 * 贝露的眼睛 — 桌面截图工具 (Electron 主进程)
 *
 * 功能：
 * 1. 系统托盘 ✦ 图标
 * 2. 全局快捷键 Alt+Shift+S 触发框选截图
 * 3. 桌面全屏截图 → 透明窗口框选 → 裁剪 → 发送对话框
 * 4. HTTP POST 发送到 Fount 后端 (localhost:1314)
 */

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
} = require('electron')
const path = require('path')
const http = require('http')

// ============================================================
// 配置
// ============================================================

const FOUNT_PORT = 1314
const FOUNT_HOST = 'localhost'
const INJECT_ENDPOINT = '/api/parts/shells:beilu-chat/eye/inject'

// ============================================================
// 全局变量
// ============================================================

let tray = null
let orbWindow = null
let cropWindow = null
let dialogWindow = null
let currentScreenshot = null

// ============================================================
// 应用初始化
// ============================================================

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
	console.log('[desktop-eye] 已有实例运行，退出')
	app.quit()
}
app.whenReady().then(() => {
	if (app.dock) app.dock.hide()
	createTray()
	createOrbWindow()
	registerShortcuts()
	console.log('[desktop-eye] 贝露的眼睛已启动')
	console.log('[desktop-eye] 悬浮球已显示，快捷键: Alt+Shift+S')
})

app.on('will-quit', () => {
	globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
	// 不退出，保持托盘
})

// ============================================================
// 系统托盘
// ============================================================

function createTray() {
	const trayIcon = createDefaultIcon()
	tray = new Tray(trayIcon)
	tray.setToolTip('贝露的眼睛 ✦')

	const contextMenu = Menu.buildFromTemplate([
		{
			label: '框选截图  (Alt+Shift+S)',
			click: () => startCropCapture(),
		},
		{ type: 'separator' },
		{
			label: '关于',
			click: () => {
				dialog.showMessageBox({
					type: 'info',
					title: '贝露的眼睛',
					message: '贝露的眼睛 v0.1.0\n桌面截图 → 临时注入 AI 上下文\n\n快捷键: Alt+Shift+S',
					buttons: ['好的'],
				})
			},
		},
		{ type: 'separator' },
		{
			label: '退出',
			click: () => app.quit(),
		},
	])

	tray.setContextMenu(contextMenu)
	tray.on('click', () => startCropCapture())
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
// 桌面悬浮球窗口
// ============================================================

function createOrbWindow() {
	if (orbWindow) return

	const primaryDisplay = screen.getPrimaryDisplay()
	const workArea = primaryDisplay.workAreaSize

	orbWindow = new BrowserWindow({
		width: 52,
		height: 52,
		x: workArea.width - 72,
		y: workArea.height - 120,
		frame: false,
		transparent: true,
		alwaysOnTop: true,
		skipTaskbar: true,
		resizable: false,
		hasShadow: false,
		focusable: false,
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			contextIsolation: true,
			nodeIntegration: false,
		},
	})

	orbWindow.loadFile(path.join(__dirname, 'renderer', 'orb.html'))
	orbWindow.setMenuBarVisibility(false)
	// 允许鼠标穿透圆形区域外的透明部分
	orbWindow.setIgnoreMouseEvents(false)

	orbWindow.on('closed', () => {
		orbWindow = null
	})

	console.log('[desktop-eye] 悬浮球窗口已创建')
}

// ============================================================
// 快捷键
// ============================================================

function registerShortcuts() {
	const ok = globalShortcut.register('Alt+Shift+S', () => {
		console.log('[desktop-eye] Alt+Shift+S 触发')
		startCropCapture()
	})
	if (!ok) {
		console.error('[desktop-eye] Alt+Shift+S 注册失败')
	}
}

// ============================================================
// 截图 + 框选
// ============================================================

async function startCropCapture() {
	if (cropWindow) {
		cropWindow.close()
		cropWindow = null
	}

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

// 悬浮球点击 → 触发截图
ipcMain.on('start-capture', () => {
	startCropCapture()
})

// 悬浮球右键 → 显示菜单
ipcMain.on('show-orb-menu', () => {
	const contextMenu = Menu.buildFromTemplate([
		{
			label: '框选截图  (Alt+Shift+S)',
			click: () => startCropCapture(),
		},
		{ type: 'separator' },
		{
			label: '关于',
			click: () => {
				dialog.showMessageBox({
					type: 'info',
					title: '贝露的眼睛',
					message: '贝露的眼睛 v0.1.0\n桌面截图 → 临时注入 AI 上下文\n\n• 点击悬浮球截图\n• 快捷键: Alt+Shift+S',
					buttons: ['好的'],
				})
			},
		},
		{ type: 'separator' },
		{
			label: '退出',
			click: () => app.quit(),
		},
	])
	if (orbWindow) {
		contextMenu.popup({ window: orbWindow })
	}
})

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

ipcMain.on('send-screenshot', async (event, data) => {
	if (dialogWindow) {
		dialogWindow.close()
		dialogWindow = null
	}
	await sendToFount(data.imageBase64, data.message, data.mode || 'active')
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
// HTTP 发送到 Fount
// ============================================================

function sendToFount(imageBase64, message, mode) {
	return new Promise((resolve, reject) => {
		const base64Data = imageBase64.includes(',')
			? imageBase64.split(',')[1]
			: imageBase64

		const body = JSON.stringify({
			image: base64Data,
			message: message || '',
			mode: mode || 'active',
		})

		const options = {
			hostname: FOUNT_HOST,
			port: FOUNT_PORT,
			path: INJECT_ENDPOINT,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(body),
			},
			timeout: 10000,
		}

		const req = http.request(options, (res) => {
			let responseData = ''
			res.on('data', (chunk) => { responseData += chunk })
			res.on('end', () => {
				if (res.statusCode === 200) {
					console.log('[desktop-eye] 截图已发送到 Fount，模式:', mode)
					if (Notification.isSupported()) {
						const notifyBody = mode === 'passive'
							? '✦ 截图已分享给贝露'
							: '✦ 已发送给贝露，等她回复...'
						new Notification({
							title: '贝露的眼睛',
							body: notifyBody,
							silent: true,
						}).show()
					}
					resolve(responseData)
				} else {
					console.error('[desktop-eye] 发送失败:', res.statusCode, responseData)
					showErrorNotification('发送失败: ' + res.statusCode)
					reject(new Error('HTTP ' + res.statusCode + ': ' + responseData))
				}
			})
		})

		req.on('error', (err) => {
			console.error('[desktop-eye] 连接 Fount 失败:', err.message)
			showErrorNotification('连接失败，请确认 Fount 正在运行')
			reject(err)
		})

		req.on('timeout', () => {
			req.destroy()
			showErrorNotification('连接超时')
			reject(new Error('Timeout'))
		})

		req.write(body)
		req.end()
	})
}

function showErrorNotification(msg) {
	if (Notification.isSupported()) {
		new Notification({
			title: '贝露的眼睛 — 错误',
			body: msg,
		}).show()
	}
}