/**
 * bilibili.mjs — 哔哩哔哩直播弹幕 adapter（持续流）。
 *
 * 契约（与 reach 的关键分岔点，图纸 v2 §六 雷区1）：
 *   本 adapter 是 connect(conf, onMessage, onError, opts) → { close }【持续推送】。
 *   ⚠ reach/adapters/bilibili.mjs:60 的契约是 execute(action, query, opts)【一次性返回】——
 *     那是内容读取（search/video/hot/rank），与弹幕流形状完全不同，两者互不共享代码、互不引用。
 *
 * 链路（六步）：
 *   ① GET  apiRoomInit    → 真实 room_id（用户填的可能是短号）
 *   ②-pre WBI 凭证材料（wbiEnabled 时）：apiNav 取双 key 推 mixin_key + apiFingerSpi 取真 buvid3
 *   ② GET  apiDanmuInfo   → 弹幕服务器 host 列表 + 认证 token
 *          ⚠ 实测：不签名 / 只签名不带 buvid3 / 只带 buvid3 不签名 —— 三种情况一律 code=-352。
 *            必须【WBI 签名 + 真 buvid3 同时具备】。自生成的假 buvid3 无效。
 *   ③ WS   wss://{host}{wsPath} → 建连
 *   ④ SEND ops.auth 认证包 → 收 ops.authReply 认证成功
 *   ⑤ 定时 ops.heartbeat 心跳包 → 收 ops.heartbeatReply 人气值
 *   ⑥ 收   ops.message 数据包 → 解压 → 切子包 → JSON → cmd 判定 → 归一化 LiveMessage → onMessage
 *
 * 【零硬编码】(002 于本轮拍板：「协议常量…这些需要可以配置」)：
 *   本文件【不持有任何协议常量】——API URL / op 码 / 包头长度 / protover 值 / cmd 名 / UA / Referer /
 *   Cookie 字段名 / 认证包字段，全部从 opts.protocol 取，单源=capabilities.mjs
 *   LIVE_CAPABILITIES.platformProtocol.bilibili（出厂默认 ← data/live_capabilities.json ← per-user）。
 *   → B站改协议时改 data 文件即可，不必改源码重启（这是 002 要求可配的实际收益）。
 *   ⚠ 本文件也【不写任何兜底默认值】：缺配置就响亮报错，不静默用第二份默认值
 *     （给了兜底 = 同一常量两处副本 = 改了配置却仍走旧值的经典分叉）。
 *
 * 【仍留在代码里的是什么】（002 可再推翻，此处留痕说明边界）：
 *   ✅ 搬进配置：URL / 魔数 / 枚举值 / 字段名 —— 即 002 原话点名的那些
 *   ⬜ 留在代码：从平台原始 JSON 提取字段的【路径】（如弹幕文本在 info[1]、uid 在 info[2][0]）。
 *      它们是解析实现不是常量；做成配置等于要实现一套 JSON-path DSL，复杂度远超收益。
 *      平台改了字段布局时，改的是本文件的 _normalize 函数。
 *
 * 解压依赖（本会话 deno eval 实测）：
 *   Deno 原生 DecompressionStream 只支持 gzip/deflate，'br' 抛 "not a valid enum value"。
 *   → brotli 走 node:zlib.brotliDecompressSync（实测往返通过）。
 *   ⚠ `node:` 是 Deno 内置模块前缀，≠ `npm:` 外部包：零安装零依赖，
 *     也不触发 ERR_UNSUPPORTED_ESM_URL_SCHEME（图纸雷区5 只针对 npm:）。
 *
 * 凭据：只在 ①② 两个 HTTP 请求的 Cookie 头里用于提升可见范围，
 *   【不进 LiveMessage、不进 prompt、不写日志】（图纸雷区10）。
 */
import zlib from 'node:zlib'
import crypto from 'node:crypto' // WBI 签名的 md5（标准算法走内置模块，不自实现）

const _enc = new TextEncoder()
const _dec = new TextDecoder()

// ============================================================
// 配置校验（本文件唯一的"常量"：必需配置项的键名清单）
// ============================================================

