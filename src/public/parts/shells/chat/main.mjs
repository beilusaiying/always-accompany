// chat Shell 已被 beilu-chat 完全替代
// 此文件保留作为依赖桥接骨架
// 前端 API 请求路径为 /api/parts/shells:chat/...，框架将其路由到 shells/chat 的 router
// 因此需要将 beilu-chat 的 endpoints 注册到此 router 上
import { setEndpoints } from '../beilu-chat/src/endpoints.mjs'

export default {
	Load: ({ router }) => {
		setEndpoints(router)
	},
	Unload: () => {},
}
