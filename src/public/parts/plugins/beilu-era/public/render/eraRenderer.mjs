/**
 * eraRenderer.mjs — ERA 地图布局 JSON → 三层渲染 DOM（地图/人物/动态）+ era 视图缓存加载器。
 *
 * 三层架构（凛倾 0731「我需要3层的动态层,地图,人物,动态层」）：
 *   数据即分层（layout=地图 / entities=人物 / overlays=动态）→ 渲染输出同构三层独立 DOM 叠加
 *   （.era-*-stack 内三个绝对定位同网格层），各层可经 caps.layers 独立开关，动态层刷新不碰地图层。
 *
 * 双渲染模式（caps.render.mode）：
 *   grid  = CSS grid 铺 tile（房间=边框矩形，房名内嵌）
 *   ascii = 真字符画矩阵（盒线+房名双宽内嵌进房间——era 正统玩家看名字不查表；
 *           写不下的截断+「名称截断房间」兜底行；CJK 双宽记账防列错位）
 *
 * 语义落点（凛倾「落点由系统计算——不要给坐标,好歹给个范围和参照」）：
 *   overlay 推荐 {room, at, near} 形态，at 值域=caps.placement 规则表（真数据：anchor 原语+偏移，
 *   用户可增删改参照词）；本文件解析器只实现 anchor 几何原语（与 python resolve_placement 同约定）。
 *
 * 禁硬编码（凛倾 0731「删除全部硬编码」）：字符集/符号/配色/单元尺寸唯一来源=caps（后端三层谱），
 *   本文件零默认副本——谱缺键=不画（诚实降级），不在代码里兜第二份字面量。
 *
 * 挂载：地图块由 messageList 在含 extension.era_map 的楼层调 maybeAppendEraBlock 直插 DOM
 *   （框架产物不过 markdown/rehypeSanitize，与 fetchRenderEntries 同款直插先例）。
 *   stripEraTags 供 displayRegex 防御性剥残留指令。
 * 数据源：sendAction shells:chat#getEraView → shell 端点 era/view → beilu-era GetRenderView。
 * 交互（002[80]「点击角色进行对话」）：点击实体 → 名字填 #message-input（workPanel.mjs:224 同款先例）。
 */
import { sendAction } from "../transport/sendAction.mjs"

// ============================================================
// 视图缓存（照 displayRegex.loadAirpCaps :126-183 单飞+TTL 范式）
// ============================================================

const CACHE_TTL = 30 * 1000

/** @type {{caps:object|null, map:object|null, activeId:string|null, mapIds:string[]}|null} */
let cachedEraView = null
let _eraCacheTimestamp = 0
/** @type {Promise|null} */
let _eraLoadingPromise = null

/**
 * 拉取 era 渲染视图并缓存。
 * @param {boolean} [force] - true 无视 TTL 强刷（楼层 rev 比缓存新时用）
 * @returns {Promise<object|null>}
 */
export async function loadEraView(force = false) {
	if (!force && cachedEraView !== null && Date.now() - _eraCacheTimestamp < CACHE_TTL) {
		return cachedEraView
	}
	if (_eraLoadingPromise) return _eraLoadingPromise
	_eraLoadingPromise = _doLoadEraView()
	try {
		return await _eraLoadingPromise
	} finally {
		_eraLoadingPromise = null
	}
}

async function _doLoadEraView() {
	try {
		const data = await sendAction({
			verb: "getEraView", target: "shells:chat", source: "web",
			scope: { chatId: window._beiluGetChatId?.() || "" },
			payload: { charId: window._beiluGetCharId?.() || "" },
		})
		cachedEraView = (data && typeof data === "object") ? data : null
		_eraCacheTimestamp = Date.now()
		return cachedEraView
	} catch (err) {
		console.warn("[eraRenderer] 加载 era 视图失败:", err)
		cachedEraView = null
		_eraCacheTimestamp = Date.now()
		return null
	}
}

/** 强刷缓存（设置面板改 era 配置后/地图 rev 变更后语义）。 */
export async function refreshEraView() {
	cachedEraView = null
	_eraCacheTimestamp = 0
	return loadEraView(true)
}

// ============================================================
// 基础工具
// ============================================================

