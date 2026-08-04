/**
 * functions/rollback/index.mjs — 回档/回收站系统节点 facade（T3a·3.10 已入住）
 *
 * 【功能链】
 *   写前快照链：AI 要改文件/表格 → backupBeforeWrite（fileHistory）/ createTableSnapshot（环形≤50）
 *   / createSnapshot（记忆全量原子 swap）→ 执行写 → 用户点回档 → restore* 从快照恢复。
 *   删除链：safeTrash 回收站优先 + 聊天快照（凛倾 06-25：「删除必须优先以hide为主…可以手动回档」）。
 *   dispatch({target:"functions:rollback", verb:"snapshot|restore|listSnapshots|tableSnapshot|
 *   restoreTable|backupFile|revertFile|diffFile|trash", payload}) → 本组各实现。
 *   旧线路：memory setDataActions/tableEngine、beilu-files main、chat chatOps/endpoints 经各旧位薄壳到达。
 *
 * 【why】
 *   五文件三处来源（memory storage_mod ×2 / beilu-files lib / beilu-chat lib ×2）= 同一"回档"职能
 *   散点归位（3_功能层 组11）。储存契约（renameSyncWithRetry 原子写/环形上限）实现内一字未改。
 *   **YonBan 侧**（remote 传输另一侧，contributes 标注不迁）：YonBan/src/services/FileCheckpoint.ts +
 *   YonBan/src/tools/checkpoint-tools.ts——IDE 内 AI 改文件前快照/回档/diff，与本组 fileHistory 同功能
 *   跨库两侧；物理在 YonBan 插件库（TS），逻辑归属本组。
 *   snapshotCache keyed user/char（per-scope 已隔离，不动）。
 *
 * 【影响范围】
 *   写 data/ 下快照/回收站/文件历史（与旧线路同一实现同一路径）。
 */
import { createSnapshot, listSnapshots, restoreSnapshot } from "./snapshot.mjs";
import {
	createTableSnapshot,
	listTableSnapshots,
	restoreTableSnapshot,
} from "./tableSnapshot.mjs";
import { backupBeforeWrite, diffVersions, getFileVersions, revertToVersion } from "./fileHistory.mjs";
import { safeTrash } from "./safeDelete.mjs";
import { register } from "../../dispatch/registry.mjs";

register("functions:rollback", {
	transport: "local",
	contributes: {
		// remote 侧同功能标注（物理在 YonBan 库不迁）：FileCheckpoint.ts / checkpoint-tools.ts
		remoteCounterpart: ["YonBan/src/services/FileCheckpoint.ts", "YonBan/src/tools/checkpoint-tools.ts"],
	},
	handlers: {
		// 换算面（中间站桥身份收口）：context.user 存在=服务端已盖章（桥强制②），为身份唯一权威，覆盖 payload 自报。
		// 主链 scope={chatId,mode} 无 user → context.user 恒 undefined=恒空操作，零漂移。trash 无身份字段不换算。
		async snapshot(payload, context) {
			return { ok: true, data: createSnapshot(payload?.projectRoot, context?.user ?? payload?.username, payload?.charName, payload?.memoryDir, payload?.label) };
		},
		async listSnapshots(payload, context) {
			return { ok: true, data: listSnapshots(payload?.projectRoot, context?.user ?? payload?.username, payload?.charName) };
		},
		async restore(payload, context) {
			return { ok: true, data: restoreSnapshot(payload?.projectRoot, context?.user ?? payload?.username, payload?.charName, payload?.snapshotId, payload?.memoryDir) };
		},
		async tableSnapshot(payload, context) {
			const meta = payload?.meta && typeof payload.meta === "object" ? payload.meta : {};
			const data = createTableSnapshot(
				context?.user ?? payload?.username,
				payload?.charName,
				payload?.tableData,
				payload?.chatId ?? meta.chatId,
				payload?.messageIndex ?? meta.messageIndex ?? -1,
				payload?.reason ?? meta.reason ?? "tableEdit前自动快照",
				payload?.mode ?? meta.mode ?? "",
				payload?.messageId ?? meta.messageId ?? "",
			);
			return { ok: data?.success === true, data, ...(data?.success === true ? {} : { error: data?.error || "表格快照创建失败" }) };
		},
		async listTableSnapshots(payload, context) {
			return { ok: true, data: listTableSnapshots(context?.user ?? payload?.username, payload?.charName) };
		},
		async restoreTable(payload, context) {
			const meta = payload?.meta && typeof payload.meta === "object" ? payload.meta : {};
			const expectedScope = payload?.expectedScope && typeof payload.expectedScope === "object"
				? payload.expectedScope
				: {
					chatId: payload?.chatId ?? meta.chatId,
					...(payload?.messageIndex !== undefined || meta.messageIndex !== undefined
						? { messageIndex: payload?.messageIndex ?? meta.messageIndex }
						: {}),
					...(payload?.messageId || meta.messageId ? { messageId: payload?.messageId ?? meta.messageId } : {}),
				};
			const data = restoreTableSnapshot(
				context?.user ?? payload?.username,
				payload?.charName,
				payload?.snapshotId,
				expectedScope,
			);
			return { ok: data?.success === true, data, ...(data?.success === true ? {} : { error: data?.error || "表格快照恢复失败" }) };
		},
		async backupFile(payload, context) {
			return { ok: true, data: backupBeforeWrite(context?.user ?? payload?.username, payload?.absPath, payload?.meta ?? {}) };
		},
		async fileVersions(payload, context) {
			return { ok: true, data: getFileVersions(context?.user ?? payload?.username, payload?.absPath, payload?.chatid ?? "") };
		},
		async revertFile(payload, context) {
			return { ok: true, data: revertToVersion(context?.user ?? payload?.username, payload?.absPath, payload?.timestamp, payload?.chatid ?? "") };
		},
		async diffFile(payload, context) {
			return { ok: true, data: diffVersions(context?.user ?? payload?.username, payload?.absPath, payload?.ts1, payload?.ts2, payload?.chatid ?? "") };
		},
		async trash(payload, _context) {
			return { ok: true, data: await safeTrash(payload?.targetPath, payload?.label ?? "") };
		},
	},
});
