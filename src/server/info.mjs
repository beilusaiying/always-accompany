import { setInterval } from 'node:timers'

import { ms } from '../scripts/ms.mjs'

/**
 * 获取软件信息对象
 * @returns {{
 * 	title: string
 * 	activity: string
 * 	logotext: string
 * 	logotextColor: `#${string}`
 * 	shortlinkName: string
 * 	shortlinkUrl: `${string}://${string}`
 * 	xPoweredBy: `${string}/${string}`
 * }} 软件信息对象
 */
function getInfo() {
	return {
		title: 'beilu-always accompany',
		activity: 'beilu-running',
		logotext: 'beilu-与你之诗 beilu-always accompany',
		logotextColor: '#0e3c5c',
		shortlinkName: 'beilu',
		shortlinkUrl: 'http://localhost:1314',
		xPoweredBy: 'beilu/1.0',
	}
}
/**
 * 软件信息对象
 */
export let info = getInfo()
setInterval(() => {
	info = getInfo()
}, ms('1h')).unref()