const _ESC = { 38: "&amp;", 60: "&lt;", 62: "&gt;", 34: "&quot;", 39: "&#39;" }
function esc(s) {
	if (s == null) return ""
	return String(s).replace(/[&<>"']/g, (c) => _ESC[c.charCodeAt(0)])
}

/** 命名色 → CSS 值（查 caps.palette；未命中允许 #hex/rgb/纯字母透传）。 */
function resolveColor(name, palette) {
	if (!name) return ""
	if (palette && Object.prototype.hasOwnProperty.call(palette, name)) return palette[name]
	if (/^#[0-9a-fA-F]{3,8}$/.test(name) || /^rgb/.test(name) || /^[a-zA-Z]+$/.test(name)) return name
	return ""
}

/** 字符显示宽度：CJK/全角=2 列（与 python _cw east_asian_width 同判据的前端近似域）。 */
function _cw(ch) {
	return /[ᄀ-ᅟ⺀-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦　-〿]/.test(ch) ? 2 : 1
}

/**
 * 从显示内容剥 era 指令块（防御兜底：后端 ReplyHandler 已剥主路径，此处兜历史楼层/手编原文）。
 * @param {string} content
 * @returns {string}
 */
export function stripEraTags(content) {
	if (!content || typeof content !== "string") return content
	if (!/<era-(map|patch|ui)\b/.test(content)) return content
	return content
		.replace(/<era-map\b[^>]*>[\s\S]*?<\/era-map>/g, "")
		.replace(/<era-patch\b[^>]*>[\s\S]*?<\/era-patch>/g, "")
		.replace(/<era-ui\b[^>]*>[\s\S]*?<\/era-ui>/g, "")
}

// ============================================================
// 语义落点（与 python resolve_placement / resolve_overlay 同约定）
// ============================================================

function _roomById(layout, roomId) {
	for (const f of Object.keys(layout.floors || {})) {
		const r = (layout.floors[f]?.rooms || []).find((x) => x.id === roomId)
		if (r) return r
	}
	return null
}

/** 语义参照 → 房内格坐标。规则表=caps.placement（anchor 原语+dx/dy）；返回 {x,y} 房内钳制。 */
function _resolvePlacement(room, at, near, layout, caps) {
	const table = caps?.placement || {}
	const rule = table[at || "center"] || table.center || { anchor: "center" }
	const anchor = rule.anchor || "center"
	const x0 = room.x, y0 = room.y, w = room.w, h = room.h
	const cx = x0 + Math.floor(w / 2), cy = y0 + Math.floor(h / 2)
	let x = cx, y = cy
	if (anchor === "topleft") { x = x0; y = y0 }
	else if (anchor === "topright") { x = x0 + w - 1; y = y0 }
	else if (anchor === "bottomleft") { x = x0; y = y0 + h - 1 }
	else if (anchor === "bottomright") { x = x0 + w - 1; y = y0 + h - 1 }
	else if (anchor === "wall_n") { x = cx; y = y0 + 1 }
	else if (anchor === "wall_s") { x = cx; y = y0 + h - 2 }
	else if (anchor === "wall_e") { x = x0 + w - 2; y = cy }
	else if (anchor === "wall_w") { x = x0 + 1; y = cy }
	else if (anchor === "door") {
		const fl = (layout.floors || {})[String(room.floor)] || {}
		outer: for (const [ddx, ddy] of (fl.doors || [])) {
			for (const [nx, ny] of [[ddx - 1, ddy], [ddx + 1, ddy], [ddx, ddy - 1], [ddx, ddy + 1]]) {
				if (nx > x0 && nx < x0 + w - 1 && ny > y0 && ny < y0 + h - 1) { x = nx; y = ny; break outer }
			}
		}
	} else if (anchor === "near") {
		const e = (layout.entities || []).find((v) => v.id === near)
		if (e) {
			x = e.x + 1
			y = e.y
			if (x >= x0 + w - 1) x = e.x - 1
		}
	}
	x += Math.trunc(rule.dx || 0)
	y += Math.trunc(rule.dy || 0)
	// 钳制进房内 + 避开房名行（首内行=房名内嵌行）+ 避让实体格（与 python resolve_placement 同约定）
	const yMin = h >= 4 ? y0 + 2 : y0 + 1
	x = Math.min(Math.max(x, x0 + 1), x0 + w - 2)
	y = Math.min(Math.max(y, yMin), y0 + h - 2)
	const entCells = new Set()
	for (const e of (layout.entities || [])) {
		if ((e.floor || 0) !== room.floor) continue
		entCells.add(`${e.x},${e.y}`)
		if (e.sym && _cw(String(e.sym)[0]) === 2) entCells.add(`${e.x + 1},${e.y}`)
	}
	if (entCells.has(`${x},${y}`)) {
		const innerW = Math.max(1, w - 2)
		const innerH = Math.max(1, (y0 + h - 1) - yMin)
		for (let step = 1; step <= innerW * innerH; step++) {
			const nx = x0 + 1 + ((x - x0 - 1 + step) % innerW)
			const ny = yMin + (((y - yMin) + Math.floor((x - x0 - 1 + step) / innerW)) % innerH)
			if (!entCells.has(`${nx},${ny}`)) { x = nx; y = ny; break }
		}
	}
	return { x, y }
}

/** 覆盖层落点：room+at 语义形态或 x/y/floor 绝对形态。@returns {{x,y,floor}|null} */
function _resolveOverlay(o, layout, caps) {
	if (typeof o?.room === "string" && o.room) {
		const room = _roomById(layout, o.room)
		if (!room) return null
		const p = _resolvePlacement(room, o.at, o.near, layout, caps)
		// 双宽符号贴东墙回缩（与 python resolve_overlay 同约定）
		if (o.sym && _cw(String(o.sym)[0]) === 2 && p.x >= room.x + room.w - 2) {
			p.x = Math.max(room.x + 1, room.x + room.w - 3)
		}
		return { x: p.x, y: p.y, floor: room.floor }
	}
	const x = Number(o?.x)
	const y = Number(o?.y)
	if (!Number.isFinite(x) || !Number.isFinite(y)) return null
	return { x, y, floor: Number(o?.floor) || 0 }
}

// ============================================================
// ascii 字符画模式：三层矩阵（cell={ch,color,cls,ent}，双宽续格=CONT 哨兵）
// ============================================================

const _CONT = Symbol("cont")

function _newMat(W, H) {
	return Array.from({ length: H }, () => Array.from({ length: W }, () => ({ ch: " ", color: "", cls: "", ent: "" })))
}

function _mput(mat, x, y, ch, color = "", cls = "", ent = "") {
	const H = mat.length, W = mat[0].length
	if (!ch || y < 0 || y >= H) return false
	const w = _cw(ch)
	if (x < 0 || x + w > W) return false
	mat[y][x] = { ch, color, cls, ent }
	if (w === 2) mat[y][x + 1] = _CONT
	return true
}

/** 向右写字符串到 maxX（含）；返回是否完整写入（截断=false 供图例兜底）。 */
function _mputText(mat, x, y, text, maxX, color) {
	let cx = x
	for (const ch of text) {
		const w = _cw(ch)
		if (cx + w - 1 > maxX) return false
		_mput(mat, cx, y, ch, color)
		cx += w
	}
	return true
}

/**
 * 单层矩阵 → CSS grid 逐格锚定 HTML（凛倾 0731 真机断裂截图返工：<pre> 字符流靠字体度量
 * 对齐=任何真实字体环境必碎；grid-area 逐格锚定=「对齐由代码保证，永远不会歪」（必读拍板原话）。
 * 双宽字符占两列（grid-column span 2）；空格不产 DOM。
 */
function _matToGrid(mat, layerCls, W, H) {
	const parts = [`<div class="era-grid era-agrid era-layer ${layerCls}" style="--era-cols:${W};--era-rows:${H}">`]
	for (let y = 0; y < mat.length; y++) {
		for (let x = 0; x < mat[y].length; x++) {
			const cell = mat[y][x]
			if (cell === _CONT || !cell || cell.ch === " ") continue
			const w = _cw(cell.ch)
			const style = `grid-area:${y + 1}/${x + 1}/${y + 2}/${x + 1 + w};` + (cell.color ? `color:${esc(cell.color)};` : "")
			const entAttr = cell.ent ? ` data-ent="${esc(cell.ent)}" title="${esc(cell.ent)}"` : ""
			parts.push(`<span class="era-cell${cell.cls ? " " + esc(cell.cls) : ""}" style="${style}"${entAttr}>${esc(cell.ch)}</span>`)
		}
	}
	parts.push("</div>")
	return parts.join("")
}

/**
 * 单层楼 ascii 三层（地图/人物/动态）。
 * @returns {{layers:string[], truncated:string[]}}
 */
function renderFloorAscii(map, floorKey, caps) {
	const layout = map.layout
	const fl = layout.floors[floorKey]
	const palette = caps?.palette || {}
	const cs = caps?.charset || {}
	const syms = caps?.symbols || {}
	const dyn = caps?.dynEffects || {}
	const layersOn = caps?.layers || {}
	const W = layout.w, H = layout.h
	const mMap = _newMat(W, H)
	const mChar = _newMat(W, H)
	const mDyn = _newMat(W, H)
	const truncated = []

	// —— 地图层：盒线 + 房名内嵌 + 走廊/门/楼梯（字符唯一来源=caps，缺键不画）——
	for (const r of (fl.rooms || [])) {
		const color = resolveColor(r.color, palette)
		for (let x = r.x; x < r.x + r.w; x++) {
			_mput(mMap, x, r.y, cs.wallH || "", color)
			_mput(mMap, x, r.y + r.h - 1, cs.wallH || "", color)
		}
		for (let y = r.y; y < r.y + r.h; y++) {
			_mput(mMap, r.x, y, cs.wallV || "", color)
			_mput(mMap, r.x + r.w - 1, y, cs.wallV || "", color)
		}
		_mput(mMap, r.x, r.y, cs.cornerTL || "", color)
		_mput(mMap, r.x + r.w - 1, r.y, cs.cornerTR || "", color)
		_mput(mMap, r.x, r.y + r.h - 1, cs.cornerBL || "", color)
		_mput(mMap, r.x + r.w - 1, r.y + r.h - 1, cs.cornerBR || "", color)
		// 房名可辨识压缩（与 python 同约定：放不下→首段+末字，同前缀房保住尾部序号）
		const name = r.name || r.id
		let label = `${r.sym || ""}${name}`
		const width = (r.x + r.w - 2) - (r.x + 1) + 1
		const textW = (s) => [...s].reduce((n, ch) => n + _cw(ch), 0)
		if (textW(label) > width && name.length >= 2) {
			const head = r.sym || ""
			const tail = name[name.length - 1]
			let body = ""
			for (const ch of name.slice(0, -1)) {
				if (textW(head + body + ch + tail) > width) break
				body += ch
			}
			if (textW(head + tail) <= width) label = head + body + tail
			truncated.push(`${label}=${name}(f${floorKey})`)
		} else if (textW(label) > width) {
			truncated.push(`${name}(f${floorKey})`)
		}
		_mputText(mMap, r.x + 1, r.y + 1, label, r.x + r.w - 2, color)
	}
	// —— 房内自由字符画块 + 地点编号（与 python build_layers 同约定；创作内容引擎零解释）——
	for (const r of (fl.rooms || [])) {
		const rColor = resolveColor(r.color, palette)
		const interior = Array.isArray(r.interior) ? r.interior : []
		for (let li = 0; li < Math.min(interior.length, Math.max(0, r.h - 3)); li++) {
			if (typeof interior[li] === "string") _mputText(mMap, r.x + 1, r.y + 2 + li, interior[li], r.x + r.w - 2, rColor)
		}
		const num = String(r.num ?? "")
		if (num) {
			const tw = [...num].reduce((n, ch) => n + _cw(ch), 0)
			_mputText(mMap, Math.max(r.x + 1, r.x + r.w - 1 - tw), r.y + r.h - 2, num, r.x + r.w - 2, rColor)
		}
	}

	// —— 道路带（roadWidth≥2 右/下膨胀铺 road 字符）——
	const roadW = Number(caps?.render?.roadWidth) || 1
	const roadCh = cs.road || ""
	const corrCh = cs.corridor || syms.corridor || ""
	for (const c of (fl.corridors || [])) {
		for (const [x, y] of (c.cells || [])) {
			_mput(mMap, x, y, (roadW >= 2 && roadCh) ? roadCh : corrCh)
			if (roadW >= 2 && roadCh) {
				for (const [ex, ey] of [[x + 1, y], [x, y + 1]].slice(0, roadW - 1)) {
					if (ey < mMap.length && ex < mMap[0].length && mMap[ey]?.[ex] !== _CONT && mMap[ey]?.[ex]?.ch === " ") _mput(mMap, ex, ey, roadCh)
				}
			}
		}
	}
	for (const [x, y] of (fl.doors || [])) _mput(mMap, x, y, cs.door || syms.door || "")
	for (const [x, y] of (fl.stairs || [])) _mput(mMap, x, y, cs.stairs || syms.stairs || "")

	// —— 自由装饰块（art 多行 + room/at 语义锚）——
	for (const d of ((map.topology || {}).decor || [])) {
		if (!d || !Array.isArray(d.art)) continue
		let ax, ay
		const anchorRoom = d.room ? _roomById(layout, d.room) : null
		if (anchorRoom) {
			if (anchorRoom.floor !== Number(floorKey)) continue
			const p = _resolvePlacement(anchorRoom, d.at, d.near, layout, caps)
			ax = p.x; ay = p.y
		} else {
			ax = Number(d.x); ay = Number(d.y)
			if (!Number.isFinite(ax) || !Number.isFinite(ay) || (Number(d.floor) || 0) !== Number(floorKey)) continue
		}
		const dColor = resolveColor(d.color, palette)
		d.art.forEach((line, li) => {
			if (typeof line === "string") _mputText(mMap, ax, ay + li, line, W - 1, dColor)
		})
	}

	// —— 地形纹理层（inline chars/color 或 preset 缩写；密度散布+ground 晕染，与 python 同哈希约定）——
	const terrCfg = caps?.terrain || {}
	if (terrCfg.enabled !== false) {
		const band = Math.max(1, Number(terrCfg.bandWidth) || 1)
		const presets = terrCfg.presets || {}
		const terrChars = (spec) => (typeof spec.chars === "string" && spec.chars) ? spec.chars
			: (typeof presets[spec.type || ""]?.chars === "string" ? presets[spec.type || ""].chars : "")
		const terrColor = (spec) => resolveColor(spec.color || presets[spec.type || ""]?.color || "", palette)
		const densityOf = (spec, fb = 1) => {
			const d = Number(spec.density ?? presets[spec.type || ""]?.density)
			return (Number.isFinite(d) && d >= 0 && d <= 1) ? d : fb
		}
		const hashPick = (chars, x, y) => {
			if (!chars) return ""
			const pool = [...chars]
			return pool[(x * 31 + y * 17) % pool.length]
		}
		const densityHit = (x, y, d) => ((x * 73 + y * 151) % 100) / 100 < d
		const inBand = (at, x, y) => at === "north" ? y < band : at === "south" ? y >= H - band
			: at === "west" ? x < band : at === "east" ? x >= W - band
			: (x < band || x >= W - band || y < band || y >= H - band)
		const zones = ((map.topology || {}).terrain || []).filter((z) => z && typeof z === "object")
		const ground = terrCfg.ground || {}
		const groundChars = typeof ground.chars === "string" ? ground.chars : ""
		const groundColor = resolveColor(ground.color || "", palette)
		const gFill = ground.fill || "around"
		const gRadius = Math.max(0, Number(ground.radius) || 0)
		let activeMask = null
		if (gFill === "around") {
			activeMask = Array.from({ length: H }, () => new Array(W).fill(false))
			const marks = []
			for (const r of (fl.rooms || [])) marks.push([r.x, r.y, r.w, r.h])
			for (const c of (fl.corridors || [])) for (const [x, y] of (c.cells || [])) marks.push([x, y, 1, 1])
			for (const [x, y] of (fl.doors || [])) marks.push([x, y, 1, 1])
			for (const [mx, my, mw, mh] of marks)
				for (let yy = Math.max(0, my - gRadius); yy < Math.min(H, my + mh + gRadius); yy++)
					for (let xx = Math.max(0, mx - gRadius); xx < Math.min(W, mx + mw + gRadius); xx++)
						activeMask[yy][xx] = true
		}
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				const cell = mMap[y][x]
				if (cell === _CONT || cell.ch !== " ") continue
				let ch = ""
				let color = ""
				let inZone = false
				for (const z of zones) {
					if (inBand(z.at || "edge", x, y)) {
						inZone = true
						if (densityHit(x, y, densityOf(z))) {
							ch = hashPick(terrChars(z), x, y)
							color = terrColor(z)
						}
						break
					}
				}
				if (!inZone && (gFill === "all" || (gFill === "around" && activeMask?.[y]?.[x]))) {
					if (densityHit(x, y, densityOf(ground))) {
						ch = hashPick(groundChars, x, y)
						color = groundColor
					}
				}
				if (ch && _cw(ch) === 2 && x + 1 < W && mMap[y][x + 1] !== _CONT && mMap[y][x + 1].ch !== " ") continue
				if (ch) _mput(mMap, x, y, ch, color)
			}
		}
	}

	// —— 人物层 ——
	for (const e of (layout.entities || [])) {
		if ((e.floor || 0) !== Number(floorKey)) continue
		const ch = (e.sym || syms.entity || "")[0]
		if (ch) _mput(mChar, e.x, e.y, ch, resolveColor(e.color, palette), "era-ent" + (dyn.enabled && dyn.pulse ? " era-pulse" : ""), e.id)
	}

	// —— 动态层 ——
	for (const o of (map.overlays || [])) {
		const pos = _resolveOverlay(o, layout, caps)
		if (!pos || pos.floor !== Number(floorKey)) continue
		const ch = (o.sym || syms.overlayDefault || "")[0]
		if (ch) _mput(mDyn, pos.x, pos.y, ch, resolveColor(o.color, palette), dyn.enabled && dyn.flicker ? "era-flicker" : "")
	}

	const layers = []
	if (layersOn.map !== false) layers.push(_matToGrid(mMap, "era-layer-map", W, H))
	if (layersOn.char !== false) layers.push(_matToGrid(mChar, "era-layer-char", W, H))
	if (layersOn.dyn !== false) layers.push(_matToGrid(mDyn, "era-layer-dyn", W, H))
	return { layers, truncated }
}

/**
 * 逐格地形数据（ascii/grid 两模式共用判定：zone 带/ground 晕染/密度散布，与 python 同哈希约定）。
 * @returns {Array<{x:number,y:number,ch:string,color:string,zone:boolean}>}
 */
function _terrainCells(map, floorKey, caps, occupied) {
	const terrCfg = caps?.terrain || {}
	if (terrCfg.enabled === false) return []
	const layout = map.layout
	const fl = layout.floors[floorKey]
	const palette = caps?.palette || {}
	const W = layout.w, H = layout.h
	const band = Math.max(1, Number(terrCfg.bandWidth) || 1)
	const presets = terrCfg.presets || {}
	const terrChars = (spec) => (typeof spec.chars === "string" && spec.chars) ? spec.chars
		: (typeof presets[spec.type || ""]?.chars === "string" ? presets[spec.type || ""].chars : "")
	const terrColor = (spec) => resolveColor(spec.color || presets[spec.type || ""]?.color || "", palette)
	const densityOf = (spec, fb = 1) => {
		const d = Number(spec.density ?? presets[spec.type || ""]?.density)
		return (Number.isFinite(d) && d >= 0 && d <= 1) ? d : fb
	}
	const hashPick = (chars, x, y) => {
		if (!chars) return ""
		const pool = [...chars]
		return pool[(x * 31 + y * 17) % pool.length]
	}
	const densityHit = (x, y, d) => ((x * 73 + y * 151) % 100) / 100 < d
	const inBand = (at, x, y) => at === "north" ? y < band : at === "south" ? y >= H - band
		: at === "west" ? x < band : at === "east" ? x >= W - band
		: (x < band || x >= W - band || y < band || y >= H - band)
	const zones = ((map.topology || {}).terrain || []).filter((z) => z && typeof z === "object")
	const ground = terrCfg.ground || {}
	const groundChars = typeof ground.chars === "string" ? ground.chars : ""
	const groundColor = resolveColor(ground.color || "", palette)
	const gFill = ground.fill || "around"
	const gRadius = Math.max(0, Number(ground.radius) || 0)
	let activeMask = null
	if (gFill === "around") {
		activeMask = Array.from({ length: H }, () => new Array(W).fill(false))
		const marks = []
		for (const r of (fl.rooms || [])) marks.push([r.x, r.y, r.w, r.h])
		for (const c of (fl.corridors || [])) for (const [x, y] of (c.cells || [])) marks.push([x, y, 1, 1])
		for (const [x, y] of (fl.doors || [])) marks.push([x, y, 1, 1])
		for (const [mx, my, mw, mh] of marks)
			for (let yy = Math.max(0, my - gRadius); yy < Math.min(H, my + mh + gRadius); yy++)
				for (let xx = Math.max(0, mx - gRadius); xx < Math.min(W, mx + mw + gRadius); xx++)
					activeMask[yy][xx] = true
	}
	const cells = []
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			if (occupied && occupied(x, y)) continue
			let inZone = false
			for (const z of zones) {
				if (inBand(z.at || "edge", x, y)) {
					inZone = true
					const color = terrColor(z)
					const ch = densityHit(x, y, densityOf(z)) ? hashPick(terrChars(z), x, y) : ""
					if (color || ch) cells.push({ x, y, ch, color, zone: true })
					break
				}
			}
			if (!inZone && (gFill === "all" || (gFill === "around" && activeMask?.[y]?.[x]))) {
				const ch = densityHit(x, y, densityOf(ground)) ? hashPick(groundChars, x, y) : ""
				if (groundColor || ch) cells.push({ x, y, ch, color: groundColor, zone: false })
			}
		}
	}
	return cells
}

