/**
 * 企业微信 Bot 工具函数
 * 包含: AES 加解密、XML 解析、签名验证、access_token 管理、消息发送
 */

import { createHash, createDecipheriv, createCipheriv, randomBytes } from "node:crypto";
import { createDiag } from "../../../../../../server/diagLogger.mjs";
import { extractPlatformContentShared, splitBotReply } from "../../../../../../scripts/botContentShared.mjs";

const diag = createDiag("wecombot");

// ---- 限流退避（M17：原先出站全裸 throw，不识别频控也不读 Retry-After）----

// 企业微信频控 errcode：45009=应用发消息超日限 / 45011=API调用太频繁 / -1=系统繁忙
const WECOM_RATELIMIT_ERRCODES = new Set([45009, 45011, -1]);
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 30_000;

function _parseRetryAfterMs(resp) {
	const ra = resp.headers.get("Retry-After");
	if (!ra) return null;
	const secs = Number(ra);
	if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
	const dateMs = Date.parse(ra);
	if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
	return null;
}

/**
 * 带限流退避的企业微信请求：处理 HTTP 429（读 Retry-After）与 wecom 频控
 * errcode（45009/45011/-1）的指数退避重试。非频控错误透传给调用方按原逻辑处理。
 * @param {string} label - 调用名（日志/错误用）。
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<any>} 解析后的 JSON data 对象。
 */
async function wecomRequest(label, url, options = undefined) {
	let lastErr = null;
	for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
		if (attempt > 0) {
			const backoff = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
			diag.log(`${label}: 频控退避重试 ${attempt}/${RETRY_MAX_ATTEMPTS - 1}, 等待 ${backoff}ms`);
			await new Promise((r) => setTimeout(r, backoff));
		}
		const resp = await fetch(url, options);
		if (resp.status === 429) {
			const waitMs = _parseRetryAfterMs(resp) ?? Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
			lastErr = new Error(`${label} HTTP 429（限流）`);
			if (attempt < RETRY_MAX_ATTEMPTS - 1) {
				diag.log(`${label}: HTTP 429, 按 Retry-After 等待 ${waitMs}ms`);
				await new Promise((r) => setTimeout(r, waitMs));
				continue;
			}
			throw lastErr;
		}
		if (!resp.ok) throw new Error(`${label} HTTP ${resp.status}`);
		const data = await resp.json();
		if (data.errcode !== 0 && WECOM_RATELIMIT_ERRCODES.has(data.errcode)) {
			lastErr = new Error(`${label} 频控: errcode=${data.errcode}, errmsg=${data.errmsg}`);
			if (attempt < RETRY_MAX_ATTEMPTS - 1) continue;
			throw lastErr;
		}
		return data;
	}
	throw lastErr || new Error(`${label}: 重试耗尽`);
}

// ---- 签名与加解密 ----

/**
 * 生成企业微信消息签名。
 * 签名算法: sha1(sort([token, timestamp, nonce, msgEncrypt]).join(''))
 * @param {string} token - 企业微信回调 Token。
 * @param {string} timestamp - 时间戳。
 * @param {string} nonce - 随机字符串。
 * @param {string} msgEncrypt - 加密消息内容。
 * @returns {string} sha1 签名（十六进制小写）。
 */
export function buildSignature(token, timestamp, nonce, msgEncrypt) {
	const arr = [token, timestamp, nonce, msgEncrypt].sort();
	return createHash("sha1").update(arr.join("")).digest("hex");
}

/**
 * 验证企业微信消息签名。
 * @param {string} token - 企业微信回调 Token。
 * @param {string} timestamp - 时间戳。
 * @param {string} nonce - 随机字符串。
 * @param {string} msgEncrypt - 加密消息内容（GET 时是 echostr，POST 时是 Encrypt 字段）。
 * @param {string} msgSignature - 企业微信发送的签名。
 * @returns {boolean} 是否合法。
 */
export function verifySignature(token, timestamp, nonce, msgEncrypt, msgSignature) {
	const expected = buildSignature(token, timestamp, nonce, msgEncrypt);
	return expected === msgSignature;
}

