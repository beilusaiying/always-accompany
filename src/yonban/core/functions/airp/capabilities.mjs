/**
 * capabilities.mjs — AIRP 渲染能力谱（全局出厂默认 + data/airp_config.json 覆盖）。
 *
 * 单源权威（凛倾禁硬编码范式，照 injection_state.mjs:618 PET_CAPABILITIES / :731 loadPetCapabilities）：
 *   配色板 / DSL标签集 / 动态效果默认 / 自适应参数的【唯一出厂默认】住这里的 AIRP_CAPABILITIES 常量。
 *   全局覆盖：data/airp_config.json 顶层键 merge（改配色/加标签/调阈值=改数据文件，不改源码）。
 *   个人覆盖：per-user 层在 main.mjs（data/users/<user>/airp/config.json），消费时叠加在本谱之上。
 *   → 有效值 = AIRP_CAPABILITIES ← data/airp_config.json（全局） ← per-user config（个人）。任何消费方零本地副本。
 *
 * 铁律(002)：参数只是参照，禁止硬编码，用户需要可以设置一切。
 *   ↳ 常量=代码持出厂默认(合规)；全局 data 文件可改；per-user 可改。三层皆非写死。
 *
 * DSL 标签集(tagSpec)声明哪些标签/属性合法——渲染器据此判定，未知标签降级纯文本(第4章)。
 */
import fs from 'node:fs'
import { join } from 'node:path'

/**
 * AIRP 渲染能力出厂默认。命名色为语义名→CSS 色值；tagSpec 声明合法标签与属性；
 * dynEffects 为动态效果开关+参数；layout 为对话框自适应断点/列数域。
 * 全部为【示意默认】——002 玩起来后按体验调，改这里或改 data/airp_config.json 均可。
 * @type {{
 *   palette: Record<string,string>,
 *   tagSpec: Record<string, {attrs: string[], desc: string}>,
 *   dynEffects: {enabled: boolean, glow: boolean, rain: boolean, flicker: boolean, respectReducedMotion: boolean},
 *   layout: {adaptive: boolean, minColWidthPx: number, maxCols: number, narrowBreakpointPx: number},
 *   fallback: {unknownTagAsText: boolean}
 * }}
 */
export const AIRP_CAPABILITIES = {
	// 命名色板：DSL 里 bg/light/color 写语义名，渲染器查此表得 CSS 值。用户可增改。
	palette: {
		'雨夜': '#0f1419',
		'霓虹红': '#ff0033',
		'霓虹蓝': '#00e5ff',
		'霓虹紫': '#b026ff',
		'暖黄': '#ffcc66',
		'冷青': '#66ffe0',
		'血月': '#8b0000',
		'晨雾': '#c8d6e5',
		'暗夜': '#1a1a2e',
		'cyan': '#00ffff',
		'magenta': '#ff00ff',
		'amber': '#ffbf00',
	},

	// DSL 标签集：声明合法标签 + 各自允许的属性。渲染器据此校验，未知标签走 fallback。
	tagSpec: {
		scene: { attrs: ['bg', 'light'], desc: '场景容器，bg/light 查 palette 得背景色/光照色' },

		char: { attrs: ['name', 'mood', 'pos'], desc: '角色位，name/mood/pos(左中右)' },
		desc: { attrs: ['color'], desc: '叙事文本，color 查 palette 着色' },
	},

	// 动态效果(第4章 D-B)：默认可开，用户可整体关(防性能)；respectReducedMotion 尊重系统减动效偏好。
	dynEffects: {
		enabled: true,
		glow: true,      // light 场景→辉光呼吸
		rain: true,      // bg 含雨→雨滴动画
		flicker: true,   // 霓虹闪烁
		respectReducedMotion: true,
	},

	// 对话框自适应(第4章 D-A·002原话"结合算法当前对话框自适应")：渲染器读容器宽度调符号画列数。
	layout: {
		adaptive: true,
		minColWidthPx: 8,       // 单符号列最小像素宽(等宽字体基准)
		maxCols: 80,            // 符号画最大列数上限
		narrowBreakpointPx: 480, // 窄于此宽度→紧凑布局
	},

	// 容错(第4章)：未知标签/属性降级为纯文本，不炸渲染。
	fallback: {
		unknownTagAsText: true,
	},

	// DSL 操作说明(第5章·002原话"inj 让 ai 知道怎么操作")：由 airp GetPrompt 注入提示词，告诉 LLM 能输出哪些 DSL 标签。
	// 【默认值】住此常量(禁硬编码合规)：用户可经 data/airp_config.json 全局改 或 per-user config 改；设为空字符串 '' 即关闭注入(不额外加开关，最小)。
	// 模板字符串包裹——含 <scene bg="雨夜"> 等标签的尖括号/双引号无需转义。
	dslGuide: `你可以用 AIRP 符号 DSL 标签渲染场景，让画面更有氛围。可用标签：
- <scene bg="背景色名" light="光照色名">...</scene>：场景容器，包裹整个画面。bg/light 用命名色(如 雨夜/霓虹红/暗夜/cyan)。

- <char name="角色名" mood="情绪" pos="左|中|右" />：角色位，自闭合。
- <desc color="颜色名">叙事文本</desc>：着色的叙事文本。
数值变化用 <airp-patch>[{"op":"delta","path":"好感度","value":5}]</airp-patch>（op 支持 delta 增量/set 赋值/remove 删除），数值由系统确定性计算，你只需写指令。
示例：
<scene bg="雨夜" light="霓虹红"><char name="酒保" mood="警惕" pos="右" /><desc color="cyan">风扇在头顶吱呀转着…</desc></scene><airp-patch>[{"op":"delta","path":"好感度","value":3}]</airp-patch>
不想用符号渲染时，正常输出文本即可——标签是可选的表现增强。`,
}

