import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'

import { VirtualConsole } from 'npm:@steve02081504/virtual-console'

import { console, geti18n } from '../../scripts/i18n.mjs'
import { getLoadedPartList, getPartDetails, getPartList, loadPart } from '../parts_loader.mjs'
import { data_path, restartor } from '../server.mjs'

// beilu: 与其他 beilu 实例隔离。沙箱实例(BEILU_SANDBOX=1)用独立 IPC 端口,否则与 prod 同抢 16700→EADDRINUSE
// 被误判"另一个实例正在运行"而无法与 prod 并存(沙箱设计本就该独立端口/数据并行)。prod 不设该 env→16700 不变。
const IPC_PORT = process.env.BEILU_SANDBOX === '1' ? 16701 : 16700

// SEC-W06: IPC 鉴权——启动时生成随机 token 写入 data/.ipc_token，每条消息校验
let _ipcToken = null

function _generateAndWriteToken() {
	_ipcToken = crypto.randomBytes(32).toString('base64url')
	fs.writeFileSync(path.join(data_path, '.ipc_token'), _ipcToken, 'utf-8')
}

function _readTokenFromFile() {
	return fs.readFileSync(path.join(data_path, '.ipc_token'), 'utf-8').trim()
}

/**
 * 处理 IPC 命令。
 * @param {string} command - 命令类型。
 * @param {object} data - 命令数据。
 * @returns {Promise<object>} 命令处理的结果。
 */
export async function processIPCCommand(command, data) {
	try {
		switch (command) {
			case 'runpart': {
				const { username, partpath, args } = data
				console.logI18n('beiluConsole.ipc.runPartLog', { partpath, username, args: JSON.stringify(args) })
				const part = await loadPart(username, partpath)
				const vc = new VirtualConsole()
				const result = await vc.hookAsyncContext(async () => await part.interfaces.invokes.ArgumentsHandler(username, args))
				return { status: 'ok', data: { result, outputs: vc.outputs } }
			}
			case 'invokepart': {
				const { username, partpath, data: invokedata } = data
				console.logI18n('beiluConsole.ipc.invokePartLog', { partpath, username, invokedata: JSON.stringify(invokedata) })
				const part = await loadPart(username, partpath)
				const result = await part.interfaces.invokes.IPCInvokeHandler(username, invokedata)
				return { status: 'ok', data: result }
			}
			case 'getlist': {
				const { username, partpath } = data
				return { status: 'ok', data: await getPartList(username, partpath) }
			}
			case 'getloadedlist': {
				const { username, partpath } = data
				return { status: 'ok', data: await getLoadedPartList(username, partpath) }
			}
			case 'getdetails': {
				const { username, partpath } = data
				return { status: 'ok', data: await getPartDetails(username, partpath) }
			}
			case 'shutdown':
				process.exit()
				return { status: 'ok' }
			case 'reboot':
				restartor()
				return { status: 'ok' }
			case 'ping':
				return { status: 'ok', data: 'pong' }
			default:
				return { status: 'error', message: geti18n('beiluConsole.ipc.unsupportedCommand') }
		}
	}
	catch (err) {
		console.errorI18n('beiluConsole.ipc.processMessageError', { error: err })
		if (err.errors) console.dir(err.errors)
		else if (err.error) console.dir(err.error)
		return { status: 'error', message: err.message }
	}
}

/**
 * 管理 IPC 服务器和客户端通信。
 */
export class IPCManager {
	/**
	 * 创建 IPCManager 的实例。
	 */
	constructor() {
		this.serverV6 = null
		this.serverV4 = null
	}

