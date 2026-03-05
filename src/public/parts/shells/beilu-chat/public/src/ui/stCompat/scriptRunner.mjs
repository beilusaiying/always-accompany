/**
 * 角色卡脚本 iframe 管理器（Phase 2B）
 *
 * 负责：
 * 1. 从角色卡 data.extensions.tavern_helper.scripts[] 提取脚本
 * 2. 将所有 enabled 脚本合并到单个隐藏 iframe 中执行（模拟酒馆行为）
 * 3. 注入 ST 兼容层 + jQuery + Vue + 脚本内容到 iframe 中执行
 * 4. 管理脚本生命周期（加载/卸载/查询）
 * 5. 处理 import 语句转换（裸导入 → <script src>，命名导入保留为内联 module）
 * 6. 脚本按钮系统（button.buttons[] → 事件绑定）
 *
 * 架构说明：
 * - 所有脚本共享同一个 iframe 执行环境，与酒馆助手行为一致
 * - 脚本间可以共享全局变量（如 z, $, Vue 等）
 * - MVU bundle.js 将 Zod 声明为 webpack external（var z = self["z"]），不包含 Zod 源码
 * - 酒馆助手通过 third_party_object.ts 在主窗口注册 globalThis.z = import * as z from 'zod'
 * - 然后 predefine.js 在 iframe 中从 parent 继承 z
 * - 我们通过 <script type="module"> 从 testingcf CDN 加载 Zod 4.x 并设置 window.z
 * - CDN 选择与 bundle.js 自身依赖一致（testingcf.jsdelivr.net），确保网络可达性
 *
 * 使用方式（在 index.mjs 中调用）：
 *   import { loadCharacterScripts, unloadCharacterScripts } from './stCompat/scriptRunner.mjs'
 *
 *   // 角色卡加载时
 *   loadCharacterScripts(charData, { userName, charName, chatId })
 *
 *   // 角色卡切换时
 *   unloadCharacterScripts()
 *   loadCharacterScripts(newCharData, context)
 */

import { createDiag } from "../../diagLogger.mjs";
import { buildInjectionScript } from "./index.mjs";

const diag = createDiag("stCompat");

// ============================================================
// 状态管理
// ============================================================

/**
 * @typedef {object} RunningScript
 * @property {string} id - 脚本 ID
 * @property {string} name - 脚本名称
 * @property {boolean} enabled - 是否启用
 * @property {Array<{name: string, visible: boolean}>} buttons - 脚本按钮列表
 */

/** @type {RunningScript[]} 当前运行的脚本列表（逻辑记录，所有脚本共享一个 iframe） */
let _runningScripts = [];

/** @type {HTMLIFrameElement|null} 共享脚本 iframe */
let _sharedIframe = null;

/** @type {Function|null} 父页面 message 监听器（用于清理） */
let _messageHandler = null;

// ============================================================
// 公开接口
// ============================================================

/**
 * 从角色卡数据中提取并运行脚本
 *
 * @param {object} charData - 角色卡完整数据（V3 格式）
 * @param {object} context - 运行上下文
 * @param {string} [context.userName='User'] - 用户名
 * @param {string} [context.charName='Character'] - 角色名
 * @param {string} [context.chatId=''] - 当前聊天 ID
 * @param {Array<object>} [context.chatMessages=[]] - 当前聊天消息队列（beilu 格式）
 */
