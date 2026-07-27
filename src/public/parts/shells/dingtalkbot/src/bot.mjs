import { DWClient } from 'npm:dingtalk-stream@^2.1.0' // ^1.6.0 已无发布(npm 只 2.x)致 dingtalk bot 无法加载;2.x DWClientDownStream 改 type-only(SUCCESS 移到 EventAck,见 default_interface);TOPIC_ROBOT 仅 default_interface 消费,本文件原 import 系未用残留,件9 收口时纯删

import { console } from '../../../../../scripts/i18n.mjs'
import { createBotLifecycle } from '../../../../../scripts/botContentShared.mjs'
import { createDiag } from '../../../../../server/diagLogger.mjs'
import { broadcastBotError } from '../../botErrorBroadcast.mjs'

const diag = createDiag('dingtalk')

// [0716 P1 件9] 生命周期骨架收口 createBotLifecycle（botContentShared）——原同构实现纯删。
// 壳侧只余钉钉传输实现：connect=DWClient(Stream 长连)+error 挂钩+OnceClientReady+connect()；
// disconnect=client.disconnect?.()。
const _lc = createBotLifecycle('dingtalkbot', {
	interfaceKey: 'dingtalk',
	createInterface: async (char, username, charname) => {
		const { createSimpleDingTalkInterface } = await import('./default_interface/main.mjs')
		return createSimpleDingTalkInterface(char, username, charname)
	},
	connect: async (config, char, { botname }) => {
		diag.log(`startBot: 启动 bot="${config.char}", clientId长度=${config.clientId?.length || 0}`)
		const client = new DWClient({
			clientId: config.clientId,
			clientSecret: config.clientSecret,
		})
		// BR2 runtime：DWClient extends EventEmitter(2.x SDK .d.ts 坐实)，运行时 WS 错误外显红点(phase=runtime，补齐 M8 半修：原仅 start 阶段有 producer)
		client.on('error', (error) => { try { broadcastBotError({ platform: 'dingtalkbot', botname, phase: 'runtime', error }) } catch { /* 外显失败不阻断 bot 主流程 */ } })
		await char.interfaces.dingtalk?.OnceClientReady?.(client, config.config)
		await client.connect()
		diag.log(`startBot: 钉钉 Stream 已连接, char="${config.char}"`)
		console.infoI18n?.('beiluConsole.dingtalkbot.botStarted', {
			charname: config.char,
		})
		return client
	},
	disconnect: async (client) => {
		await client.disconnect?.()
	},
})

export const { getBotConfig, getBotConfigTemplate, setBotConfig, deleteBotConfig, runBot, stopBot, pauseBot, getRunningBotList, getBotList } = _lc
export const getBotDingTalkInterface = _lc.getBotInterface
