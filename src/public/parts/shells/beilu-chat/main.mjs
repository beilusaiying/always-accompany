import info from './info.json' with { type: 'json' }
import { setEndpoints } from './src/endpoints.mjs'
import { getChatIdsByCharName, deleteChat } from './src/chat.mjs'

/**
 * beilu-chat Shell — 贝露聊天界面
 *
 * 职责：
 * - 提供聊天界面（消息发送/接收、流式输出）
 * - 消息渲染管线（标签解析、正则美化）
 * - 管理面板（预设/记忆/正则/文件/Agent）
 * - 琥珀色主题
 * - 图片发送（多模态）
 * - 截图接收（从截图球）
 */
export default {
	info,
	/**
	 * 加载 Shell，注册路由
	 * @param {Object} root0 - 参数对象
	 * @param {Object} root0.router - Express 路由器
	 */
	Load: ({ router }) => {
		setEndpoints(router)
	},
	Unload: () => {},
	interfaces: {
		web: {},
		chat: {
			getChatIdsByCharName,
			deleteChat,
		},
	},
}