/**
 * [defaults.mjs] — 前端数值/布尔缺省集中表（单一权威源）
 *
 * 功能链：消费方 import { DEFAULTS } → 读取缺省值 → 行为（请求超时 abort / 环形缓冲上限 / 通知条数）。
 *
 * why：数值缺省散落各文件（api-client 30000 / diagLogger 500·200 / crossModeNotification 3·20·24h），
 *   调优要逐文件找。收口为一处冻结对象；行为等价——每个值都是 2026-07-02 grep 实测的现值原样搬入。
 *   边界（设计⑤§5.3）：localStorage key 名不并入（职能不同，归 storage-keys.mjs）；
 *   语义不同的同数值不合并（websocket.mjs 重连退避上限 30000 ≠ 请求超时 30000，各留原地）。
 *
 * 现值锚点（真实 file:line，切换前）：
 *   request.timeoutMs      ← shared/transport/api-client.mjs:32 DEFAULT_TIMEOUT_MS=30000
 *   diag.maxLogs           ← shared/state/diagLogger.mjs:142 MAX_LOGS=500
 *   diag.maxSnapshots      ← shared/state/diagLogger.mjs:136 MAX_SNAPSHOTS=200
 *   notify.maxVisible      ← shared/widgets/crossModeNotification.mjs:38 MAX_VISIBLE=3
 *   notify.historyMax      ← shared/widgets/crossModeNotification.mjs:43 HISTORY_MAX=20
 *   notify.historyMaxAgeMs ← shared/widgets/crossModeNotification.mjs:44 24*60*60*1000
 *   notify.popupDurationMs ← shared/widgets/crossModeNotification.mjs 原 10000ms 定时器
 *
 * 影响范围：改这里 = 改全前端对应行为（超时挂起时间/日志内存占用/通知堆叠）。
 */

export const DEFAULTS = Object.freeze({
	request: Object.freeze({
		/** /api/* 请求超时（ms），超时 abort 防半死连接永挂 */
		timeoutMs: 30000,
	}),
	diag: Object.freeze({
		/** diagLogger 环形日志缓冲上限（条） */
		maxLogs: 500,
		/** diagLogger 状态快照上限（条） */
		maxSnapshots: 200,
	}),
	notify: Object.freeze({
		/** 跨模式通知同屏最多堆叠条数 */
		maxVisible: 3,
		/** 通知历史保留条数 */
		historyMax: 20,
		/** 通知历史保留时长（ms） */
		historyMaxAgeMs: 24 * 60 * 60 * 1000,
		/** 页内通知自动消失时间（ms，0=不自动消失） */
		popupDurationMs: 10000,
		/** 图标角标提醒缺省开（🔔 通知中心可关；消费=crossModeNotification.getNotifyPrefs） */
		badges: true,
		/** 页内弹窗通知缺省开 */
		popup: true,
		/** 桌面 OS 通知缺省开（键=beilu-browser-notify，与 pages/scripts/desktopNotify.mjs 同源） */
		desktop: true,
	}),
	cleanup: Object.freeze({
		/** IDE 清理模式缺省（前端自身运行参数，非后端下发）；T6：收口 settings.mjs:526 / layout.mjs:316 双 `|| "auto"` 副本 */
		mode: "auto",
	}),
	messages: Object.freeze({
		/** 初始加载最后 N 条消息（0=全部）。P2一致性审计①：收口 backup.mjs:70 / settingsSlots.mjs:576 / virtualQueue.mjs:315 三份 "100" 副本 */
		loadLimit: 100,
	}),
	token: Object.freeze({
		/**
		 * Token 条定时刷新间隔（秒）。**只是缺省值**——频率由用户在 ⚙️Token设置 里定
		 * （凛倾 0727「用户可以自己调节刷新时间,比如性能好1秒刷新一次都没啥大问题」），
		 * 存 localStorage BEILU_TOKEN_POLL_SEC。0=关闭定时、只保留事件驱动刷新。
		 * 缺省 10s 而非更快：一次刷新=后端要跑完整提示词组装（全插件 GetPrompt+TweakPrompt×3+逐条计数），
		 * 对弱机保守；机器好的用户自己调低即可。
		 */
		pollSec: 10,
		/** 允许的调节范围（秒）：下限 1（凛倾原话）、上限 120；0 单独表示关闭 */
		pollMin: 1,
		pollMax: 120,
	}),
	iframe: Object.freeze({
		/**
		 * iframe sandbox 缺省档（standard/strict/sandbox）。
		 * 0719 收口：settings.mjs 与 iframeRenderer.mjs 各写一份 "standard" 字面量（双源，
		 * 且 settings 侧注释仍称默认 strict=腐烂）。值本身是 0719 角色卡渲染修复 session 拍的
		 * standard（strict 的 opaque origin 曾致高度/音频链全断）；档位→sandbox 属性映射在
		 * iframeRenderer._sandboxMap（消费侧渲染语义，非缺省值，不进此表）。
		 */
		sandboxLevel: "standard",
	}),
	runtimeParams: Object.freeze({
		/**
		 * 提示词后处理模式缺省，无本地值时前端全局入口回退用。
		 * T15-1：收口 featureControls.mjs:432 的 `|| "none"` 字面量副本，与后端真默认单点对齐——
		 *   后端 RUNTIME_PARAMS_DEFAULTS.prompt_post_processing="none"（preset/main.mjs:489）。
		 * 边界：subModePanel 克隆分身表单的 selectedValue="strict" 是分身表单独立产品默认
		 *   （分身必设一值，非"回退全局默认"），语义不同不并入此源（见 defaults 头注释语义不合并原则）。
		 */
		postProcessing: "none",
	}),
});
