/**
 * 图片处理工具模块
 *
 * 职责：
 * 1. 通过 magic bytes 检测图片实际格式，修正错误的 mime_type
 * 2. 超过 5MB 的图片压缩到一半质量，还超过则退回（丢弃）
 *
 * 适用于 POST /message 和 PUT /message/:index 路由中的 files 数组
 */

import { Buffer } from 'node:buffer'

// ============================================================
// 1. 图片格式检测与修正
// ============================================================

/**
 * 通过 magic bytes 检测 Buffer 的实际图片格式
 * 不依赖外部库，纯 JS 实现
 *
 * @param {Buffer} buffer - 图片二进制数据
 * @returns {{ mime: string, ext: string } | null} 检测到的格式，或 null（非图片/未知格式）
 */
function detectImageFormat(buffer) {
	if (!buffer || buffer.length < 4) return null

	// JPEG: FF D8 FF
	if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
		return { mime: 'image/jpeg', ext: 'jpg' }
	}

	// PNG: 89 50 4E 47 0D 0A 1A 0A
	if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
		return { mime: 'image/png', ext: 'png' }
	}

	// GIF: 47 49 46 38 (GIF8)
	if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
		return { mime: 'image/gif', ext: 'gif' }
	}

	// WebP: 52 49 46 46 ... 57 45 42 50 (RIFF....WEBP)
	if (buffer.length >= 12 &&
		buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
		buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
		return { mime: 'image/webp', ext: 'webp' }
	}

	// BMP: 42 4D (BM)
	if (buffer[0] === 0x42 && buffer[1] === 0x4D) {
		return { mime: 'image/bmp', ext: 'bmp' }
	}

	// TIFF: 49 49 2A 00 (little-endian) or 4D 4D 00 2A (big-endian)
	if ((buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2A && buffer[3] === 0x00) ||
		(buffer[0] === 0x4D && buffer[1] === 0x4D && buffer[2] === 0x00 && buffer[3] === 0x2A)) {
		return { mime: 'image/tiff', ext: 'tiff' }
	}

	// AVIF: ....ftypavif 或 ....ftypavis
	if (buffer.length >= 12) {
		const ftyp = buffer.toString('ascii', 4, 8)
		if (ftyp === 'ftyp') {
			const brand = buffer.toString('ascii', 8, 12)
			if (brand === 'avif' || brand === 'avis') {
				return { mime: 'image/avif', ext: 'avif' }
			}
			// HEIF/HEIC
			if (brand === 'heic' || brand === 'heix' || brand === 'mif1') {
				return { mime: 'image/heic', ext: 'heic' }
			}
		}
	}

	// ICO: 00 00 01 00
	if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0x00) {
		return { mime: 'image/x-icon', ext: 'ico' }
	}

	return null
}

/**
 * 检测并修正文件的 mime_type
 * 如果检测到的实际格式与声明的 mime_type 不一致，自动修正
 *
 * @param {object} file - 文件对象 { name, mime_type, buffer, ... }
 * @returns {object} 修正后的文件对象（原地修改）
 */
function detectAndFixMimeType(file) {
	if (!file.buffer || !file.mime_type?.startsWith('image/')) return file

	const detected = detectImageFormat(file.buffer)
	if (!detected) return file // 无法检测，保持原样

	if (detected.mime !== file.mime_type) {
		console.log(`[imageProcessing] 格式修正: ${file.name} 声明 ${file.mime_type}，实际 ${detected.mime}`)
		file.mime_type = detected.mime

		// 修正文件扩展名（如果名字中有扩展名）
		if (file.name) {
			const lastDot = file.name.lastIndexOf('.')
			if (lastDot > 0) {
				file.name = file.name.substring(0, lastDot + 1) + detected.ext
			}
		}
	}

	return file
}

// ============================================================
// 2. 图片压缩
// ============================================================

const MAX_IMAGE_SIZE = 5 * 1024 * 1024 // 5MB

/**
 * 尝试用 sharp 压缩图片
 * @param {Buffer} buffer - 原始图片 buffer
 * @param {string} mimeType - 图片 MIME 类型
 * @returns {Promise<Buffer|null>} 压缩后的 buffer，失败返回 null
 */
async function compressWithSharp(buffer, mimeType) {
	try {
		const sharp = (await import('npm:sharp')).default
		let pipeline = sharp(buffer)

		// 先缩小分辨率（最大宽度 2048）
		pipeline = pipeline.resize(2048, null, {
			withoutEnlargement: true,
			fit: 'inside',
		})

		// 根据格式选择压缩方式
		if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
			pipeline = pipeline.jpeg({ quality: 50 })
		} else if (mimeType === 'image/png') {
			// PNG 转 JPEG 压缩效果更好
			pipeline = pipeline.jpeg({ quality: 50 })
		} else if (mimeType === 'image/webp') {
			pipeline = pipeline.webp({ quality: 50 })
		} else {
			// 其他格式一律转 JPEG
			pipeline = pipeline.jpeg({ quality: 50 })
		}

		return await pipeline.toBuffer()
	} catch (err) {
		console.warn('[imageProcessing] sharp 压缩失败:', err.message)
		return null
	}
}