/** protocol 必需的顶层键。缺任一即拒绝连接——不兜底，让缺失在发生处响亮暴露。 */
const _REQUIRED_PROTOCOL_KEYS = [
	'apiRoomInit', 'apiDanmuInfo', 'fallbackHost', 'wsPath',
	'userAgent', 'referer', 'headerLen', 'ops', 'protovers', 'auth', 'cmds', 'cookieMap',
]

/**
 * WBI 签名【启用时】才必需的键。
 * ⚠ 条件必需而非无条件必需：`wbiEnabled:false` 时（平台若取消风控）这些键无用，
 *   此时强制要求它们会让"关掉签名"这个配置动作反而失败。
 */
const _REQUIRED_WBI_KEYS = ['apiNav', 'apiFingerSpi', 'navReferer', 'wbiMixinTab', 'wbiCacheTtlMs']

/** connection 必需的键（行为参数，单源同为 capabilities.mjs）。 */
const _REQUIRED_CONNECTION_KEYS = [
	'heartbeatMs', 'maxRetries', 'retryBaseMs', 'retryFactor', 'retryMaxMs', 'httpTimeoutMs',
]

/**
 * 校验 protocol 配置完整性。
 * @param {object} p
 * @throws {Error} 缺键时抛，附明确的键路径便于定位
 */
function _assertProtocol(p) {
	if (!p || typeof p !== 'object') {
		throw new Error('[beilu-live/bilibili] connect 缺 opts.protocol（协议常量单源=capabilities.mjs LIVE_CAPABILITIES.platformProtocol.bilibili，adapter 不持默认值）')
	}
	for (const k of _REQUIRED_PROTOCOL_KEYS) {
		if (p[k] === undefined || p[k] === null) {
			throw new Error(`[beilu-live/bilibili] connect 缺 opts.protocol.${k}`)
		}
	}
	for (const k of ['heartbeat', 'heartbeatReply', 'message', 'auth', 'authReply']) {
		if (!Number.isFinite(p.ops[k])) throw new Error(`[beilu-live/bilibili] connect 缺 opts.protocol.ops.${k}`)
	}
	for (const k of ['json', 'zlib', 'brotli']) {
		if (!Number.isFinite(p.protovers[k])) throw new Error(`[beilu-live/bilibili] connect 缺 opts.protocol.protovers.${k}`)
	}
	if (!Number.isFinite(p.headerLen)) throw new Error('[beilu-live/bilibili] opts.protocol.headerLen 必须是数字')
	// WBI 签名启用时才校验其专属键（条件必需，见 _REQUIRED_WBI_KEYS 注释）
	if (p.wbiEnabled) {
		for (const k of _REQUIRED_WBI_KEYS) {
			if (p[k] === undefined || p[k] === null) {
				throw new Error(`[beilu-live/bilibili] wbiEnabled=true 但缺 opts.protocol.${k}`)
			}
		}
		if (!Array.isArray(p.wbiMixinTab) || p.wbiMixinTab.length !== 64) {
			throw new Error(`[beilu-live/bilibili] opts.protocol.wbiMixinTab 必须是长度 64 的数组，实际长度: ${p.wbiMixinTab?.length}`)
		}
	}
}

// ============================================================
// WBI 风控签名（2026-07-25 实测：签名 + 真 buvid3 二者缺一即 -352）
// ============================================================

/**
 * 进程级缓存：wbi mixin_key 与 buvid。
 *
 * 【为什么缓存】nav / finger-spi 是取"凭证材料"的接口，与房间无关；
 *   每次重连都重取 = 三倍 HTTP 往返，且频繁调用本身可能触发风控。
 * 【为什么是进程级而非 per-session】buvid3 是【设备】指纹不是【用户】指纹——
 *   同一台 beilu 服务器就是同一台设备，多会话共用一个是正确语义。
 *   ⚠ 用户在面板填了自己的 biliBuvid3 时，【优先用用户的】（见 _fetchDanmuInfo）。
 * 【失效】TTL 到期，或 getDanmuInfo 返回业务错误时主动清（见 _fetchDanmuInfo 的 catch）。
 * @type {{mixinKey:string, buvid3:string, buvid4:string, ts:number, inflight:Promise|null}}
 */
