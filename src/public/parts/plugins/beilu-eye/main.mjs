import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import info from './info.json' with { type: 'json' }
import { consumePendingInjection, hasPendingInjection, setPendingInjection } from './injection_state.mjs'

// ============================================================
// beilu-eye 插件 — 桌面截图临时注入
//
// 职责：
// - 自动启动/管理 Python 桌面截图客户端
// - 接收来自 Python 脚本的截图数据（通过 /api/eye/inject → 共享状态）
// - GetPrompt: 将截图作为一次性临时上下文注入给 AI
// - 截图在 AI 看到一次后自动清除，不留在聊天记录或后续上下文中
// ============================================================

// 路径计算
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// beilu-eye 位于 src/public/parts/plugins/beilu-eye/
// 项目根目录(beilu-always accompany)在 5 层之上：
//   beilu-eye → plugins → parts → public → src → [项目根]
const projectRoot = resolve(__dirname, '..', '..', '..', '..', '..')
const desktopEyeDir = resolve(projectRoot, 'desktop-eye')
const pythonScript = resolve(desktopEyeDir, 'beilu_eye.py')

// Python 子进程
let eyeProcess = null
let eyeStatus = 'stopped' // 'stopped' | 'checking' | 'starting' | 'running' | 'error'
let eyeError = null

/**
 * 检查 Python 脚本是否存在
 */
async function checkPythonScriptExists() {
	try {
		await Deno.stat(pythonScript)
		return true
	} catch {
		return false
	}
}

/**
 * 检查 Python 及所需依赖是否可用
 */
async function checkPythonDeps() {
	eyeStatus = 'checking'
	try {
		const isWindows = Deno.build.os === 'windows'
		const pythonCmd = isWindows ? 'python' : 'python3'
		const command = new Deno.Command(pythonCmd, {
			args: ['-c', 'import mss, pystray, keyboard; from PIL import Image; print("OK")'],
			stdout: 'piped',
			stderr: 'piped',
		})
		const result = await command.output()
		const stdout = new TextDecoder().decode(result.stdout).trim()
		if (result.success && stdout === 'OK') {
			return true
		}
		// 依赖缺失，尝试自动安装
		console.log('[beilu-eye] Python 依赖缺失，自动安装...')
		const installCmd = new Deno.Command(pythonCmd, {
			args: ['-m', 'pip', 'install', 'mss', 'Pillow', 'pystray', 'keyboard'],
			stdout: 'piped',
			stderr: 'piped',
		})
		const installResult = await installCmd.output()
		if (installResult.success) {
			console.log('[beilu-eye] Python 依赖安装完成')
			return true
		}
		const stderr = new TextDecoder().decode(installResult.stderr)
		console.error('[beilu-eye] pip install 失败:', stderr.substring(0, 500))
		eyeError = 'pip install 失败'
		eyeStatus = 'error'
		return false
	} catch (err) {
		console.error('[beilu-eye] Python 检查失败:', err.message)
		eyeError = 'Python 不可用: ' + err.message
		eyeStatus = 'error'
		return false
	}
}

/**
 * 启动 Python 桌面截图工具
 */
