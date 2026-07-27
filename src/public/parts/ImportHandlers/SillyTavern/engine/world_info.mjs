import seedrandom from 'npm:seedrandom'

import { world_info_logic, world_info_position, extension_prompt_roles } from './charData.mjs' // 枚举与类型来源
import { evaluateMacros } from './marco.mjs' // 宏引擎，接受 memory（chat 作用域）做变量替换
import { escapeRegExp, parseRegexFromString } from './tools.mjs' // 正则工具：转义 / 解析斜杠分隔的正则串

/**
 * WI 设置
 */
export const WISettings = { // WI 设置，可以保持默认值或根据 beilu 环境调整
	depth: 4, // 扫描深度，表示在多少轮对话中查找关键词
	isSensitive: false, // 是否区分大小写
	isFullWordMatch: true // 是否全词匹配
}

/**
 * 构建关键词列表，将字符串关键词转换为正则表达式
 * @param {string[]} keys 关键词数组
 * @param {boolean} isSensitive 是否区分大小写
 * @param {boolean} isFullWordMatch 是否全词匹配
 * @returns {RegExp[]} 正则表达式数组
 */
function buildKeyList(keys, isSensitive, isFullWordMatch) {
	return keys.map(key => {
		const regtest = parseRegexFromString(key) // 尝试解析为正则表达式
		if (regtest) return regtest // 如果解析成功，直接返回正则表达式
		key = escapeRegExp(key) // 转义正则表达式特殊字符
		if (isFullWordMatch) key = `\\b${key}\\b` // 如果是全词匹配，添加单词边界
		return new RegExp(key, isSensitive ? 'ug' : 'ugi') // 创建正则表达式
	})
}

/**
 * 判断是否至少有一个正则表达式匹配内容
 * @param {RegExp[]} list 正则表达式数组
 * @param {string} content 要匹配的内容
 * @returns {boolean} 是否匹配
 */
function isAnyMatch(/** @type {RegExp[]} */list, /** @type {string} */content) {
	for (const key of list)
		if (key.test(content)) return true // 如果任何一个正则表达式匹配，则返回 true
	return false
}

/**
 * 判断是否所有正则表达式都匹配内容
 * @param {RegExp[]} list 正则表达式数组
 * @param {string} content 要匹配的内容
 * @returns {boolean} 是否匹配
 */
function isAllMatch(/** @type {RegExp[]} */list, /** @type {string} */content) {
	for (const key of list)
		if (!key.test(content)) return false // 如果任何一个正则表达式不匹配，则返回 false
	return true
}

/**
 * 判断是否没有任何正则表达式匹配内容
 * @param {RegExp[]} list 正则表达式数组
 * @param {string} content 要匹配的内容
 * @returns {boolean} 是否匹配
 */
function notAnyMatch(/** @type {RegExp[]} */list, /** @type {string} */content) {
	for (const key of list)
		if (key.test(content)) return false // 如果任何一个正则表达式匹配，则返回 false
	return true
}

/**
 * 判断是否不是所有正则表达式都匹配内容
 * @param {RegExp[]} list 正则表达式数组
 * @param {string} content 要匹配的内容
 * @returns {boolean} 是否匹配
 */
function notAllMatch(/** @type {RegExp[]} */list, /** @type {string} */content) {
	for (const key of list)
		if (!key.test(content)) return true // 如果任何一个正则表达式不匹配，则返回 true
	return false
}

/**
 * 预处理 WI 条目：编译正则表达式，并准备激活检查
 * @param {WorldInfoEntry[]} WIentries WI 条目数组
 */
