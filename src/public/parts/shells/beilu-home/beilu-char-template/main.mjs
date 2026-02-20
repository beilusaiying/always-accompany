/**
 * beilu 角色卡模板 — 从 ST 角色卡导入时使用
 *
 * 注意：此文件会被复制到 data/users/{username}/chars/{charName}/main.mjs
 * 因此 import 路径基于 data/users/xxx/chars/yyy/ 的 5 层深度
 *
 * 特性：
 * - 走 beilu 插件体系（beilu-preset 司令员模式接管提示词）
 * - 自动使用默认 AIsource（不需要单独配置）
 * - 开场白原样返回（display regex 由前端负责美化渲染）
 * - 角色卡的 description/personality/scenario 等通过 GetPrompt 输出
 *   交给 beilu-preset 的 TweakPrompt 接管
 *
 * @typedef {import('../../../../../src/decl/charAPI.ts').CharAPI_t} CharAPI_t
 * @typedef {import('../../../../../src/decl/pluginAPI.ts').PluginAPI_t} PluginAPI_t
 */

import fs from 'node:fs'
import path from 'node:path'

import { buildPromptStruct } from '../../../../../src/public/parts/shells/chat/src/prompt_struct.mjs'
import { loadAnyPreferredDefaultPart, loadPart } from '../../../../../src/server/parts_loader.mjs'

/** @type {import('../../../../../src/decl/AIsource.ts').AIsource_t} */
let AIsource = null
/** @type {Record<string, PluginAPI_t>} */
let plugins = {}
let username = ''

const chardir = import.meta.dirname
const charjson = path.join(chardir, 'chardata.json')
const charurl = `/parts/chars:${encodeURIComponent(path.basename(chardir))}`

// 读取角色卡数据
let chardata = {}
try {
	chardata = JSON.parse(fs.readFileSync(charjson, 'utf-8'))
} catch (e) {
	console.warn('[beilu-char] 读取 chardata.json 失败:', e.message)
}

/** @type {CharAPI_t} */
export default {
	info: {
		'': {
			name: chardata.name || path.basename(chardir),
			avatar: fs.existsSync(path.join(chardir, 'public', 'image.png'))
				? charurl + '/image.png'
				: '',
			description: (chardata.creator_notes || chardata.description || '').split('\n')[0] || '',
			description_markdown: chardata.creator_notes || chardata.description || '',
			version: chardata.character_version || '1.0',
			author: chardata.creator || '',
			tags: chardata.tags || [],
		},
	},

	Load: (stat) => {
		username = stat.username
	},

	interfaces: {
		config: {
			GetData: () => ({
				AIsource: AIsource?.filename || '',
				plugins: Object.keys(plugins),
				chardata,
			}),
			SetData: async (data) => {
				if (data.AIsource)
					AIsource = await loadPart(username, 'serviceSources/AI/' + data.AIsource)
				else
					AIsource = await loadAnyPreferredDefaultPart(username, 'serviceSources/AI')
				if (data.plugins)
					plugins = Object.fromEntries(
						await Promise.all(data.plugins.map(async (x) => [x, await loadPart(username, 'plugins/' + x)]))
					)
			},
		},
		chat: {
			/**
			 * 开场白 — 原样返回 first_mes / alternate_greetings
			 * display regex 由前端 beilu-chat 负责美化渲染
			 */
			GetGreeting: (_args, index) => {
					const greetings = [
						chardata.first_mes,
						...(chardata.alternate_greetings || []),
					].filter((x) => x)
					if (!greetings.length) return { content: '' }
					if (index >= greetings.length) throw new Error('Invalid index')
					return { content: greetings[index] }
				},

			GetGroupGreeting: (_args, index) => {
				const greetings = [
					...(chardata.extensions?.group_greetings || []),
					...(chardata.group_only_greetings || []),
				].filter((x) => x)
				if (index >= greetings.length) throw new Error('Invalid index')
				return { content: greetings[index] }
			},

			/**
			 * GetPrompt — 将角色卡数据作为 text[] 输出
			 * beilu-preset 司令员模式会在 TweakPrompt 中接管这些内容
			 */
			GetPrompt: (_args) => {
				const texts = []

				if (chardata.system_prompt) {
					texts.push({
						content: chardata.system_prompt,
						important: 3,
						description: 'system_prompt',
					})
				}

				if (chardata.description) {
					texts.push({
						content: chardata.description,
						important: 2,
						description: 'char_description',
					})
				}

				if (chardata.personality) {
					texts.push({
						content: chardata.personality,
						important: 2,
						description: 'personality',
					})
				}

				if (chardata.scenario) {
					texts.push({
						content: chardata.scenario,
						important: 1,
						description: 'scenario',
					})
				}

				if (chardata.mes_example) {
					texts.push({
						content: chardata.mes_example,
						important: -1,
						description: 'mes_examples',
					})
				}

				if (chardata.post_history_instructions) {
					texts.push({
						content: chardata.post_history_instructions,
						important: 0,
						description: 'post_history_instructions',
					})
				}

				// depth_prompt（如果有）
				const dp = chardata.extensions?.depth_prompt
				if (dp?.prompt) {
					texts.push({
						content: dp.prompt,
						important: 0,
						description: `depth_prompt_d${dp.depth || 4}`,
					})
				}

				return {
					text: texts,
					additional_chat_log: [],
					extension: {},
				}
			},

			/**
			 * GetReply — 标准 beilu 模式
			 * 使用默认 AIsource + buildPromptStruct + 插件 ReplyHandler
			 */
			GetReply: async (args) => {
				if (!AIsource) {
					return {
						content:
							'请先配置 AI 源。[前往设置](/parts/shells:serviceSourceManage)',
					}
				}

				// 注入角色插件
				args.plugins = Object.assign({}, plugins, args.plugins)

				// 构建提示词结构
				const prompt_struct = await buildPromptStruct(args)

				/** @type {import('../../../../../src/public/parts/shells/chat/decl/chatLog.ts').chatReply_t} */
				const result = {
					content: '',
					logContextBefore: [],
					logContextAfter: [],
					files: [],
					extension: {},
				}

				function AddLongTimeLog(entry) {
					entry.charVisibility = [args.char_id]
					result?.logContextBefore?.push?.(entry)
					prompt_struct.char_prompt.additional_chat_log.push(entry)
				}

				// 构建更新预览管线
				args.generation_options ??= {}
				const oriReplyPreviewUpdater = args.generation_options?.replyPreviewUpdater
				let replyPreviewUpdater = (_args, r) => oriReplyPreviewUpdater?.(r)
				for (const GetReplyPreviewUpdater of [
					...Object.values(args.plugins)
						.map((plugin) => plugin.interfaces?.chat?.GetReplyPreviewUpdater)
						.filter(Boolean),
				])
					replyPreviewUpdater = GetReplyPreviewUpdater(replyPreviewUpdater)

				args.generation_options.replyPreviewUpdater = (r) =>
					replyPreviewUpdater(args, r)

				// 重新生成循环
				regen: while (true) {
					args.generation_options.base_result = result
					await AIsource.StructCall(prompt_struct, args.generation_options)
					let continue_regen = false
					for (const replyHandler of [
						...Object.values(args.plugins)
							.map((plugin) => plugin.interfaces?.chat?.ReplyHandler)
							.filter(Boolean),
					])
						if (await replyHandler(result, { ...args, prompt_struct, AddLongTimeLog }))
							continue_regen = true
					if (continue_regen) continue regen
					break
				}

				return result
			},
		},
	},
}