// ============================================================
// grid 模式：三层同网格叠加（eraTW 视觉=色块瓦片矩阵，字符叠在色块上）
// ============================================================

function renderFloorGrid(map, floorKey, caps) {
	const layout = map.layout
	const fl = layout.floors[floorKey]
	const palette = caps?.palette || {}
	const syms = caps?.symbols || {}
	const dyn = caps?.dynEffects || {}
	const layersOn = caps?.layers || {}
	const W = layout.w, H = layout.h
	const gridStyle = `--era-cols:${W};--era-rows:${H}`

	// —— 地图层：先铺地形色块瓦片（eraTW 视觉基底；同行同色 run 合并控 DOM 量），字符叠色块上 ——
	const mapParts = []
	{
		const inRoom = (x, y) => (fl.rooms || []).some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)
		const tCells = _terrainCells(map, floorKey, caps, inRoom)
		const rowRuns = new Map() // y → runs [{x1,x2,color}]
		for (const c of tCells) {
			if (!c.color) continue
			const runs = rowRuns.get(c.y) || []
			const last = runs[runs.length - 1]
			if (last && last.x2 === c.x - 1 && last.color === c.color && last.zone === c.zone) last.x2 = c.x
			else runs.push({ x1: c.x, x2: c.x, color: c.color, zone: c.zone })
			rowRuns.set(c.y, runs)
		}
		for (const [y, runs] of rowRuns) {
			for (const run of runs) {
				mapParts.push(`<div class="era-tile${run.zone ? " era-tile-zone" : ""}" style="grid-area:${y + 1}/${run.x1 + 1}/${y + 2}/${run.x2 + 2};background:${esc(run.color)}"></div>`)
			}
		}
		for (const c of tCells) {
			if (!c.ch) continue
			mapParts.push(`<span class="era-cell era-terrain-ch"${c.color ? ` style="grid-area:${c.y + 1}/${c.x + 1};color:${esc(c.color)}"` : ` style="grid-area:${c.y + 1}/${c.x + 1}"`}>${esc(c.ch)}</span>`)
		}
	}
	// 道路色块（terrain.road.color 数据层；字符符号仍由 corridor span 叠加）
	const roadColor = resolveColor((caps?.terrain?.road || {}).color || "", palette)
	if (roadColor) {
		for (const c of (fl.corridors || []))
			for (const [x, y] of (c.cells || []))
				mapParts.push(`<div class="era-tile era-tile-road" style="grid-area:${y + 1}/${x + 1};background:${esc(roadColor)}"></div>`)
	}
	for (const r of (fl.rooms || [])) {
		const color = resolveColor(r.color, palette)
		const style = `grid-area:${r.y + 1}/${r.x + 1}/${r.y + 1 + r.h}/${r.x + 1 + r.w};` +
			(color ? `border-color:${esc(color)};--era-room-color:${esc(color)};` : "")
		const label = (caps?.render?.labelRooms !== false)
			? `<span class="era-room-label">${esc(r.sym || "")}${esc(r.name || r.id)}</span>` : ""
		const note = r.note ? ` title="${esc(r.note)}"` : ""
		const glow = (color && dyn.enabled && dyn.glow) ? " era-glow" : ""
		mapParts.push(`<div class="era-room${glow}" data-room="${esc(r.id)}" style="${style}"${note}>${label}</div>`)
	}
	for (const c of (fl.corridors || []))
		for (const [x, y] of (c.cells || []))
			mapParts.push(`<span class="era-cell era-corridor" style="grid-area:${y + 1}/${x + 1}">${esc(syms.corridor || "")}</span>`)
	for (const [x, y] of (fl.doors || []))
		mapParts.push(`<span class="era-cell era-door" style="grid-area:${y + 1}/${x + 1}">${esc(syms.door || "")}</span>`)
	for (const [x, y, to] of (fl.stairs || []))
		mapParts.push(`<span class="era-cell era-stairs" title="${esc(to)}" style="grid-area:${y + 1}/${x + 1}">${esc(syms.stairs || "")}</span>`)

	// —— 人物层 ——
	const charParts = []
	const pulseCls = (dyn.enabled && dyn.pulse) ? " era-pulse" : ""
	for (const e of (layout.entities || [])) {
		if ((e.floor || 0) !== Number(floorKey)) continue
		const color = resolveColor(e.color, palette)
		const sym = e.sym || syms.entity || ""
		if (!sym) continue
		charParts.push(`<span class="era-cell era-ent${pulseCls}" data-ent="${esc(e.id)}" title="${esc(e.id)}"${color ? ` style="grid-area:${e.y + 1}/${e.x + 1};color:${esc(color)}"` : ` style="grid-area:${e.y + 1}/${e.x + 1}"`}>${esc(sym)}</span>`)
	}

	// —— 动态层 ——
	const dynParts = []
	const flickerCls = (dyn.enabled && dyn.flicker) ? " era-flicker" : ""
	for (const o of (map.overlays || [])) {
		const pos = _resolveOverlay(o, layout, caps)
		if (!pos || pos.floor !== Number(floorKey)) continue
		const color = resolveColor(o.color, palette)
		const sym = o.sym || syms.overlayDefault || ""
		if (!sym) continue
		dynParts.push(`<span class="era-cell era-overlay${flickerCls}"${color ? ` style="grid-area:${pos.y + 1}/${pos.x + 1};color:${esc(color)}"` : ` style="grid-area:${pos.y + 1}/${pos.x + 1}"`}>${esc(sym)}</span>`)
	}

	const layers = []
	if (layersOn.map !== false) layers.push(`<div class="era-grid era-layer era-layer-map" style="${gridStyle}">${mapParts.join("")}</div>`)
	if (layersOn.char !== false) layers.push(`<div class="era-grid era-layer era-layer-char" style="${gridStyle}">${charParts.join("")}</div>`)
	if (layersOn.dyn !== false) layers.push(`<div class="era-grid era-layer era-layer-dyn" style="${gridStyle}">${dynParts.join("")}</div>`)
	return layers
}

