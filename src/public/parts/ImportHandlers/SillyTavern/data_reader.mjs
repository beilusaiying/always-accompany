import { Buffer } from 'node:buffer'

import { encode as encodeText, decode as decodeText } from 'npm:png-chunk-text'
import encode from 'npm:png-chunks-encode'
import extract from 'npm:png-chunks-extract'

/**
 * 从块数组中删除关键字为 'chara' 的 'tEXt' 块。
 * @param {Array} chunks - PNG 块数组。
 */
function removeCharaChunks(chunks) {
	for (let i = chunks.length - 1; i >= 0; i--)
		if (chunks[i].name === 'tEXt') {
			const decodedChunk = decodeText(chunks[i].data)
			if (decodedChunk.keyword.toLowerCase() === 'chara')
				chunks.splice(i, 1)
		}
}

/**
 * 将角色元数据写入 PNG 图像缓冲区。
 * @param {Buffer} image - PNG 图像缓冲区。
 * @param {string} data - 要写入的角色数据。
 * @returns {Buffer} - 带有元数据的 PNG 图像缓冲区。
 */
export function write(image, data) {
	const chunks = extract(image)

	// 先删除已有 'chara' 块，再定位 IEND —— 顺序不能反：
	// 删除会改变数组下标，若在删除前取 iendChunkIndex，当原图已含 chara 块(在 IEND 前)时，
	// 删除后 IEND 实际下标前移，旧下标会把新块 splice 到 IEND 之后 → PNG 规范下 IEND 后内容被忽略，
	// 重读即 "No PNG metadata"。所有角色卡都含 chara 块，故此 bug 必现(与运行时无关)。
	removeCharaChunks(chunks)
	const iendChunkIndex = chunks.findIndex(chunk => chunk.name === 'IEND')

	// Add new 'tEXt' chunk before 'IEND'
	const base64EncodedData = Buffer.from(data, 'utf8').toString('base64')
	chunks.splice(iendChunkIndex, 0, encodeText('chara', base64EncodedData))

	return Buffer.from(encode(chunks))
}

/**
 * 从 PNG 图像缓冲区读取角色元数据。
 * @param {Buffer} image - PNG 图像缓冲区。
 * @returns {string} - 角色数据。
 */
export function read(image) {
	const chunks = extract(image)

	const charaChunk = chunks.find(chunk => {
		return chunk.name === 'tEXt' && decodeText(chunk.data).keyword.toLowerCase() === 'chara'
	})

	if (!charaChunk) throw new Error('No PNG metadata.')

	return Buffer.from(decodeText(charaChunk.data).text, 'base64').toString('utf8')
}

/**
 * 从 PNG 图像缓冲区中删除角色元数据。
 * @param {Buffer} image - PNG 图像缓冲区。
 * @returns {Buffer} - 不带角色元数据的 PNG 图像缓冲区。
 */
export function remove(image) {
	const chunks = extract(image)

	// Remove existing 'chara' chunks
	removeCharaChunks(chunks)

	return Buffer.from(encode(chunks))
}

/**
 * PNG 块读写器
 */
export default { read, write, remove }
