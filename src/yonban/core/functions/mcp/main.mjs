import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import url from 'node:url'

import { copy } from 'npm:fs-extra'

import { saveJsonFile } from '../../../../scripts/json_loader.mjs'
import { getUserDictionary } from '../security/auth.mjs'
import { isPartLoaded, reloadPart, setDefaultPartBatch } from '../../../../server/parts_loader.mjs'
import { confineSegment } from '../security/path_confine.mjs'

const templateDir = path.join(import.meta.dirname, '..', '..', '..', '..', 'public', 'parts', 'ImportHandlers', 'MCP', 'Template') // T3a·3.5: Template 是部署资产（复制到用户目录），留原位
import info from '../../../../public/parts/ImportHandlers/MCP/info.json' with { type: 'json' } // T3a·3.5: part 元数据留原位

/**
 * 将 MCP 配置文件作为数据导入。
 * @param {string} username - 用户名。
 * @param {Buffer} data - 配置数据缓冲区。
 * @returns {Promise<Array<string>>} - 导入的部分路径数组（partpath）。
 */
async function ImportAsData(username, data) {
	const configText = data.toString('utf-8')
	return await ImportByText(username, configText)
}

/**
 * 通过文本导入 MCP 配置。
 * @param {string} username - 用户名。
 * @param {string} text - MCP 配置的 JSON 文本。
 * @returns {Promise<Array<string>>} - 导入的部分路径数组（partpath）。
 */
async function ImportByText(username, text) {
	try {
		const config = JSON.parse(text)
		if (!config.mcpServers)
			throw new Error('Invalid MCP config: missing mcpServers')

		const installedParts = []
		// SEC-T3：收集需用户确认的条目（command 非空=可 spawn 宿主进程）。
		// 作为属性挂在 installedParts 数组上：保持原数组返回契约（length / for..of 不受影响）。
		// 传导链（07-09 核实已全通）：数组属性会被 JSON.stringify 丢弃——install/src/endpoints.mjs:40-43
		// 显式提取 needsConsent/consentItems 进响应对象 → mcpPanel:695 消费弹 RCE 确认 → approveMcp（原"前端接收归后续"已落地）。
		const consentItems = []
		const userPath = getUserDictionary(username)
		const pluginsDir = path.join(userPath, 'plugins')

		// 确保 plugins 目录存在
		await mkdir(pluginsDir, { recursive: true })

		// 为每个 MCP 服务器创建一个插件
		for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
			// SEC-T2：serverName 来自上传 JSON 的 key，不可信——净化为扁平段，阻断 ../ 写到 plugins 目录外
			const _safeServerName = confineSegment(serverName)
			if (!_safeServerName) throw new Error(`非法 MCP serverName: ${serverName}`)
			const pluginName = `mcp_${_safeServerName}`
			const pluginPath = path.join(pluginsDir, pluginName)

			// 复制模板文件夹
			await copy(templateDir, pluginPath)

			// 拆出 beilu 扩展项（roots / samplingAIsource），剩余 mcpConfig 为标准 MCP server 配置
			const { roots, samplingAIsource, ...mcpConfig } = serverConfig

			// SEC-T3 consent 打点：stdio 模式（command 非空）会 spawn 宿主进程执行任意命令，
			// 标记为需用户确认 + 后端日志告警。url 模式（远程 transport）不 spawn 本机进程，不打 consent。
			if (mcpConfig.command) {
				const consent = {
					serverName,
					pluginName,
					partpath: `plugins/${pluginName}`,
					command: mcpConfig.command,
					args: Array.isArray(mcpConfig.args) ? mcpConfig.args : [],
				}
				consentItems.push(consent)
				console.warn(
					`[SEC-T3][MCP consent] 用户 ${username} 导入可执行 MCP server "${serverName}" -> ` +
					`将 spawn: ${consent.command} ${consent.args.join(' ')} （需用户确认）`
				)
			}

			// 创建插件数据
			const pluginData = {
				name: pluginName,
				description: `MCP plugin for ${serverName}`,
				description_markdown: `MCP (Model Context Protocol) plugin for **${serverName}**`,
				tags: [serverName, 'mcp'],
				config: mcpConfig
			}

			// 如果有 roots 配置，添加到 pluginData
			if (roots) pluginData.roots = roots

			// 如果有 samplingAIsource 配置，添加到 pluginData
			if (samplingAIsource) pluginData.samplingAIsource = samplingAIsource

			// 保存 data.json
			await saveJsonFile(
				path.join(pluginPath, 'data.json'),
				pluginData
			)

			// 如果插件已加载，重新加载它
			// FT8-1: isPartLoaded 签名为 (username, partpath) 二参；原三参调用使 partpath 恒为字面量 'plugins'
			// （检查一个名为 plugins 的不存在部件→恒 false→永走预加载分支，已加载插件不会被 reload）。
			// 修：partpath 传完整 'plugins/<name>'，与下方 reloadPart 的路径口径对齐。
			if (isPartLoaded(username, 'plugins/' + pluginName))
				await reloadPart(username, 'plugins/' + pluginName)
			else // 预加载插件代码
				import(url.pathToFileURL(path.join(pluginPath, 'main.mjs'))).catch(e => { console.warn(`[mcp] 插件 ${pluginName} 预加载失败:`, e?.message || e); return e }) // T021 留痕：原 .catch(x=>x) 纯吞

			installedParts.push(`plugins/${pluginName}`)
		}

		// 断链修（2026-07-16 链路走查确诊）：原导入零 setDefaultPart——mcpPanel 导入流程只把插件
		// mountPlugin 进「导入时的当前对话」（全前端唯一挂载点），而新对话 StartNewAs 的插件初始集
		// = getAllDefaultParts（models.mjs），MCP 不在 → 用户换/新建对话后 MCP 工具静默消失且无恢复
		// 入口（死配置）。修=导入即入用户级默认插件集（defaultParts 是「用户级默认插件」的既有正主，
		// beilu-memory Load 同范式）；per-chat 挂载/移除机制原样保留（「从当前聊天移除」仍 per-chat 生效）。
		try {
			setDefaultPartBatch(username, 'plugins', installedParts.map((p) => p.replace(/^plugins\//, '')))
		} catch (e) {
			console.warn(`[mcp] setDefaultPartBatch 失败（新对话将不含本次导入的 MCP，需手动挂载）: ${e?.message || e}`)
		}

		// SEC-T3：把 consent 标志挂到数组上（不改变数组本身的 length / 元素，
		// 兼容 Installer_handler 的 for..of / .length 消费方式）。
		installedParts.needsConsent = consentItems.length > 0
		installedParts.consentItems = consentItems

		return installedParts
	} catch (err) {
		throw new Error(`Failed to import MCP config: ${err.message || err}`)
	}
}

/**
 * MCP 导入器模块定义。
 */
export default {
	info,
	interfaces: {
		import: {
			ImportAsData,
			ImportByText,
		}
	}
}
