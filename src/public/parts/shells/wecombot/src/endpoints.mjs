import * as botModule from "./bot.mjs";
import { createBotEndpoints } from "../../../../../scripts/botContentShared.mjs";
import { createDiag } from "../../../../../server/diagLogger.mjs";

const diag = createDiag("wecombot");

// [0716 P1 件8] 13 标准端点收口 createBotEndpoints——原同构实现纯删；活跃会话端点统一
// /activechannels（原 activechats 与前端拼名不符=恒 404，接口方法/字段已同批归一 discord 系）。
// 特异端点（webhook GET 验证 / POST 消息回调，无 authenticate=平台回调正确形）留本文件原文。
const _std = createBotEndpoints("wecombot", {
	botModule,
	getBotInterface: botModule.getBotWecomInterface,
});

const { getBotConfig, getRunningBotList, getBotWecomInterface } = botModule;

/**
 * 为企业微信机器人功能设置 API 端点（管理接口 + webhook 回调）。
 * @param {object} router - Express 路由实例。
 */
export function setEndpoints(router) {
	_std(router);

	// ---- 企业微信 Webhook 路由 ----

	/**
	 * GET /webhook — 企业微信配置回调时的 URL 验证请求。
	 * 企业微信发送: msg_signature, timestamp, nonce, echostr（AES 加密）
	 * 需要解密 echostr 并返回明文。
	 */
	router.get("/api/parts/shells\\:wecombot/webhook", async (req, res) => {
		const { msg_signature, timestamp, nonce, echostr } = req.query;
		diag.log(`webhook GET: ts=${timestamp}, nonce=${nonce}`);

		try {
			const { verifySignature, decryptMessage } = await import("./default_interface/tools.mjs");
			const { getAllUserNames } = await import("../../../../../yonban/core/functions/security/auth.mjs");
			let verified = false;

			// 企业微信 URL 验证不含 corpId 路由，需要遍历所有运行中 bot 尝试匹配
			for (const username of getAllUserNames()) {
				for (const botname of getRunningBotList(username)) {
					const config = getBotConfig(username, botname);
					if (!config.token || !config.encodingAESKey) continue;
					try {
						if (!verifySignature(config.token, timestamp, nonce, echostr, msg_signature))
							continue;
						const plainText = decryptMessage(config.encodingAESKey, echostr);
						diag.log(`webhook GET: 验证通过, bot="${botname}", 明文长度=${plainText.length}`);
						res.status(200).send(plainText);
						verified = true;
						break;
					} catch (e) {
						diag.warn(`webhook GET: bot="${botname}" 解密失败: ${e.message}`);
					}
				}
				if (verified) break;
			}

			if (!verified) {
				diag.warn("webhook GET: 没有匹配的 bot 能验证此请求");
				res.status(403).send("verification failed");
			}
		} catch (error) {
			diag.error("webhook GET 处理异常", error);
			res.status(500).send("error");
		}
	});

	/**
	 * POST /webhook — 企业微信推送消息回调。
	 * Body: <xml><ToUserName>...</ToUserName><Encrypt>加密消息</Encrypt>...</xml>
	 * Query: msg_signature, timestamp, nonce
	 */
	router.post("/api/parts/shells\\:wecombot/webhook", async (req, res) => {
		const { msg_signature, timestamp, nonce } = req.query;
		diag.log(`webhook POST: ts=${timestamp}, nonce=${nonce}`);

		// 企业微信要求立即返回空字符串（5秒内），避免重试
		res.status(200).send("");

		try {
			const { parseXml, verifySignature, decryptMessage, extractWecomMessage } =
				await import("./default_interface/tools.mjs");

			// 解析外层 XML
			const rawBody = req.body;
			let bodyStr = typeof rawBody === "string"
				? rawBody
				: rawBody?.toString?.() || "";

			// Express 可能已经 parse 成对象，尝试重建或从原始 buffer 取
			if (!bodyStr && req.rawBody)
				bodyStr = req.rawBody.toString("utf8");

			diag.debug(`webhook POST body 长度=${bodyStr?.length || 0}`);

			const outerXml = parseXml(bodyStr);
			const encryptText = outerXml?.Encrypt;
			const toUser = outerXml?.ToUserName; // corpId

			if (!encryptText) {
				diag.warn("webhook POST: body 中没有 Encrypt 字段");
				return;
			}

			// 遍历运行中的 bot 找到匹配的（先按 ToUserName / corpId 筛选）
			const { getAllUserNames } = await import("../../../../../yonban/core/functions/security/auth.mjs");

			for (const username of getAllUserNames()) {
				for (const botname of getRunningBotList(username)) {
					const config = getBotConfig(username, botname);
					if (!config.token || !config.encodingAESKey || !config.corpId) continue;
					// 如果 ToUserName 存在则先比对 corpId
					if (toUser && toUser !== config.corpId) continue;

					try {
						// 验证签名
						if (!verifySignature(config.token, timestamp, nonce, encryptText, msg_signature))
							continue;
						// 解密消息
						const plainXml = decryptMessage(config.encodingAESKey, encryptText);
						diag.debug(`webhook POST: bot="${botname}" 解密成功, 长度=${plainXml.length}`);

						// 解析明文 XML
						const msg = extractWecomMessage(plainXml);
						diag.log(`webhook POST: MsgType="${msg.MsgType}", FromUser="${msg.FromUserName}", agentId="${msg.AgentID}"`);

						// agentId 二次验证
						if (config.agentId && String(msg.AgentID) !== String(config.agentId)) {
							diag.debug(`webhook POST: agentId 不匹配 (期望 ${config.agentId}, 实际 ${msg.AgentID})，跳过`);
							continue;
						}

						// 分发给接口处理
						const iface = getBotWecomInterface(username, botname);
						if (iface?.handleMessage) {
							await iface.handleMessage(msg, config);
						} else {
							diag.warn(`webhook POST: bot="${botname}" 接口无 handleMessage 方法`);
						}
						break;
					} catch (e) {
						diag.warn(`webhook POST: bot="${botname}" 处理失败: ${e.message}`);
					}
				}
			}
		} catch (error) {
			diag.error("webhook POST 处理异常", error);
		}
	});
}