/**
 * 获取企业微信 AES 密钥和 IV。
 * encodingAESKey 是 43 字符 Base64，密钥 = Base64Decode(key + "=")，IV = key.slice(0, 16)
 * @param {string} encodingAESKey - 43 字符 Base64 编码密钥。
 * @returns {{ key: Buffer, iv: Buffer }}
 */
function getAesKeyAndIv(encodingAESKey) {
	const key = Buffer.from(encodingAESKey + "=", "base64");
	const iv = key.slice(0, 16);
	return { key, iv };
}

/**
 * 解密企业微信 AES-256-CBC 消息。
 * 明文格式: 16字节随机串 + 4字节消息长度（big-endian）+ 消息内容 + corpId
 * @param {string} encodingAESKey - 43 字符 Base64 密钥。
 * @param {string} encryptBase64 - Base64 编码的密文。
 * @returns {string} 解密后的消息内容（XML 字符串）。
 */
export function decryptMessage(encodingAESKey, encryptBase64) {
	const { key, iv } = getAesKeyAndIv(encodingAESKey);
	const encryptBuf = Buffer.from(encryptBase64, "base64");
	const decipher = createDecipheriv("aes-256-cbc", key, iv);
	decipher.setAutoPadding(false); // PKCS7 需要手动处理
	let decrypted = Buffer.concat([decipher.update(encryptBuf), decipher.final()]);

	// 去掉 PKCS7 padding
	const padLen = decrypted[decrypted.length - 1];
	decrypted = decrypted.slice(0, decrypted.length - padLen);

	// 跳过前 16 字节随机串
	const msgLen = decrypted.readUInt32BE(16);
	const msgContent = decrypted.slice(20, 20 + msgLen);

	return msgContent.toString("utf8");
}

/**
 * 加密消息（AES-256-CBC，企业微信格式）。
 * 明文格式: 16字节随机串 + 4字节消息长度 + 消息内容 + corpId
 * @param {string} encodingAESKey - 43 字符 Base64 密钥。
 * @param {string} msgContent - 要加密的消息（XML 字符串）。
 * @param {string} corpId - 企业微信 corpId。
 * @returns {string} Base64 编码的密文。
 */
export function encryptMessage(encodingAESKey, msgContent, corpId) {
	const { key, iv } = getAesKeyAndIv(encodingAESKey);
	const randBytes = randomBytes(16);
	const msgBuf = Buffer.from(msgContent, "utf8");
	const corpBuf = Buffer.from(corpId, "utf8");

	const lenBuf = Buffer.alloc(4);
	lenBuf.writeUInt32BE(msgBuf.length, 0);

	let plain = Buffer.concat([randBytes, lenBuf, msgBuf, corpBuf]);

	// PKCS7 padding to 32 bytes block
	const blockSize = 32;
	const padLen = blockSize - (plain.length % blockSize);
	const pad = Buffer.alloc(padLen, padLen);
	plain = Buffer.concat([plain, pad]);

	const cipher = createCipheriv("aes-256-cbc", key, iv);
	cipher.setAutoPadding(false);
	return Buffer.concat([cipher.update(plain), cipher.final()]).toString("base64");
}

// ---- XML 解析 ----

/**
 * 极简 XML 解析器（只处理企业微信的平铺 XML 结构）。
 * 提取所有 <Tag>value</Tag> 和 <![CDATA[value]]> 到 key-value 对象。
 * @param {string} xml - XML 字符串。
 * @returns {Record<string, string>} 解析结果。
 */
export function parseXml(xml) {
	const result = {};
	// 匹配 <Tag>content</Tag>，content 可以是 CDATA 或普通文本
	const tagRegex = /<(\w+)>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))\s*<\/\1>/g;
	let match;
	while ((match = tagRegex.exec(xml)) !== null) {
		const key = match[1];
		const value = match[2] !== undefined ? match[2] : (match[3] || "");
		result[key] = value;
	}
	return result;
}

/**
 * 从解密后的明文 XML 提取企业微信消息结构。
 * @param {string} xml - 解密后的明文 XML。
 * @returns {object} 消息对象（MsgType、Content、FromUserName、ToUserName、AgentID 等）。
 */
