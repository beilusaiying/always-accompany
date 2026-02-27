/**
 * 全局对象管理
 *
 * 实现 initializeGlobal / waitGlobalInitialized
 * 用于 MVU 注册和等待机制
 * 从 polyfills.mjs generateGlobalManagerScript 拆出
 */

export function generateGlobalManagerScript() {
	return `
/* === ST Compat: Global Object Manager === */
(function() {
	if (!window.parent.__beiluGlobals) window.parent.__beiluGlobals = {};
	var globals = window.parent.__beiluGlobals;

	window.initializeGlobal = function(name, value) {
		globals[name] = value;
		window[name] = value;
		if (typeof window.eventEmit === 'function') {
			window.eventEmit('global_' + name + '_initialized');
		}
	};

	window.waitGlobalInitialized = function(name) {
		if (globals[name] !== undefined) {
			window[name] = globals[name];
			return Promise.resolve(globals[name]);
		}
		return new Promise(function(resolve) {
			if (typeof window.eventOn === 'function') {
				window.eventOnce('global_' + name + '_initialized', function() {
					window[name] = globals[name];
					resolve(globals[name]);
				});
			} else {
				/* Fallback: polling */
				var timer = setInterval(function() {
					if (globals[name] !== undefined) {
						clearInterval(timer);
						window[name] = globals[name];
						resolve(globals[name]);
					}
				}, 100);
				setTimeout(function() { clearInterval(timer); resolve(undefined); }, 30000);
			}
		});
	};
})();
`
}