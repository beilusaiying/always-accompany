/**
 * MVU Polyfill
 *
 * 实现 window.Mvu 对象：events / getMvuData / replaceMvuData /
 * parseMessage / isDuringExtraAnalysis
 * 从 polyfills.mjs generateMVUPolyfillScript 拆出
 */

export function generateMVUPolyfillScript() {
	return `
/* === ST Compat: MVU Polyfill === */
(function() {
	/* Note: 'initiailized' typo is intentional — matches MVU source */
	var MVU_EVENTS = {
		VARIABLE_INITIALIZED: 'mag_variable_initiailized',
		VARIABLE_UPDATE_STARTED: 'mag_variable_update_started',
		COMMAND_PARSED: 'mag_command_parsed',
		VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended',
		BEFORE_MESSAGE_UPDATE: 'mag_before_message_update'
	};

	window.Mvu = {
		events: MVU_EVENTS,

		getMvuData: function(options) {
			var vars = window.getVariables ? window.getVariables(options || { type: 'chat' }) : {};
			/* Ensure MvuData shape */
			if (!vars.stat_data) vars.stat_data = {};
			if (!vars.initialized_lorebooks) vars.initialized_lorebooks = {};
			return vars;
		},

		replaceMvuData: function(mvu_data, options) {
			if (window.replaceVariables) {
				window.replaceVariables(mvu_data, options || { type: 'chat' });
			}
			return Promise.resolve();
		},

		parseMessage: function(message, old_data) {
			return new Promise(function(resolve) {
				if (!message || typeof message !== 'string') {
					resolve(old_data || { stat_data: {}, initialized_lorebooks: {} });
					return;
				}

				var new_data;
				try {
					new_data = typeof _ !== 'undefined' && _.cloneDeep
						? _.cloneDeep(old_data || {})
						: JSON.parse(JSON.stringify(old_data || {}));
				} catch(e) {
					new_data = { stat_data: {}, initialized_lorebooks: {} };
				}

				if (!new_data.stat_data) new_data.stat_data = {};

				/* Parse Beta MVU: _.set('path', value) commands */
				var setRegex = /_.set\\s*\\(\\s*['\"]([^'\"]+)['\"]\\s*,\\s*([\\s\\S]+?)\\s*\\)/g;
				var match;
				while ((match = setRegex.exec(message)) !== null) {
					try {
						var path = match[1];
						var valStr = match[2].trim();
						var value;
						try { value = JSON.parse(valStr); }
						catch(e2) {
							value = valStr.replace(/^['\"]|['\"]$/g, '');
						}
						if (typeof _ !== 'undefined' && _.set) {
							_.set(new_data, 'stat_data.' + path, value);
						}
					} catch(e) { /* skip invalid command */ }
				}

				/* Parse Zod MVU: <JSONPatch>[...]</JSONPatch> */
				var patchRegex = /<JSONPatch>\\s*([\\s\\S]*?)\\s*<\\/JSONPatch>/g;
				var patchMatch;
				while ((patchMatch = patchRegex.exec(message)) !== null) {
					try {
						var patches = JSON.parse(patchMatch[1]);
						if (Array.isArray(patches)) {
							patches.forEach(function(p) {
								try {
									if (!p.path) return;
									var pathParts = p.path.replace(/^\\//, '').split('/');
									if (p.op === 'replace' || p.op === 'add') {
										setNestedValue(new_data.stat_data, pathParts, p.value);
									} else if (p.op === 'remove') {
										removeNestedValue(new_data.stat_data, pathParts);
									}
								} catch(pe) { /* skip invalid patch */ }
							});
						}
					} catch(e) { /* skip invalid JSON */ }
				}

				resolve(new_data);
			});
		},

		isDuringExtraAnalysis: function() { return false; }
	};

	/* JSON Patch helpers (RFC 6902 subset) */
	function setNestedValue(obj, pathParts, value) {
		var current = obj;
		for (var i = 0; i < pathParts.length - 1; i++) {
			var key = pathParts[i];
			if (current[key] === undefined || current[key] === null) {
				current[key] = isNaN(Number(pathParts[i + 1])) ? {} : [];
			}
			current = current[key];
		}
		var lastKey = pathParts[pathParts.length - 1];
		if (Array.isArray(current) && lastKey === '-') {
			current.push(value);
		} else {
			current[lastKey] = value;
		}
	}

	function removeNestedValue(obj, pathParts) {
		var current = obj;
		for (var i = 0; i < pathParts.length - 1; i++) {
			current = current[pathParts[i]];
			if (current === undefined || current === null) return;
		}
		var lastKey = pathParts[pathParts.length - 1];
		if (Array.isArray(current)) {
			var idx = Number(lastKey);
			if (!isNaN(idx)) current.splice(idx, 1);
		} else {
			delete current[lastKey];
		}
	}

	/* Register Mvu as global so waitGlobalInitialized('Mvu') resolves immediately */
	if (window.initializeGlobal) {
		window.initializeGlobal('Mvu', window.Mvu);
	}
})();
`
}