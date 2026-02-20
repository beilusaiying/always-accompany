
import { nicerWriteFileSync } from '../scripts/nicerWriteFile.mjs'

import { __dirname, setMain } from './base.mjs'

setMain(main)
/**
 * 生成图标（从 JPG 源文件生成 PNG 和 ICO）
 */
async function main() {
	const { default: pngToIco } = await import('npm:png-to-ico')
	const { default: sharp } = await import('npm:sharp')
	const jpgPath = __dirname + '/imgs/icon.jpg'
	const favpngbuf = await sharp(jpgPath)
		.resize(256, 256)
		.png()
		.toBuffer()
	nicerWriteFileSync(__dirname + '/src/public/pages/favicon.png', favpngbuf)
	const favicobuf = await pngToIco(favpngbuf)
	nicerWriteFileSync(__dirname + '/src/public/pages/favicon.ico', favicobuf)
}
