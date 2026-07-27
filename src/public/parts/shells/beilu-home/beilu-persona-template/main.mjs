import info from './info.json' with { type: 'json' }

/**
 * 用户人设 — 最小模板
 *
 * persona part 只需要提供 info（name / description 等）
 * 聊天系统通过 getPartDetails 读取 info 来构建用户描述
 */
export default {
	info,
	Load: async () => { },
	Unload: async () => { },
	interfaces: {},
}