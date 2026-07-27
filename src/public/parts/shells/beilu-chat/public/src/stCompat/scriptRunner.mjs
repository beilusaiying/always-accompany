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

import { createDiag } from "../shared/state/diagLogger.mjs";
import { buildInjectionScript } from "./index.mjs";
import { escapeHtml as _escapeHtml } from "../shared/state/utils.mjs";
import { apiFetch } from "../shared/transport/api-client.mjs"; // R1: raw fetch → apiFetch（timeout+401；raw 保留 ok 判断；:fetchUrlScript 外部源 SKIP）
import { sendAction } from "../shared/transport/sendAction.mjs"; // T8·切桥：readUserFile 直连收口走门面（凛倾 07-03"ST 只是插件"拍板）

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

/** @type {RunningScript[]} 当前运行的脚本列表（逻辑记录） */
let _runningScripts = [];

/**
 * S1: 每脚本独立一个 iframe,对标酒馆助手 Iframe.vue 的 "每脚本独立沙盒" 模式
 *   key   = scriptId
 *   value = HTMLIFrameElement (display:none)
 *
 * 这样一个脚本崩溃不会影响其他脚本,且脚本间全局变量彼此隔离。
 * 代价:每个 iframe 都要独立加载 ST 兼容层 + jQuery + Zod,内存/启动时间 ≈ 脚本数倍。
 * @type {Map<string, HTMLIFrameElement>}
 */
const _scriptIframes = new Map();

/** @type {Function|null} 父页面 message 监听器（用于清理） */
let _messageHandler = null;

/** R3: 按钮状态聚合 Map<scriptId, {scriptName, buttons[]}>, iframe postMessage 时更新 */
const _scriptButtonsByScript = new Map();

/**
 * R-UP-6: 外部 URL 脚本内容缓存
 *   key = script.url, value = { content, fetchedAt }
 *   autoUpdate=false 的脚本命中缓存直接复用,不重复拉取(切角色/重载时省网络往返)。
 *   autoUpdate=true 的脚本每次都重新 fetch,确保拿到远端最新版本。
 * @type {Map<string, {content: string, fetchedAt: number}>}
 */
const _urlScriptCache = new Map();

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
      const res = await apiFetch(
        `/api/parts/plugins:beilu-worldbook/lorebook/char-books?charName=${encodeURIComponent(charName)}`,
        { raw: true },
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

  // R-UP-6: 物化 source:'url' 脚本(拉取远端源码为内嵌 content),再继续后续流程
  //   URL 拉取失败的脚本被剔除,不阻塞其他脚本
  const materializedScripts = await _materializeScripts(enabledScripts);
  if (materializedScripts.length === 0) {
    diag.warn("角色卡脚本物化后无可运行脚本(URL 拉取全部失败?)");
    return;
  }

  // 检测所有脚本是否需要 Vue / jQuery
  // bundle.js 依赖 Vue 作为 external，脚本中的 $() 需要 jQuery
  const allContent = materializedScripts.map((s) => s.content || "").join("\n");
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

  // S1: 每个脚本独立一个 iframe — 逐个创建,互不影响
  //   旧方案(共享 iframe): 所有脚本合并到一个 HTML 中,一个崩溃全崩
  //   新方案(独立 iframe): for 循环单独创建,崩溃隔离
  //   复用原 _createSharedScriptIframe 签名(接数组),外层每次只传 1 个脚本
  for (const script of materializedScripts) {
    try {
      await _createSharedScriptIframe([script], stCompatScript, {
        userName,
        charName,
        charId,
        chatId,
        needsjQuery,
        primaryLorebook,
        chatMessages,
        scope: "character", // S2: 标记 scope,切角色时按此卸载
      });
    } catch (err) {
      diag.error(`脚本 "${script.name}" iframe 创建失败:`, err.message);
      // 继续创建其他脚本,一个失败不影响其他
    }
  }

  diag.log(
    `角色卡脚本加载完成: ${_runningScripts.length} 个脚本,${_scriptIframes.size} 个独立 iframe`,
  );
  diag.snapshot("loadCharacterScripts", {
    total: scripts.length,
    enabled: enabledScripts.length,
    running: _runningScripts.length,
    scriptNames: _runningScripts.map((s) => s.name),
    iframeCount: _scriptIframes.size,
  });
}

