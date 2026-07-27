import { createBotLifecycle } from '../../../../../scripts/botContentShared.mjs'
import { createDiag } from '../../../../../server/diagLogger.mjs'

const diag = createDiag('wechat')

// [0716 P1 件9] 生命周期骨架收口 createBotLifecycle（botContentShared）——原同构实现纯删。
// 壳侧只余微信传输实现：connect=Init(config)（桥接网关被动模型无长连接，句柄={config, char}）；
// disconnect=char.interfaces.wechat.Destroy?.()。
const _lc = createBotLifecycle('wechatbot', {
	interfaceKey: 'wechat',
	createInterface: async (char, username, charname) => {
		const { createSimpleWechatInterface } = await import('./default_interface/main.mjs')
		return createSimpleWechatInterface(char, username, charname)
	},
	connect: async (config, char) => {
		await char.interfaces.wechat?.Init?.(config)
		return { config, char }
	},
	disconnect: async (ctx) => {
		await ctx?.char?.interfaces?.wechat?.Destroy?.()
	},
})

export const { getBotConfig, getBotConfigTemplate, setBotConfig, deleteBotConfig, runBot, stopBot, pauseBot, getRunningBotList, getBotList } = _lc
export const getBotWechatInterface = _lc.getBotInterface

/**
 * webhook 桥接入站消息投递（平台私有导出，endpoints.mjs webhook 路由消费）：
 * 找到运行中 bot 的接口并转交 HandleMessage；未运行=忽略并 warn（原语义）。
 */
export async function pushWebhookMessage(username, botname, message) {
	diag.debug(`pushWebhookMessage: bot="${botname}", msgId="${message.msgId}"`)
	const iface = getBotWechatInterface(username, botname)
	if (!iface) {
		diag.warn(`pushWebhookMessage: bot="${botname}" 未运行，忽略消息`)
		return
	}
	await iface.HandleMessage?.(message)
}
