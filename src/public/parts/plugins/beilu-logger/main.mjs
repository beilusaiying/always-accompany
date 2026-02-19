import info from './info.json' with { type: 'json' };

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
 */
function startIntercept() {
	if (intercepted) return;
	intercepted = true;

	console.error = (...args) => {
		pushLog('error', args);
		originalError.apply(console, args);
	};
	console.warn = (...args) => {
		pushLog('warn', args);
		originalWarn.apply(console, args);
	};
}

/**
 * 恢复原始 console
 */
function stopIntercept() {
	if (!intercepted) return;
	intercepted = false;
	console.error = originalError;
	console.warn = originalWarn;
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
		// 开始拦截
		startIntercept();
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
			logBuffer.length = 0;
			logCounts = { error: 0, warn: 0 };
			originalWarn.call(console, '[beilu-logger] 日志缓冲区已清空');
			res.json({ success: true });
		});
	},

	Unload: async () => {
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