	/**
	 * 启动 IPC 服务器。
	 * @returns {Promise<boolean>} 如果服务器成功启动，则解析为 true，否则为 false。
	 */
	async startServer() {
		this.serverV6 = net.createServer(socket => {
			this.handleConnection(socket)
		})

		this.serverV4 = net.createServer(socket => {
			this.handleConnection(socket)
		})

		/**
		 * 启动一个服务器实例。
		 * @param {net.Server} server - 要启动的服务器。
		 * @param {string} address - 要监听的地址。
		 * @returns {Promise<boolean>} 如果服务器成功启动，则解析为 true，否则为 false。
		 */
		const startServer = (server, address) => {
			return new Promise((resolve, reject) => {
				server.on('error', async err => {
					if (err.code === 'EADDRINUSE') resolve(false)
					else if (['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(err.code)) resolve(true) // 不支持的地址族/地址，视为成功
					else reject(err)
				})

				server.listen(IPC_PORT, address, _ => resolve(true))
			})
		}
		// 使用 Promise.all 确保两个侦听器都成功后才返回 true
		return Promise.all([
			startServer(this.serverV6, '::1'),
			startServer(this.serverV4, '127.0.0.1'),
		]).then(async results => {
			const result = results.every(result => result === true)
			if (result) {
				_generateAndWriteToken()
				console.freshLineI18n('server start', 'beiluConsole.ipc.serverStarted')
			}
			else console.logI18n('beiluConsole.ipc.instanceRunning')
			return result
		})
	}

	/**
	 * 处理到 IPC 服务器的新连接。
	 * @param {net.Socket} socket - 连接的套接字。
	 * @returns {void}
	 */
	handleConnection(socket) {
		let buffer = ''

		socket.on('data', async chunk => {
			buffer += chunk
			// SEC-W06-T4: 循环处理缓冲区中所有完整消息（修复 TCP 粘包只处理首条的问题）
			while (buffer.includes('\n')) {
				const idx = buffer.indexOf('\n')
				const message = buffer.slice(0, idx)
				buffer = buffer.slice(idx + 1)

				try {
					const parsed = JSON.parse(message)
					// SEC-W06-T1: 校验 IPC 鉴权 token
					if (parsed.token !== _ipcToken) {
						console.warn('[SEC] IPC connection rejected: invalid token')
						socket.write(JSON.stringify({ status: 'error', message: 'unauthorized' }) + '\n')
						socket.destroy()
						return
					}
					const result = await processIPCCommand(parsed.type, parsed.data)
					socket.write(JSON.stringify(result) + '\n')
				}
				catch (err) {
					console.errorI18n('beiluConsole.ipc.processMessageError', { error: err })
					socket.write(JSON.stringify({ status: 'error', message: err instanceof SyntaxError ? geti18n('beiluConsole.ipc.invalidCommandFormat') : err.message }) + '\n')
				}
			}
		})

		socket.on('error', async err => {
			console.errorI18n('beiluConsole.ipc.socketError', { error: err })
		})
	}

	/**
	 * 向 IPC 服务器发送命令。
	 * @param {string} type - 命令类型。
	 * @param {object} data - 命令数据。
	 * @returns {Promise<any>} 一个解析为服务器响应的承诺。
	 */
	static async sendCommand(type, data) {
		return new Promise((resolve, reject) => {
			// SEC-W06-T1: 读取 IPC 鉴权 token
			let token
			try { token = _readTokenFromFile() }
			catch { return reject(new Error('IPC token file not found — is the server running?')) }

			const client = net.createConnection({ port: IPC_PORT })

			let responseData = ''
			// settle 守卫：首个结果（data/error/close）生效，避免重复 settle 及连接关闭后再 reject
			let settled = false
			const settle = (fn, arg) => { if (!settled) { settled = true; fn(arg) } }

			client.on('data', async chunk => {
				responseData += chunk
				// 检查消息分隔符（换行符）
				if (responseData.includes('\n')) try {
					const parts = responseData.split('\n')
					const message = parts[0] // 提取完整消息
					responseData = parts.slice(1).join('\n') // 保留剩余数据

					const response = JSON.parse(message)
					if (response.status === 'ok') settle(resolve, response.data) // 返回结果
					else settle(reject, new Error(response.message || geti18n('beiluConsole.ipc.unknownError')))
				} catch (err) {
					console.errorI18n('beiluConsole.ipc.parseResponseFailed', { error: err })
					settle(reject, new Error(geti18n('beiluConsole.ipc.cannotParseResponse')))
				} finally {
					client.end() // 处理后关闭连接
				}
			})

			client.on('error', err => {
				client.destroy()
				settle(reject, err)
			})

			// 连接在收到响应前被关闭（如服务端 process.exit/崩溃且未走 error 路径）→
			// 显式 reject，避免调用方 Promise 永久 pending。RST 场景 error 先触发，settle 守卫保证不覆盖。
			client.on('close', () => {
				settle(reject, new Error('IPC connection closed before response'))
			})

			client.setEncoding('utf8')
			client.on('connect', () => {
				client.write(JSON.stringify({ type, data, token }) + '\n')
			})
		})
	}
}