/**
 * 移除指定 iframe window 在父页面 EventBus 上注册的全部桥接回调。
 * bridgeCallback 在 beilu-event-on 时打了 _beiluSource 标记，按 window 精准清除，
 * 避免 iframe 销毁后回调常驻（每次 emit 仍向死 window postMessage + 内存泄漏）。
 * @param {Window|null} win - 已销毁 iframe 的 contentWindow（须在 remove 前捕获）
 */
function _purgeEventBusListeners(win) {
  if (!win || !window.__beiluEventBus?._listeners) return;
  const map = window.__beiluEventBus._listeners;
  for (const [eventName, cbs] of Array.from(map.entries())) {
    const kept = cbs.filter((cb) => cb._beiluSource !== win);
    if (kept.length) map.set(eventName, kept);
    else map.delete(eventName);
  }
}

/**
 * 按 scope 销毁脚本 iframe
 * S2: 只卸对应 scope 的脚本,其他 scope 保留
 *   切角色 → unloadScriptsByScope('character') 保留 global/preset
 *   切预设 → unloadScriptsByScope('preset') 保留 global/character
 *   退出 → unloadScriptsByScope() 清空全部
 * @param {string} [scope] - 'character' / 'preset' / 'global',不传则清全部
 */
export function unloadScriptsByScope(scope) {
  if (_runningScripts.length === 0 && _scriptIframes.size === 0) return;

  const before = _runningScripts.length;

  // 保留其他 scope 的脚本
  const survivors = scope ? _runningScripts.filter((s) => s.scope !== scope) : [];
  _runningScripts = survivors;

  // 销毁匹配 scope 的 iframe
  for (const [scriptId, iframe] of Array.from(_scriptIframes.entries())) {
    const iframeScope = iframe.dataset?.scriptScope || "character";
    if (scope && iframeScope !== scope) continue;
    const win = iframe.contentWindow; // 必须在 remove() 前捕获，remove 后 contentWindow 为 null
    try { iframe.remove(); } catch { /* ignore */ }
    _scriptIframes.delete(scriptId);
    _purgeEventBusListeners(win); // 移除该 iframe 注册的 EventBus 桥接回调，防死回调常驻泄漏
  }

  // 同步清理按钮 map 里匹配 scope 的项
  if (scope) {
    // 运行列表里已无的 scriptId → 从按钮 map 移除
    const survivorIds = new Set(survivors.map((s) => s.id));
    for (const sid of Array.from(_scriptButtonsByScript.keys())) {
      if (!survivorIds.has(sid)) _scriptButtonsByScript.delete(sid);
    }
  } else {
    _scriptButtonsByScript.clear();
  }
  _renderScriptButtonsHost();

  // 只有全清才移除 message 监听器(global 脚本常驻时不能移除)
  if (!scope && _messageHandler) {
    window.removeEventListener("message", _messageHandler);
    _messageHandler = null;
  }

  const removed = before - survivors.length;
  diag.log(`脚本 iframe 销毁: ${removed} 个(scope=${scope || "all"}),剩余 ${survivors.length}`);
}

/**
 * 销毁当前角色卡的脚本 iframe(保留 global/preset)
 * 兼容旧 API:外部调用 unloadCharacterScripts() 仍然工作
 */
export function unloadCharacterScripts() {
  unloadScriptsByScope("character");
}

/**
 * 销毁单个脚本的 iframe（用于即时禁用）
 * @param {string} scriptId
 */
export function unloadSingleScript(scriptId) {
  if (!scriptId) return;
  const idx = _runningScripts.findIndex((s) => s.id === scriptId);
  if (idx !== -1) _runningScripts.splice(idx, 1);
  const iframe = _scriptIframes.get(scriptId);
  if (iframe) {
    const win = iframe.contentWindow;
    try { iframe.remove(); } catch { /* ignore */ }
    _scriptIframes.delete(scriptId);
    _purgeEventBusListeners(win);
  }
  _scriptButtonsByScript.delete(scriptId);
  _renderScriptButtonsHost();
  diag.log(`单脚本已卸载: ${scriptId}`);
}

/**
 * S2: 加载全局脚本(scope='global')
 *
 * 数据来源:beilu-memory 的 readUserFile action 读 `global_scripts.json`
 * 文件格式:{ "scripts": [{ id, name, enabled, type:"script", content, button, data }] }
 * 生命周期:页面启动时加载一次,切角色/切预设都不卸载,用户手动修改文件后需刷新页面
 *
 * @param {string} [userName="User"] 用于 context
 */
