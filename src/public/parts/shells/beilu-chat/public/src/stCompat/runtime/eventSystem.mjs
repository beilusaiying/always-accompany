/**
 * 事件系统 shim
 *
 * 实现 eventOn / eventOnce / eventMakeLast / eventMakeFirst /
 * eventEmit / eventEmitAndWait / eventRemoveListener /
 * eventClearEvent / eventClearListener / eventClearAll
 *
 * 所有事件注册到父页面的 __beiluEventBus 上，
 * iframe 销毁时自动清理本 iframe 注册的监听器。
 *
 * 从 polyfills.mjs 拆出，代码保持不变。
 */

/**
 * @returns {string} 内联注入到 iframe 的 JavaScript 代码
 */
export function generateEventSystemScript() {
	return `
/* === ST Compat: Event System === */
(function() {
	var _bus = window.parent.__beiluEventBus;
	if (!_bus) {
		_bus = { _listeners: new Map() };
		window.parent.__beiluEventBus = _bus;
	}
	var _myListeners = [];

	function _getArr(type) {
		if (!_bus._listeners.has(type)) _bus._listeners.set(type, []);
		return _bus._listeners.get(type);
	}

	window.eventOn = function(type, listener) {
		var arr = _getArr(type);
		if (arr.indexOf(listener) !== -1) return { stop: function(){} };
		arr.push(listener);
		_myListeners.push({ type: type, listener: listener });
		return { stop: function() { window.eventRemoveListener(type, listener); } };
	};

	window.eventOnce = function(type, listener) {
		var wrapper = function() {
			window.eventRemoveListener(type, wrapper);
			listener.apply(this, arguments);
		};
		wrapper._original = listener;
		return window.eventOn(type, wrapper);
	};

	window.eventMakeLast = function(type, listener) {
		window.eventRemoveListener(type, listener);
		var arr = _getArr(type);
		arr.push(listener);
		_myListeners.push({ type: type, listener: listener });
		return { stop: function() { window.eventRemoveListener(type, listener); } };
	};

	window.eventMakeFirst = function(type, listener) {
		window.eventRemoveListener(type, listener);
		var arr = _getArr(type);
		arr.unshift(listener);
		_myListeners.push({ type: type, listener: listener });
		return { stop: function() { window.eventRemoveListener(type, listener); } };
	};

	window.eventEmit = async function(type) {
		var args = Array.prototype.slice.call(arguments, 1);
		var arr = _getArr(type);
		var copy = arr.slice();
		for (var i = 0; i < copy.length; i++) {
			try { await copy[i].apply(null, args); } catch(e) { console.error('[eventEmit]', type, e); }
		}
	};

	window.eventEmitAndWait = function(type) {
		var args = Array.prototype.slice.call(arguments, 1);
		var arr = _getArr(type);
		var copy = arr.slice();
		for (var i = 0; i < copy.length; i++) {
			try { copy[i].apply(null, args); } catch(e) { console.error('[eventEmitAndWait]', type, e); }
		}
	};

	window.eventRemoveListener = function(type, listener) {
		var arr = _bus._listeners.get(type);
		if (!arr) return;
		var idx = arr.indexOf(listener);
		if (idx !== -1) arr.splice(idx, 1);
		/* Also remove from _myListeners tracking */
		for (var i = _myListeners.length - 1; i >= 0; i--) {
			if (_myListeners[i].type === type && _myListeners[i].listener === listener) {
				_myListeners.splice(i, 1);
				break;
			}
		}
	};

	window.eventClearEvent = function(type) {
		_bus._listeners.delete(type);
		/* Remove from _myListeners too */
		for (var i = _myListeners.length - 1; i >= 0; i--) {
			if (_myListeners[i].type === type) _myListeners.splice(i, 1);
		}
	};

	window.eventClearListener = function(listener) {
		_bus._listeners.forEach(function(arr, type) {
			var idx = arr.indexOf(listener);
			if (idx !== -1) arr.splice(idx, 1);
		});
		for (var i = _myListeners.length - 1; i >= 0; i--) {
			if (_myListeners[i].listener === listener) _myListeners.splice(i, 1);
		}
	};

	window.eventClearAll = function() {
		for (var i = 0; i < _myListeners.length; i++) {
			var entry = _myListeners[i];
			var arr = _bus._listeners.get(entry.type);
			if (arr) {
				var idx = arr.indexOf(entry.listener);
				if (idx !== -1) arr.splice(idx, 1);
			}
		}
		_myListeners.length = 0;
	};

	/* iframe 销毁时自动清理 */
	window.addEventListener('pagehide', function() { window.eventClearAll(); });
	window.addEventListener('beforeunload', function() { window.eventClearAll(); });
})();
`
}