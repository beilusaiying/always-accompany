/**
 * 变量系统 shim
 *
 * Phase 2D: 混合模式 — 本地缓存 + postMessage 委托父页面持久化
 * 从 polyfills.mjs generateVariableSystemScript 拆出
 */

export function generateVariableSystemScript() {
  return `
/* === ST Compat: Variable System (Phase 2D: persistent) === */
(function() {
	/* 从父页面 VariableStore 同步初始化本地缓存 */
	var _parentStore = null;
	try { _parentStore = window.parent.__beiluVarStore; } catch(e) {}

	var _vars = {
		global: (_parentStore && _parentStore.global) ? JSON.parse(JSON.stringify(_parentStore.global)) : {},
		character: (_parentStore && _parentStore.character) ? JSON.parse(JSON.stringify(_parentStore.character)) : {},
		chat: (_parentStore && _parentStore.chat) ? JSON.parse(JSON.stringify(_parentStore.chat)) : {},
		messages: {},
		scripts: (_parentStore && _parentStore.scripts) ? JSON.parse(JSON.stringify(_parentStore.scripts)) : {},
		preset: (_parentStore && _parentStore.preset) ? JSON.parse(JSON.stringify(_parentStore.preset)) : {},
		extensions: (_parentStore && _parentStore.extensions) ? JSON.parse(JSON.stringify(_parentStore.extensions)) : {}
	};

	/* ★ 楼层号映射：chat 数组索引 → 递增序号（从 0 开始）
	   不依赖实际对话楼层，而是按变量写入次序递增 */
	var _floorMap = {};   /* realId → floorNumber */
	var _nextFloor = 0;   /* 下一个可用楼层号 */

	/* 初始化时从父页面已有的 messages key 恢复序号 */
	if (_parentStore && _parentStore.messages) {
		var existingKeys = Object.keys(_parentStore.messages).map(Number).filter(function(n) { return !isNaN(n); });
		if (existingKeys.length > 0) {
			_nextFloor = Math.max.apply(null, existingKeys) + 1;
		}
	}

	function _getFloorNumber(realId) {
		if (realId in _floorMap) return _floorMap[realId];
		var floor = _nextFloor++;
		_floorMap[realId] = floor;
		return floor;
	}

	/** 将变量操作同步到父页面持久化 */
	function _notifyParent(scope, key, variables) {
		try {
			window.parent.postMessage({
				type: 'beilu-var-replace',
				option: { scope: scope, key: key },
				variables: variables
			}, '*');
		} catch(e) { /* iframe 可能与父页面不同源 */ }
	}

	function _resolveStore(option) {
		option = option || { type: 'chat' };
		switch (option.type) {
			case 'global': return { store: _vars, key: 'global', scope: 'global', storeKey: '' };
			case 'character': return { store: _vars, key: 'character', scope: 'character', storeKey: '' };
			case 'chat': return { store: _vars, key: 'chat', scope: 'chat', storeKey: '' };
			case 'preset': return { store: _vars, key: 'preset', scope: 'preset', storeKey: '' };
			case 'message': {
				var id = option.message_id;
				if (id === 'latest' || id === undefined || id === null) id = -1;
				/* ★ 优先从 SillyTavern.chat 读取楼层变量（与 setChatMessages 对接） */
				var chatArr = (window.SillyTavern && window.SillyTavern.chat) ? window.SillyTavern.chat : [];
				if (chatArr.length > 0) {
					var realId = (typeof id === 'number') ? id : Number(id);
					if (realId < 0) realId = chatArr.length + realId;
					if (realId >= 0 && realId < chatArr.length) {
						var msg = chatArr[realId];
						if (msg) {
							var swipeId = msg.swipe_id || 0;
							if (!msg.variables) msg.variables = [{}];
							if (!msg.variables[swipeId]) msg.variables[swipeId] = {};
							/* ★ storeKey 使用递增楼层号而非 chat 数组索引 */
							var floorNum = _getFloorNumber(realId);
							return { store: msg.variables, key: swipeId, scope: 'message', storeKey: String(floorNum) };
						}
					}
				}
				/* 回退到本地存储 — 同样使用递增楼层号 */
				var fallbackFloor = _getFloorNumber(id);
				if (!_vars.messages[fallbackFloor]) _vars.messages[fallbackFloor] = {};
				return { store: _vars.messages, key: fallbackFloor, scope: 'message', storeKey: String(fallbackFloor) };
			}
			case 'script': {
				var sid = option.script_id || '_default';
				if (!_vars.scripts[sid]) _vars.scripts[sid] = {};
				return { store: _vars.scripts, key: sid, scope: 'script', storeKey: sid };
			}
			case 'extension': {
				var eid = option.extension_id || '_default';
				if (!_vars.extensions[eid]) _vars.extensions[eid] = {};
				return { store: _vars.extensions, key: eid, scope: 'extension', storeKey: eid };
			}
			default: return { store: _vars, key: 'chat', scope: 'chat', storeKey: '' };
		}
	}

	window.getVariables = function(option) {
		var ref = _resolveStore(option);
		return ref.store[ref.key] || {};
	};

	window.replaceVariables = function(variables, option) {
		var ref = _resolveStore(option);
		ref.store[ref.key] = variables || {};
		_notifyParent(ref.scope, ref.storeKey, variables || {});
	};

	window.updateVariablesWith = function(updater, option) {
		var ref = _resolveStore(option);
		var current = ref.store[ref.key] || {};
		var updated = updater(current);
		ref.store[ref.key] = updated;
		_notifyParent(ref.scope, ref.storeKey, updated);
		return updated;
	};

	window.insertOrAssignVariables = function(variables, option) {
		var ref = _resolveStore(option);
		var current = ref.store[ref.key] || {};
		Object.keys(variables).forEach(function(k) { current[k] = variables[k]; });
		ref.store[ref.key] = current;
		_notifyParent(ref.scope, ref.storeKey, current);
		return current;
	};

	window.insertVariables = function(variables, option) {
		var ref = _resolveStore(option);
		var current = ref.store[ref.key] || {};
		Object.keys(variables).forEach(function(k) {
			if (!(k in current)) current[k] = variables[k];
		});
		ref.store[ref.key] = current;
		_notifyParent(ref.scope, ref.storeKey, current);
		return current;
	};

	window.deleteVariable = function(path, option) {
		var ref = _resolveStore(option);
		var current = ref.store[ref.key] || {};
		var occurred = false;
		if (path in current) {
			delete current[path];
			occurred = true;
		} else if (typeof _ !== 'undefined' && _.unset) {
			occurred = _.unset(current, path);
		}
		ref.store[ref.key] = current;
		_notifyParent(ref.scope, ref.storeKey, current);
		return { variables: current, delete_occurred: occurred };
	};

	window.registerVariableSchema = function(schema, option) {
		/* Schema validation — store for future use */
	};

	/* ★ 修复：earlyScript 注入的 MVU 累积变量同步到 _vars.messages（不再污染 _vars.chat）
	   参考 JS-Slash-Runner：chat 作用域只存放脚本的默认变量，
	   message 变量存在 messages[floorNumber] 中，getAllVariables 动态合并。
	   之前把 MVU 变量合并到 _vars.chat 会覆盖默认变量。 */
	(function _syncInjectedMvuVars() {
		var stChat = (window.SillyTavern && window.SillyTavern.chat) ? window.SillyTavern.chat : [];
		var _swipeId0 = (stChat.length > 0 && stChat[0]) ? (stChat[0].swipe_id || 0) : 0; /* [0807 §七#3] 按真实 swipe 下标读（此前硬编码 [0]，开场白切换时间线后读到空/旧份） */
		if (stChat.length > 0 && stChat[0] && stChat[0].variables && stChat[0].variables[_swipeId0]) {
			var injected = stChat[0].variables[_swipeId0];
			if (injected && typeof injected === 'object' && Object.keys(injected).length > 0) {
				/* 写入 messages 作用域而非 chat 作用域 */
				var floorNum = _getFloorNumber(0);
				_vars.messages[floorNum] = injected;
			}
		}
	})();

	window.getAllVariables = function() {
		/* Merge all layers: global → character → chat → 所有楼层变量累积
		   与酒馆 _getAllVariables 行为一致：遍历 chat[0..N].variables[swipe_id] 依次覆盖 */
		var merged = {};
		Object.assign(merged, _vars.global);
		Object.assign(merged, _vars.character);
		Object.assign(merged, _vars.chat);

		/* ★ 从 SillyTavern.chat 累积楼层变量 */
		var chatArr = (window.SillyTavern && window.SillyTavern.chat) ? window.SillyTavern.chat : [];
		var foundMessageVars = false;

		if (chatArr.length > 0) {
			for (var ci = 0; ci < chatArr.length; ci++) {
				var msg = chatArr[ci];
				if (!msg || !msg.variables) continue;
				var swipeId = msg.swipe_id || 0;
				var vars = msg.variables[swipeId];
				if (vars && typeof vars === 'object' && Object.keys(vars).length > 0) {
					Object.assign(merged, vars);
					foundMessageVars = true;
				}
			}
		}

		/* ★ 回退：如果 SillyTavern.chat 中没找到有效变量，从 __beiluVarStore.messages 和本地 messages 读取 */
		if (!foundMessageVars) {
			/* 从父页面 __beiluVarStore.messages 中累积合并所有楼层变量（按楼层号从小到大） */
			try {
				var parentStore = window.parent.__beiluVarStore;
				if (parentStore && parentStore.messages) {
					var parentMsgKeys = Object.keys(parentStore.messages).map(Number).filter(function(n) { return !isNaN(n); });
					parentMsgKeys.sort(function(a, b) { return a - b; });
					for (var pi = 0; pi < parentMsgKeys.length; pi++) {
						var pVars = parentStore.messages[parentMsgKeys[pi]];
						if (pVars && typeof pVars === 'object' && Object.keys(pVars).length > 0) {
							Object.assign(merged, pVars);
							foundMessageVars = true;
						}
					}
				}
			} catch(e) { /* cross-origin */ }

			/* 本地 messages 也累积合并（按楼层号从小到大） */
			if (!foundMessageVars) {
				var msgKeys = Object.keys(_vars.messages).map(Number).filter(function(n) { return !isNaN(n); });
				msgKeys.sort(function(a, b) { return a - b; });
				for (var mi = 0; mi < msgKeys.length; mi++) {
					var mVars = _vars.messages[msgKeys[mi]];
					if (mVars && typeof mVars === 'object' && Object.keys(mVars).length > 0) {
						Object.assign(merged, mVars);
					}
				}
			}
		}

		return merged;
	};
})();
`;
}
