/**
 * functions/notification/index.mjs — 通知/调度系统节点 facade（T3a·3.9 已入住）
 *
 * 【功能链】
 *   dispatch({target:"functions:notification", verb:"addJob|removeJob|toggleJob|listJobs|getDueJobs|notify", payload})
 *   → ./scheduler.mjs（定时任务自适应 tick；到期任务经 dispatch → bus:activate 出口节点产生新激活线——
 *     07-02 搭线：scheduler._busActivate 走计算图的边，不再直连 dispatchActivation 旧位）
 *   → src/scripts/notify.mjs notify（跨平台桌面通知，降级 console；shared 原语复用不迁）。
 *   旧线路：memory getPromptHandler(getDueJobsText 到期提醒注入)/replyHandler(parseScheduleTaskTag
 *   AI 自动建任务)/setDataActions(CRUD)/generation(runCodeRoundTriggers) 经旧位薄壳到达同一实现。
 *
 * 【why】
 *   调度唤醒 = 通知组职能（3_功能层 §三迁出表：scheduler 从 beilu-memory 迁出）。
 *   dispatchActivation.mjs 不属本组（归 dispatch 层，T1 bus:activate 已包装）——未动。
 *   notify.mjs 留 shared/scripts（被非本组消费方共用），本 facade import 引用（对照表 L 型复用）。
 *   _schedulerState keyed user/char（per-scope 已隔离，不动）。
 *
 * 【影响范围】
 *   scheduler 写 memoryDir 下任务 JSON（与旧线路同一实现）；notify 起系统通知进程。
 */
import { notify } from "../../../../scripts/notify.mjs";
import {
	addJob,
	getDueJobsText,
	getJobsSummary,
	listJobs,
	removeJob,
	toggleJob,
	updateJob,
} from "./scheduler.mjs";
import { register } from "../../dispatch/registry.mjs";

register("functions:notification", {
	transport: "local",
	handlers: {
		// 换算面（中间站桥身份收口）：context.user 存在=服务端已盖章（桥强制②），为身份唯一权威，覆盖 payload 自报。
		// 主链 scope={chatId,mode} 无 user → context.user 恒 undefined=恒空操作，零漂移。notify 无身份字段不换算。
		async addJob(payload, context) {
			return { ok: true, data: addJob(context?.user ?? payload?.username, payload?.charName, payload?.jobDef) };
		},
		async removeJob(payload, context) {
			return { ok: true, data: removeJob(context?.user ?? payload?.username, payload?.charName, payload?.jobId) };
		},
		async updateJob(payload, context) {
			return { ok: true, data: updateJob(context?.user ?? payload?.username, payload?.charName, payload?.jobId, payload?.updates) };
		},
		async toggleJob(payload, context) {
			return { ok: true, data: toggleJob(context?.user ?? payload?.username, payload?.charName, payload?.jobId, payload?.enabled) };
		},
		async listJobs(payload, context) {
			return { ok: true, data: listJobs(context?.user ?? payload?.username, payload?.charName) };
		},
		async getDueJobs(payload, context) {
			return { ok: true, data: getDueJobsText(context?.user ?? payload?.username, payload?.charName) };
		},
		async getJobsSummary(payload, context) {
			return { ok: true, data: getJobsSummary(context?.user ?? payload?.username, payload?.charName) };
		},
		async notify(payload, _context) {
			return { ok: true, data: await notify(payload?.title, payload?.message, payload?.options ?? {}) };
		},
	},
});
