import info from './info.json' with { type: 'json' };
import { wbT, wbD } from "../../../../server/wbStub.mjs";

// ============================================================
// 环形缓冲区
// ============================================================

const LOG_BUFFER_SIZE = 500;

/** @type {Array<{time: string, level: string, message: string}>} */
const logBuffer = [];

/** 启动时间 */
const startTime = new Date().toISOString();

/** 日志计数器 */
let logCounts = { error: 0, warn: 0 };

// ============================================================
// console 拦截
// ============================================================

const originalError = console.error;
const originalWarn = console.warn;

/** 是否已拦截 */
let intercepted = false;

/**
 * 将参数序列化为可读字符串
 * @param {any[]} args
 * @returns {string}
 */
function serializeArgs(args) {
	return args.map(a => {
		if (a instanceof Error) return a.stack || a.message;
		if (typeof a === 'object' && a !== null) {
			try { return JSON.stringify(a, null, 2); } catch { return String(a); }
		}
		return String(a);
	}).join(' ');
}

/**
 * 向缓冲区推入日志条目
 * @param {'error'|'warn'} level
 * @param {any[]} args
 */
function pushLog(level, args) {
	const entry = {
		time: new Date().toISOString(),
		level,
		message: serializeArgs(args),
	};
	logBuffer.push(entry);
	if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
	logCounts[level]++;
}

/**
 * 开始拦截 console.error / console.warn
 *
 * 注意：console.error/warn 可能已被 monitor.mjs、diagLogger.mjs 等模块
 * 链式覆写。为避免 stopIntercept 恢复快照时把其他模块的 hook 一并剥离，
 * 这里只安装一次 wrapper，wrapper 内部根据 intercepted 标志决定是否
 * 写入 beilu-logger 缓冲区。stopIntercept 仅翻转标志，不还原 console。
 */
function startIntercept() {
	if (intercepted) return;
	intercepted = true;

	// 只在首次安装 wrapper（_hooked 标志保证幂等）
	if (!startIntercept._hooked) {
		startIntercept._hooked = true;

		const prevError = console.error;
		const prevWarn = console.warn;

		console.error = (...args) => {
			if (intercepted) pushLog('error', args);
			prevError.apply(console, args);
		};
		console.warn = (...args) => {
			if (intercepted) pushLog('warn', args);
			prevWarn.apply(console, args);
		};
	}
}

/**
 * 停止拦截——仅关闭缓冲写入，不还原 console.error/warn。
 *
 * 原实现会 console.error = originalError，把 monitor/diagLogger
 * 的 hook 也一并还原掉（三层叠加问题 F-24）。改为只翻转标志，
 * wrapper 仍在链上但变为纯透传，不影响其他模块的拦截链。
 */
function stopIntercept() {
	if (!intercepted) return;
	intercepted = false;
}

// ============================================================
// beilu-logger 插件
// ============================================================

/**
 * beilu-logger — 服务器日志收集与可视化
 *
 * 职责：
 * - Load 时劫持全局 console.error / console.warn
 * - 拦截的日志写入内存环形缓冲区（最近 500 条）
 * - 提供 HTTP API 给前端查询日志
 * - 原始 console 输出不受影响（仍然输出到终端）
 */
export default {
	info,

	Load: async ({ router }) => {
		wbT(null, 'logger:load', 'load_enter', { bufferSize: LOG_BUFFER_SIZE });
		// 开始拦截
		startIntercept();
		wbT(null, 'logger:load', 'intercept_started', { intercepted });
		originalWarn.call(console, '[beilu-logger] 日志拦截已启动，缓冲区上限:', LOG_BUFFER_SIZE);

		// ---- HTTP API ----

		/**
		 * GET /api/parts/plugins:beilu-logger/logs
		 *
		 * 查询参数：
		 *   since  - ISO 时间戳，只返回该时间之后的日志（可选）
		 *   level  - 过滤级别：error | warn | all（默认 all）
		 *   limit  - 最大返回条数（默认 200）
		 *
		 * 返回：
		 *   { logs: [...], total: N, counts: { error, warn }, startTime }
		 */
		router.get('/api/parts/plugins\\:beilu-logger/logs', (req, res) => {
			wbT(null, 'logger:logs', 'read_enter', { since: req.query.since || null, level: req.query.level || 'all' });
			try {
				const since = req.query.since || null;
				const level = req.query.level || 'all';
				const limit = Math.min(parseInt(req.query.limit) || 200, LOG_BUFFER_SIZE);

				let filtered = logBuffer;

				// 时间过滤
				if (since) {
					filtered = filtered.filter(entry => entry.time > since);
				}

				// 级别过滤
				if (level !== 'all') {
					filtered = filtered.filter(entry => entry.level === level);
				}

				// 限制数量（取最新的）
				if (filtered.length > limit) {
					filtered = filtered.slice(-limit);
				}

				res.json({
					logs: filtered,
					total: logBuffer.length,
					counts: { ...logCounts },
					startTime,
					bufferSize: LOG_BUFFER_SIZE,
				});
			} catch (err) {
				wbD(null, 'logger:logs', 'read_failed', false, '日志查询 API 异常', { error: err && err.message });
				originalError.call(console, '[beilu-logger] API error:', err);
				res.status(500).json({ error: err.message });
			}
		});

		/**
		 * POST /api/parts/plugins:beilu-logger/clear
		 *
		 * 清空日志缓冲区
		 */
		router.post('/api/parts/plugins\\:beilu-logger/clear', (req, res) => {
			wbT(null, 'logger:clear', 'clear_enter', { before: logBuffer.length });
			logBuffer.length = 0;
			logCounts = { error: 0, warn: 0 };
			originalWarn.call(console, '[beilu-logger] 日志缓冲区已清空');
			res.json({ success: true });
		});
	},

	Unload: async () => {
		wbT(null, 'logger:unload', 'unload_enter', { intercepted });
		stopIntercept();
		originalWarn.call(console, '[beilu-logger] 日志拦截已停止');
	},

	interfaces: {
		config: {
			GetData: async () => ({
				total: logBuffer.length,
				counts: { ...logCounts },
				startTime,
				bufferSize: LOG_BUFFER_SIZE,
				intercepted,
			}),
			SetData: async (data) => {
				if (!data) return;
				if (data._action === 'clear') {
					logBuffer.length = 0;
					logCounts = { error: 0, warn: 0 };
				}
			},
		},
	},
};