import { Buffer } from 'node:buffer'
import fs from 'node:fs'

/**
 * D-09：renameSync 带重试。Windows 下杀软/索引器偶发短暂锁住目标致 EPERM/EBUSY/EACCES（瞬时），
 * 旧版 catch 吞错 → 数据未落盘 + tmp 孤儿。重试若干次，每次 Atomics.wait 同步小睡（非忙等，不空转 CPU），
 * 仍失败才抛——tmp 保留、数据不丢、下次覆盖再试。
 * @param {string} tmpPath - 临时文件路径。
 * @param {string} destPath - 目标路径。
 * @param {number} [attempts=5] - 最大尝试次数。
 * @param {number} [delayMs=20] - 每次重试前的同步等待毫秒。
 * @returns {void}
 */
export function renameSyncWithRetry(tmpPath, destPath, attempts = 5, delayMs = 20) {
	for (let i = 0; ; i++) {
		try { fs.renameSync(tmpPath, destPath); return }
		catch (e) {
			const transient = e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES')
			if (!transient || i >= attempts - 1) throw e
			try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs) } catch { /* SAB 不可用则不睡，直接下一次重试 */ }
		}
	}
}

/**
 * 如果数据与现有数据不同步，则将数据写入文件。
 *
 * @param {string} filePath - 要写入的文件的路径。
 * @param {string|Buffer} data - 要写入文件的数据。
 * @param {string} [encoding] - 写入文件时使用的编码；当 data 为字符串且未指定时默认为 'utf8'。
 * @returns {void}
 */
export function nicerWriteFileSync(filePath, data, encoding) {
	if (Object(data) instanceof String) encoding ??= 'utf8'
	let oldData
	if (fs.existsSync(filePath))
		oldData = fs.readFileSync(filePath, encoding)
	if (!Buffer.from(oldData ?? '').equals(Buffer.from(data))) {
		// D-01：tmp 名含 pid+Date.now()，避免进程内并发写同一文件时 tmp 互覆（与 storage/dataSystem 同口径）
		const tmpPath = filePath + '.tmp_' + process.pid + '_' + Date.now()
		// [0716 断电安全·凛倾拍板] fsyncSync 补严格持久性：writeFileSync 只保证进内核页缓存，
		//   rename 后立刻断电可能 tmp 数据未刷盘=新旧文件都不完整。写→fsync→close→rename 后，
		//   断电最坏=rename 未生效（旧文件完好），数据窗口闭合。fsync 失败（个别文件系统不支持）降级原行为不阻断。
		const fd = fs.openSync(tmpPath, 'w')
		try {
			const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, encoding || 'utf8')
			fs.writeSync(fd, buf, 0, buf.length)
			try { fs.fsyncSync(fd) } catch { /* fs 不支持 fsync → 维持页缓存语义 */ }
		} finally {
			fs.closeSync(fd)
		}
		renameSyncWithRetry(tmpPath, filePath) // D-09: EPERM/EBUSY 重试
	}
}
