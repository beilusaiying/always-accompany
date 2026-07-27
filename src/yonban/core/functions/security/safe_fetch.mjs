/**
 * safe_fetch.mjs — SEC-T7 出站 SSRF 防护（服务端共享单源）。不管入站请求校验（那是 middleware.mjs 的事）。
 *
 * 用于"目标 URL 部分由用户/AI 控制"的服务端出站请求（webhook 推送、角色卡下载等）。
 * 校验：仅 http/https；字面 IP 或域名解析出的所有 A/AAAA 命中私网/保留段(含云元数据 169.254)即拒；
 *   纯数字非点分四段(十进制混淆 IP)直接拒。fail-closed（校验不过抛错）。
 *
 * 注意：用户自配的 LLM 端点(serviceSource/getModels)在【本地】部署故意不走此校验——本地 Ollama/LAN
 *   推理是合法用法。但【多用户 server 部署】下，"用户自配出站 URL / 模型输出的 URL"会让任一登录用户
 *   驱动服务端探测运营者内网（云元数据 169.254/内网服务）→ 经 assertSafeOutboundInServerMode 收紧。
 *
 * 链路：调用方 → assertSafeUrl(url) / safeFetch(url) / assertSafeOutboundInServerMode(url)
 * 影响：DNS 解析（lookup）；无磁盘/状态副作用
 * 相交：← api_v1_router.mjs / beilu-web / char-download / MCP / AI 生成器（共 9 处 import）
 *       → path_confine.mjs(getDeployMode — 部署模式分级) / whitebox.mjs(wbTrace,wbDetect)
 */

import { getDeployMode } from './path_confine.mjs'
// 白盒埋点：safe_fetch 在 server/ 下，可直接 import（同级核心层，无倒挂/循环风险）。
import { wbTrace, wbDetect } from '../../../../server/whitebox.mjs'

/**
 * 从 IPv4-mapped / -compatible IPv6 中取出内嵌 IPv4（点分），否则 null。
 * 覆盖三形态：点分 `::ffff:1.2.3.4`、WHATWG 规范化后的压缩 hex `::ffff:7f00:1`、compatible `::1.2.3.4`。
 * SEC-R3：红方坐实 `[::ffff:127.0.0.1]` 被 URL 规范化成 hex `::ffff:7f00:1`，旧正则只认点分 → 漏过。
 */
