// service_worker.mjs — 自毁墓碑（kill-switch SW）
//
// why(2026-07-20 全链审计定案):SW 缓存机制已整体禁用(base.mjs 只注销不注册),但本文件此前
// 仍保留 802 行"活的"完整缓存实现且被 express.static 照常伺服——老安装浏览器里已激活的旧 SW
// 走浏览器更新机制拉到的还是"会缓存旧前端"的版本,继续挟持页面伺服旧代码;而唯一解除手段
// (base.mjs 运行时注销)若恰好被旧缓存的旧 base.mjs 挡住就永久失守。
// 正解=墓碑:旧 SW 更新到本版本后,activate 即清空全部 Cache Storage、注销自身、强刷受控页——
// 老客户端下一次加载即回到"直连服务端拿新前端"的干净态。文件保留(非 404)因 404 依赖各浏览器
// 更新失败语义,墓碑是确定性自毁。
// 如需重新启用 SW 缓存:从 git 历史恢复本文件旧实现,并恢复 base.mjs 的注册行(成对操作)。

self.addEventListener('install', () => {
	// 跳过 waiting,让墓碑立即接管旧 SW 的位置
	self.skipWaiting()
})

self.addEventListener('activate', event => {
	event.waitUntil((async () => {
		// 1. 清空全部遗留缓存(旧 SW 的 Cache Storage 是"旧前端代码"的宿主)
		try {
			for (const key of await caches.keys()) await caches.delete(key)
		} catch { /* 清不掉也要继续注销 */ }
		// 2. 接管所有受控页并强制刷新——让它们脱离 SW 缓存、直连服务端拿新代码
		try {
			await self.clients.claim()
			for (const client of await self.clients.matchAll({ type: 'window' }))
				client.navigate(client.url).catch(() => { })
		} catch { /* 刷不动的页面在下次手动刷新时也已无缓存可用 */ }
		// 3. 自我注销:彻底移出 SW 注册表,后续加载零 SW 参与
		try { await self.registration.unregister() } catch { /* 注销失败=下次 activate 重试 */ }
	})())
})

// 不注册任何 fetch 处理器:墓碑存活期间所有请求直连网络,零拦截零缓存。