// ============================================================
// 地图块组装
// ============================================================

/**
 * 渲染完整地图块（头部+逐层楼）。三层 DOM 独立叠加；按 caps.render.mode 分派 grid/ascii。
 * 纯函数：同 (map, caps) 恒产同 HTML。
 * @param {object} map - beilu-era 地图 JSON（含 layout）
 * @param {object} caps - era 能力谱
 * @returns {string} HTML（不含外层 .era-block 容器）
 */
export function renderEraMap(map, caps) {
	if (!map?.layout) return ""
	const cellPx = Math.max(6, Number(caps?.render?.cellPx) || 14)
	const ascii = caps?.render?.mode === "ascii"
	const floors = Object.keys(map.layout.floors || {}).sort()
	const parts = []
	const truncatedAll = []
	const scopeId = String(map.id || "").replace(/[^\w-]/g, "_")
	parts.push(`<div class="era-map${ascii ? " era-map-ascii" : ""}" data-era="${esc(scopeId)}" style="--era-cell:${cellPx}px">`)
	// AI 供图级 CSS（setStyle 持久化）：scoped 前缀注入（@keyframes 块整体保留；CSP 挡外联兜底）
	const aiCss = map.style?.css || ""
	if (aiCss) {
		const scoped = aiCss.replace(/(^|\})\s*([^@{}][^{}]*)\{/g, (m, brace, sel) =>
			`${brace} ${sel.split(",").map((s) => `.era-map[data-era="${scopeId}"] ${s.trim()}`).join(",")}{`)
		parts.push(`<style>${scoped}</style>`)
	}
	parts.push(`<div class="era-map-header"><span class="era-map-name">${esc(map.name || map.id)}</span><span class="era-map-rev">rev ${esc(map.rev)}</span></div>`)
	for (const f of floors) {
		if (floors.length > 1) parts.push(`<div class="era-floor-label">F${esc(f)}</div>`)
		if (ascii) {
			const { layers, truncated } = renderFloorAscii(map, f, caps)
			parts.push(`<div class="era-ascii-stack">${layers.join("")}</div>`)
			truncatedAll.push(...truncated)
		} else {
			parts.push(`<div class="era-grid-stack">${renderFloorGrid(map, f, caps).join("")}</div>`)
		}
	}
	const labels = caps?.textLabels || {}
	if (truncatedAll.length && labels.truncatedLine) {
		parts.push(`<div class="era-legend">${esc(labels.truncatedLine)}${truncatedAll.map((t) => `<span class="era-legend-item">${esc(t)}</span>`).join("")}</div>`)
	}
	// 方位行（机制开关在谱，方位字与模板在数据层——textLabels.compassLine）
	const comp = caps?.compass || {}
	if (comp.enabled !== false && labels.compassLine && (comp.n || comp.s)) {
		const line = String(labels.compassLine)
			.replace("{n}", comp.n || "").replace("{s}", comp.s || "")
			.replace("{e}", comp.e || "").replace("{w}", comp.w || "")
		parts.push(`<div class="era-legend era-compass">${esc(line)}</div>`)
	}
	parts.push("</div>")
	return parts.join("")
}