function _embeddedIPv4(s) {
	let m = s.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
	if (m) return m[1]
	m = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
	if (m) {
		const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16)
		return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`
	}
	return null
}

/** IP 是否私网/保留段（含 IPv4-mapped IPv6 双形态、回环、ULA、link-local/元数据；未知 IPv6 fail-closed）。 */
export function ipIsPrivate(ip) {
	if (!ip) return true
	let s = String(ip).toLowerCase().trim().replace(/^\[|\]$/g, '')
	const v4 = _embeddedIPv4(s)
	if (v4) s = v4 // mapped/compatible → 取内嵌 IPv4 走下方 IPv4 判定
	if (s === '::1' || s === '::' || s === '0:0:0:0:0:0:0:1' || s === '0:0:0:0:0:0:0:0') return true
	if (/^f[cd]/.test(s)) return true       // ULA fc00::/7
	if (/^fe[89ab]/.test(s)) return true    // link-local fe80::/10
	const p = s.split('.')
	if (p.length === 4) {
		const a = +p[0], b = +p[1]
		if ([a, b, +p[2], +p[3]].some(n => Number.isNaN(n) || n < 0 || n > 255)) return true
		if (a === 0 || a === 10 || a === 127) return true
		if (a === 169 && b === 254) return true
		if (a === 172 && b >= 16 && b <= 31) return true
		if (a === 192 && b === 168) return true
		if (a === 100 && b >= 64 && b <= 127) return true
		if (a === 192 && b === 0 && +p[2] === 0) return true
		if (a === 198 && (b === 18 || b === 19)) return true
		if (a >= 224) return true
		return false
	}
	// SEC-F1（红方 round2 亲跑坐实）：6to4 2002::/16 把内嵌 IPv4 编码进第 2-3 个 hextet
	//   （2002:WWXX:YYZZ:: → WW.XX.YY.ZZ）。原"首字符 2 视全局单播放行"会放过内嵌 127/10/169.254
	//   等私网（[2002:7f00:1::]=127.0.0.1、[2002:a9fe:a9fe::]=169.254.169.254 云元数据）。
	//   修：识别 6to4，解出内嵌 IPv4 递归按 IPv4 规则判定。
	const t6 = s.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})/)
	if (t6) {
		const hi = parseInt(t6[1], 16), lo = parseInt(t6[2], 16)
		return ipIsPrivate(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`)
	}
	// SEC-F1：Teredo 2001:0::/32 在低 32 位内嵌客户端 IPv4，可指向内网；出站目标几乎不会是
	//   合法 Teredo 地址 → 一律 fail-closed 拒绝。
	if (/^2001:0{1,4}:/.test(s)) return true
	// SEC-R3：到此仍含冒号 = 无法归并为 IPv4 的 IPv6 字面。本模块只服务"目标含用户/AI 可控部分"的
	//   出站，全局单播 2000::/3（首字符 2/3）视为公网放行，其余（含 NAT64/未知）一律 fail-closed
	//   拒绝——杜绝 mapped 及各类未知 IPv6 形态绕过（旧版末尾 return false 是 fail-open 病根）。
	if (s.includes(':')) return !/^[23]/.test(s)
	return false
}

/**
 * 抓取/推送前强制 URL 安全校验。不过抛错（fail-closed）。
 * @param {string} rawUrl
 * @throws {Error}
 */
export async function assertSafeUrl(rawUrl) {
	let u
	try { u = new URL(rawUrl) } catch { wbDetect(null, 'net', 'ssrf:badUrl', false, 'SSRF 拦截：非法 URL', { raw: String(rawUrl).slice(0, 120) }); throw new Error('非法 URL') }
	if (u.protocol !== 'http:' && u.protocol !== 'https:') { wbDetect(null, 'net', 'ssrf:badProto', false, `SSRF 拦截：禁止的协议 ${u.protocol}`, { protocol: u.protocol, host: u.hostname }); throw new Error(`禁止的协议: ${u.protocol}`) }
	const host = u.hostname.replace(/^\[|\]$/g, '')
	if (/^[\d.]+$/.test(host) || host.includes(':')) {
		if (/^[\d.]+$/.test(host) && host.split('.').length !== 4) { wbDetect(null, 'net', 'ssrf:obfuscatedIp', false, `SSRF 拦截：可疑数字主机(疑似混淆 IP) ${host}`, { host }); throw new Error(`可疑数字主机(疑似混淆 IP): ${host}`) }
		if (ipIsPrivate(host)) { wbDetect(null, 'net', 'ssrf:privateLiteral', false, `SSRF 拦截：内网/保留字面 IP ${host}`, { host }); throw new Error(`禁止访问内网/保留地址: ${host}`) }
		wbTrace(null, 'net', 'ssrf:allowLiteral', { host })
		return
	}
	const { lookup } = await import('node:dns/promises')
	let addrs
	try { addrs = await lookup(host, { all: true }) } catch (e) { wbDetect(null, 'net', 'ssrf:dnsError', false, `SSRF：DNS 解析失败 ${host}`, { host, error: String(e?.message || e) }); throw e }
	if (!addrs.length) { wbDetect(null, 'net', 'ssrf:dnsEmpty', false, `SSRF 拦截：DNS 无解析结果 ${host}`, { host }); throw new Error('DNS 无解析结果') }
	for (const a of addrs) if (ipIsPrivate(a.address)) { wbDetect(null, 'net', 'ssrf:dnsPrivate', false, `SSRF 拦截：域名解析到内网 ${host}→${a.address}`, { host, addr: a.address }); throw new Error(`域名解析到内网地址: ${host}→${a.address}`) }
	wbTrace(null, 'net', 'ssrf:allowResolved', { host, addrs: addrs.length })
}

