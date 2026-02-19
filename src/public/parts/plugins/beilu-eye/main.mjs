import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import info from './info.json' with { type: 'json' }
import { consumePendingInjection, hasPendingInjection, setPendingInjection } from './injection_state.mjs'

// ============================================================
// beilu-eye 插件 — 桌面截图临时注入
//
// 职责：
// - 自动启动/管理 Electron 桌面截图客户端
// - 接收来自 Electron 的截图数据（通过 beilu-chat 端点 → 共享状态）
// - GetPrompt: 将截图作为一次性临时上下文注入给 AI
// - 截图在 AI 看到一次后自动清除，不留在聊天记录或后续上下文中
// ============================================================

// 路径计算
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// beilu-eye 位于 src/public/parts/plugins/beilu-eye/
// 项目根目录在 5 层之上
const projectRoot = resolve(__dirname, '..', '..', '..', '..', '..', '..')
const desktopEyeDir = resolve(projectRoot, 'desktop-eye')

// Electron 子进程
let electronProcess = null
let electronStatus = 'stopped' // 'stopped' | 'installing' | 'starting' | 'running' | 'error'
let electronError = null

/**
 * 检查 desktop-eye 目录是否存在
 */
async function checkDesktopEyeExists() {
	try {
		await Deno.stat(desktopEyeDir)
		return true
	} catch {
		return false
	}
}

/**
 * 检查是否已安装依赖
 */
async function checkNodeModules() {
	try {
		await Deno.stat(resolve(desktopEyeDir, 'node_modules'))
		return true
	} catch {
		return false
	}
}

/**
 * 执行 npm install
 */
async function installDependencies() {
	electronStatus = 'installing'
	console.log('[beilu-eye] 首次启动，安装 Electron 依赖（这可能需要几分钟）...')

	try {
		const isWindows = Deno.build.os === 'windows'
		const cmd = isWindows ? 'cmd' : 'sh'
		const args = isWindows ? ['/c', 'npm install'] : ['-c', 'npm install']

		const command = new Deno.Command(cmd, {
			args,
			cwd: desktopEyeDir,
			stdout: 'piped',
			stderr: 'piped',
		})

		const result = await command.output()

		if (result.success) {
			console.log('[beilu-eye] Electron 依赖安装完成')
			return true
		} else {
			const stderr = new TextDecoder().decode(result.stderr)
			console.error('[beilu-eye] npm install 失败:', stderr.substring(0, 500))
			electronError = 'npm install 失败'
			electronStatus = 'error'
			return false
		}
	} catch (err) {
		console.error('[beilu-eye] npm install 执行失败:', err.message)
		electronError = err.message
		electronStatus = 'error'
		return false
	}
}

/**
 * 启动 Electron 子进程
 */
async function launchElectron() {
	electronStatus = 'starting'
	console.log('[beilu-eye] 启动 Electron 桌面截图工具...')

	try {
		const isWindows = Deno.build.os === 'windows'
		const cmd = isWindows ? 'cmd' : 'sh'
		const args = isWindows ? ['/c', 'npx electron .'] : ['-c', 'npx electron .']

		const command = new Deno.Command(cmd, {
			args,
			cwd: desktopEyeDir,
			stdout: 'piped',
			stderr: 'piped',
		})

		electronProcess = command.spawn()
		electronStatus = 'running'
		console.log('[beilu-eye] Electron 桌面截图工具已启动 (PID:', electronProcess.pid, ')')

		// 异步监听进程退出
		electronProcess.status.then((status) => {
			console.log('[beilu-eye] Electron 进程已退出, code:', status.code)
			electronProcess = null
			electronStatus = 'stopped'
		}).catch(() => {
			electronProcess = null
			electronStatus = 'stopped'
		})

		// 异步读取 stdout/stderr（不阻塞）
		pipeOutput(electronProcess.stdout, '[desktop-eye]')
		pipeOutput(electronProcess.stderr, '[desktop-eye ERR]')

	} catch (err) {
		console.error('[beilu-eye] Electron 启动失败:', err.message)
		electronError = err.message
		electronStatus = 'error'
		electronProcess = null
	}
}

