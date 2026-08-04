/**
 * events.mjs — 极简进程内事件发射器（闭包 Map 实现）。不管跨进程/持久化（那是 IPC/磁盘层的事）。
 *
 * 链路：全项目 → events.on() / events.emit() / events.emitStrict() → 注册的监听器
 * 影响：无磁盘/广播副作用，纯内存回调分发
 * 相交：← auth.mjs(AfterUserDeleted/AfterUserRenamed/BeforeUserDeleted)
 *         / parts_loader.mjs(part-loaded/part-installed/part-uninstalled)
 *         / event_dispatcher.mjs(send-event-to-user)
 *       → 各监听方：parts_router.mjs(AfterUserDeleted 清路由) / parts_loader.mjs(AfterUserDeleted 卸载+清缓存)
 *
 * 重要行为：emit / emitStrict 都是 await 串行的（非并行），单个监听器阻塞会延迟后续监听器。
 *   每个监听器独立 try/catch 隔离——单个抛错只 console.error 记录，不中断后续监听器执行。
 *   需要把监听器失败作为业务前置门的调用方必须使用 emitStrict；它仍执行全部监听器，
 *   但在末尾以 AggregateError 向调用方传播失败，便于调用方统一触发补偿事件。
 */

/** @type {Object<string, Function[]>} 事件名→监听器数组的内部存储 */
const data = {}

/**
 * 进程内事件发射器单例。
 * @type {{on: Function, emit: Function, emitStrict: Function, off: Function}}
 */
export const events = {
	/**
	 * 为给定的事件名称注册一个事件监听器。
	 * @param {string} eventName - 要监听的事件的名称。
	 * @param {Function} listener - 事件触发时执行的回调函数。
	 * @returns {void}
	 */
	on(eventName, listener) {
		data[eventName] ??= []
		data[eventName].push(listener)
	},
	/**
	 * 使用给定的名称和参数触发一个事件。
	 * @param {string} eventName - 要触发的事件的名称。
	 * @param {...*} args - 传递给事件监听器的参数。
	 * @returns {Promise<void>}
	 */
	async emit(eventName, ...args) {
		if (!data[eventName]) return
		// 串行保序，但每个监听器独立隔离：单个监听器抛错只记录、不中断后续监听器
		//   （原 `await listener` 无 try/catch，第 k 个 reject 会吞掉后续全部监听器）。
		//   console.error 由 server/monitor.mjs 的 console 拦截链收进权威错误缓冲。
		for (const listener of data[eventName])
			try {
				await listener(...args)
			} catch (err) {
				console.error(`[events] 监听器 "${eventName}" 抛错，已隔离，不影响其余监听器:`, err)
			}
	},
	/**
	 * 严格触发事件：串行执行当前监听器快照，收集并向调用方传播全部失败。
	 * 适用于删除/迁移等“所有前置条件都成功才允许提交”的事务门。
	 * @param {string} eventName
	 * @param {...*} args
	 * @returns {Promise<void>}
	 */
	async emitStrict(eventName, ...args) {
		const listeners = [...(data[eventName] || [])]
		const errors = []
		for (const listener of listeners)
			try {
				await listener(...args)
			} catch (err) {
				errors.push(err instanceof Error ? err : new Error(String(err)))
			}
		if (errors.length > 0)
			throw new AggregateError(errors, `Strict event "${eventName}" failed in ${errors.length} listener(s)`)
	},
	/**
	 * 为给定的事件名称移除一个事件监听器。
	 * @param {string} eventName - 要从中移除监听器的事件的名称。
	 * @param {Function} listenerToRemove - 要移除的监听器函数。
	 * @returns {void}
	 */
	off(eventName, listenerToRemove) {
		if (!data[eventName]) return
		data[eventName] = data[eventName].filter(listener => listener !== listenerToRemove)
	}
}