async function launchPythonEye() {
	eyeStatus = 'starting'
	console.log('[beilu-eye] 启动 Python 桌面截图工具...')

	try {
		const isWindows = Deno.build.os === 'windows'
		// 使用 python（非 pythonw），因为 pythonw 下 pystray 托盘和 tkinter 悬浮球无法显示
		const pythonCmd = isWindows ? 'python' : 'python3'

		const command = new Deno.Command(pythonCmd, {
			args: [pythonScript],
			cwd: desktopEyeDir,
			stdout: 'piped',
			stderr: 'piped',
			// 注意: 不使用 windowsRawArguments，让 Deno 自动处理路径中的空格引号
		})

		eyeProcess = command.spawn()
		eyeStatus = 'running'
		console.log('[beilu-eye] Python 桌面截图工具已启动 (PID:', eyeProcess.pid, ')')

		// 异步监听进程退出
		eyeProcess.status.then((status) => {
			console.log('[beilu-eye] Python 进程已退出, code:', status.code)
			eyeProcess = null
			eyeStatus = 'stopped'
		}).catch(() => {
			eyeProcess = null
			eyeStatus = 'stopped'
		})

		// 异步读取 stdout/stderr（不阻塞）
		pipeOutput(eyeProcess.stdout, '[desktop-eye]')
		pipeOutput(eyeProcess.stderr, '[desktop-eye ERR]')

	} catch (err) {
		console.error('[beilu-eye] Python 启动失败:', err.message)
		eyeError = err.message
		eyeStatus = 'error'
		eyeProcess = null
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
 * 关闭 Python 子进程
 * Windows 上必须用 SIGKILL（映射到 TerminateProcess），
 * 因为 SIGTERM 不会终止 tkinter mainloop 的 GUI 进程
 */
function killPythonEye() {
	if (eyeProcess) {
		try {
			// Windows 上 SIGTERM 无法终止 tkinter GUI 进程
			// 使用 SIGKILL（在 Windows 上映射为 TerminateProcess）
			eyeProcess.kill('SIGKILL')
		} catch { /* ignore */ }
		eyeProcess = null
		eyeStatus = 'stopped'
		console.log('[beilu-eye] Python 进程已终止')
	}
}

/**
 * 确保 Python 桌面截图工具已启动
 * 调用时机：Load()（打开角色卡 / 进入聊天时）
 */
async function ensurePythonEyeRunning() {
	// 如果已经在运行就跳过
	if (eyeProcess && eyeStatus === 'running') {
		console.log('[beilu-eye] Python 进程已在运行 (PID:', eyeProcess.pid, ')，跳过重复启动')
		return
	}

	console.log('[beilu-eye] 检查 Python 桌面截图工具...')

	const scriptExists = await checkPythonScriptExists()
	if (!scriptExists) {
		console.warn('[beilu-eye] Python 脚本不存在:', pythonScript)
		console.warn('[beilu-eye] 桌面截图功能不可用')
		return
	}

	const depsOk = await checkPythonDeps()
	if (!depsOk) {
		console.warn('[beilu-eye] Python 依赖不可用，桌面截图功能不可用')
		return
	}

	await launchPythonEye()
}

// ============================================================
// 模块顶层自启动
// beilu-eye 是全局服务型插件，不依赖特定角色卡
// shallowLoadDefaultPartsForUser 只调 import 不调 Load()
// 所以需要在 import 时自启动
// ============================================================

setTimeout(() => {
	ensurePythonEyeRunning().catch(err => {
		console.error('[beilu-eye] 自启动失败:', err.message)
	})
}, 3000)

// ============================================================
// 插件导出
// ============================================================

export default {
	info,
	Load: async () => {
		console.log('[beilu-eye] Load() — 角色卡打开，重启 Python 桌面截图进程')

		// 每次角色切换都重启，确保进程绑定到当前角色生命周期
		killPythonEye()
		await ensurePythonEyeRunning()
	},

	Unload: async () => {
		// 角色卡退出时终止 Python 进程
		killPythonEye()
		console.log('[beilu-eye] Unload() — 角色卡退出，Python 进程已关闭')
	},

	interfaces: {
		config: {
			GetData: async () => ({
				hasPending: hasPendingInjection(),
				eyeStatus,
				eyeError,
				desktopEyeDir,
				description: '贝露的眼睛 — 桌面截图工具 (Python)，截图通过 files 路径直接发送给 AI',
			}),
			/**
			 * SetData 同时作为截图注入的接收入口 + 进程控制
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
						mode: data.mode || 'passive',
					})
					return
				}

				if (data._action === 'clear') {
					consumePendingInjection()
					console.log('[beilu-eye] 待注入数据已手动清除')
					return
				}

				if (data._action === 'restart') {
					killPythonEye()
					await launchPythonEye()
					return
				}

				if (data._action === 'stop') {
					killPythonEye()
					return
				}
			},
		},
		// GetPrompt 已移除 — 截图改为通过前端 pollEyeStatus → addUserReply(files) 路径发送
		// 与浏览器上传图片完全相同的管线，AI 可以直接看到图片内容
	},
}