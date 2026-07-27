/**
 * airpRenderer.mjs — AIRP 符号 DSL → styled HTML 渲染器（纯函数层）。
 *
 * 职责（第4章步①）：把 LLM 输出的 DSL 标签渲染成带 class 的 styled HTML 字符串。
 *   DSL: <scene bg light><char name mood pos/><desc color>...</desc></scene>
 *   注：<sym>（LLM 手写符号画）已删除 — 符号画由算法从布局 JSON 生成（框架 v6 §二 L2/L4），不经 LLM。
 *   数值指令 <airp-patch> 不在此处理（已在后端 stateMachine 剥离，见 airp/main.mjs ReplyHandler）。
 *
 * 设计哲学(002)：LLM 只写叙事皮肤（DSL 标签），渲染器负责视觉呈现；数值留后端确定性代码。
 *
 * 禁硬编码(铁律)：配色/合法标签集/动态效果开关/自适应参数全部由调用方传入 capabilities（后端 plugins:beilu-airp 谱），
 *   本文件不写死任何具体色值/标签白名单——tagSpec 决定哪些标签合法，palette 决定命名色→CSS 值。
 *   本函数是【纯函数】：同一 (content, capabilities) 恒产同一 HTML，异步配置拉取/缓存在消费方(displayRegex 接入点)做。
 *
 * 契约：返回 string（同 applyBuiltinProcessors 返回类型），产出 block-level HTML 供下游 markdown 渲染器保留(unified/remark 保留内嵌 HTML)。
 * 容错：未知标签/属性 → 按 capabilities.fallback.unknownTagAsText 降级为转义纯文本，不炸渲染(禁 throw)。
 *
 * 关联链：
 *   ← displayRegex.mjs applyBuiltinProcessors（第4章步②并列接入，同步读缓存的 capabilities）
 *   ← 后端 plugins:beilu-airp GetData 返回的 capabilities（palette/tagSpec/dynEffects/layout/fallback）
 */

// HTML 转义映射：key=字符码点(38=& 60=< 62=> 34=" 39=')，value=实体串。
// 用码点做 key 而非字面字符——避开源码里裸 & < > " ' 与引号/显示层的转义纠缠（此文件历史踩坑，见错误经验表）。
const _ESC = { 38: "\u0026amp;", 60: "\u0026lt;", 62: "\u0026gt;", 34: "\u0026quot;", 39: "\u0026#39;" }

/**
 * HTML 转义（防 DSL 文本内容里的特殊字符破坏结构 / XSS）。
 * @param {string} s
 * @returns {string}
 */
