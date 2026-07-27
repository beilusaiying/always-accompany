import { authenticate, getUserByReq } from '../../../../../yonban/core/functions/security/auth.mjs'
// [0716 W3 刷新机制] AI 源增删改广播出口（preset_list_changed 同范式；dispatcher 不依赖具体 shell 无环）
import { dispatch } from '../../../../../yonban/core/dispatch/dispatcher.mjs'

import { addServiceSourceFile, deleteServiceSourceFile, getConfigDisplay, getConfigTemplate, getProviderMeta, getServiceSourceFile, saveServiceSourceFile } from './manager.mjs'

// [0716 W3 刷新机制] 服务源增删改/设默认后单点广播——此前全库无 aisource 广播（事件配对矩阵普查 D3）：
//   跨窗口增删改源后，别窗口的源下拉/模型列表定格旧值。消费链：websocket "aisource_changed" →
//   失效前端源/模型缓存 + 派发既有内部事件 resource:api-changed（复用 settingsSlots/apiConfig/layout 全部既有消费者）。
async function _broadcastSourcesChanged(username, type, name) {
	try {
		const _r = await dispatch({
			target: 'bus:broadcast', verb: 'emitAll', source: 'yonban',
			payload: { username: username !== '_default' ? username : undefined, event: { type: 'aisource_changed', payload: { sourceType: type, name } } },
		})
		if (!_r?.ok) console.warn('[serviceSourceManage] aisource_changed 广播失败:', _r?.error?.msg)
	} catch (e) { console.warn('[serviceSourceManage] aisource_changed 广播异常:', e?.message) }
}

/**
 * 根据类型推断服务源路径。
 * @param {string} type - 服务源类型。
 * @returns {string} - 推断的服务源路径。
 */
function inferServiceSourcePath(type = 'AI') {
	return `serviceSources/${type}`
}

/**
 * 为服务源管理设置API端点，使用 RESTful 风格。
 * @param {object} router - Express的路由实例。
 */