/**
 * SEC-F4（红方 round2，凛倾定"聚焦多用户"）：对【用户自配/模型输出】的出站 URL 做部署模式分级 SSRF 校验。
 *   - local（单用户，owner 自己机器）：放行——本地 Ollama/LAN 推理、本地 MCP server 等合法用法不受影响。
 *   - server（多用户）：强制 assertSafeUrl——杜绝任一登录用户经"自配 AI 端点 / 模型吐的 image URL /
 *     MCP url transport"驱动服务端探测运营者内网（云元数据/内网服务）。
 *   与 deployGatedAllow 同一部署分级哲学；本函数面向"出站目标 URL"，故走 assertSafeUrl 而非 config 开关。
 * @param {string} url
 * @throws {Error} server 模式且目标为内网/保留地址时抛错（fail-closed）。
 */
export async function assertSafeOutboundInServerMode(url) {
	const _mode = getDeployMode()
	if (_mode !== 'server') { wbTrace(null, 'net', 'outbound:localBypass', { mode: _mode }); return }
	wbTrace(null, 'net', 'outbound:serverCheck', { mode: _mode })
	await assertSafeUrl(url)
}

/**
 * 安全出站 fetch：每一跳（含重定向 Location）都过 assertSafeUrl，禁自动跟随。
 *
 * 默认 fetch 的 redirect:'follow' 会让"公网域 302→内网/元数据"绕过 assertSafeUrl
 * （初始 URL 校验通过、跳转目标不校验）。本函数改用 redirect:'manual' 手动跟随：
 *   初始 URL 校验 → fetch → 遇 3xx 取 Location → assertSafeUrl(Location) → 再 fetch，
 *   最多跟随 MAX_REDIRECTS 跳；非 http(s)/超跳数/缺 Location 一律抛错（fail-closed）。
 *
 * 调用方保留各自 headers/signal/method/body，与裸 fetch 用法一致。
 * @param {string} url
 * @param {RequestInit} [opts]
 * @param {number} [MAX_REDIRECTS]
 * @returns {Promise<Response>}
 * @throws {Error}
 */
export async function safeFetch(url, opts = {}, MAX_REDIRECTS = 3) {
	let current = url
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		await assertSafeUrl(current)
		wbTrace(null, 'net', 'safeFetch:hop', { hop, host: (() => { try { return new URL(current).host } catch { return '?' } })() })
		const resp = await fetch(current, { ...opts, redirect: 'manual' })
		// 非重定向（含 opaqueredirect 之外的正常响应）直接返回
		if (resp.status < 300 || resp.status >= 400) { wbTrace(null, 'net', 'safeFetch:done', { hop, status: resp.status }); return resp }
		const loc = resp.headers.get('location')
		if (!loc) { wbDetect(null, 'net', 'safeFetch:noLocation', false, `重定向缺少 Location 头 (status ${resp.status})`, { hop, status: resp.status }); throw new Error(`重定向缺少 Location 头 (status ${resp.status})`) }
		// 相对 Location 按当前 URL 解析为绝对地址，再交由 assertSafeUrl 校验协议/私网
		let next
		try { next = new URL(loc, current).href } catch { wbDetect(null, 'net', 'safeFetch:badRedirect', false, `非法重定向地址: ${loc}`, { hop, loc: String(loc).slice(0, 120) }); throw new Error(`非法重定向地址: ${loc}`) }
		current = next
	}
	wbDetect(null, 'net', 'safeFetch:tooManyRedirects', false, `重定向次数超过上限 (${MAX_REDIRECTS})`, { MAX_REDIRECTS })
	throw new Error(`重定向次数超过上限 (${MAX_REDIRECTS})`)
}