function esc(s) {
	if (s == null) return ""
	return String(s).replace(/[&<>"']/g, (c) => _ESC[c.charCodeAt(0)])
}

/**
 * 解析标签属性字符串（如 `bg="雨夜" light="霓虹红"`）为对象。
 * 支持双引号/单引号/无引号值。属性名限定 [\w-]，防注入。
 * @param {string} attrStr
 * @returns {Record<string,string>}
 */
function parseAttrs(attrStr) {
	const attrs = {}
	if (!attrStr) return attrs
	const re = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
	let m
	while ((m = re.exec(attrStr)) !== null) {
		attrs[m[1]] = m[2] ?? m[3] ?? m[4] ?? ""
	}
	return attrs
}

/**
 * 命名色 → CSS 值。查 palette，命中返回色值；未命中：若本身是合法 CSS 色(#hex/rgb/具名)原样返回，否则空串(不渲染该色)。
 * @param {string} name - DSL 里写的颜色名(如 '霓虹红' / '#ff0033' / 'cyan')
 * @param {Record<string,string>} palette
 * @returns {string} CSS 色值或空串
 */
function resolveColor(name, palette) {
	if (!name) return ""
	if (palette && Object.prototype.hasOwnProperty.call(palette, name)) return palette[name]
	// 未命中 palette：允许直接的 CSS 色值透传(#hex / rgb() / 具名色)，否则忽略
	if (/^#[0-9a-fA-F]{3,8}$/.test(name) || /^rgb/.test(name) || /^[a-zA-Z]+$/.test(name)) return name
	return ""
}

/** pos → 对齐 class 后缀。合法值 左/中/右 / left/center/right，其余空。 */
function normPos(pos) {
	const map = { "左": "left", "中": "center", "右": "right", left: "left", center: "center", right: "right" }
	return map[pos] || ""
}

/**
 * 渲染单个 <scene>...</scene> 块的内部子标签(char/desc + 纯文本)。
 * @param {string} inner - scene 标签之间的内容
 * @param {object} caps - capabilities
 * @returns {string} HTML
 */
function renderSceneInner(inner, caps) {
	const palette = caps?.palette || {}
	const tagSpec = caps?.tagSpec || {}
	let html = inner

	// <char name="酒保" mood="警惕" pos="右" /> → 角色位（自闭合）
	if (tagSpec.char) {
		html = html.replace(/<char\b([^>]*?)\/?>/g, (_m, attrStr) => {
			const a = parseAttrs(attrStr)
			const pos = normPos(a.pos)
			const moodClass = /^[\w-]+$/.test(a.mood || "") ? " airp-mood-" + a.mood : ""
			return `<div class="airp-char${pos ? " airp-pos-" + pos : ""}${moodClass}">` +
				`<span class="airp-char-name">${esc(a.name || "")}</span>` +
				(a.mood ? `<span class="airp-char-mood">${esc(a.mood)}</span>` : "") +
				`</div>`
		})
	}

	// <desc color="cyan">...</desc> → 着色文本
	if (tagSpec.desc) {
		html = html.replace(/<desc\b([^>]*)>([\s\S]*?)<\/desc>/g, (_m, attrStr, body) => {
			const a = parseAttrs(attrStr)
			const color = resolveColor(a.color, palette)
			const style = color ? ` style="color:${esc(color)}"` : ""
			return `<span class="airp-desc"${style}>${esc(body)}</span>`
		})
	}

	return html
}

/**
 * 渲染 AIRP DSL → styled HTML。纯函数：配置由 caps 传入。
 * @param {string} content - 含 DSL 标签的文本
 * @param {object} capabilities - 后端 plugins:beilu-airp 能力谱 { palette, tagSpec, dynEffects, layout, fallback }
 * @returns {string} 渲染后的 HTML（无 DSL 标签时原样返回）
 */
export function renderAirpDSL(content, capabilities) {
	if (!content || typeof content !== "string") return content
	// 无 scene 标签 = 无 airp 内容，原样返回（零开销早退，不影响非 airp 消息）
	if (!/<scene\b/.test(content)) return content

	const caps = capabilities || {}
	const tagSpec = caps.tagSpec || {}
	const dyn = caps.dynEffects || {}
	// scene 必须在 tagSpec 声明才渲染；未声明 → 交给 fallback 降级
	const sceneEnabled = !!tagSpec.scene

	let html = content

	if (sceneEnabled) {
		html = html.replace(/<scene\b([^>]*)>([\s\S]*?)<\/scene>/g, (_m, attrStr, inner) => {
			const a = parseAttrs(attrStr)
			const palette = caps.palette || {}
			const bg = resolveColor(a.bg, palette)
			const light = resolveColor(a.light, palette)
			// 动态效果 class 走 dynEffects 开关（CSS 在前端接入时补，此处只挂 class）
			const dynClasses = []
			if (dyn.enabled) {
				if (dyn.glow && light) dynClasses.push("airp-glow")
				if (dyn.rain && /雨/.test(a.bg || "")) dynClasses.push("airp-rain")
				if (dyn.flicker && light) dynClasses.push("airp-flicker")
			}
			const styleParts = []
			if (bg) styleParts.push(`background:${esc(bg)}`)
			if (light) styleParts.push(`--airp-light:${esc(light)}`)
			const style = styleParts.length ? ` style="${styleParts.join(";")}"` : ""
			const cls = ["airp-scene", ...dynClasses].join(" ")
			return `<div class="${cls}"${style}>${renderSceneInner(inner, caps)}</div>`
		})
	}

	// 容错：剥掉/降级任何残留的未知/未启用 airp 标签，防裸标签流入 markdown
	if (caps.fallback?.unknownTagAsText !== false) {
		html = html.replace(/<(\/?)(scene|char|desc)\b[^>]*>/g, "")
	}

	return html
}