export async function loadCharacterScripts(charData, context = {}) {
  const {
    userName = "User",
    charName = "Character",
    charId = "",
    chatId = "",
    chatMessages = [],
  } = context;

  // 先卸载之前的脚本
  unloadCharacterScripts();

  // 提取 tavern_helper.scripts
  // 兼容两种格式：
  // 1. 已解包的 chardata.json（beilu 导入时 charDataRaw.data || charDataRaw）
  //    → charData.extensions.tavern_helper.scripts
  // 2. 完整 V3 格式（外层包含 data 字段）
  //    → charData.data.extensions.tavern_helper.scripts
  const scripts =
    charData?.extensions?.tavern_helper?.scripts ||
    charData?.data?.extensions?.tavern_helper?.scripts;
  if (!scripts || !Array.isArray(scripts) || scripts.length === 0) {
    diag.debug("角色卡无 tavern_helper 脚本");
    return;
  }

  const enabledScripts = scripts.filter(
    (s) => s.enabled && s.type === "script",
  );
  if (enabledScripts.length === 0) {
    diag.debug("角色卡有脚本但全部禁用:", scripts.length, "个");
    return;
  }

  diag.log(
    `开始加载角色卡脚本: ${enabledScripts.length} 个启用 / ${scripts.length} 个总计`,
  );

  // 注册父页面 postMessage 监听器（处理脚本 iframe 的通信）
  _setupMessageHandler();

  // 提取角色卡关联的主世界书名称（供 getCurrentCharPrimaryLorebook() 使用）
  let primaryLorebook =
    charData?.extensions?.world || charData?.data?.extensions?.world || "";

  // 如果角色卡没有指定世界书，尝试从 beilu-worldbook 查询角色绑定的世界书
  if (!primaryLorebook && charName) {
    try {
      const res = await fetch(
        `/api/parts/plugins:beilu-worldbook/lorebook/char-books?charName=${encodeURIComponent(charName)}`,
      );
      if (res.ok) {
        const data = await res.json();
        primaryLorebook = data.primary || "";
        if (primaryLorebook) {
          diag.log(
            `角色卡无 extensions.world，从 beilu-worldbook 绑定关系获取到主世界书: "${primaryLorebook}"`,
          );
        }
      }
    } catch {
      /* ignore */
    }
  }

  diag.log(`脚本 iframe primaryLorebook: "${primaryLorebook}"`);

  // 检测所有脚本是否需要 Vue / jQuery
  // bundle.js 依赖 Vue 作为 external，脚本中的 $() 需要 jQuery
  const allContent = enabledScripts.map((s) => s.content || "").join("\n");
  const needsVue = /MagVarUpdate|bundle\.js|Vue\b/.test(allContent);
  const needsjQuery = /\$\s*\(|\bjQuery\b/.test(allContent);

  // 构建 ST 兼容层注入脚本
  // 注意：不注入 Zod UMD（needsMVU: false for script iframe）
  // MVU bundle.js 自带 Zod 4.x 并注册全局 z，我们注入 Zod 3.x 会覆盖它导致 .prefault() 不可用
  const stCompatScript = await buildInjectionScript({
    needsST: true,
    needsMVU: false, // ★ 不注入 Zod UMD + MVU polyfill，让 bundle.js 自己管理
    needsVue: needsVue,
    needsEJS: false,
    messageId: -1, // 脚本 iframe 不关联消息
    userName,
    charName,
  });

  // ★ 所有脚本合并到一个共享 iframe 中执行（模拟酒馆行为）
  try {
    await _createSharedScriptIframe(enabledScripts, stCompatScript, {
      userName,
      charName,
      charId,
      chatId,
      needsjQuery,
      primaryLorebook,
      chatMessages,
    });
  } catch (err) {
    diag.error("脚本共享 iframe 创建失败:", err.message);
  }

  diag.log(
    `角色卡脚本加载完成: ${_runningScripts.length} 个脚本在共享 iframe 中运行`,
  );
  diag.snapshot("loadCharacterScripts", {
    total: scripts.length,
    enabled: enabledScripts.length,
    running: _runningScripts.length,
    scriptNames: _runningScripts.map((s) => s.name),
    sharedIframe: !!_sharedIframe,
  });
}

/**
 * 销毁当前角色卡的所有脚本 iframe
 */
export function unloadCharacterScripts() {
  if (_runningScripts.length === 0 && !_sharedIframe) return;

  const count = _runningScripts.length;
  _runningScripts = [];

  // 销毁共享 iframe
  if (_sharedIframe) {
    try {
      _sharedIframe.remove();
    } catch {
      /* ignore */
    }
    _sharedIframe = null;
  }

  // 移除 message 监听器
  if (_messageHandler) {
    window.removeEventListener("message", _messageHandler);
    _messageHandler = null;
  }

  diag.log(`脚本 iframe 销毁: ${count} 个脚本，1 个共享 iframe`);
}

/**
 * 获取当前运行的脚本列表
 *
 * @returns {Array<{id: string, name: string, enabled: boolean, buttons: Array}>}
 */
export function getRunningScripts() {
  return _runningScripts.map((s) => ({
    id: s.id,
    name: s.name,
    enabled: s.enabled,
    buttons: s.buttons,
  }));
}

/**
 * 触发指定脚本按钮的点击事件
 *
 * @param {string} scriptId - 脚本 ID
 * @param {string} buttonName - 按钮名称
 */
export function triggerScriptButton(scriptId, buttonName) {
  const eventName = `script_button_${scriptId}_${buttonName}`;
  // 通过父页面 EventBus 广播事件（所有脚本 iframe 都能收到）
  if (window.__beiluEventBus) {
    const listeners = window.__beiluEventBus._listeners;
    if (listeners && listeners.has(eventName)) {
      const cbs = listeners.get(eventName);
      cbs.forEach((cb) => {
        try {
          cb();
        } catch (e) {
          diag.error(`脚本按钮事件执行失败: ${eventName}`, e.message);
        }
      });
    }
  }
  diag.debug(`脚本按钮触发: ${eventName}`);
}

// ============================================================
// 内部实现
// ============================================================

/**
 * 解析脚本 content 中的 import 语句
 * 支持以下格式：
 * - import 'url'              （裸导入/副作用导入 → 转为 <script type="module" src>）
 * - import { x } from 'url'   （命名导入 → 保留为内联 module 代码）
 * - import x from 'url'       （默认导入 → 保留为内联 module 代码）
 * - import * as x from 'url'  （命名空间导入 → 保留为内联 module 代码）
 *
 * 裸导入转换为 <script type="module" src="url">
 * 命名/默认导入保留为内联 module 代码（浏览器 ES module 天然支持 import from）
 *
 * @param {string} content - 脚本内容
 * @returns {{ bareUrls: string[], remainingCode: string }}
 */
function _convertImports(content) {
  if (!content) return { bareUrls: [], remainingCode: "" };

  const bareUrls = [];
  // 只提取裸导入（import 'url' 或 import "url"，不带任何绑定符号）
  // 带 { } / * as / default 绑定的 import 保留在代码中
  const cleaned = content.replace(
    /^\s*import\s+['"]([^'"]+)['"]\s*;?\s*$/gm,
    (_match, url) => {
      bareUrls.push(url);
      return ""; // 裸导入移除，转为 <script src>
    },
  );

  if (bareUrls.length > 0) {
    diag.debug(`裸 import 转换: ${bareUrls.length} 个 URL`, bareUrls);
  }

  // 命名/默认导入保留在 remainingCode 中（<script type="module"> 天然支持）
  return { bareUrls, remainingCode: cleaned.trim() };
}

/**
 * 构建共享脚本 iframe 的 srcdoc HTML
 * 所有脚本合并到一个 iframe 中执行，模拟酒馆的共享环境
 *
 * @param {object[]} scripts - 所有启用的脚本对象数组
 * @param {string} stCompatScript - ST 兼容层 <script> 标签
 * @param {object} context - 运行上下文
 * @returns {string} 完整的 HTML 文档
 */
function _buildSharedScriptHtml(scripts, stCompatScript, context) {
  const {
    userName = "User",
    charName = "Character",
    charId = "",
    needsjQuery = false,
    primaryLorebook = "",
    chatMessages = [],
  } = context;

  // 收集所有脚本的裸导入 URL（去重）和内联代码
  const allBareUrls = [];
  const allInlineBlocks = [];
  const seenUrls = new Set();

  for (const script of scripts) {
    const { bareUrls, remainingCode } = _convertImports(script.content || "");

    // 裸导入去重
    for (const url of bareUrls) {
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        allBareUrls.push(url);
      }
    }

    // 内联代码块（每个脚本独立的 module，保留 import from 语句）
    if (remainingCode) {
      allInlineBlocks.push({
        scriptName: script.name,
        scriptId: script.id,
        code: remainingCode,
      });
    }
  }

  // 第一个脚本的 API 信息（用于 getScriptId 等基础 API）
  const firstScript = scripts[0];
  const scriptApiCode = _generateScriptApiCode(firstScript);

  // 裸导入 URL 转为 <script type="module" src> 标签
  const importScriptTags = allBareUrls
    .map((url) => `<script type="module" src="${url}"></` + `script>`)
    .join("\n    ");

  // 内联代码块转为 <script type="module"> 标签
  const inlineScripts = allInlineBlocks
    .map(
      (block) =>
        `<!-- 脚本: ${_escapeHtml(block.scriptName)} (${block.scriptId}) -->
    <script type="module">
${block.code}
    </` + `script>`,
    )
    .join("\n    ");

  // jQuery 注入（如果需要）— 必须在脚本之前同步加载
  const jqueryTag = needsjQuery
    ? `<!-- jQuery 3.7.1 -->
    <script src="https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js"></` +
      `script>`
    : "";

  // 将 beilu 消息队列转换为酒馆 SillyTavern.chat 格式
  // 酒馆格式: { message_id, name, role('system'|'assistant'|'user'), is_hidden, message, data, extra }
  // beilu 格式: { id, role('user'|'char'|'system'), name, content, ... }
  const stChatArray = _convertToSTChatFormat(chatMessages, userName, charName);
  // 注意：JSON.stringify 不转义 </，但在 <script> 内嵌 JSON 时，
  // </script> 会被 HTML 解析器提前闭合。替换 </ 为 <\/ 防止此问题。
  const stChatJson = JSON.stringify(stChatArray).replace(/<\//g, "<\\/");

  return (
    `<!DOCTYPE html>
<html>
<head>
	   <meta charset="utf-8">
	   <!-- earlyScript: SillyTavern 基础 API -->
	   <script>
	   (function() {
	       window.SillyTavern = {
	           chat: ${stChatJson}, name1: '${_escapeJs(userName)}', name2: '${_escapeJs(charName)}',
	           _charId: '${_escapeJs(charId)}',
	           _primaryLorebook: '${_escapeJs(primaryLorebook)}'
	       };
	       window.getCurrentMessageId = function() { return window.SillyTavern.chat.length > 0 ? window.SillyTavern.chat.length - 1 : -1; };
	       window.getChatMessages = function() { return window.SillyTavern.chat; };
	       window.getIframeName = function() { return 'script_shared'; };
	       window.getLastMessageId = function() { return window.SillyTavern.chat.length > 0 ? window.SillyTavern.chat.length - 1 : -1; };
	       console.log('[scriptRunner earlyScript] SillyTavern.chat initialized with', window.SillyTavern.chat.length, 'messages');
	   })();
	   </` +
    `script>
	   
	   ${jqueryTag}
	   <!-- toastr stub（bundle.js 中 Me() 等函数使用 toastr.error/info/success） -->
	   <script>
	   if (typeof window.toastr === 'undefined') {
	       window.toastr = {
	           info: function(msg, title) { console.log('[toastr.info]', title || '', msg); },
	           success: function(msg, title) { console.log('[toastr.success]', title || '', msg); },
	           warning: function(msg, title) { console.warn('[toastr.warning]', title || '', msg); },
	           error: function(msg, title, opts) { console.error('[toastr.error]', title || '', msg); },
	           clear: function() {},
	           remove: function() {},
	       };
	   }
	   </` +
    `script>
	   
	   <!-- predefine: 全局对象预注入（仿酒馆助手 predefine.js + third_party_object.ts） -->
	   <!--
	     酒馆助手流程（参考 JS-Slash-Runner 源码）：
	     1. third_party_object.ts: import * as z_object from 'zod'; globalThis.z = z_object
	        → 在酒馆主窗口注册 window.z = Zod 4.x 命名空间
	     2. predefine.js: _.merge(window, _.pick(parent, ['z', 'YAML', ...]))
	        → iframe 从 parent 继承 z
	     3. bundle.js: webpack external var "z" → module.exports = z
	        → bundle.js 不包含 Zod 源码！它只是从 window.z 读取

	     我们的流程：
	     1. 同步 <script> 设置 window.z = {} 空占位（防止 external var "z" 的 ReferenceError）
	     2. <script type="module"> 从 CDN 加载 Zod 4.x 并设置 window.z（module 脚本按文档顺序执行）
	     3. <body> 中的 bundle.js module 脚本执行时，self["z"] 已是真正的 Zod 4.x
	     4. 用户脚本 z.object({...}).prefault({...}) 正常工作
	   -->
	   <script>
	   (function() {
	       // ★ Zod 空占位：防止 bundle.js 的 external var "z" 在 strict mode 下抛出 ReferenceError
	       // 这只是 fallback，真正的 Zod 4.x 由下方的 module 脚本从 CDN 加载
	       if (typeof window.z === 'undefined') {
	           window.z = {};
	       }
	       
	       // 从 parent 窗口继承关键全局对象
	       try {
	           var p = window.parent;
	           if (p) {
	               // z（Zod）— 如果 parent 有完整的 Zod，优先使用（比 CDN 更快）
	               if (p.z && typeof p.z === 'object' && typeof p.z.object === 'function') {
	                   window.z = p.z;
	               }
	               // Mvu — 从 parent 继承（如果已经初始化）
	               if (typeof p.Mvu !== 'undefined' && typeof window.Mvu === 'undefined') {
	                   Object.defineProperty(window, 'Mvu', {
	                       get: function() { try { return p.Mvu; } catch(e) { return undefined; } },
	                       set: function() {},
	                       configurable: true
	                   });
	               }
	               // showdown / toastr / YAML — 如果 parent 有则继承
	               if (p.showdown && !window.showdown) window.showdown = p.showdown;
	               if (p.toastr && !window.toastr) window.toastr = p.toastr;
	               if (p.YAML && !window.YAML) window.YAML = p.YAML;
	               if (p.jsyaml && !window.YAML) window.YAML = p.jsyaml;
	           }
	       } catch(e) {
	           console.warn('[scriptRunner predefine] parent access failed:', e.message);
	       }
	   })();
	   </` +
    `script>
	   
	   <!-- ★ ST 兼容层注入（lodash CDN + 事件系统 + 变量系统 + TavernHelper 等） -->
	   ${stCompatScript}
	   
	   <!-- ★ Zod 4.x CDN 加载（ES Module）
	     module 脚本按文档出现顺序执行，保证在 body 中的 bundle.js 之前完成。
	     如果 parent 已经有完整的 Zod（上方 predefine 设置了），这里会跳过 CDN 加载。
	     CDN 选择与 bundle.js 自身依赖一致（testingcf.jsdelivr.net），确保网络可达性。
	     如果所有 CDN 加载失败，window.z 保持为 {} 占位，bundle.js 会出 TypeError 但不会 ReferenceError。
	   -->
	   <script type="module">
	   if (typeof window.z.object !== 'function') {
	       try {
	           // 主 CDN：与 bundle.js 的其他依赖（klona/json5/pinia 等）使用同一 CDN
	           const zod = await import('https://testingcf.jsdelivr.net/npm/zod@3/+esm');
	           window.z = zod;
	           self.z = zod;
	           console.log('[scriptRunner] Zod 4.x loaded from testingcf CDN, methods:', Object.keys(zod).slice(0, 8).join(', '));
	       } catch(e1) {
	           console.warn('[scriptRunner] testingcf CDN failed:', e1.message, '— trying fallback CDN');
	           try {
	               // 备选 CDN
	               const zod2 = await import('https://cdn.jsdelivr.net/npm/zod@3/+esm');
	               window.z = zod2;
	               self.z = zod2;
	               console.log('[scriptRunner] Zod 4.x loaded from cdn.jsdelivr fallback');
	           } catch(e2) {
	               console.error('[scriptRunner] All Zod CDN loads failed:', e1.message, e2.message, '— bundle.js will use fallback empty z');
	           }
	       }
	   } else {
	       console.log('[scriptRunner] Zod already available from parent, version check:', typeof window.z.object);
	   }
	   </` +
    `script>
	   
	   <!-- 脚本 API（第一个脚本） -->
	   <script>
	   ${scriptApiCode}
	   </` +
    `script>
	   
	   <!-- 裸导入的外部脚本（放在 head 中，保证在 Zod 加载完成后按文档顺序执行） -->
	   ${importScriptTags}
</head>
<body>
	   <!-- 各脚本的内联代码 -->
	   ${inlineScripts}
</body>
</html>`
  );
}

/**
 * 生成脚本特有 API 代码
 * 提供 getScriptId / getScriptName / getButtonEvent / getScriptButtons 等
 *
 * @param {object} script - 脚本对象
 * @returns {string} JavaScript 代码字符串
 */
function _generateScriptApiCode(script) {
  const buttons = script.button?.buttons || [];
  const buttonsJson = JSON.stringify(buttons);
  const scriptDataJson = JSON.stringify(script.data || {});

  return `
/* === ST Compat: Script API for "${_escapeJs(script.name)}" === */
(function() {
    var _scriptId = '${_escapeJs(script.id)}';
    var _scriptName = '${_escapeJs(script.name)}';
    var _scriptButtons = ${buttonsJson};
    var _scriptData = ${scriptDataJson};
    var _scriptInfo = ${JSON.stringify(script.info || "")};

    // 脚本标识
    window.getScriptId = function() { return _scriptId; };
    window.getScriptName = function() { return _scriptName; };
    window.getScriptInfo = function() { return _scriptInfo; };

    // 脚本按钮
    window.getScriptButtons = function() { return JSON.parse(JSON.stringify(_scriptButtons)); };
    window.replaceScriptButtons = function(newButtons) { _scriptButtons = newButtons; };
    window.updateScriptButtonsWith = function(fn) { _scriptButtons = fn(_scriptButtons); };
    window.appendInexistentScriptButtons = function(buttons) {
        var existing = _scriptButtons.map(function(b) { return b.name; });
        buttons.forEach(function(b) {
            if (existing.indexOf(b.name) === -1) _scriptButtons.push(b);
        });
    };

    // 按钮事件名生成
    window.getButtonEvent = function(buttonName) {
        return 'script_button_' + _scriptId + '_' + buttonName;
    };

    // 脚本数据（角色卡中 script.data 字段）
    window.getScriptData = function() { return JSON.parse(JSON.stringify(_scriptData)); };
    window.replaceScriptInfo = function(info) { _scriptInfo = info; };

    // reloadIframe — 重新加载当前脚本 iframe
    window.reloadIframe = function() {
        window.parent.postMessage({
            type: 'beilu-script-reload',
            scriptId: _scriptId
        }, '*');
    };
})();
`;
}

/**
 * 创建共享脚本 iframe，将所有脚本合并到一个 iframe 中执行
 *
 * @param {object[]} scripts - 所有启用的脚本对象数组
 * @param {string} stCompatScript - ST 兼容层 <script> 标签
 * @param {object} context - 运行上下文
 */
async function _createSharedScriptIframe(scripts, stCompatScript, context) {
  diag.log(`共享脚本 iframe 创建: ${scripts.length} 个脚本`);

  // 构建合并的 iframe HTML
  const html = _buildSharedScriptHtml(scripts, stCompatScript, context);

  // 创建隐藏 iframe
  const iframe = document.createElement("iframe");
  iframe.className = "beilu-script-iframe";
  iframe.style.cssText =
    "display:none!important;width:0;height:0;border:none;position:absolute;";
  iframe.sandbox = "allow-scripts allow-same-origin";
  iframe.srcdoc = html;

  // 添加到 DOM
  document.body.appendChild(iframe);
  _sharedIframe = iframe;

  // 记录所有脚本到运行列表
  for (const script of scripts) {
    const buttons = (script.button?.buttons || []).map((b) => ({
      name: b.name || "",
      visible: b.visible !== false,
    }));

    _runningScripts.push({
      id: script.id,
      name: script.name,
      enabled: script.enabled,
      buttons,
    });
  }

  diag.log(
    `共享脚本 iframe 已创建: ${scripts.length} 个脚本，总按钮: ${_runningScripts.reduce((n, s) => n + s.buttons.length, 0)}`,
  );
}

/**
 * 设置父页面 postMessage 监听器
 * 处理来自脚本 iframe 的通信请求
 */
function _setupMessageHandler() {
  if (_messageHandler) return;

  _messageHandler = (e) => {
    if (!e.data || !e.data.type) return;

    switch (e.data.type) {
      case "beilu-script-reload": {
        // 脚本请求重新加载共享 iframe
        if (_sharedIframe) {
          diag.log("脚本 iframe 重载（共享 iframe）");
          const currentSrcdoc = _sharedIframe.srcdoc;
          _sharedIframe.srcdoc = "";
          setTimeout(() => {
            _sharedIframe.srcdoc = currentSrcdoc;
          }, 50);
        }
        break;
      }

      case "beilu-event-emit": {
        // 脚本 iframe 内触发事件 → 广播到父页面 EventBus → 所有 iframe 收到
        const eventName = e.data.eventName;
        const args = e.data.args || [];
        if (window.__beiluEventBus && window.__beiluEventBus._listeners) {
          const listeners = window.__beiluEventBus._listeners.get(eventName);
          if (listeners) {
            listeners.forEach((cb) => {
              try {
                cb(...args);
              } catch (err) {
                diag.error(`EventBus 事件处理失败: ${eventName}`, err.message);
              }
            });
          }
        }
        break;
      }

      case "beilu-event-on": {
        // 脚本 iframe 注册事件监听 → 存储在父页面 EventBus
        const eventName = e.data.eventName;
        const source = e.source; // 发送消息的 iframe window
        if (!window.__beiluEventBus)
          window.__beiluEventBus = { _listeners: new Map() };
        const listeners = window.__beiluEventBus._listeners;
        if (!listeners.has(eventName)) listeners.set(eventName, []);

        // 创建桥接回调：当事件触发时，通过 postMessage 通知原 iframe
        const bridgeCallback = (...args) => {
          try {
            source.postMessage(
              {
                type: "beilu-event-callback",
                eventName,
                args,
              },
              "*",
            );
          } catch {
            /* iframe 可能已销毁 */
          }
        };
        listeners.get(eventName).push(bridgeCallback);
        break;
      }
    }
  };

  window.addEventListener("message", _messageHandler);
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 将 beilu 消息队列转换为酒馆 SillyTavern.chat 格式
 *
 * 酒馆格式: { message_id, name, role('system'|'assistant'|'user'), is_hidden, message, data, extra }
 * beilu 格式: { id, role('user'|'char'|'system'), name, content, ... }
 *
 * @param {Array<object>} beiluMessages - beilu 格式的消息队列
 * @param {string} userName - 用户名
 * @param {string} charName - 角色名
 * @returns {Array<object>} 酒馆格式的 chat 数组
 */
function _convertToSTChatFormat(beiluMessages, userName, charName) {
  if (
    !beiluMessages ||
    !Array.isArray(beiluMessages) ||
    beiluMessages.length === 0
  ) {
    return [];
  }

  return beiluMessages
    .filter((msg) => msg && msg.role !== "system") // 过滤 system 消息（酒馆 chat 数组通常不含 system）
    .map((msg, index) => {
      // beilu role → 酒馆 role
      let stRole = "assistant";
      if (msg.role === "user") stRole = "user";
      else if (msg.role === "char") stRole = "assistant";

      // 名字
      const name = msg.name || (stRole === "user" ? userName : charName);

      const msgText = msg.content || "";
      return {
        // === 酒馆助手 API 字段 ===
        message_id: index,
        name: name,
        role: stRole,
        is_hidden: false,
        is_user: stRole === "user",
        message: msgText,
        data: {},
        extra: {},
        // === 酒馆内部字段（setChatMessages / getVariables 依赖） ===
        is_system: false,
        mes: msgText,
        swipe_id: 0,
        swipes: [msgText],
        // ★ MVU 变量映射：extension.mvu_variables → variables[swipe_id]
        // 对标 JS-Slash-Runner: chat_message.variables[swipe_id]
        // beilu-mvu 后端将变量快照存储在 chatLogEntry.extension.mvu_variables
        variables: [msg.extension?.mvu_variables || {}],
        swipe_info: [{}],
      };
    });
}

/**
 * 转义 HTML 特殊字符
 * @param {string} str
 * @returns {string}
 */
function _escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * 转义 JavaScript 字符串中的特殊字符
 * @param {string} str
 * @returns {string}
 */
function _escapeJs(str) {
  return String(str)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/<\//g, "<\\/");
}