export function extractWecomMessage(xml) {
	return parseXml(xml);
}

/**
 * 将消息对象序列化为企业微信回复 XML。
 * （企业微信被动回复模式已弃用，建议使用 REST API 发送，此函数备用）
 * @param {string} toUser - 接收方 OpenID / userId。
 * @param {string} fromUser - corpId 或 touser。
 * @param {string} msgType - 消息类型（text）。
 * @param {string} content - 消息内容。
 * @returns {string} XML 字符串。
 */
export function buildReplyXml(toUser, fromUser, msgType, content) {
	const ts = Math.floor(Date.now() / 1000);
	return `<xml><ToUserName><![CDATA[${toUser}]]></ToUserName><FromUserName><![CDATA[${fromUser}]]></FromUserName><CreateTime>${ts}</CreateTime><MsgType><![CDATA[${msgType}]]></MsgType><Content><![CDATA[${content}]]></Content></xml>`;
}

// ---- access_token 缓存 ----

/**
 * access_token 缓存，key: `corpId:secret前8位`，value: { token, expireAt }
 * @type {Map<string, { token: string, expireAt: number }>}
 */
const tokenCache = new Map();

/**
 * 获取企业微信 access_token（自动缓存并刷新）。
 * @param {string} corpId - 企业微信 corpId。
 * @param {string} secret - 应用 Secret。
 * @returns {Promise<string>} access_token。
 */
export async function getAccessToken(corpId, secret) {
	const cacheKey = `${corpId}:${secret.slice(0, 8)}`;
	const cached = tokenCache.get(cacheKey);
	if (cached && cached.expireAt > Date.now() + 60_000) {
		return cached.token;
	}

	diag.log(`getAccessToken: 刷新 token, corpId="${corpId}"`);
	const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secret)}`;
	const data = await wecomRequest("getAccessToken", url);
	if (data.errcode !== 0)
		throw new Error(`getAccessToken API 错误: errcode=${data.errcode}, errmsg=${data.errmsg}`);

	const token = data.access_token;
	const expireAt = Date.now() + (data.expires_in - 300) * 1000; // 提前 5 分钟刷新
	tokenCache.set(cacheKey, { token, expireAt });
	diag.log(`getAccessToken: token 获取成功, expires_in=${data.expires_in}s`);
	return token;
}

// ---- REST API 调用 ----

/**
 * 发送企业微信应用消息（文本）。
 * @param {string} accessToken - access_token。
 * @param {number|string} agentId - 应用 agentId。
 * @param {string} toUser - 接收人 userId（多个用 | 分隔，"@all" 发给全部）。
 * @param {string} content - 消息内容。
 * @returns {Promise<object>} API 响应。
 */
export async function sendTextMessage(accessToken, agentId, toUser, content) {
	const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`;
	const body = {
		touser: toUser,
		msgtype: "text",
		agentid: Number(agentId),
		text: { content },
		safe: 0,
	};
	const data = await wecomRequest("sendTextMessage", url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (data.errcode !== 0)
		throw new Error(`sendTextMessage API 错误: errcode=${data.errcode}, errmsg=${data.errmsg}`);
	return data;
}

/**
 * 上传临时素材（图片/语音/视频/文件）。
 * @param {string} corpId - 企业微信 corpId。
 * @param {string} secret - 应用 Secret。
 * @param {Buffer} buffer - 文件内容。
 * @param {string} filename - 文件名。
 * @param {'image'|'voice'|'video'|'file'} [type='image'] - 素材类型。
 * @returns {Promise<string>} media_id。
 */
export async function uploadMedia(corpId, secret, buffer, filename, type = "image") {
	const token = await getAccessToken(corpId, secret);
	const url = `https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${encodeURIComponent(token)}&type=${type}`;
	const form = new FormData();
	form.append("media", new Blob([buffer]), filename);
	const data = await wecomRequest("uploadMedia", url, { method: "POST", body: form });
	if (data.errcode !== 0)
		throw new Error(`uploadMedia API 错误: errcode=${data.errcode}, errmsg=${data.errmsg}`);
	diag.log(`uploadMedia: 上传成功, type="${type}", filename="${filename}", media_id="${data.media_id}"`);
	return data.media_id;
}