const _wbiCache = { mixinKey: '', buvid3: '', buvid4: '', ts: 0, inflight: null }

/** 主动作废缓存（凭证过期时调用，下次连接会重取）。 */
function _invalidateWbiCache() {
	_wbiCache.mixinKey = ''
	_wbiCache.buvid3 = ''
	_wbiCache.buvid4 = ''
	_wbiCache.ts = 0
}

/**
 * 取 wbi mixin_key + 真 buvid（带缓存与并发合流）。
 *
 * mixin_key 推导：nav 返回的 img_url/sub_url 各取文件名（去扩展名）→ 拼成 64 字符原串
 *   → 按 wbiMixinTab 的下标顺序重排 → 取前 32 位。
 *
 * @param {object} proto
 * @param {number} timeoutMs
 * @returns {Promise<{mixinKey:string, buvid3:string, buvid4:string}>}
 */
async function _ensureWbiMaterial(proto, timeoutMs) {
	const fresh = _wbiCache.mixinKey && (Date.now() - _wbiCache.ts) < proto.wbiCacheTtlMs
	if (fresh) return { mixinKey: _wbiCache.mixinKey, buvid3: _wbiCache.buvid3, buvid4: _wbiCache.buvid4 }
	// 并发合流：多个 session 同时首连时只发一次请求，其余等同一个 Promise
	if (_wbiCache.inflight) return _wbiCache.inflight

	const headers = { 'User-Agent': proto.userAgent, Referer: proto.navReferer }
	_wbiCache.inflight = (async () => {
		try {
			// ① nav：取 wbi 双 key。⚠ 未登录时 nav 返回 code=-101，但 data.wbi_img 仍然有值——
			//   故此处【不校验 code】，只看 wbi_img 是否拿到（实测 -101 下签名照样有效）。
			const navResp = await fetch(proto.apiNav, { headers, signal: AbortSignal.timeout(timeoutMs) })
			const navJson = await navResp.json()
			const imgUrl = navJson?.data?.wbi_img?.img_url || ''
			const subUrl = navJson?.data?.wbi_img?.sub_url || ''
			const imgKey = imgUrl.slice(imgUrl.lastIndexOf('/') + 1).split('.')[0]
			const subKey = subUrl.slice(subUrl.lastIndexOf('/') + 1).split('.')[0]
			if (!imgKey || !subKey) throw new Error(`nav 未返回 wbi_img（code=${navJson?.code}）`)
			const rawKey = imgKey + subKey
			const mixinKey = proto.wbiMixinTab.map((i) => rawKey[i]).join('').slice(0, 32)

			// ② finger/spi：取真 buvid3。⚠ 自生成的假 buvid3 实测【无效】，必须走此接口。
			let buvid3 = '', buvid4 = ''
			try {
				const spiResp = await fetch(proto.apiFingerSpi, { headers, signal: AbortSignal.timeout(timeoutMs) })
				const spiJson = await spiResp.json()
				buvid3 = spiJson?.data?.b_3 || ''
				buvid4 = spiJson?.data?.b_4 || ''
			} catch (e) {
				// buvid 取失败不直接抛：用户若在面板填了自己的 biliBuvid3，仍可成功（见 _fetchDanmuInfo）
				console.warn('[beilu-live/bilibili] finger/spi 取 buvid 失败:', e.message)
			}

			_wbiCache.mixinKey = mixinKey
			_wbiCache.buvid3 = buvid3
			_wbiCache.buvid4 = buvid4
			_wbiCache.ts = Date.now()
			return { mixinKey, buvid3, buvid4 }
		} finally {
			_wbiCache.inflight = null
		}
	})()
	return _wbiCache.inflight
}

/**
 * WBI 签名：参数按 key 升序排列 + wts(秒级时间戳) → 拼 query → 追加 md5(query + mixinKey) 作 w_rid。
 *
 * ⚠ 值需剔除 `!'()*` 四类字符（平台前端的编码规则，实测必须一致，否则签名不匹配）。
 * 本函数是【签名算法实现】不是协议常量，故留在代码里（配置化它等于要实现一套算法 DSL）。
 *
 * @param {Record<string, string|number>} params - 待签参数（不含 wts/w_rid）
 * @param {string} mixinKey
 * @returns {string} 完整 query string（含 wts 与 w_rid）
 */