export async function loadGlobalScripts(userName = "User") {
  try {
    // T8·切桥：raw 直连→sendAction 门面（memory 通配桥 unwrap 还原旧裸形状；HTTP 失败抛异常被本函数外层 catch 吃掉=等价原 !r.ok 静默 return）
    const j = await sendAction({ verb: "readUserFile", target: "plugins:beilu-memory", source: "web", payload: { filename: "global_scripts.json" } });
    if (!j.success || !j.content) {
      diag.debug("global_scripts.json 不存在或为空,跳过全局脚本加载");
      return;
    }
    let data;
    try { data = JSON.parse(j.content); }
    catch (e) { diag.error("global_scripts.json JSON 解析失败:", e.message); return; }

    const scripts = Array.isArray(data.scripts) ? data.scripts : [];
    const enabledScripts = scripts.filter((s) => s && s.enabled && s.type === "script");
    if (enabledScripts.length === 0) {
      diag.debug(`global_scripts.json 无启用脚本(共 ${scripts.length} 条)`);
      return;
    }

    // 注册 message handler(global 脚本也需要 postMessage 通信)
    _setupMessageHandler();

    // R-UP-6: 物化 source:'url' 全局脚本(拉取远端源码为内嵌 content)
    const materializedGlobal = await _materializeScripts(enabledScripts);
    if (materializedGlobal.length === 0) {
      diag.warn("全局脚本物化后无可运行脚本(URL 拉取全部失败?)");
      return;
    }

    // 构建 ST 兼容层脚本(global 无 charName/charId,传空字符串)
    const stCompatScript = await buildInjectionScript({
      needsST: true,
      needsMVU: false,
      needsVue: /MagVarUpdate|bundle\.js|Vue\b/.test(materializedGlobal.map(s => s.content || "").join("\n")),
      needsEJS: false,
      messageId: -1,
      userName,
      charName: "",
    });

    diag.log(`加载全局脚本: ${materializedGlobal.length} 个`);
    for (const script of materializedGlobal) {
      try {
        await _createSharedScriptIframe([script], stCompatScript, {
          userName,
          charName: "",
          charId: "",
          chatId: "",
          needsjQuery: /\$\s*\(|\bjQuery\b/.test(script.content || ""),
          primaryLorebook: "",
          chatMessages: [],
          scope: "global", // S2: 标记为 global,切角色不卸载
        });
      } catch (err) {
        diag.error(`全局脚本 "${script.name}" 创建失败:`, err.message);
      }
    }
    diag.log(`全局脚本加载完成: ${materializedGlobal.length} 个`);
  } catch (e) {
    diag.error("loadGlobalScripts 失败:", e.message);
  }
}

/**
 * S2: 销毁所有全局脚本(scope='global')
 */
export function unloadGlobalScripts() {
  unloadScriptsByScope("global");
}

/**
 * R-UP-7: 加载预设脚本(scope='preset')
 *
 * 数据来源:预设配置对象的 `scripts[]` 字段(preset.scripts)。
 *   调用方在切换/读取预设后,把预设对象传进来即可(避免本模块依赖预设存储实现)。
 * 生命周期:切预设时 unloadPresetScripts() 再 loadPresetScripts(newPreset),
 *   切角色不卸载预设脚本(unloadScriptsByScope('character') 会保留 preset),
 *   与设计文档"切预设时加载/卸载,切角色保留"一致。
 *
 * @param {object} preset - 预设配置对象,含 scripts[]
 * @param {object} context - 运行上下文 { userName, charName, charId, chatId, chatMessages }
 */
export async function loadPresetScripts(preset, context = {}) {
  // 先卸旧预设脚本(只卸 preset scope,保留 global/character)
  unloadScriptsByScope("preset");

  const rawScripts = preset?.scripts;
  if (!rawScripts || !Array.isArray(rawScripts) || rawScripts.length === 0) {
    diag.debug("预设无 scripts[]");
    return;
  }
  const enabled = rawScripts.filter((s) => s && s.enabled && s.type === "script");
  if (enabled.length === 0) {
    diag.debug(`预设有脚本但全部禁用(共 ${rawScripts.length} 条)`);
    return;
  }

  const {
    userName = "User",
    charName = "",
    charId = "",
    chatId = "",
    chatMessages = [],
  } = context;

  _setupMessageHandler();

  // R-UP-6: 把 source:'url' 的脚本内容拉取下来(走与角色/全局脚本一致的物化逻辑)
  const materialized = await _materializeScripts(enabled);
  if (materialized.length === 0) {
    diag.warn("预设脚本物化后无可运行脚本(URL 拉取全部失败?)");
    return;
  }

  const stCompatScript = await buildInjectionScript({
    needsST: true,
    needsMVU: false,
    needsVue: /MagVarUpdate|bundle\.js|Vue\b/.test(materialized.map((s) => s.content || "").join("\n")),
    needsEJS: false,
    messageId: -1,
    userName,
    charName,
  });

  diag.log(`加载预设脚本: ${materialized.length} 个`);
  for (const script of materialized) {
    try {
      await _createSharedScriptIframe([script], stCompatScript, {
        userName,
        charName,
        charId,
        chatId,
        needsjQuery: /\$\s*\(|\bjQuery\b/.test(script.content || ""),
        primaryLorebook: "",
        chatMessages,
        scope: "preset", // S2: 标记 preset,切角色不卸载
      });
    } catch (err) {
      diag.error(`预设脚本 "${script.name}" 创建失败:`, err.message);
    }
  }
  diag.log(`预设脚本加载完成: ${materialized.length} 个`);
}

/**
 * R-UP-7: 销毁所有预设脚本(scope='preset')
 */
export function unloadPresetScripts() {
  unloadScriptsByScope("preset");
}

/**
 * R3: 渲染聊天输入栏的脚本按钮 (#script-buttons-host)
 *   遍历 _scriptButtonsByScript,为每个 visible 按钮创建 DOM
 *   点击 → triggerScriptButton(scriptId, buttonName)
 */
function _renderScriptButtonsHost() {
  let host = document.getElementById("script-buttons-host");
  if (!host) {
    // 容器不存在就建一个,挂到 toolbar-left 末尾
    const toolbarLeft = document.querySelector(".chat-input-toolbar-left");
    if (!toolbarLeft) return;
    host = document.createElement("div");
    host.id = "script-buttons-host";
    host.className = "script-buttons-host";
    toolbarLeft.appendChild(host);
  }
  host.innerHTML = "";
  for (const [scriptId, info] of _scriptButtonsByScript.entries()) {
    for (const btn of info.buttons) {
      if (btn.visible === false) continue;
      const b = document.createElement("button");
      b.className = "chat-toolbar-btn script-btn";
      b.type = "button";
      b.textContent = btn.name;
      b.title = `${info.scriptName}: ${btn.name}`;
      b.dataset.scriptId = scriptId;
      b.dataset.buttonName = btn.name;
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        triggerScriptButton(scriptId, btn.name);
      });
      host.appendChild(b);
    }
  }
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
  let cleaned = content.replace(
    /^\s*import\s+['"]([^'"]+)['"]\s*;?\s*$/gm,
    (_match, url) => {
      // R-UP-4: 裸说明符也转 CDN
      bareUrls.push(_resolveImportSpecifier(url));
      return ""; // 裸导入移除，转为 <script src>
    },
  );

  // R-UP-4: 命名/默认/命名空间 import 的 URL 部分,如果是裸说明符(npm 包名),
  //   浏览器 ES module 无法解析(没有 importmap),会抛
  //   TypeError: Failed to resolve module specifier "lodash"
  //   把 `import x from 'lodash'` 改写为 `import x from 'https://esm.sh/lodash'`
  //   `_resolveImportSpecifier` 只在裸说明符(不含 / 不以 . 开头 非 http:)时替换
  //
  //   匹配三种形式:
  //     import defaultExport from 'url'
  //     import { named } from 'url'
  //     import * as ns from 'url'
  //     import defaultExport, { named } from 'url'
  const NAMED_IMPORT_RE = /^(\s*import\s+[^'"]+from\s+)(['"])([^'"]+)(['"])(\s*;?\s*)$/gm;
  let rewriteCount = 0;
  cleaned = cleaned.replace(NAMED_IMPORT_RE, (match, prefix, q1, url, q2, trail) => {
    const resolved = _resolveImportSpecifier(url);
    if (resolved !== url) rewriteCount++;
    return `${prefix}${q1}${resolved}${q2}${trail}`;
  });

  if (bareUrls.length > 0) {
    diag.debug(`裸 import 转换: ${bareUrls.length} 个 URL`, bareUrls);
  }
  if (rewriteCount > 0) {
    diag.debug(`命名 import 裸说明符 → CDN 转换: ${rewriteCount} 处`);
  }

  // 命名/默认导入保留在 remainingCode 中（<script type="module"> 天然支持）
  return { bareUrls, remainingCode: cleaned.trim() };
}

/**
 * R-UP-4: import URL 标准化
 *   裸说明符(npm 包名,如 'lodash' / '@vue/reactivity')→ esm.sh CDN URL
 *   绝对路径 / 相对路径 / URL / data: → 原样保留
 *
 *   CDN 选择 esm.sh:
 *     - 支持标准 ES module,无需 unpkg 的 ?module 参数
 *     - npm 包名 + subpath 都支持(如 'lodash-es/debounce')
 *     - 自动处理 CJS/ESM 兼容
 *
 * @param {string} spec - import 语句里 from 后的字符串
 * @returns {string} 可直接被浏览器 import 的 URL
 */
function _resolveImportSpecifier(spec) {
  if (!spec) return spec;
  // 绝对 URL(http/https/data/blob)→ 原样
  if (/^(https?:|data:|blob:)/i.test(spec)) return spec;
  // 相对路径 / 绝对路径(/ ./ ../)→ 原样
  if (spec.startsWith("/") || spec.startsWith("./") || spec.startsWith("../")) return spec;
  // 裸说明符 → esm.sh
  return `https://esm.sh/${spec}`;
}

/**
 * R-UP-6: 物化脚本内容 — 把 source:'url' 的脚本拉取为内嵌 content
 *
 * 设计要点(为什么不破坏沙箱隔离):
 *   - URL 脚本只是"内容来源"不同,拉取到的源码仍然走 _createSharedScriptIframe →
 *     _buildSharedScriptHtml 注入 sandbox="allow-scripts allow-same-origin" 的隐藏 iframe。
 *   - 不引入新的 <script src=远端URL> 直挂主文档:fetch 回来的纯文本进 iframe srcdoc,
 *     隔离边界与内嵌脚本完全一致,远端代码无法触达主页面 DOM(仅 postMessage 通道)。
 *   - 因此外部 URL 加载复用现有脚本加载链路,沙箱模型不变。
 *
 * 脚本数据结构(对齐设计文档):
 *   { source: 'inline'|'url', content?, url?, autoUpdate? }
 *   source 缺省视为 'inline'(向后兼容旧角色卡脚本,旧脚本无 source 字段)。
 *
 * @param {object[]} scripts - 启用脚本数组
 * @returns {Promise<object[]>} 物化后的脚本数组(content 已填充);URL 拉取失败的脚本被剔除
 */
async function _materializeScripts(scripts) {
  const out = [];
  for (const script of scripts) {
    // 缺省 / 'inline' → 直接用内嵌 content,无需网络
    if (!script.source || script.source === "inline") {
      out.push(script);
      continue;
    }
    if (script.source === "url") {
      const url = script.url;
      if (!url || !/^https?:\/\//i.test(url)) {
        diag.warn(`脚本 "${script.name}" source=url 但 url 非法,跳过:`, url);
        continue;
      }
      try {
        const content = await _fetchUrlScript(url, !!script.autoUpdate);
        if (content == null) {
          diag.warn(`脚本 "${script.name}" URL 拉取无内容,跳过: ${url}`);
          continue;
        }
        // 用拉取到的 content 覆盖,其余字段(按钮/data/id/name)保留
        out.push({ ...script, content });
      } catch (e) {
        diag.error(`脚本 "${script.name}" URL 拉取失败(${url}):`, e.message);
        // 拉取失败的脚本不加入运行集,不阻塞其他脚本
      }
      continue;
    }
    // 未知 source → 当 inline 兜底
    diag.warn(`脚本 "${script.name}" 未知 source="${script.source}",按 inline 处理`);
    out.push(script);
  }
  return out;
}

/**
 * R-UP-6: 拉取外部 URL 脚本源码(带缓存)
 *   autoUpdate=false → 命中缓存直接返回,避免重复网络往返
 *   autoUpdate=true  → 每次重新 fetch,拿远端最新
 * @param {string} url
 * @param {boolean} autoUpdate
 * @returns {Promise<string|null>}
 */
async function _fetchUrlScript(url, autoUpdate) {
  if (!autoUpdate && _urlScriptCache.has(url)) {
    diag.debug(`URL 脚本命中缓存: ${url}`);
    return _urlScriptCache.get(url).content;
  }
  // R1-SKIP: url=用户填的远端脚本源(任意外站) + cache 选项 + .text()；apiFetch 的 401→/login 对外站有害。
  const resp = await fetch(url, { cache: autoUpdate ? "no-store" : "default" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const content = await resp.text();
  _urlScriptCache.set(url, { content, fetchedAt: Date.now() });
  diag.log(`URL 脚本已拉取: ${url} (${content.length} 字符, autoUpdate=${autoUpdate})`);
  return content;
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
${(block.code || "").replace(/<\/(script)/gi, "<\\/$1")}
    </` + `script>`,
    )
    .join("\n    ");

  // jQuery 注入（如果需要）— 必须在脚本之前同步加载
  const jqueryTag = needsjQuery
    ? `<!-- jQuery 3.7.1 -->
    <script src="/vendor/jquery.min.js"></` +
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
	   if (typeof window.z === 'undefined' || typeof window.z.object !== 'function') {
	       try {
	           // 主 CDN：testingcf（与 bundle.js 的其他依赖使用同一 CDN，各地区可达性更好）
	           const zod2 = await import('https://testingcf.jsdelivr.net/npm/zod@4/+esm');
	           window.z = zod2;
	           self.z = zod2;
	           console.log('[scriptRunner] Zod 4.x loaded from testingcf CDN, methods:', Object.keys(zod2).slice(0, 8).join(', '));
	       } catch(e1) {
	           console.warn('[scriptRunner] testingcf CDN failed:', e1.message, '— trying fallback CDN');
	           try {
	               // 备选 CDN：cdn.jsdelivr.net
	               const zod2 = await import('https://cdn.jsdelivr.net/npm/zod@4/+esm');
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
  // 角色卡 script 字段（buttons/data/info）经 JSON.stringify 直嵌入 <script> 体；
  // JSON.stringify 不转义 </script，恶意卡可借按钮名/data 突破脚本标签。
  // HTML 脚本数据结束标签为 </script 后跟 空白/'/'/'>'（如 "</script >" 也闭合），故按 </script 前缀中和（保留大小写以 round-trip）。
  const buttonsJson = JSON.stringify(buttons).replace(/<\/(script)/gi, "<\\/$1");
  const scriptDataJson = JSON.stringify(script.data || {}).replace(/<\/(script)/gi, "<\\/$1");

  return `
/* === ST Compat: Script API for "${_escapeJs(script.name)}" === */
(function() {
    var _scriptId = '${_escapeJs(script.id)}';
    var _scriptName = '${_escapeJs(script.name)}';
    var _scriptButtons = ${buttonsJson};
    var _scriptData = ${scriptDataJson};
    var _scriptInfo = ${JSON.stringify(script.info || "").replace(/<\/(script)/gi, "<\\/$1")};

    // 脚本标识
    window.getScriptId = function() { return _scriptId; };
    window.getScriptName = function() { return _scriptName; };
    window.getScriptInfo = function() { return _scriptInfo; };

    // 脚本按钮 — R3: 改动后 postMessage 通知父页面更新输入栏 DOM
    var _postScriptButtons = function() {
        try {
            window.parent.postMessage({
                type: 'beilu-script-buttons-update',
                scriptId: _scriptId,
                scriptName: _scriptName,
                buttons: JSON.parse(JSON.stringify(_scriptButtons)),
            }, '*');
        } catch (e) { /* ignore */ }
    };
    window.getScriptButtons = function() { return JSON.parse(JSON.stringify(_scriptButtons)); };
    window.replaceScriptButtons = function(newButtons) { _scriptButtons = newButtons || []; _postScriptButtons(); };
    window.updateScriptButtonsWith = function(fn) { _scriptButtons = fn(_scriptButtons) || []; _postScriptButtons(); };
    window.appendInexistentScriptButtons = function(buttons) {
        var existing = _scriptButtons.map(function(b) { return b.name; });
        (buttons || []).forEach(function(b) {
            if (existing.indexOf(b.name) === -1) _scriptButtons.push(b);
        });
        _postScriptButtons();
    };
    // 初始化时广播一次角色卡自带按钮
    setTimeout(_postScriptButtons, 0);

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

    // S3: pagehide 卸载钩子 — 切角色/重载 iframe 时自动清空事件监听,避免残留
    //   酒馆助手 predefine.js:41 的同款机制
    window.addEventListener('pagehide', function() {
        try {
            if (typeof window.eventClearAll === 'function') window.eventClearAll();
            // 同时清空脚本按钮(通知父页面移除 DOM)
            _scriptButtons = [];
            _postScriptButtons();
        } catch (e) { /* ignore */ }
    });

    // R-UP-5: console 日志聚合 — 脚本 iframe 的所有 console 输出转发到父页面 diag
    //   保留原生 console(DevTools 仍可见),额外 postMessage 到父页面
    //   方便用户不开 DevTools 也能在后台监控/脚本日志面板看到脚本输出
    (function(){
        var _origConsole = {
            log: console.log.bind(console),
            warn: console.warn.bind(console),
            error: console.error.bind(console),
            info: console.info.bind(console),
            debug: console.debug.bind(console),
        };
        // 把任意 args 安全序列化(避免循环引用/DOM 等无法 JSON 化的对象)
        function _safeSerialize(args) {
            return Array.prototype.map.call(args, function(a) {
                try {
                    if (a === null || a === undefined) return String(a);
                    if (typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean') return String(a);
                    if (a instanceof Error) return a.stack || a.message || String(a);
                    // DOM 节点
                    if (typeof Node !== 'undefined' && a instanceof Node) return '[DOM:' + (a.nodeName || 'Node') + ']';
                    return JSON.stringify(a, function(k, v) {
                        if (typeof v === 'function') return '[Function ' + (v.name || 'anonymous') + ']';
                        if (v && typeof v === 'object' && v.constructor && v.constructor.name !== 'Object' && v.constructor.name !== 'Array') {
                            return '[' + v.constructor.name + ']';
                        }
                        return v;
                    });
                } catch (e) { return '[Unserializable: ' + e.message + ']'; }
            }).join(' ');
        }
        function _forward(level, args) {
            try {
                window.parent.postMessage({
                    type: 'beilu-script-log',
                    scriptId: _scriptId,
                    scriptName: _scriptName,
                    level: level,
                    message: _safeSerialize(args),
                    timestamp: Date.now(),
                }, '*');
            } catch (e) { /* 父页面通信失败不影响脚本运行 */ }
        }
        console.log   = function() { _origConsole.log.apply(console, arguments);   _forward('log',   arguments); };
        console.warn  = function() { _origConsole.warn.apply(console, arguments);  _forward('warn',  arguments); };
        console.error = function() { _origConsole.error.apply(console, arguments); _forward('error', arguments); };
        console.info  = function() { _origConsole.info.apply(console, arguments);  _forward('info',  arguments); };
        console.debug = function() { _origConsole.debug.apply(console, arguments); _forward('debug', arguments); };
        // 同时捕获 uncaught error,脚本抛异常时能看到
        window.addEventListener('error', function(e) {
            _forward('error', [(e.message || 'script error') + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0)]);
        });
        window.addEventListener('unhandledrejection', function(e) {
            _forward('error', ['UnhandledRejection: ' + (e.reason && (e.reason.stack || e.reason.message || String(e.reason)))]);
        });
    })();
})();
`;
}

/**
 * 创建一个脚本 iframe
 *
 * S1 改造:外层调用方每次只传 1 个脚本,每个脚本对应独立 iframe
 *   (函数签名保留 scripts[] 是为了复用 _buildSharedScriptHtml 的内部逻辑,
 *    不需要大改 HTML 生成部分;实际长度 = 1)
 *
 * iframe 被保存到 _scriptIframes Map,key = script.id,卸载时按 id 精准销毁。
 * 每个 iframe 都独立加载 ST 兼容层/jQuery/Zod,彼此不共享全局变量。
 * 这样任一脚本抛出 uncaught error 不影响其他脚本 iframe 的运行。
 *
 * @param {object[]} scripts - 启用的脚本数组(S1 后始终是长度 1)
 * @param {string} stCompatScript - ST 兼容层 <script> 标签
 * @param {object} context - 运行上下文
 */
async function _createSharedScriptIframe(scripts, stCompatScript, context) {
  if (!scripts || scripts.length === 0) return;
  const _scriptLabel = scripts.length === 1 ? `"${scripts[0].name}"` : `${scripts.length} 个脚本`;
  diag.log(`脚本 iframe 创建: ${_scriptLabel}`);

  // 构建 iframe HTML (内部按 scripts 数组迭代,长度 1 时即单脚本模式)
  const html = _buildSharedScriptHtml(scripts, stCompatScript, context);

  // 创建隐藏 iframe
  const iframe = document.createElement("iframe");
  iframe.className = "beilu-script-iframe";
  // S1: 每脚本 iframe 都加 data-script-id,便于父页面从 e.source 反查 scriptId
  iframe.dataset.scriptId = scripts[0]?.id || "";
  // S2: scope 从 context 传入(默认 'character'),切换角色时按 scope 选择性卸载
  iframe.dataset.scriptScope = context.scope || "character";
  iframe.style.cssText =
    "display:none!important;width:0;height:0;border:none;position:absolute;";
  iframe.sandbox = "allow-scripts allow-same-origin";
  iframe.srcdoc = html;

  // 添加到 DOM
  document.body.appendChild(iframe);
  // S1: 注册到 Map 而非单例 _sharedIframe
  if (scripts[0]?.id) _scriptIframes.set(scripts[0].id, iframe);

  // 记录脚本到运行列表
  for (const script of scripts) {
    const buttons = (script.button?.buttons || []).map((b) => ({
      name: b.name || "",
      visible: b.visible !== false,
    }));

    _runningScripts.push({
      id: script.id,
      name: script.name,
      enabled: script.enabled,
      scope: context.scope || "character",
      buttons,
    });
  }

  diag.log(
    `脚本 iframe 已创建: ${_scriptLabel},总按钮: ${_runningScripts.reduce((n, s) => n + s.buttons.length, 0)}`,
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
    // N15：origin 校验（镜像 iframeRenderer.mjs:278）。脚本 srcdoc iframe origin="null"、同源=location.origin；拒其它=防任意 origin 调脚本通信口
    if (e.origin !== 'null' && e.origin !== window.location.origin) return;

    switch (e.data.type) {
      case "beilu-script-reload": {
        // S1: 按 scriptId 找到对应 iframe 重载,不影响其他脚本
        //     脚本 iframe 内 reloadIframe() 会带 scriptId (见 _generateScriptApiCode)
        //     srcdoc = "" 触发 iframe 销毁(pagehide 触发脚本 eventClearAll)
        //     再恢复 srcdoc 触发重建
        const scriptId = e.data.scriptId;
        if (!scriptId) break;
        const iframe = _scriptIframes.get(scriptId);
        if (!iframe) {
          diag.debug(`脚本 iframe 重载请求但未找到: scriptId=${scriptId}`);
          break;
        }
        diag.log(`脚本 iframe 重载: scriptId=${scriptId}`);
        const currentSrcdoc = iframe.srcdoc;
        iframe.srcdoc = "";
        setTimeout(() => {
          // 再次检查 iframe 是否还在 Map 中(用户可能已切角色触发 unload)
          if (_scriptIframes.get(scriptId) === iframe) {
            iframe.srcdoc = currentSrcdoc;
          }
        }, 50);
        break;
      }

      case "beilu-script-buttons-update": {
        // R3: 脚本声明按钮集合 → 聚合到 map → 重绘输入栏 host
        const { scriptId, scriptName, buttons } = e.data;
        if (!scriptId) break;
        if (!Array.isArray(buttons) || buttons.length === 0) {
          _scriptButtonsByScript.delete(scriptId);
        } else {
          _scriptButtonsByScript.set(scriptId, {
            scriptName: scriptName || scriptId,
            buttons: buttons.filter((b) => b && b.name),
          });
        }
        _renderScriptButtonsHost();
        break;
      }

      case "beilu-script-log": {
        // R-UP-5: 脚本 iframe 内 console 聚合 → 父页面 diag 系统
        //   场景:用户不开 DevTools 也能在后台监控/UI 日志面板看到脚本输出
        //   data: { scriptId, scriptName, level, message, timestamp }
        const { scriptId, scriptName, level = "log", message = "" } = e.data;
        const tag = `[script:${scriptName || scriptId}]`;
        // 通过 diag 统一收集,diagLogger 自带 snapshot/ringbuffer
        if (level === "error") diag.error(tag, message);
        else if (level === "warn") diag.warn(tag, message);
        else if (level === "info") diag.log(tag, message);
        else if (level === "debug") diag.debug(tag, message);
        else diag.log(tag, message);
        // 转发自定义事件,UI 面板可订阅显示
        window.dispatchEvent(new CustomEvent("beilu:script-log", { detail: e.data }));
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
        // 标记来源 window，iframe 销毁时 _purgeEventBusListeners 据此精准移除，防泄漏
        bridgeCallback._beiluSource = source;
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
    .filter((msg) => msg && msg.role !== "system") // 仅过滤真 system 消息；隐藏(智能清理)消息保留进数组,由 is_system 标记,脚本可经 getChatMessages({hide_state}) 读取
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
        is_hidden: !!msg.extension?._hidden,
        is_user: stRole === "user",
        message: msgText,
        data: {},
        extra: {},
        // === 酒馆内部字段（setChatMessages / getVariables 依赖） ===
        // 隐藏态(extension._hidden)映射到 ST is_system，使 getChatMessages 的 hide_state 过滤 + is_hidden 输出正确
        is_system: !!msg.extension?._hidden,
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
