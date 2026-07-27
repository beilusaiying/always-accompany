import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import { setInterval } from 'node:timers'

import blake2b from 'npm:@bitgo/blake2b-wasm'
import { on_shutdown } from 'npm:on-shutdown'

import { ms } from '../../../../../scripts/ms.mjs'
import { nicerWriteFileSync } from '../../../../../scripts/nicerWriteFile.mjs'
import { getAllUserNames, getUserDictionary } from '../../../../../yonban/core/functions/security/auth.mjs'
// SEC（红方 round2 隔离审计·破口2）：hash 来自请求(query)裸拼到用户目录 → `../` 穿越可读他人文件。
//   收口到 path_confine 单一权威：确保解析路径落在本用户 files 目录内，越界即抛。
import { confinePath } from '../../../../../yonban/core/functions/security/path_confine.mjs'
/**
 * 获取buffer的hash值。
 * @param {Buffer} buffer - 输入的buffer。
 * @returns {Promise<string>} - hash值。
 */
async function gethash(buffer) {
	return new Promise((resolve, reject) => {
		blake2b.ready(function (err) {
			if (err) return reject(err)
			resolve(
				blake2b()
					.update(Buffer.from(buffer))
					.digest('hex')
			)
		})
	})
}
/**
 * 获取用户目录。
 * @param {string} username - 用户名。
 * @returns {string} - 用户目录路径。
 */
function getUserDir(username) { return getUserDictionary(username) + '/shells/chat/files/' }
/**
 * 检查文件是否存在。
 * @param {string} username - 用户名。
 * @param {string} hash - 文件hash。
 * @returns {Promise<boolean>} - 文件是否存在。
 */
export async function checkfile(username, hash) {
	let p; try { p = confinePath(getUserDir(username), String(hash)) } catch { return false }
	return fs.existsSync(p)
}
/**
 * 添加文件。
 * @param {string} username - 用户名。
 * @param {Buffer} buffer - 文件buffer。
 * @returns {Promise<string>} - 文件hash。
 */
export async function addfile(username, buffer) {
	const hash = await gethash(buffer)
	const userDir = getUserDir(username)
	if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true })
	nicerWriteFileSync(userDir + hash, buffer)
	return hash
}
/**
 * 获取文件。
 * @param {string} username - 用户名。
 * @param {string} hash - 文件hash。
 * @returns {Promise<Buffer>} - 文件buffer。
 */
export async function getfile(username, hash) {
	return fs.readFileSync(confinePath(getUserDir(username), String(hash)))
}

/**
 * 清理文件。
 */
function cleanFiles() {
	const users = getAllUserNames()
	for (const user of users) {
		const userDir = getUserDir(user)
		if (!fs.existsSync(userDir)) continue
		const files = new Set(fs.readdirSync(userDir))
		if (!files.size) continue

		// T021 fail-closed：chat 文件解析失败=其文件引用无法登记，继续删除会把仍被引用的文件当孤儿
		// 误删（不可逆）。任一解析失败→本用户本轮跳过删除，下轮重试（延迟无害，误删不可逆）。
		let _scanFailed = false
		const _scanChatDir = (dir) => {
			if (!fs.existsSync(dir)) return
			for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
				try {
					const data = JSON.parse(fs.readFileSync(dir + f, 'utf-8'))
					for (const entry of data.chatLog || data.chat || [])
						for (const ef of entry.files || [])
							if (ef.buffer && typeof ef.buffer === 'string' && ef.buffer.startsWith('file:'))
								files.delete(ef.buffer.slice(5))
				} catch (e) {
					_scanFailed = true
					console.warn(`[files] cleanFiles 解析 ${dir + f} 失败，本轮跳过 ${user} 的孤儿清理:`, e?.message || e) // T021 留痕
				}
			}
		}

		const userDict = getUserDictionary(user)
		_scanChatDir(userDict + '/shells/chat/chats/')
		const charsDir = userDict + '/chars/'
		if (fs.existsSync(charsDir)) {
			for (const charName of fs.readdirSync(charsDir)) {
				_scanChatDir(charsDir + charName + '/chats/')
			}
		}
		if (_scanFailed) continue

		// mtime 宽限：近 1h 内写入的文件不删。挡住①暂存已上传但消息未发送（无 chat 引用）
		// ②chat 已持文件引用但 saveChat 尚未落盘的竞态窗口。超期未引用才视为真孤儿。
		const GRACE_MS = ms('1h')
		const now = Date.now()
		for (const file of files) {
			try {
				if (now - fs.statSync(userDir + file).mtimeMs < GRACE_MS) continue
				fs.unlinkSync(userDir + file)
			} catch {}
		}
	}
}
/**
 * 清理文件的定时器。
 */
export const cleanFilesInterval = setInterval(cleanFiles, ms('1h')).unref() // every hour
on_shutdown(cleanFiles)
