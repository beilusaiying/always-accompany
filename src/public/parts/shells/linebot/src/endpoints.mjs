import { randomUUID } from "node:crypto";

import * as botModule from "./bot.mjs";
import { createBotEndpoints } from "../../../../../scripts/botContentShared.mjs";
import { createDiag } from "../../../../../server/diagLogger.mjs";

const diag = createDiag("linebot");

// [0716 P1 件8] 13 标准端点收口 createBotEndpoints——原同构实现纯删；活跃会话端点统一
// /activechannels（原 activechats 与前端拼名不符=恒 404，接口方法/字段已同批归一 discord 系）。
// 特异端点（tempfile / webhook）为 line 平台专属，留本文件原文。
const _std = createBotEndpoints("linebot", {
	botModule,
	getBotInterface: botModule.getBotLineInterface,
});

// ---- 临时文件存储（内存，TTL 5分钟，用于向 LINE 发送文件） ----
const tempFiles = new Map(); // key -> { buffer, mime_type, expires }

/**
 * 将 buffer 存入临时文件 Map，返回可访问的 key。
 * @param {Buffer} buffer
 * @param {string} mime_type
 * @returns {string} key（用于拼接 URL）
 */
export function storeTempFile(buffer, mime_type) {
	const key = randomUUID();
	const expires = Date.now() + 5 * 60 * 1000;
	tempFiles.set(key, { buffer, mime_type, expires });
	setTimeout(() => tempFiles.delete(key), 5 * 60 * 1000);
	return key;
}

/**
 * 为 LINE Bot 功能设置 API 端点。
 * @param {object} router - Express 的路由实例。
 */
export function setEndpoints(router) {
	_std(router);

	// 临时文件下载端点（供 LINE 服务器拉取文件用，TTL 5分钟，无需鉴权）
	router.get(
		"/api/parts/shells\\:linebot/tempfile/:key",
		(req, res) => {
			const file = tempFiles.get(req.params.key);
			if (!file || Date.now() > file.expires) {
				tempFiles.delete(req.params.key);
				return res.status(404).end();
			}
			res.set("Content-Type", file.mime_type);
			res.send(file.buffer);
		},
	);

	/**
	 * LINE Webhook 端点
	 * LINE 服务器会将用户消息 POST 到此路由。
	 * 路由按 botname query 参数分发到对应 bot 的处理器。
	 *
	 * URL: /api/parts/shells:linebot/webhook?user=<username>&bot=<botname>
	 */
	router.post(
		"/api/parts/shells\\:linebot/webhook",
		async (req, res) => {
			const { user: username, bot: botname } = req.query;
			if (!username || !botname) {
				diag.warn("webhook: 缺少 user 或 bot 参数");
				return res.status(400).json({ error: "Missing user or bot params" });
			}

			try {
				// 获取对应 bot 的 client 和 middleware
				const cached = await botModule.getBotClientAndMiddleware(username, botname);
				if (!cached) {
					diag.warn(`webhook: bot="${botname}" user="${username}" 未运行`);
					return res.status(503).json({ error: "Bot not running" });
				}

				const { client, middlewareFn } = cached;

				// 使用 LINE middleware 验证签名
				middlewareFn(req, res, async (err) => {
					if (err) {
						diag.error(`webhook: LINE 签名验证失败, bot="${botname}"`, err);
						return res.status(401).json({ error: "Signature verification failed" });
					}

					// 签名验证通过，将 events 分发给接口处理器
					const lineInterface = botModule.getBotLineInterface(username, botname);
					if (!lineInterface?.HandleWebhookEvents) {
						diag.warn(`webhook: bot="${botname}" 无 HandleWebhookEvents`);
						return res.status(200).json({ message: "ok (no handler)" });
					}

					try {
						const body = req.body;
						const lineEvents = body?.events || [];
						diag.debug(`webhook: bot="${botname}" 收到 ${lineEvents.length} 个事件`);
						await lineInterface.HandleWebhookEvents(lineEvents, client);
						res.status(200).json({ message: "ok" });
					} catch (handlerErr) {
						diag.error(`webhook: bot="${botname}" 事件处理出错`, handlerErr);
						res.status(500).json({ error: handlerErr.message });
					}
				});
			} catch (error) {
				diag.error(`webhook: bot="${botname}" 处理失败`, error);
				res.status(500).json({ error: error.message });
			}
		},
	);
}