// ============================================================
// 消息流挂载（messageList 消费；框架 DOM 直插，不过 sanitize）
// ============================================================

/**
 * 若楼层带 extension.era_map，则在其内容元素后追加当前地图块。
 * 楼层 rev 比缓存新 → 强刷视图。幂等：同一气泡已挂过则替换。
 * @param {HTMLElement} contentEl
 * @param {object} entry - chatLog 条目（entry.extension.era_map = {id, rev, errors?}）
 */
export async function maybeAppendEraBlock(contentEl, entry) {
	try {
		const mark = entry?.extension?.era_map
		if (!mark || !contentEl) return
		const needFresh = !!(cachedEraView?.map && typeof mark.rev === "number" && mark.rev > (cachedEraView.map.rev || 0))
		const view = await loadEraView(needFresh)
		if (!view?.caps || !view?.map) return
		const html = renderEraMap(view.map, view.caps)
		if (!html) return
		let block = contentEl.parentElement?.querySelector?.(":scope > .era-block")
		if (!block) {
			block = document.createElement("div")
			block.className = "era-block"
			contentEl.insertAdjacentElement("afterend", block)
		}
		block.innerHTML = html
		_bindEraBlock(block, view.map)
	} catch (err) {
		console.warn("[eraRenderer] 地图块挂载失败:", err)
	}
}