/**
 * 尝试用 Python Pillow 压缩图片（sharp 不可用时的回退方案）
 * @param {Buffer} buffer - 原始图片 buffer
 * @param {string} mimeType - 图片 MIME 类型
 * @returns {Promise<Buffer|null>} 压缩后的 buffer，失败返回 null
 */
async function compressWithPython(buffer, mimeType) {
	try {
		const isWindows = Deno.build.os === 'windows'
		const pythonCmd = isWindows ? 'python' : 'python3'

		// Python 一行命令：从 stdin 读 base64，压缩后输出 base64 到 stdout
		const script = `
import sys, base64, io
from PIL import Image
data = base64.b64decode(sys.stdin.read())
img = Image.open(io.BytesIO(data))
if img.mode in ('RGBA', 'LA', 'P'):
    img = img.convert('RGB')
w, h = img.size
if w > 2048:
    ratio = 2048 / w
    img = img.resize((2048, int(h * ratio)), Image.LANCZOS)
out = io.BytesIO()
img.save(out, format='JPEG', quality=50, optimize=True)
sys.stdout.write(base64.b64encode(out.getvalue()).decode())
`
		const command = new Deno.Command(pythonCmd, {
			args: ['-c', script],
			stdin: 'piped',
			stdout: 'piped',
			stderr: 'piped',
		})

		const child = command.spawn()

		// 写入 base64 编码的图片数据到 stdin
		const writer = child.stdin.getWriter()
		const base64Data = buffer.toString('base64')
		await writer.write(new TextEncoder().encode(base64Data))
		await writer.close()

		const result = await child.output()
		if (!result.success) {
			const stderr = new TextDecoder().decode(result.stderr)
			console.warn('[imageProcessing] Python 压缩失败:', stderr.substring(0, 300))
			return null
		}

		const outputBase64 = new TextDecoder().decode(result.stdout).trim()
		if (!outputBase64) return null

		return Buffer.from(outputBase64, 'base64')
	} catch (err) {
		console.warn('[imageProcessing] Python 压缩回退失败:', err.message)
		return null
	}
}

/**
 * 如果图片超过 5MB，尝试压缩
 * 压缩后如果仍超过 5MB，返回 null（表示退回/丢弃）
 *
 * @param {object} file - 文件对象 { name, mime_type, buffer, ... }
 * @returns {Promise<object|null>} 处理后的文件对象，或 null（退回）
 */
async function compressImageIfNeeded(file) {
	if (!file.buffer || !file.mime_type?.startsWith('image/')) return file

	const originalSize = file.buffer.length
	if (originalSize <= MAX_IMAGE_SIZE) return file // 不需要压缩

	console.log(`[imageProcessing] 图片 ${file.name} 大小 ${(originalSize / 1024 / 1024).toFixed(1)}MB > 5MB，尝试压缩...`)

	// 尝试 sharp
	let compressed = await compressWithSharp(file.buffer, file.mime_type)

	// sharp 失败时回退到 Python
	if (!compressed) {
		compressed = await compressWithPython(file.buffer, file.mime_type)
	}

	if (!compressed) {
		console.warn(`[imageProcessing] 图片 ${file.name} 压缩失败（sharp 和 Python 均不可用），保持原大小`)
		return file // 无法压缩，保持原样（不退回，让 API 自行处理）
	}

	const compressedSize = compressed.length
	console.log(`[imageProcessing] 压缩完成: ${(originalSize / 1024 / 1024).toFixed(1)}MB → ${(compressedSize / 1024 / 1024).toFixed(1)}MB`)

	if (compressedSize > MAX_IMAGE_SIZE) {
		console.warn(`[imageProcessing] 图片 ${file.name} 压缩后仍然 ${(compressedSize / 1024 / 1024).toFixed(1)}MB > 5MB，退回`)
		return null // 退回
	}

	// 更新 file 对象
	file.buffer = compressed
	// 压缩后统一为 JPEG（因为 sharp/Python 都输出 JPEG）
	if (file.mime_type !== 'image/webp') {
		file.mime_type = 'image/jpeg'
		if (file.name) {
			const lastDot = file.name.lastIndexOf('.')
			if (lastDot > 0) {
				file.name = file.name.substring(0, lastDot + 1) + 'jpg'
			}
		}
	}

	return file
}

// ============================================================
// 3. 统一入口
// ============================================================

/**
 * 处理消息中的图片文件：格式校验 + 压缩
 * 修改 files 数组内容（原地修改），移除被退回的文件
 *
 * @param {Array<object>} files - 文件对象数组（已经过 Buffer.from(base64) 转换）
 * @returns {Promise<Array<object>>} 处理后的文件数组
 */
export async function processImageFiles(files) {
	if (!files || !Array.isArray(files) || files.length === 0) return files

	const processed = []

	for (const file of files) {
		// 步骤 1：格式检测与修正
		detectAndFixMimeType(file)

		// 步骤 2：图片压缩（如需要）
		if (file.mime_type?.startsWith('image/')) {
			const result = await compressImageIfNeeded(file)
			if (result === null) {
				console.warn(`[imageProcessing] 文件 ${file.name} 已被退回（压缩后仍超过 5MB）`)
				continue // 跳过此文件
			}
			processed.push(result)
		} else {
			processed.push(file)
		}
	}

	return processed
}