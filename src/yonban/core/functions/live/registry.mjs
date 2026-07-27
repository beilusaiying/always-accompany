/**
 * registry.mjs — 直播平台注册表。
 *
 * 每个平台声明：显示名、adapter 模块路径、凭据控件、消息类型。
 * adapter 按需惰性加载（runtime 首次 connect 时动态 import，模块顶层零 import——避 TDZ 禁止项16）。
 *
 * 【功能链】
 *   本表 → main.mjs GetData.platforms（经 listPlatformsForUI 投影）→ 前端「直播设计」面板渲染平台下拉+凭据控件
 *   本表 → runtime.mjs（章5）按 config.platform 取 entry.module → 动态 import → adapter.connect()
 *
 * 【与 reach/registry.mjs 的关系：借结构，不借语义】
 *   借：声明式平台表 + credentials[] 凭据控件声明（凛倾 0722「前端凭据区按此渲染，零逐平台手写区块」）
 *   不借：reach 的 actions/backends/probe/fromUrl —— 那些是【一次性内容读取】语义
 *         （reach/adapters/bilibili.mjs 的契约是 execute(action,query,opts) 单次返回）。
 *   ⚠ 弹幕是【持续实时流】，契约是 connect(conf,onMessage,onError) → {close}。
 *     照搬 reach 的 adapter 形状 = 只能拿到一次快照，拿不到持续弹幕（图纸 v2 §六 雷区1）。
 *     两者互不共享代码、互不引用。
 */

/**
 * @typedef {Object} LivePlatformEntry
 * @property {string} label - 人类可读名（前端下拉显示）
 * @property {string} module - adapter 模块路径（相对本文件所在目录，runtime 动态 import 用）
 * @property {number} tier - 0=零配置可用 1=需登录凭据 2=复杂设置
 * @property {string[]} msgTypes - 该平台可产出的消息类型（对齐 LiveMessage.type 值域）
 * @property {Array<{key:string,label:string,desc:string,type:string,placeholder?:string}>} [credentials]
 *   - 凭据控件声明。前端据此【动态渲染】输入框，不逐平台手写区块（禁止项8 + reach/registry.mjs:28 既有范式）。
 *     key = per-user config.credentials 下的字段名；type = 前端 input 的 type（password 走密码框不明文回显）。
 * @property {string} [credentialHelp] - 凭据获取分步引导（多行文案，前端「如何获取?」折叠块正文）
 */

/**
 * 直播平台注册表。
 * 加平台 = 加一个条目 + 加一个 adapters/<name>.mjs，核心（runtime/filter/前端）零改动。
 * @type {Record<string, LivePlatformEntry>}
 */
export const LIVE_PLATFORM_REGISTRY = {
	bilibili: {
		label: '哔哩哔哩直播',
		module: './adapters/bilibili.mjs',
		tier: 1, // 不填凭据也能连（只收到部分弹幕），填了可见范围更全 → 归 1 而非 0
		msgTypes: ['danmaku', 'gift', 'enter', 'superchat'],
		credentials: [
			{ key: 'biliSessdata', label: 'SESSDATA', desc: '浏览器 Cookie 中的 SESSDATA 值（不填只能收到部分弹幕）', type: 'password' },
			{ key: 'biliBuvid3', label: 'buvid3', desc: '浏览器 Cookie 中的 buvid3 值', type: 'password' },
		],
		credentialHelp: '1. 在浏览器登录 bilibili.com\n2. 按 F12 → 「应用/Application」→ 左侧「Cookie」→ 点 https://www.bilibili.com\n3. 找到 SESSDATA，双击「值」一列复制，粘贴到上方第一格\n4. 同样找到 buvid3，复制粘贴到第二格\n（只想看公开弹幕可两格都留空）',
	},
}

/**
 * 平台表的【前端投影】——只出前端渲染需要的字段。
 *
 * 【为什么要投影而不是把 LIVE_PLATFORM_REGISTRY 整个下发】：
 *   module 是后端实现细节（磁盘相对路径），下发给前端既无用、又把内部结构暴露到 HTTP 响应里。
 *   前端只需要：显示什么名字(label) / 要不要填凭据(tier + credentials) / 怎么填(credentialHelp) / 有哪些消息类型(msgTypes)。
 *
 * 【与 capabilities 的分工，别合并】：
 *   registry = 平台【声明】（有哪些平台、各自要什么凭据）—— owner 是本文件
 *   capabilities = 用户【参数谱】（阈值/开关/值域）—— owner 是 capabilities.mjs
 *   两者不同域，各自单一 owner，在 GetData 里并列下发为两个字段，不合并成一个对象。
 *
 * @returns {Array<{id:string,label:string,tier:number,msgTypes:string[],credentials:Array<object>,credentialHelp:string}>}
 *   数组形态（非对象）：前端下拉按数组顺序渲染，顺序即本表书写顺序，无需前端再排序。
 */
export function listPlatformsForUI() {
	return Object.entries(LIVE_PLATFORM_REGISTRY).map(([id, e]) => ({
		id,
		label: e.label,
		tier: e.tier,
		msgTypes: Array.isArray(e.msgTypes) ? [...e.msgTypes] : [],
		credentials: Array.isArray(e.credentials) ? e.credentials.map((c) => ({ ...c })) : [],
		credentialHelp: e.credentialHelp || '',
		// ⚠ 刻意不出 module —— 后端实现细节不进 HTTP 响应
	}))
}

/**
 * 取某平台的注册条目（含 module，供 runtime 动态 import）。
 * @param {string} platformId
 * @returns {LivePlatformEntry|null} 未注册的平台返回 null（调用方诚实报错，不静默回退到某个默认平台）
 */
export function getPlatformEntry(platformId) {
	if (!platformId || typeof platformId !== 'string') return null
	return LIVE_PLATFORM_REGISTRY[platformId] || null
}