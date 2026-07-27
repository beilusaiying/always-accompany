import * as botModule from './bot.mjs'
import { createBotEndpoints } from '../../../../../scripts/botContentShared.mjs'

// [0716 P1 件8] 13 标准端点收口 createBotEndpoints——原同构实现纯删；活跃会话端点统一
// /activechannels（原 activechats 与前端拼名不符=恒 404，接口方法/字段已同批归一 discord 系）。
// 特异端点（webhook 桥接推送，无 authenticate=第三方桥接服务推送正确形）留本文件原文。
const _std = createBotEndpoints('wechatbot', {
	botModule,
	getBotInterface: botModule.getBotWechatInterface,
})

const { getBotConfig, pushWebhookMessage } = botModule

/**
 * 根据用户名和 botname 查找对应用户，供 Webhook 端点使用。
 * Webhook 不携带认证信息，需遍历所有用户的 bot 配置来匹配。
 * @param {string} botname - 机器人名称。
 * @returns {{username: string}|null} 找到的用户信息或 null。
 */
async function findUserByBotname(botname) {
	const { getAllUserNames } = await import('../../../../../yonban/core/functions/security/auth.mjs')
	for (const username of getAllUserNames()) {
		const config = getBotConfig(username, botname)
		if (config && Object.keys(config).length)
			return { username }
	}
	return null
}

/**
 * 为微信机器人功能设置API端点。
 * @param {object} router - Express的路由实例。
 */
export function setEndpoints(router) {
	_std(router)

	// ---- Webhook 接收端点（不需要 authenticate，供第三方桥接服务推送） ----
	router.post('/api/parts/shells\\:wechatbot/webhook', async (req, res) => {
		try {
			const { botname, token, ...message } = req.body || {}
			if (!botname) {
				res.status(400).json({ error: 'botname is required' })
				return
			}

			// 查找对应用户
			const userInfo = await findUserByBotname(botname)
			if (!userInfo) {
				res.status(404).json({ error: `Bot "${botname}" not found` })
				return
			}

			const { username } = userInfo
			const config = getBotConfig(username, botname)

			// 验证 token（如果配置了的话）
			if (config.apiToken && config.apiToken !== token) {
				res.status(403).json({ error: 'Invalid token' })
				return
			}

			// 推送消息进处理队列
			await pushWebhookMessage(username, botname, message)
			res.json({ success: true })
		} catch (error) {
			res.status(500).json({ error: error.message })
		}
	})
}