/**
 * 点击实体 → 动态层展开该实体的动作菜单（凛倾 0731「用户点击角色你知道他是对话还是攻击?」返工：
 * 交互语义=数据——动作集来自实体的 actions 字段（AI/做卡人在拓扑里自主定义，如
 * {"id":"酒保","actions":[{"num":300,"label":"会话"},{"num":310,"label":"攻击"}]}），
 * 插件零预设语义：无 actions 数据=点击无行为（不发明默认）；选中动作只抛结构化事件
 * era:action（detail={num,label,target}），是否/如何进对话由宿主消费方决定——插件不碰输入框。
 */
function _bindEraBlock(block, map) {
	if (block._eraBound) return
	block._eraBound = true
	const entities = (map?.topology?.entities || [])
	block.addEventListener("click", (ev) => {
		const old = block.querySelector(".era-actions")
		if (old) old.remove()
		const entEl = ev.target?.closest?.("[data-ent]")
		if (!entEl) return
		const entId = entEl.getAttribute("data-ent") || ""
		const ent = entities.find((e) => e?.id === entId)
		const actions = Array.isArray(ent?.actions) ? ent.actions : []
		if (!actions.length) return // 无动作数据=无行为（语义归数据，插件不发明）
		const menu = document.createElement("div")
		menu.className = "era-actions era-layer-dyn"
		for (const a of actions) {
			if (!a || typeof a !== "object") continue
			const btn = document.createElement("button")
			btn.className = "era-action-btn"
			btn.textContent = `${a.label ?? ""}${a.num != null ? `[${a.num}]` : ""}`
			btn.addEventListener("click", (e2) => {
				e2.stopPropagation()
				menu.remove()
				block.dispatchEvent(new CustomEvent("era:action", {
					bubbles: true,
					detail: { num: a.num, label: a.label, target: entId, mapId: map?.id },
				}))
			})
			menu.appendChild(btn)
		}
		const rect = entEl.getBoundingClientRect()
		const host = block.getBoundingClientRect()
		menu.style.left = `${rect.left - host.left + rect.width + 4}px`
		menu.style.top = `${rect.top - host.top}px`
		block.style.position = "relative"
		block.appendChild(menu)
	})
}