/**
 * 下载临时素材。
 * @param {string} corpId - 企业微信 corpId。
 * @param {string} secret - 应用 Secret。
 * @param {string} mediaId - 素材 media_id。
 * @returns {Promise<Buffer>} 文件内容。
 */
export async function downloadMedia(corpId, secret, mediaId) {
	const token = await getAccessToken(corpId, secret);
	const url = `https://qyapi.weixin.qq.com/cgi-bin/media/get?access_token=${encodeURIComponent(token)}&media_id=${encodeURIComponent(mediaId)}`;
	const resp = await fetch(url);
	if (!resp.ok) throw new Error(`downloadMedia HTTP ${resp.status}`);
	return Buffer.from(await resp.arrayBuffer());
}

/**
 * 发送企业微信图片消息。
 * @param {string} accessToken - access_token。
 * @param {number|string} agentId - 应用 agentId。
 * @param {string} toUser - 接收人 userId。
 * @param {string} mediaId - 临时素材 media_id。
 * @returns {Promise<object>} API 响应。
 */
export async function sendImageMessage(accessToken, agentId, toUser, mediaId) {
	const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`;
	const body = {
		touser: toUser,
		msgtype: "image",
		agentid: Number(agentId),
		image: { media_id: mediaId },
	};
	const data = await wecomRequest("sendImageMessage", url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (data.errcode !== 0)
		throw new Error(`sendImageMessage API 错误: errcode=${data.errcode}, errmsg=${data.errmsg}`);
	return data;
}

/**
 * 发送企业微信文件消息。
 * @param {string} accessToken - access_token。
 * @param {number|string} agentId - 应用 agentId。
 * @param {string} toUser - 接收人 userId。
 * @param {string} mediaId - 临时素材 media_id。
 * @returns {Promise<object>} API 响应。
 */
export async function sendFileMessage(accessToken, agentId, toUser, mediaId) {
	const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`;
	const body = {
		touser: toUser,
		msgtype: "file",
		agentid: Number(agentId),
		file: { media_id: mediaId },
	};
	const data = await wecomRequest("sendFileMessage", url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (data.errcode !== 0)
		throw new Error(`sendFileMessage API 错误: errcode=${data.errcode}, errmsg=${data.errmsg}`);
	return data;
}

/**
 * 获取企业微信用户信息。
 * @param {string} accessToken - access_token。
 * @param {string} userId - 用户 userId。
 * @returns {Promise<object>} 用户信息对象。
 */
export async function getUserInfo(accessToken, userId) {
	const url = `https://qyapi.weixin.qq.com/cgi-bin/user/get?access_token=${encodeURIComponent(accessToken)}&userid=${encodeURIComponent(userId)}`;
	const resp = await fetch(url);
	if (!resp.ok) throw new Error(`getUserInfo HTTP ${resp.status}`);
	const data = await resp.json();
	if (data.errcode !== 0)
		throw new Error(`getUserInfo API 错误: errcode=${data.errcode}, errmsg=${data.errmsg}`);
	return data;
}

/**
 * 分割长消息（企业微信文本消息上限 2048 字符）。
 * @param {string} text - 消息文本。
 * @param {number} [maxLen=2000] - 单条最大字符数。
 * @returns {string[]} 分割后的字符串数组。
 */
export function splitWecomMessage(text, maxLen = 2000) {
	// T9 件5：收口 botContentShared.splitBotReply 单一实现（原 lastIndexOf 换行断为历史简陋实现，统一即升级）。
	return splitBotReply(text, maxLen);
}

/**
 * 从 AI 回复中提取平台专属内容，清理内部标签。
 * 直接复制自 discordbot default_interface。
 * @param {string} content - AI 完整回复。
 * @param {string} displayTag - 平台标签名（如 "wecom"、"discord"）。
 * @returns {string} 该平台应显示的内容。
 */
export function extractPlatformContent(content, displayTag) {
	return extractPlatformContentShared(content, displayTag);
}
