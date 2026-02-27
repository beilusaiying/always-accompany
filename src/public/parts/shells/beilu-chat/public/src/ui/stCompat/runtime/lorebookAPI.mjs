/**
 * 世界书 / Lorebook API shim
 *
 * MVU bundle.js 依赖以下全局函数来读取世界书条目：
 * - getCurrentCharPrimaryLorebook()
 * - getLorebookEntries(lorebookName)
 * - getCharWorldbookNames(type)
 * - getLorebookSettings()
 * - setLorebookSettings(settings)
 *
 * 数据来源：beilu-worldbook 后端 HTTP API
 * 从 polyfills.mjs generateLorebookAPIScript 拆出
 */

export function generateLorebookAPIScript() {
	return `
/* === ST Compat: Lorebook / WorldInfo API (for MVU bundle) === */
(function() {
	var _wbBaseUrl = '/api/parts/plugins:beilu-worldbook';

	/**
	 * 获取当前角色的主世界书名称
	 * 优先通过角色名查后端绑定的世界书（而非角色卡的 extensions.world，因为名称可能不匹配）
	 * @returns {Promise<string|null>} 世界书名称，未找到时返回 null
	 */
	window.getCurrentCharPrimaryLorebook = async function() {
		var st = window.SillyTavern || {};
		var charData = st._charData || (st.getContext && st.getContext().characterData);
		// 获取角色ID（文件夹名）和角色显示名
		// boundCharName 在后端存储的是 charId（文件夹名如 001魔法少女小圆-予你之歌1.1）
		// 而 charData.name / SillyTavern.name2 是显示名（如 魔法少女小圆-予你之歌）
		var charId = st._charId || '';
		var charName = '';
		if (charData) {
			charName = charData.name || charData.avatar || '';
		}
		if (!charName && st.name2) {
			charName = st.name2;
		}
		// 查询后端时优先用 charId（与 boundCharName 匹配），其次用 charName
		var queryCharName = charId || charName;

		// 策略1：通过角色名查后端绑定的世界书（最可靠）
		if (queryCharName) {
			try {
				var resp = await fetch(
					_wbBaseUrl + '/lorebook/char-books?charName=' + encodeURIComponent(queryCharName),
					{ method: 'GET', headers: { 'Accept': 'application/json' } }
				);
				if (resp.ok) {
					var data = await resp.json();
					if (data.primary) {
						console.log('[ST Compat] getCurrentCharPrimaryLorebook → 通过角色绑定查到:', data.primary, '(charId:', charId, ', charName:', charName, ')');
						return data.primary;
					}
					console.log('[ST Compat] getCurrentCharPrimaryLorebook → 角色', queryCharName, '无绑定世界书，books:', data.books);
				}
			} catch(err) {
				console.warn('[ST Compat] getCurrentCharPrimaryLorebook → char-books 查询失败:', err);
			}
		}

		// 策略2：回退到角色卡的 extensions.world（兼容旧流程）
		if (charData) {
			var world = charData.extensions && charData.extensions.world;
			if (!world) world = charData.data && charData.data.extensions && charData.data.extensions.world;
			if (world) {
				console.log('[ST Compat] getCurrentCharPrimaryLorebook → 回退 charData.extensions.world:', world);
				return world;
			}
		}

		// 策略3：直接缓存的名称
		if (st._primaryLorebook) {
			console.log('[ST Compat] getCurrentCharPrimaryLorebook → from _primaryLorebook:', st._primaryLorebook);
			return st._primaryLorebook;
		}

		console.warn('[ST Compat] getCurrentCharPrimaryLorebook → 未找到主世界书');
		return null;
	};

	/**
	 * 获取指定世界书的所有条目（含禁用条目）
	 * @param {string} lorebookName - 世界书名称
	 * @param {object} [options] - 可选参数（兼容 JS-Slash-Runner 签名）
	 * @returns {Promise<Array>} 条目数组（ST 格式）
	 */
	window.getLorebookEntries = async function(lorebookName, options) {
		if (!lorebookName) {
			console.warn('[ST Compat] getLorebookEntries: lorebookName 为空，跳过');
			return [];
		}
		console.log('[ST Compat] getLorebookEntries 请求:', lorebookName);
		try {
			// 构建查询 URL：同时传 book 和 charName，后端会优先用 charName 绑定查找
			var queryParams = 'book=' + encodeURIComponent(lorebookName);
			var st = window.SillyTavern || {};
			var charData = st._charData || (st.getContext && st.getContext().characterData);
			var _charId = st._charId || '';
			var _charName = _charId || (charData && charData.name) || st.name2 || '';
			if (_charName) {
				queryParams += '&charName=' + encodeURIComponent(_charName);
			}
			var resp = await fetch(
				_wbBaseUrl + '/lorebook/entries?' + queryParams,
				{ method: 'GET', headers: { 'Accept': 'application/json' } }
			);
			if (!resp.ok) {
				console.warn('[ST Compat] getLorebookEntries failed:', resp.status, resp.statusText);
				return [];
			}
			var data = await resp.json();
			var entries = data.entries || [];
			console.log('[ST Compat] getLorebookEntries 返回', entries.length, '条条目（含禁用）for', lorebookName);
			// 打印前3个条目的 comment 用于调试
			if (entries.length > 0) {
				entries.slice(0, 3).forEach(function(e, i) {
					console.log('[ST Compat]   条目[' + i + '] comment:', e.comment, 'disable:', e.disable);
				});
			}
			var result = entries.map(function(e) {
				return {
					uid: e.uid,
					id: e.uid,
					comment: e.comment || '',
					content: e.content || '',
					key: e.key || [],
					keys: e.key || [],
					keysecondary: e.keysecondary || [],
					secondary_keys: e.keysecondary || [],
					constant: !!e.constant,
					selective: e.selective !== false,
					order: e.order || 100,
					insertion_order: e.order || 100,
					enabled: !e.disable,
					disable: !!e.disable,
					position: e.position || 0,
					depth: e.depth || 4,
					role: e.role,
					group: e.group || '',
					probability: e.probability || 100,
					useProbability: e.useProbability !== false,
					displayIndex: e.displayIndex || e.uid,
					extensions: {
						position: e.position || 0,
						depth: e.depth || 4,
						role: e.role,
						selectiveLogic: e.selectiveLogic || 0,
						exclude_recursion: !!e.excludeRecursion,
						prevent_recursion: !!e.preventRecursion,
						display_index: e.displayIndex || e.uid,
						probability: e.probability || 100,
						useProbability: e.useProbability !== false,
						group: e.group || '',
						group_weight: e.groupWeight || 100,
						scan_depth: e.scanDepth,
						case_sensitive: e.caseSensitive,
						match_whole_words: e.matchWholeWords,
						automation_id: e.automationId || '',
						sticky: e.sticky || 0,
						cooldown: e.cooldown || 0,
						delay: e.delay || 0,
					}
				};
			});
			// 应用 filter 参数（兼容 JS-Slash-Runner 的 GetLorebookEntriesOption）
			if (options && options.filter && options.filter !== 'none') {
				var filterObj = options.filter;
				result = result.filter(function(entry) {
					return Object.keys(filterObj).every(function(field) {
						var expected = filterObj[field];
						var actual = entry[field];
						if (Array.isArray(actual)) {
							return Array.isArray(expected) ? expected.every(function(v) { return actual.indexOf(v) >= 0; }) : false;
						}
						if (typeof actual === 'string') {
							return actual.indexOf(expected) >= 0;
						}
						return actual === expected;
					});
				});
			}
			return result;
		} catch(err) {
			console.error('[ST Compat] getLorebookEntries error:', err);
			return [];
		}
	};

	/**
	 * 获取角色关联的世界书名称
	 * @param {string} [type='current']
	 * @returns {Promise<{ primary: string }>}
	 */
	window.getCharWorldbookNames = async function(type) {
		var primary = await window.getCurrentCharPrimaryLorebook();
		return { primary: primary || '' };
	};

	/**
	 * 获取世界书全局设置
	 * @returns {object}
	 */
	window.getLorebookSettings = function() {
		return {
			selected_global_lorebooks: [],
			scan_depth: 2,
			context_percentage: 100,
			budget_cap: 0,
			min_activations: 0,
			max_depth: 100,
			max_recursion_steps: 0,
		};
	};

	/**
	 * 设置世界书全局设置（当前为 no-op）
	 * @param {object} settings
	 */
	window.setLorebookSettings = function(settings) {
		console.log('[ST Compat] setLorebookSettings called (no-op in beilu)', settings);
	};
})();
`
}