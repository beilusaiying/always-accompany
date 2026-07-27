const LITTERBOX_API_URL = 'https://litterbox.catbox.moe/resources/internals/api.php'
const UPLOAD_TIMEOUT_MS = 30000

/**
 * 创建分享链接。
 * @param {Blob} fileBlob - 文件Blob。
 * @param {string} filename - 文件名。
 * @param {string} expiration - 过期时间。
 * @returns {Promise<string>} - 分享链接。
 */
export async function createShareLink(fileBlob, filename, expiration) {
	const formData = new FormData()
	formData.append('reqtype', 'fileupload')
	formData.append('time', expiration)
	formData.append('fileToUpload', fileBlob, filename)

	try {
		// R1-SKIP: 外部跨域 API(litterbox.catbox.moe，非 /api/*) + FormData 上传 + 自带 AbortSignal.timeout + .text()；apiFetch 的 401→/login 跳转对外站有害。
		const response = await fetch(LITTERBOX_API_URL, {
			method: 'POST',
			body: formData,
			signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
		})

		if (!response.ok)
			throw new Error(`Failed to upload to litterbox: ${response.statusText}`)

		return await response.text()
	} catch (err) {
		if (err.name === 'TimeoutError') {
			throw new Error('分享上传超时，请检查网络后重试')
		}
		if (err.name === 'AbortError') {
			throw new Error('分享上传已取消')
		}
		throw err
	}
}