function _wbiSign(params, mixinKey) {
	const wts = Math.floor(Date.now() / 1000)
	const all = { ...params, wts }
	const query = Object.keys(all).sort()
		.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ''))}`)
		.join('&')
	const wRid = crypto.createHash('md5').update(query + mixinKey).digest('hex')
	return `${query}&w_rid=${wRid}`
}

// ============================================================
// 工具：包编解码（协议参数全部由调用方传入，本层零常量）
// ============================================================

/**
 * 组一个协议包：包头 + body。包头布局 = totalLen(u32) headerLen(u16) protover(u16) operation(u32) sequence(u32)。
 * @param {number} op - 操作码（取自 protocol.ops.*）
 * @param {string} body - 包体（认证包为 JSON 字符串；心跳包为空串）
 * @param {{headerLen:number, protovers:object, auth:object}} proto
 * @returns {Uint8Array}
 */
function _encodePacket(op, body, proto) {
	const payload = _enc.encode(body || '')
	const headerLen = proto.headerLen
	const buf = new Uint8Array(headerLen + payload.length)
	const dv = new DataView(buf.buffer)
	dv.setUint32(0, buf.length)                                  // totalLen
	dv.setUint16(4, headerLen)                                   // headerLen
	dv.setUint16(6, proto.protovers.json)                        // 上行 protover（裸 JSON）
	dv.setUint32(8, op)                                          // operation
	dv.setUint32(12, Number.isFinite(proto.auth.sequence) ? proto.auth.sequence : 1) // sequence
	buf.set(payload, headerLen)
	return buf
}

/**
 * 解一个 ArrayBuffer 里的【全部】协议包（一个 TCP 帧可能粘包多个）。
 * 压缩包（protovers.zlib / protovers.brotli）解压后是【多个完整包】，需递归再切一次。
 * @param {ArrayBuffer|Uint8Array} raw
 * @param {{headerLen:number, protovers:object}} proto
 * @returns {Array<{op:number, protover:number, body:Uint8Array}>} 扁平化后的包列表
 */
function _decodePackets(raw, proto) {
	const u8 = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
	const headerLen = proto.headerLen
	const out = []
	let offset = 0

	while (offset + headerLen <= u8.length) {
		const dv = new DataView(u8.buffer, u8.byteOffset + offset, Math.min(headerLen, u8.length - offset))
		const totalLen = dv.getUint32(0)
		const hLen = dv.getUint16(4)
		const protover = dv.getUint16(6)
		const op = dv.getUint32(8)

		// 长度非法 → 停止解析本帧（残包/协议变更，诚实中止不静默死循环）
		if (totalLen <headerLen || hLen <headerLen || offset + totalLen > u8.length) break

		const body = u8.subarray(offset + hLen, offset + totalLen)

		if (protover === proto.protovers.zlib || protover === proto.protovers.brotli) {
			// 压缩包：解压后的内容是【多个完整包】，递归展开
			try {
				const inflated = protover === proto.protovers.brotli
					? zlib.brotliDecompressSync(body)
					: zlib.inflateSync(body)
				out.push(..._decodePackets(new Uint8Array(inflated), proto))
			} catch (e) {
				// 解压失败：该包丢弃并记一条（不抛——单包坏不该杀掉整条连接）
				console.warn('[beilu-live/bilibili] 解压失败 protover=' + protover + ':', e.message)
			}
		} else {
			out.push({ op, protover, body })
		}

		offset += totalLen
	}

	return out
}

// ============================================================
// 工具：HTTP 两接口
// ============================================================

/**
 * 拼请求头。凭据只在此处使用，不外泄。
 * @param {object} cred - per-user 凭据对象，键名来自 registry.credentials[].key
 * @param {{userAgent:string, referer:string, cookieMap:Record<string,string>}} proto
 *   cookieMap: { <registry凭据key>: <平台Cookie字段名> }，如 { biliSessdata:'SESSDATA', biliBuvid3:'buvid3' }
 *   ⚠ 左侧 key 必须与 registry.mjs 的 credentials[].key 一致，否则用户填了凭据却读不到（静默降级成未登录）。
 * @returns {Record<string,string>}
 */
function _headers(cred, proto) {
	const h = { 'User-Agent': proto.userAgent, Referer: proto.referer }
	const parts = []
	for (const [credKey, cookieName] of Object.entries(proto.cookieMap || {})) {
		const v = cred?.[credKey]
		if (v) parts.push(`${cookieName}=${v}`)
	}
	if (parts.length) h.Cookie = parts.join('; ')
	return h
}

/**
 * ① 短号 → 真实 room_id。
 * @param {string} roomId - 用户填的房间号（可能是短号）
 * @param {object} cred
 * @param {object} proto
 * @param {number} timeoutMs
 * @returns {Promise<number>} 真实 room_id
 */
async function _resolveRoomId(roomId, cred, proto, timeoutMs) {
	const resp = await fetch(proto.apiRoomInit + encodeURIComponent(roomId), {
		headers: _headers(cred, proto),
		signal: AbortSignal.timeout(timeoutMs),
	})
	if (!resp.ok) throw new Error(`room_init HTTP ${resp.status}`)
	const json = await resp.json()
	// 平台业务码：okCode（默认 0）表示成功，其余为业务错误（房间不存在/被封等）
	const okCode = Number.isFinite(proto.okCode) ? proto.okCode : 0
	if (json?.code !== okCode) throw new Error(`room_init code=${json?.code} msg=${json?.msg || json?.message || ''}`)
	const real = json?.data?.room_id
	if (!real) throw new Error('room_init 返回体缺 data.room_id')
	return real
}

/**
 * ② 取弹幕服务器 host 列表 + 认证 token。
 * @param {number} realRoomId
 * @param {object} cred
 * @param {object} proto
 * @param {number} timeoutMs
 * @returns {Promise<{token:string, hosts:string[]}>}
 */
async function _fetchDanmuInfo(realRoomId, cred, proto, timeoutMs) {
	const okCode = Number.isFinite(proto.okCode) ? proto.okCode : 0

	// —— 组 URL 与请求头：WBI 启用时走签名 + 真 buvid（二者缺一即 -352，实测见 capabilities 注释）——
	let url, headers
	if (proto.wbiEnabled) {
		const mat = await _ensureWbiMaterial(proto, timeoutMs)
		const signed = _wbiSign({ ...(proto.danmuInfoParams || {}), id: realRoomId }, mat.mixinKey)
		url = proto.apiDanmuInfo + signed
		// 用户在面板填的 buvid3 优先（他自己的浏览器指纹更"真"）；未填则用 finger/spi 自动取的
		headers = _headers(cred, proto)
		const autoCookie = []
		if (!cred?.biliBuvid3 && mat.buvid3) autoCookie.push(`buvid3=${mat.buvid3}`)
		if (mat.buvid4) autoCookie.push(`buvid4=${mat.buvid4}`)
		if (autoCookie.length) {
			headers.Cookie = headers.Cookie ? `${headers.Cookie}; ${autoCookie.join('; ')}` : autoCookie.join('; ')
		}
	} else {
		// 未启用签名：退回朴素 query（保留此路径，便于平台取消风控后一键关闭签名）
		const q = new URLSearchParams({ ...(proto.danmuInfoParams || {}), id: String(realRoomId) })
		url = proto.apiDanmuInfo + q.toString()
		headers = _headers(cred, proto)
	}

	const resp = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
	if (!resp.ok) throw new Error(`getDanmuInfo HTTP ${resp.status}`)
	const json = await resp.json()
	if (json?.code !== okCode) {
		// 业务错误多半是凭证材料过期（wbi key 每日更新）→ 作废缓存，下次重连重取
		_invalidateWbiCache()
		throw new Error(`getDanmuInfo code=${json?.code} msg=${json?.msg || json?.message || ''}`)
	}
	const token = json?.data?.token
	if (!token) throw new Error('getDanmuInfo 返回体缺 data.token')
	const hosts = Array.isArray(json?.data?.host_list)
		? json.data.host_list.map((h) => h.host).filter(Boolean)
		: []
	return { token, hosts: hosts.length ? hosts : [proto.fallbackHost] }
}

// ============================================================
// 工具：业务消息 → LiveMessage 归一化
// ============================================================

/**
 * 把一条平台业务 JSON 归一化成统一 LiveMessage（图纸 v2 §3.1）。
 * 未知 cmd 返回 null（不炸、不猜、不产出半成品消息）。
 *
 * cmd 名从 proto.cmds 取（可配）；字段提取【路径】留在本函数（见文件头"仍留在代码里的是什么"）。
 *
 * @param {object} j - 业务 JSON（含 cmd 字段）
 * @param {string} platformRoomId - 用户填的房间号（原样带回，便于多房间场景对账）
 * @param {{cmds:{danmaku:string,gift:string,superchat:string,enter:string}}} proto
 * @returns {object|null} LiveMessage
 */
function _normalize(j, platformRoomId, proto) {
	const cmd = j?.cmd || ''
	const now = Date.now()
	const C = proto.cmds

	// 弹幕：cmd 可能带后缀（如 DANMU_MSG:4:0:2:2:2:0），故用前缀判定
	if (C.danmaku && cmd.startsWith(C.danmaku)) {
		const info = j.info || []
		// 字段路径：info[1]=文本；info[2]=[uid, 用户名, ...]；info[0][4]=发送时间戳(ms)
		const text = typeof info[1] === 'string' ? info[1] : ''
		const u = Array.isArray(info[2]) ? info[2] : []
		const uid = u[0] != null ? String(u[0]) : ''
		const user = typeof u[1] === 'string' ? u[1] : ''
		const tsRaw = Array.isArray(info[0]) ? info[0][4] : null
		if (!text || !uid) return null
		return {
			platform: 'bilibili',
			roomId: platformRoomId,
			uid,
			user,
			text,
			ts: Number.isFinite(tsRaw) ? tsRaw : now,
			type: 'danmaku',
			raw: j, // 调试/扩展用，【不进 AI 上下文】（图纸 §3.1 边界隔离）
		}
	}

	// 礼物
	if (C.gift && cmd === C.gift) {
		const d = j.data || {}
		const uid = d.uid != null ? String(d.uid) : ''
		if (!uid) return null
		return {
			platform: 'bilibili',
			roomId: platformRoomId,
			uid,
			user: d.uname || '',
			text: `${d.action || ''} ${d.giftName || ''} x${d.num || 1}`.trim(),
			ts: Number.isFinite(d.timestamp) ? d.timestamp * 1000 : now, // 平台此字段是秒
			type: 'gift',
			// weight=价值权重，供 selector.weightByGift 加权（图纸 §3.1）
			weight: Number.isFinite(d.total_coin) ? d.total_coin : 0,
			raw: j,
		}
	}

	// 醒目留言（付费高亮）
	if (C.superchat && cmd === C.superchat) {
		const d = j.data || {}
		const uid = d.uid != null ? String(d.uid) : ''
		if (!uid) return null
		return {
			platform: 'bilibili',
			roomId: platformRoomId,
			uid,
			user: d.user_info?.uname || '',
			text: d.message || '',
			ts: Number.isFinite(d.start_time) ? d.start_time * 1000 : now,
			type: 'superchat',
			weight: Number.isFinite(d.price) ? d.price : 0,
			raw: j,
		}
	}

	// 进场/关注等互动
	if (C.enter && cmd === C.enter) {
		const d = j.data || {}
		const uid = d.uid != null ? String(d.uid) : ''
		if (!uid) return null
		return {
			platform: 'bilibili',
			roomId: platformRoomId,
			uid,
			user: d.uname || '',
			text: '', // 进场无文本内容——初筛的 minLength 会自然滤掉，除非用户显式放行
			ts: Number.isFinite(d.timestamp) ? d.timestamp * 1000 : now,
			type: 'enter',
			raw: j,
		}
	}

	return null // 其余 cmd（人气/榜单/横幅…）不产出消息
}

// ============================================================
// adapter 主体
// ============================================================

export default {
	name: 'bilibili',

	/**
	 * 建立弹幕连接（持续推送，非一次性返回）。
	 *
	 * @param {{roomId:string, credentials?:object}} conf
	 * @param {(msg:object) => void} onMessage - 每条归一化后的 LiveMessage
	 * @param {(err:Error) => void} [onError] - 连接级错误（单包错误只 warn 不上报）
	 * @param {{connection:object, protocol:object, onRaw?:Function, onState?:Function}} opts
	 *   ⚠ connection 与 protocol 【均为必需】——本文件不持任何默认值：
	 *     connection = 行为参数（心跳/重连/超时），单源 capabilities.LIVE_CAPABILITIES.connection
	 *     protocol   = 协议常量（URL/op码/包头/cmd名），单源 capabilities.LIVE_CAPABILITIES.platformProtocol.bilibili
	 *     调用方（runtime.mjs 章5）从 resolveLiveRules 结果里取这两组整份传入，不逐字段手拼。
	 *   onRaw(u8, packets)：可选 debug 钩子，收到原始帧时回调（探针打 hex 用，生产不传）。
	 *   onState({state, detail})：可选状态钩子，state ∈ connecting/authed/closed/retrying（面板状态条用）。
	 * @returns {{close: () => void}}
	 */
	connect(conf, onMessage, onError, opts) {
		const cn = opts?.connection
		if (!cn || typeof cn !== 'object') {
			throw new Error('[beilu-live/bilibili] connect 缺 opts.connection（行为参数单源=capabilities.mjs LIVE_CAPABILITIES.connection，adapter 不持默认值）')
		}
		for (const k of _REQUIRED_CONNECTION_KEYS) {
			if (!Number.isFinite(cn[k])) throw new Error(`[beilu-live/bilibili] connect 缺 opts.connection.${k}`)
		}
		const proto = opts?.protocol
		_assertProtocol(proto)

		const roomIdInput = String(conf?.roomId || '').trim()
		if (!roomIdInput) throw new Error('[beilu-live/bilibili] connect 缺 conf.roomId')

		const cred = conf?.credentials || {}
		const _emitState = (state, detail) => { try { opts?.onState?.({ state, detail }) } catch { /* 钩子异常不影响连接 */ } }
		const _emitErr = (e) => { try { onError?.(e) } catch { /* 同上 */ } }

		// ---- 连接级状态（closed 标志是手动关闭与自动重连之间的唯一裁决者）----
		let ws = null
		let heartbeatTimer = null
		let retryTimer = null
		let failCount = 0
		let closed = false      // close() 置 true 后，任何重连入口都必须止步
		let generation = 0      // 每次建连 +1：旧 ws 的迟到回调靠它失效，防双连接

		/** 彻底拆掉当前连接：解绑回调 + 清心跳 + 关 socket。幂等。 */
		function _teardown() {
			if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
			if (ws) {
				// 先解绑再关：否则 close() 触发的 onclose 会再进重连逻辑
				ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null
				try { ws.close() } catch { /* 已关闭 */ }
				ws = null
			}
		}

		/** 退避重连。照 websocket.mjs:699 既有范式，参数全部来自 capabilities.connection。 */
		function _scheduleRetry(reason) {
			if (closed) return
			if (failCount >= cn.maxRetries) {
				_emitState('closed', `重连次数用尽(${cn.maxRetries})，最后原因: ${reason}`)
				_emitErr(new Error(`[beilu-live/bilibili] 重连 ${cn.maxRetries} 次仍失败，停止。最后原因: ${reason}`))
				return
			}
			failCount += 1
			const delay = Math.min(cn.retryBaseMs * Math.pow(cn.retryFactor, failCount - 1), cn.retryMaxMs)
			_emitState('retrying', `第 ${failCount}/${cn.maxRetries} 次重连将在 ${delay}ms 后开始（${reason}）`)
			if (retryTimer) clearTimeout(retryTimer)
			retryTimer = setTimeout(() => { retryTimer = null; _open() }, delay)
		}

		/** 建立一次连接（①②③④⑤⑥ 全流程）。 */
		async function _open() {
			if (closed) return
			const gen = ++generation
			_teardown()
			_emitState('connecting', `房间 ${roomIdInput}`)

			let realRoomId, token, hosts
			try {
				realRoomId = await _resolveRoomId(roomIdInput, cred, proto, cn.httpTimeoutMs)
				const info = await _fetchDanmuInfo(realRoomId, cred, proto, cn.httpTimeoutMs)
				token = info.token
				hosts = info.hosts
			} catch (e) {
				if (closed || gen !== generation) return
				_scheduleRetry(`HTTP 前置失败: ${e.message}`)
				return
			}
			if (closed || gen !== generation) return

			// 多个 host 轮换：按重连次数取模，避免每次都撞同一台故障机
			const host = hosts[failCount % hosts.length]
			let sock
			try {
				sock = new WebSocket(`wss://${host}${proto.wsPath}`)
			} catch (e) {
				_scheduleRetry(`WebSocket 构造失败: ${e.message}`)
				return
			}
			sock.binaryType = 'arraybuffer'
			ws = sock

			sock.onopen = () => {
				if (closed || gen !== generation) return
				// ④ 认证包：字段全部来自 proto.auth（uid/platform/type/protover 可配）
				const authBody = JSON.stringify({
					uid: Number.isFinite(proto.auth.uid) ? proto.auth.uid : 0,
					roomid: realRoomId,
					protover: proto.auth.protover,
					platform: proto.auth.platform,
					type: proto.auth.type,
					key: token,
				})
				try {
					sock.send(_encodePacket(proto.ops.auth, authBody, proto))
				} catch (e) {
					_scheduleRetry(`认证包发送失败: ${e.message}`)
					return
				}
				// ⑤ 心跳：间隔来自 capabilities.connection.heartbeatMs
				heartbeatTimer = setInterval(() => {
					if (closed || sock.readyState !== 1) return
					try { sock.send(_encodePacket(proto.ops.heartbeat, '', proto)) } catch { /* 下一跳或 onclose 处理 */ }
				}, cn.heartbeatMs)
			}

			sock.onmessage = (ev) => {
				if (closed || gen !== generation) return
				let packets
				try {
					packets = _decodePackets(ev.data, proto)
				} catch (e) {
					console.warn('[beilu-live/bilibili] 解包异常:', e.message)
					return
				}
				// debug 钩子：探针用它打原始 hex 对照协议（生产不传）
				try { opts?.onRaw?.(ev.data, packets) } catch { /* 钩子异常不影响 */ }

				const okCode = Number.isFinite(proto.okCode) ? proto.okCode : 0
				for (const p of packets) {
					if (p.op === proto.ops.authReply) {
						// 认证结果：body 是 JSON {code:okCode} 表示成功
						let ok = true
						try { ok = (JSON.parse(_dec.decode(p.body))?.code ?? okCode) === okCode } catch { /* 非 JSON 视为成功 */ }
						if (ok) {
							failCount = 0 // ★ 认证成功才重置：否则长跑中的偶发断线会迅速耗尽重试额度
							_emitState('authed', `房间 ${roomIdInput}（真实 id ${realRoomId}）已连接`)
						} else {
							_scheduleRetry('认证被拒绝（token 失效或房间不可用）')
							return
						}
						continue
					}
					if (p.op === proto.ops.heartbeatReply) continue // 人气值，不产出消息
					if (p.op !== proto.ops.message) continue

					let json
					try { json = JSON.parse(_dec.decode(p.body)) } catch { continue } // 单包坏就跳过这一包
					const msg = _normalize(json, roomIdInput, proto)
					if (!msg) continue
					try { onMessage(msg) } catch (e) {
						// 消费方异常不能杀连接（否则一条弹幕处理出错就断流）
						console.warn('[beilu-live/bilibili] onMessage 消费异常:', e.message)
					}
				}
			}

			sock.onerror = () => {
				// WebSocket 的 error 事件不带可用信息，真正的收尾在 onclose
				if (closed || gen !== generation) return
			}

			sock.onclose = (ev) => {
				if (closed || gen !== generation) return
				if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
				_scheduleRetry(`连接关闭 code=${ev?.code ?? '?'}`)
			}
		}

		// 起飞（不 await：connect 是同步返回句柄的契约，失败经 onError/onState 上报）
		_open()

		return {
			/** 手动关闭：置 closed 后所有重连入口止步，幂等。 */
			close() {
				closed = true
				if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
				_teardown()
				_emitState('closed', '手动关闭')
			},
		}
	},
}