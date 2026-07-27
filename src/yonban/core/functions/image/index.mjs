/**
 * functions/image/index.mjs — 图片系统节点 facade（T3a·3.2 已入住：实现体在本组）
 *
 * 【功能链】
 *   dispatch({target:"functions:image", verb:"detectMime|resolveBuffer|getMime|pickLastUserImages|process", payload})
 *   → ./imageInjection.mjs（magic-bytes MIME 检测 / file:hash 三态 deref / 最后一条 user 图提取）
 *   → ./imageProcessing.mjs processImageFiles（MIME 修正 + >5MB 压缩，sharp→Pillow 降级链）
 *   → { ok, data }。
 *   旧线路：6 个 provider 经旧位薄壳（serviceGenerators/AI/_shared/imageInjection.mjs）、
 *   shell endpoints/httpFetch/groupReplyRunner 经旧位薄壳（shells/beilu-chat/src/imageProcessing.mjs）
 *   到达同一实现，行为等价；T8 消费方切净后删壳。
 *
 * 【why】
 *   凛倾迁移范式：迁文件 + index.mjs facade + 旧位 re-export。组8：纯函数、被 api 组/chat 传导调、
 *   无 chat 钩子。迁移唯一逻辑适配 = imageInjection._dataRoot 回溯级数 6→5（新位到仓库 data/ 的
 *   层级变化，已 deno eval 实测 5 级命中 data/users、6 级越界）。
 *
 * 【影响范围】
 *   resolveBuffer/pickLastUserImages 读 data/users/<u>/shells/chat/files/<hash>（只读）；
 *   process 走 sharp/Pillow 压缩（与旧线路同一实现）。
 */
import {
	detectImageMime,
	getImageMime,
	pickLastUserImages,
	resolveImageBuffer,
} from "./imageInjection.mjs";
import { processImageFiles } from "./imageProcessing.mjs";
import { register } from "../../dispatch/registry.mjs";

register("functions:image", {
	transport: "local",
	handlers: {
		async detectMime(payload, _context) {
			return { ok: true, data: detectImageMime(payload?.buf) };
		},
		// 换算面（中间站桥身份收口）：context.user 存在=服务端已盖章（桥强制②），为身份唯一权威，覆盖 payload 自报。
		// 主链 scope={chatId,mode} 无 user → context.user 恒 undefined=恒空操作，零漂移。
		async resolveBuffer(payload, context) {
			return { ok: true, data: resolveImageBuffer(payload?.file, context?.user ?? payload?.username) };
		},
		async getMime(payload, _context) {
			return { ok: true, data: getImageMime(payload?.file) };
		},
		async pickLastUserImages(payload, _context) {
			return { ok: true, data: pickLastUserImages(payload?.messages ?? []) };
		},
		async process(payload, _context) {
			return { ok: true, data: await processImageFiles(payload?.files ?? []) };
		},
	},
});