export function setEndpoints(router) {
	// 列出指定类型的所有服务源
	router.get('/api/parts/shells\\:serviceSourceManage/:type', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const { type = 'AI' } = req.params
		const serviceSourcePath = inferServiceSourcePath(type)
		const { getPartList } = await import('../../../../../server/parts_loader.mjs')
		const list = await getPartList(username, serviceSourcePath)
		res.status(200).json(list)
	})

	// 获取特定服务源的配置
	router.get('/api/parts/shells\\:serviceSourceManage/:type/:name', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const { type = 'AI', name } = req.params
		const serviceSourcePath = inferServiceSourcePath(type)
		const data = await getServiceSourceFile(username, name, serviceSourcePath)
		res.status(200).json(data)
	})

	// 创建或更新服务源
	router.post('/api/parts/shells\\:serviceSourceManage/:type/:name', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const { type = 'AI', name } = req.params
		const serviceSourcePath = inferServiceSourcePath(type)
		const { generator, config } = req.body

		// 检查服务源是否存在
		const existing = await getServiceSourceFile(username, name, serviceSourcePath).catch(() => null)

		if (existing && (existing.generator || existing.config)) {
			// 更新现有服务源
			const data = {
				...existing,
				config: config ? { ...existing.config, ...config } : existing.config
			}
			if (generator) data.generator = generator
			await saveServiceSourceFile(username, name, data, serviceSourcePath)
			await _broadcastSourcesChanged(username, type, name) // [0716 W3]
			res.status(200).json({ message: 'Service source updated successfully' })
		}
		else {
			// 创建新服务源
			await addServiceSourceFile(username, name, serviceSourcePath)
			if (generator || config) {
				const data = await getServiceSourceFile(username, name, serviceSourcePath)
				if (generator) data.generator = generator
				if (config) data.config = { ...data.config, ...config }
				await saveServiceSourceFile(username, name, data, serviceSourcePath)
			}
			await _broadcastSourcesChanged(username, type, name) // [0716 W3]
			res.status(201).json({ message: 'Service source created successfully' })
		}
	})

	// 删除服务源
	router.delete('/api/parts/shells\\:serviceSourceManage/:type/:name', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const { type = 'AI', name } = req.params
		const serviceSourcePath = inferServiceSourcePath(type)
		// T026: mode=permanent 彻底删（防留痕，前端弹窗显式选择后才传）；缺省/其他值一律进回收站
		const mode = req.query?.mode === 'permanent' ? 'permanent' : 'trash'
		await deleteServiceSourceFile(username, name, serviceSourcePath, mode)
		await _broadcastSourcesChanged(username, type, name) // [0716 W3]
		res.status(200).json({ message: 'Service source deleted successfully', mode })
	})

	// 设置默认服务源
	router.put('/api/parts/shells\\:serviceSourceManage/:type/:name/default', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const { type = 'AI', name } = req.params
		const serviceSourcePath = inferServiceSourcePath(type)
		const { setDefaultPart } = await import('../../../../../server/parts_loader.mjs')
		await setDefaultPart(username, serviceSourcePath, name)
		// beilu: achievements 已删除
		await _broadcastSourcesChanged(username, type, name) // [0716 W3]
		res.status(200).json({ message: 'Service source set as default successfully' })
	})

	// 从生成器获取配置模板（不需要服务源名称）
	router.get('/api/parts/shells\\:serviceSourceManage/:type/generators/:generator/template', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const { type = 'AI', generator } = req.params
		const serviceSourcePath = inferServiceSourcePath(type)
		const template = await getConfigTemplate(username, generator, serviceSourcePath)
		res.status(200).json(template)
	})

	// 渠道元数据：provider 枚举+label+默认URL+坑提示（前端渠道下拉单源，见 manager.getProviderMeta）
	// 路径 3 段（/:type/generators/providermeta）与既有 2 段（/:type/:name）、4 段（…/:generator/template）不冲突
	router.get('/api/parts/shells\\:serviceSourceManage/:type/generators/providermeta', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const { type = 'AI' } = req.params
		const serviceSourcePath = inferServiceSourcePath(type)
		const meta = await getProviderMeta(username, serviceSourcePath)
		res.status(200).json(meta)
	})

	// 从生成器获取配置显示（不需要服务源名称）
	router.get('/api/parts/shells\\:serviceSourceManage/:type/generators/:generator/display', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const { type = 'AI', generator } = req.params
		const serviceSourcePath = inferServiceSourcePath(type)
		const content = await getConfigDisplay(username, generator, serviceSourcePath)
		res.status(200).json(content)
	})

	// 从服务源获取配置模板（如果服务源存在，使用其配置）
	router.get('/api/parts/shells\\:serviceSourceManage/:type/:name/template', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const { type = 'AI', name } = req.params
		const serviceSourcePath = inferServiceSourcePath(type)
		let { generator } = req.query

		// 尝试从服务源获取信息
		try {
			const data = await getServiceSourceFile(username, name, serviceSourcePath)
			generator = generator || data?.generator
		}
		catch {
			// 如果服务源不存在，继续使用查询参数
		}

		if (!generator) {
			res.status(400).json({ error: 'Generator not specified' })
			return
		}
		const template = await getConfigTemplate(username, generator, serviceSourcePath)
		res.status(200).json(template)
	})

	// 从服务源获取配置显示（如果服务源存在，使用其配置）
	router.get('/api/parts/shells\\:serviceSourceManage/:type/:name/display', authenticate, async (req, res) => {
		const { username } = await getUserByReq(req)
		const { type = 'AI', name } = req.params
		const serviceSourcePath = inferServiceSourcePath(type)
		let { generator } = req.query

		// 尝试从服务源获取信息
		try {
			const data = await getServiceSourceFile(username, name, serviceSourcePath)
			generator = generator || data?.generator
		}
		catch {
			// 如果服务源不存在，继续使用查询参数
		}

		if (!generator) {
			res.status(200).json({ html: '', js: '' })
			return
		}
		const content = await getConfigDisplay(username, generator, serviceSourcePath)
		res.status(200).json(content)
	})
}