function preBuiltWIEntries(WIentries) {
	for (const entrie of WIentries) {
	  try {
		const isSensitive = entrie.extensions.case_sensitive == null ? WISettings.isSensitive : entrie.extensions.case_sensitive // 获取是否区分大小写
		const isFullWordMatch = entrie.extensions.match_whole_words == null ? WISettings.isFullWordMatch : entrie.extensions.match_whole_words // 获取是否全词匹配
		entrie.keys = buildKeyList(entrie.keys, isSensitive, isFullWordMatch) // 构建关键词正则表达式列表
		entrie.secondary_keys = buildKeyList(entrie.secondary_keys, isSensitive, isFullWordMatch) // 构建辅助关键词正则表达式列表

		/**
		 * @param {any} chatLog 聊天记录
		 * @param {any} recursion_WIs 递归世界信息
		 * @param {any} memory 内存
		 * @param {any} entryIndex 条目索引
		 * @returns {boolean} 如果条目已激活，则返回 true。
		 */
		entrie.isActived = (chatLog, recursion_WIs, memory, entryKey) => { // 传递 memory 和条目稳定键 uid
			const last_enabled_raw = memory?.enabled_WI_entries?.[entryKey] // 取激活态原值：undefined=从未激活过（无记录），不可与"在第0条激活"混淆
			const has_prior_activation = last_enabled_raw != null // 是否存在历史激活记录（ST：无记录则 sticky/cooldown 都不生效）
			const last_enabled_chat_length = last_enabled_raw ?? 0 // 数值化，仅在 has_prior_activation 为真时参与 sticky/cooldown 窗口计算

			if (entrie.extensions.delay && entrie.extensions.delay > chatLog.length) return false // 如果有延迟，并且延迟大于对话长度，则不激活
			if (has_prior_activation && entrie.extensions.sticky && last_enabled_chat_length + entrie.extensions.sticky >= chatLog.length) return true // 粘性：仅当有历史激活记录时，激活后 sticky 条消息内（窗口内）保持激活
			if (has_prior_activation && entrie.extensions.cooldown && last_enabled_chat_length + entrie.extensions.cooldown > chatLog.length) return false // 冷却：仅当有历史激活记录时，激活后 cooldown 条消息内（窗口内）抑制；窗口过后放行（对齐 ST 语义，与 sticky 镜像；原 <= 方向反致冷却期一过永久禁用，且 ?? 0 将"从未激活"误当"在第0条激活"——一并根因修）
			if (entrie.extensions.useProbability && seedrandom(
				entrie.keys.join() + entrie.secondary_keys.join() + entrie.content, { entropy: true }
			)() > entrie.extensions.probability / 100) return false // 如果有概率，并且随机数大于概率，则不激活

			// B11(20260610): per-entry scan_depth 条目级覆盖（对齐 ST 语义）。null/undefined→回退全局 WISettings.depth；
			// 显式 0→只扫 0 条对话（ST：scan depth 0 = 不扫历史，仅靠 constant/递归内容），避免 slice(-0)===slice(0) 返回全量的 JS 陷阱。
			const _scanDepth = entrie.extensions.scan_depth == null ? WISettings.depth : entrie.extensions.scan_depth
			const _recentChat = _scanDepth > 0 ? chatLog.slice(-_scanDepth) : []
			let content = _recentChat.map(e => (e.charname || e.role) + ': ' + e.content).join('\n') // 获取最近对话记录，并拼接成字符串
			if (!entrie.extensions.exclude_recursion) content += '\n' + recursion_WIs.join('\n'); // 如果不排除递归，则添加递归 WI 内容

			[...entrie.keys, ...entrie.secondary_keys].forEach(key => { key.lastIndex = 0 }) // 重置正则表达式 lastIndex
			if (isAnyMatch(entrie.keys, content)) { // 如果主关键词匹配
				if (!entrie.secondary_keys.length) return true // 如果没有辅助关键词，则激活
				switch (entrie.extensions.selectiveLogic) { // 根据选择逻辑判断是否激活
					case world_info_logic.AND_ALL: return isAllMatch(entrie.secondary_keys, content) // 所有辅助关键词都匹配
					case world_info_logic.AND_ANY: return isAnyMatch(entrie.secondary_keys, content) // 任何一个辅助关键词匹配
					case world_info_logic.NOT_ALL: return notAllMatch(entrie.secondary_keys, content) // 不是所有辅助关键词都匹配
					case world_info_logic.NOT_ANY: return notAnyMatch(entrie.secondary_keys, content) // 没有任何一个辅助关键词匹配
				}
			}
			return false // 如果主关键词不匹配或辅助关键词不满足条件，则不激活
		}
	  } catch (e) {
		// per-entry 隔离：一条目编译/闭包构建失败不影响其他条目
		console.warn(`[world_info] 条目 "${entrie.comment || entrie.uid || '?'}" 编译失败，跳过: ${e.message}`)
		entrie._buildFailed = true
	  }
	}
}