/**
 * 异步管道输出（非阻塞）
 */
async function pipeOutput(stream, prefix) {
	try {
		const reader = stream.getReader()
		const decoder = new TextDecoder()
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			const text = decoder.decode(value, { stream: true }).trim()
			if (text) console.log(prefix, text)
		}
	} catch { /* 进程已结束 */ }
}

/**
 * 关闭 Electron 子进程
 */
function killElectron() {
	if (electronProcess) {
		try {
			electronProcess.kill('SIGTERM')
		} catch { /* ignore */ }
		electronProcess = null
		electronStatus = 'stopped'
		console.log('[beilu-eye] Electron 进程已终止')
	}
}

// ============================================================
// 插件导出
// ============================================================

export default {
	info,
	Load: async () => {
		console.log('[beilu-eye] 贝露的眼睛插件已加载')

		// 自动启动 Electron 桌面截图工具
		const exists = await checkDesktopEyeExists()
		if (!exists) {
			console.warn('[beilu-eye] desktop-eye 目录不存在:', desktopEyeDir)
			console.warn('[beilu-eye] 桌面截图功能不可用，但浏览器内粘贴功能仍可使用')
			return
		}

		// 检查并安装依赖
		const hasModules = await checkNodeModules()
		if (!hasModules) {
			const installed = await installDependencies()
			if (!installed) {
				console.warn('[beilu-eye] 依赖安装失败，桌面截图功能不可用')
				console.warn('[beilu-eye] 浏览器内 Ctrl+V 粘贴截图功能仍可正常使用')
				return
			}
		}

		// 启动 Electron
		await launchElectron()
	},

	Unload: async () => {
		killElectron()
		console.log('[beilu-eye] 贝露的眼睛插件已卸载')
	},

	interfaces: {
		config: {
			GetData: async () => ({
				hasPending: hasPendingInjection(),
				electronStatus,
				electronError,
				desktopEyeDir,
				description: '贝露的眼睛 — 桌面截图临时注入插件',
			}),
			/**
			 * SetData 同时作为截图注入的接收入口 + Electron 进程控制
			 */
			SetData: async (data) => {
				if (!data) return

				if (data._action === 'inject') {
					if (!data.image) {
						console.warn('[beilu-eye] inject 缺少 image 字段')
						return
					}
					setPendingInjection({
						image: data.image,
						message: data.message || '',
					})
					return
				}

				if (data._action === 'clear') {
					consumePendingInjection()
					console.log('[beilu-eye] 待注入数据已手动清除')
					return
				}

				if (data._action === 'restart-electron') {
					killElectron()
					await launchElectron()
					return
				}

				if (data._action === 'stop-electron') {
					killElectron()
					return
				}
			},
		},
		chat: {
			/**
			 * GetPrompt: 一次性临时注入截图到 AI 上下文
			 */
			GetPrompt: async (arg) => {
				const injection = consumePendingInjection()
				if (!injection) return null

				console.log('[beilu-eye] 注入截图到 AI 上下文（一次性）')

				const result = {
					text: [],
					additional_chat_log: [],
					extension: {},
				}

				// 文本描述
				let description = '[用户通过桌面截图分享了屏幕内容]'
				if (injection.message) {
					description += '\n用户说：' + injection.message
				}

				result.text.push({
					content: description,
					description: '贝露的眼睛 — 桌面截图（一次性临时注入，不保存在聊天记录中）',
					important: 5,
				})
				// 截图作为图片附件注入到 chat_log 中（让多模态 AI 看到）
				result.additional_chat_log.push({
					role: 'user',
					name: arg?.UserCharname || 'user',
					content: injection.message || '[桌面截图]',
					time_stamp: injection.timestamp,
					files: [{
						name: `desktop_screenshot_${injection.timestamp}.jpg`,
						mime_type: 'image/jpeg',
						buffer: globalThis.Buffer
							? globalThis.Buffer.from(injection.image, 'base64')
							: new Uint8Array(atob(injection.image).split('').map(c => c.charCodeAt(0))),
						description: '来自桌面截图工具的屏幕捕获',
					}],
					extension: {},
				})

				return result
			},
		},
	},
}