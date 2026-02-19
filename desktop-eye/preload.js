/**
 * 贝露的眼睛 — Preload 脚本
 * 通过 contextBridge 暴露安全的 IPC 通道给渲染进程
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopEye', {
	// 悬浮球 → 触发截图
	startCapture: () => ipcRenderer.send('start-capture'),
	// 悬浮球 → 右键菜单
	showOrbMenu: () => ipcRenderer.send('show-orb-menu'),
	// 截图框选完成 → 通知主进程
	cropDone: (cropData) => ipcRenderer.send('crop-done', cropData),
	// 取消框选
	cropCancel: () => ipcRenderer.send('crop-cancel'),
	// 发送截图到 Fount
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
})