/**
 * 获取激活的 WI 条目列表
 * @param {WorldInfoEntry[]} WIentries 所有 WI 条目
 * @param {{role:string,charname?:string,content:string}[]} chatLog 聊天记录
 * @param {Record<string, any>} env 环境信息（用户、角色、模型等）
 * @param {Record<string, any>} memory 聊天作用域的内存对象
 * @returns {WorldInfoEntry[]} 激活的 WI 条目数组
 */
export function GetActivedWorldInfoEntries(
	WIentries,
	chatLog,
	env,
	memory
) {
	/** @type {WorldInfoEntry[]} */
	let WIdata_copy = structuredClone(WIentries.filter(e => e.enabled)) // 使用 structuredClone 进行深拷贝
	let aret = [] // 存储激活的 WI 条目

	// 初始化内存中的 enabled_WI_entries，如果不存在的话
	memory.enabled_WI_entries ??= {}

	for (const entrie of WIdata_copy) {
		entrie.keys = entrie.keys.map(k => evaluateMacros(k, env, memory)).filter(k => k) // 替换关键词中的宏
		entrie.secondary_keys = entrie.secondary_keys.map(k => evaluateMacros(k, env, memory)).filter(k => k) // 替换辅助关键词中的宏
		entrie.extensions ??= {} // 确保 extensions 存在
		entrie.extensions.position ??= entrie.position == 'before_char' ? world_info_position.before : world_info_position.after // 设置位置
		entrie.extensions.role ??= extension_prompt_roles.SYSTEM // 设置角色
	}

	preBuiltWIEntries(WIdata_copy) // 预处理 WI 条目
	WIdata_copy = WIdata_copy.filter(e => !e._buildFailed) // 移除编译失败的条目（per-entry 隔离，不影响正常条目）
	let recursion_WIs = [] // 存储递归 WI 内容
	const availableRecursionDelayLevels = [...new Set(
		WIdata_copy.map(entry => Number(entry.extensions.delay_until_recursion))
	)].sort((a, b) => a - b) // 获取并排序所有延迟递归级别

	for (const currentRecursionDelayLevel of availableRecursionDelayLevels) {
		let new_entries = []
		do {
			let WIdata_new = [...WIdata_copy]
			new_entries = []
			for (let i = 0; i < WIdata_copy.length; i++) { // 使用索引循环
				const entrie = WIdata_copy[i]
				let _activated = false
				try {
					_activated = entrie.constant || entrie.isActived(chatLog, recursion_WIs, memory, entrie.uid ?? entrie.id)
				} catch (e) {
					console.warn(`[world_info] 条目 "${entrie.comment || entrie.uid || '?'}" 激活检查失败，跳过: ${e.message}`)
					WIdata_new = WIdata_new.filter(en => en !== entrie) // 从后续循环中移除，防止重复报错
					continue
				}
				if (_activated) { // 传递稳定键 uid??id（M7+：ST卡内嵌世界书条目无uid只有id，退回id避免全条目共写[undefined]串台）
					if (entrie.extensions.delay_until_recursion > currentRecursionDelayLevel) continue

					memory.enabled_WI_entries[entrie.uid ?? entrie.id] = chatLog.length // 存储激活回合数，使用稳定键 uid??id（M7+：与上行取键一致，ST卡路径退回id）

					entrie.content = evaluateMacros(entrie.content, env, memory) // 替换 WI 内容中的宏
					new_entries.push(entrie) // 添加到新激活的 WI 条目
					WIdata_new = WIdata_new.filter(e => e !== entrie) // 从待处理 WI 列表中移除
				}
			}
			WIdata_copy = WIdata_new.filter(e => !e.extensions.exclude_recursion) // 移除排除递归的 WI 条目
			recursion_WIs = recursion_WIs.concat(new_entries.filter(e => !e.extensions.prevent_recursion).map(e => e.content)) // 添加到递归 WI 列表中
			aret = aret.concat(new_entries) // 合并到结果列表中
		} while (new_entries.length) // 如果有新的激活条目，则继续
	}

	for (const entrie of aret) delete entrie.isActived // 清理 isActived 函数
	return aret // 返回激活的 WI 条目列表
}
