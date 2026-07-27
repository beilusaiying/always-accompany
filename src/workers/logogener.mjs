import process from 'node:process'

import { info } from '../server/info.mjs'

import { setMain } from './base.mjs'

setMain(main)
/**
 * 生成并返回 beilu 的 ASCII 艺术 logo（文本取自 info.logotext）。
 * @returns {Promise<string>} 带有颜色的logo字符串。
 */
async function main() {
	const { default: chalk } = await import('npm:chalk')
	const { default: figlet } = await import('npm:figlet')
	let logo = info.logotext
	try {
		logo = figlet.textSync(logo, {
			font: 'Pagga',
			width: process.stdout.columns - 1,
			whitespaceBreak: true
		})
	} catch { /* ignore */ }
	return chalk.hex(info.logotextColor)(logo)
}