/**
 * 读全局 AIRP 能力谱：出厂默认 AIRP_CAPABILITIES ← data/airp_config.json 顶层键 merge。
 * 惰性读文件(函数体内)，顶层零调用——避开 TDZ(禁止项16)。
 * @param {string} projectRoot - 项目根(用于定位 data/airp_config.json)
 * @returns {typeof AIRP_CAPABILITIES} 合并后的全局能力谱(浅合并顶层键，未提供的键保出厂默认)
 */
export function loadAirpCapabilities(projectRoot) {
	let user = {}
	try {
		const f = join(projectRoot, 'data', 'airp_config.json')
		if (fs.existsSync(f)) {
			const parsed = JSON.parse(fs.readFileSync(f, 'utf-8'))
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) user = parsed
		}
	} catch (e) {
		console.warn('[beilu-airp] 读取 data/airp_config.json 失败，用出厂默认:', e.message)
	}
	// 顶层键深合并：全局文件覆盖出厂默认，键级递归(palette 改单色不丢其余出厂色)
	return _deepMerge(AIRP_CAPABILITIES, user)
}

/**
 * airp 私有键级深合并：普通对象递归合并；数组/原始值整体替换（覆盖非累加）。
 * 项目内无通用后端 deepMerge（前端 messageList.mjs:432 deepMergeVars 是前端+mvu 专用，不跨端），故就地私有实现，不导出公共域。
 * @param {object} base - 出厂/全局默认（不被改动）
 * @param {object} override - 覆盖层（用户/个人差异，只需存差异键）
 * @returns {object} 合并后的新对象（base 与 override 均不被 mutate）
 */
function _deepMerge(base, override) {
	if (!override || typeof override !== 'object' || Array.isArray(override)) return base
	const out = Array.isArray(base) ? [...base] : { ...base }
	for (const k of Object.keys(override)) {
		const bv = out[k]
		const ov = override[k]
		if (bv && ov && typeof bv === 'object' && typeof ov === 'object' && !Array.isArray(bv) && !Array.isArray(ov)) {
			out[k] = _deepMerge(bv, ov) // 普通对象：递归键级合并
		} else {
			out[k] = ov // 数组/原始值/新键：整体替换
		}
	}
	return out
}

/**
 * 解析某 user 的【有效 airp 能力谱】= 全局谱(出厂默认 ← data/airp_config.json) 深merge 个人覆盖层。
 * 单源收口：配色/标签集/动态效果/自适应默认唯一来源=本文件 AIRP_CAPABILITIES；main.mjs 只存/传个人差异，不自持默认。
 * @param {string} projectRoot - 项目根(定位 data/airp_config.json)
 * @param {object} [userConfig] - 该 user 的个人覆盖(main.mjs getStore(user).config，只含差异键)
 * @returns {typeof AIRP_CAPABILITIES} 有效能力谱
 */
export function resolveEffectiveAirp(projectRoot, userConfig) {
	const global = loadAirpCapabilities(projectRoot)
	return _deepMerge(global, userConfig || {})
}