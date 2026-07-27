import { TwitterApi } from 'npm:twitter-api-v2@^1.19.0'

import { createBotLifecycle } from '../../../../../scripts/botContentShared.mjs'
import { createDiag } from '../../../../../server/diagLogger.mjs'

const diag = createDiag('xbot')

// [0716 P1 件9] 生命周期骨架收口 createBotLifecycle（botContentShared）——原同构实现纯删。
// 壳侧只余 X 传输实现：connect=TwitterApi 构造+v2.me() 验证身份+OnBotReady 启动轮询（返回
// {client, stopPolling, me} 句柄）；disconnect=stopPolling()（轮询模型无长连接可断）。
// 注：xbot 的 shell 数据键=目录名 'xbot'（原 loadShellData(username,'xbot',...) 同值），工厂 shellname 一致。
const _lc = createBotLifecycle('xbot', {
	interfaceKey: 'xbot',
	createInterface: async (char, username, charname) => {
		const { createSimpleXBotInterface } = await import('./default_interface/main.mjs')
		return createSimpleXBotInterface(char, username, charname)
	},
	connect: async (config, char, { botname }) => {
		diag.log(`startBot: 启动 bot="${config.char}", appKey长度=${config.appKey?.length || 0}`)
		const client = new TwitterApi({
			appKey: config.appKey,
			appSecret: config.appSecret,
			accessToken: config.accessToken,
			accessSecret: config.accessSecret,
		})
		// 验证凭据并获取自身信息
		const meResult = await client.v2.me()
		const me = meResult.data
		diag.log(`startBot: 已验证身份, botId="${me.id}", botUsername="@${me.username}"`)
		console.log(`[X Bot] 已登录: @${me.username} (char="${config.char}")`)
		// 启动轮询
		const stopPolling = await char.interfaces.xbot.OnBotReady(client, me, config.config || {})
		return { client, stopPolling, me }
	},
	disconnect: async (handle) => {
		if (handle?.stopPolling) handle.stopPolling()
	},
})

export const { getBotConfig, getBotConfigTemplate, setBotConfig, deleteBotConfig, runBot, stopBot, pauseBot, getRunningBotList, getBotList } = _lc
export const getBotXInterface = _lc.getBotInterface
