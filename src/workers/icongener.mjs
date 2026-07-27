
import { nicerWriteFileSync } from '../scripts/nicerWriteFile.mjs'

import { __dirname, setMain } from './base.mjs'

setMain(main)

/**
 * ICO 生成为什么手搓而不用 png-to-ico：
 * pngjs@7 的 sync-inflate 在 Deno 的 zlib 兼容层下抛 "expected typed ArrayBufferView"（已复现确诊），
 * 致 favicon.ico 生成失败并把 PNG 字节 dump 进报错。手工封装根治该不兼容。
 *
 * 为什么小尺寸必须 BMP 条目而不是 PNG 条目：
 * 旧实现只封一个 256 PNG 条目——浏览器能吃，但 Windows 外壳（Explorer/快捷方式/任务栏）对
 * 非 256 尺寸只认 BMP(DIB) 条目，PNG-only ICO 嵌进 exe 后渲染成白纸图标（2026-07-17 实证）。
 * 通行做法：16~64 走 BMP 条目，256 走 PNG 条目（保体积）。
 */

/**
 * 把一份 RGBA 原始像素编成 ICO 的 BMP(DIB) 条目数据。
 * 结构 = BITMAPINFOHEADER(40B, 高度写双倍) + BGRA 像素(自底向上) + AND 掩码(全0, 透明交给 alpha 通道)。
 * @param {Buffer} rgba - size*size*4 的 RGBA 像素（sharp .ensureAlpha().raw() 输出）
 * @param {number} size - 像素宽高
 * @returns {Buffer} DIB 条目字节
 */
function buildBmpEntry(rgba, size) {
	const maskRow = Math.ceil(size / 32) * 4 // AND 掩码行按 32bit 对齐
	const xorSize = size * size * 4
	const dib = Buffer.alloc(40 + xorSize + maskRow * size)
	dib.writeUInt32LE(40, 0)          // BITMAPINFOHEADER 大小
	dib.writeInt32LE(size, 4)         // 宽
	dib.writeInt32LE(size * 2, 8)     // 高（ICO 规范：XOR+AND 写双倍高）
	dib.writeUInt16LE(1, 12)          // planes
	dib.writeUInt16LE(32, 14)         // 32bpp BGRA
	dib.writeUInt32LE(0, 16)          // BI_RGB 无压缩
	dib.writeUInt32LE(xorSize + maskRow * size, 20)
	for (let y = 0; y < size; y++) {
		const src = (size - 1 - y) * size * 4 // 自底向上
		const dst = 40 + y * size * 4
		for (let x = 0; x < size; x++) {
			dib[dst + x * 4] = rgba[src + x * 4 + 2]     // B
			dib[dst + x * 4 + 1] = rgba[src + x * 4 + 1] // G
			dib[dst + x * 4 + 2] = rgba[src + x * 4]     // R
			dib[dst + x * 4 + 3] = rgba[src + x * 4 + 3] // A
		}
	}
	// AND 掩码保持全 0（Buffer.alloc 已置零）：32bpp 下透明由 alpha 决定
	return dib
}

/**
 * 组装多条目 ICO 容器。
 * @param {{size: number, data: Buffer, isPng?: boolean}[]} entries
 * @returns {Buffer} ICO 字节
 */
function buildIco(entries) {
	const header = Buffer.alloc(6 + 16 * entries.length)
	header.writeUInt16LE(0, 0)               // reserved
	header.writeUInt16LE(1, 2)               // type = 1(icon)
	header.writeUInt16LE(entries.length, 4)  // image count
	let offset = header.length
	entries.forEach((e, i) => {
		const o = 6 + i * 16
		header.writeUInt8(e.size >= 256 ? 0 : e.size, o)     // 宽（256→0）
		header.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1) // 高（256→0）
		header.writeUInt16LE(1, o + 4)        // color planes
		header.writeUInt16LE(32, o + 6)       // bits per pixel
		header.writeUInt32LE(e.data.length, o + 8)
		header.writeUInt32LE(offset, o + 12)
		offset += e.data.length
	})
	return Buffer.concat([header, ...entries.map(e => e.data)])
}

/**
 * 生成全套图标（单源 imgs/icon.jpg → favicon.png/ico + iOS/PWA 图标 + svg）。
 * 产物全部运行时生成、被 src/public/pages/.gitignore 忽略，仓库不携带。
 * 消费方：html <link>（favicon.ico/svg/apple-touch-icon）、manifest.json icons（192/256/512）、
 * ps12exe exe 图标嵌入（path/exe-launcher.ps1 编译时取 favicon.ico）。
 */
async function main() {
	const { default: sharp } = await import('npm:sharp')
	const jpgPath = __dirname + '/imgs/icon.jpg'
	const pagesDir = __dirname + '/src/public/pages'
	const pngOf = size => sharp(jpgPath).resize(size, size).png().toBuffer()

	const favpngbuf = await pngOf(256)
	nicerWriteFileSync(pagesDir + '/favicon.png', favpngbuf)
	// iOS 加主屏只认 html 的 apple-touch-icon(180x180)，不读 manifest icons
	nicerWriteFileSync(pagesDir + '/apple-touch-icon.png', await pngOf(180))
	// manifest 安装图标（Android/桌面 PWA 要 192+512）
	nicerWriteFileSync(pagesDir + '/favicon-192.png', await pngOf(192))
	nicerWriteFileSync(pagesDir + '/favicon-512.png', await pngOf(512))
	// 多处 html 引用 /favicon.svg：base64 内嵌位图包成 svg（无矢量源，保引用不悬空）
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><image width="256" height="256" href="data:image/png;base64,${favpngbuf.toString('base64')}"/></svg>\n`
	nicerWriteFileSync(pagesDir + '/favicon.svg', Buffer.from(svg, 'utf8'))

	const entries = []
	for (const size of [16, 24, 32, 48, 64]) {
		const rgba = await sharp(jpgPath).resize(size, size).ensureAlpha().raw().toBuffer()
		entries.push({ size, data: buildBmpEntry(rgba, size) })
	}
	entries.push({ size: 256, data: favpngbuf, isPng: true })
	nicerWriteFileSync(pagesDir + '/favicon.ico', buildIco(entries))
}
