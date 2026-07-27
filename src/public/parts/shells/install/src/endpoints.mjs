import { authenticate, getUserByReq } from '../../../../../yonban/core/functions/security/auth.mjs'
import { uninstallPartBase } from '../../../../../server/parts_loader.mjs'

import { importPart, importPartByText } from './Installer_handler.mjs'

/**
 * 为安装功能设置API端点。
 * @param {object} router - Express的路由实例。
 */
export function setEndpoints(router) {
	// 文件上传接口
	router.post('/api/parts/shells\\:install/file', authenticate, async (req, res) => {
		const user = await getUserByReq(req)
		if (!user)
			return res.status(401).json({ message: '未授权' })

		if (!Object.keys(req.files || {}).length)
			return res.status(400).json({ message: '未上传文件' })

		// consent 透传：ImportHandler 把 needsConsent/consentMessage 挂在返回数组的属性上（如 SillyTavern 角色卡
		// 高优先级字段安全提醒）。数组属性会被 JSON.stringify 丢弃，故此处显式提取进响应对象供前端展示。
		// 多文件循环时取任一带提醒的（同批消息一致），确保提醒不因返回值被丢弃而断链（配 install/public/index.mjs 展示）。
		let needsConsent = false
		let consentMessage = ''
		for (const file of Object.values(req.files)) {
			const installed = await importPart(user.username, file.data)
			if (installed?.needsConsent) {
				needsConsent = true
				if (installed.consentMessage) consentMessage = installed.consentMessage
			}
		}

		res.status(200).json({ message: '文件导入成功', needsConsent, consentMessage })
	})

	// 文本导入接口
	router.post('/api/parts/shells\\:install/text', authenticate, async (req, res) => {
		const user = await getUserByReq(req)
		if (!user)
			return res.status(401).json({ message: '未授权' })

		const { text } = req.body

		if (!text)
			return res.status(400).json({ message: '文本内容不能为空' })

		const installedParts = await importPartByText(user.username, text)
		const parts = Array.isArray(installedParts) ? [...installedParts] : []
		// SEC-T3: 命令型 MCP 的 consent 标志（挂在数组属性上）透传给前端，供导入后弹确认。
		// consentMessage：字符文本型提醒（如 SillyTavern 角色卡高优先级字段安全提示），与 consentItems 数组型
		// （MCP RCE 逐项确认）并存不同渠道——数组属性经 JSON.stringify 会丢，故一并显式提取透传给前端展示。
		const needsConsent = installedParts?.needsConsent || false
		const consentItems = Array.isArray(installedParts?.consentItems) ? installedParts.consentItems : []
		const consentMessage = typeof installedParts?.consentMessage === 'string' ? installedParts.consentMessage : ''

		res.status(200).json({ message: '文本导入成功', parts, needsConsent, consentItems, consentMessage })
	})

	// 删除请求发送
	router.post('/api/parts/shells\\:install/uninstall', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const partpath = (req.body.partpath || '').replace(/^\/+|\/+$/g, '')
		if (!partpath) return res.status(400).json({ message: 'partpath is required' })
		// SEC-T2：uninstall 走 fs.rmSync(recursive)，partpath 含 .. 段可递归删任意目录——拒绝穿越
		if (partpath.split(/[/\\]/).some(s => s === '..' || s === '.' || s.includes('\0')))
			return res.status(400).json({ message: 'invalid partpath' })
		await uninstallPartBase(username, partpath)
		res.status(200).json({ message: '删除成功' })
	})
}
