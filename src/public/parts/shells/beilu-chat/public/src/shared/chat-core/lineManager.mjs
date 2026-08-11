/**
 * [lineManager.mjs] — 多对话线管理器（凛倾 2026-07-26：「活动栏下面做一个+号，点击打开新的对话界面，
 *   选择角色卡、对话文件；关闭的话可以加个小×，点击给提醒」）。
 * 只管「＋拉线 + 活动栏线图标 + 切显示 + ×关闭」；不管对话渲染（chat.mjs）、不管列表（conversationManager）。
 *
 * 【术语·负向定义（凛倾 0726 纠正，禁再异化）】
 *   「窗口/线」= 同一个页面实例内的一个会话（chatid），**不是**浏览器窗口、不是 tab、不是 iframe、
 *   不是第二个页面实例。本模块出现 window.open / iframe / 二次挂载根组件 = 方案错误，回滚。
 *   依据：① 底部功能层.txt 定义「窗口级=code/work/chat/airp」是隔离域；② 原话「加个小×点击给提醒」
 *   在浏览器窗口方案下物理不可实现（关窗拦不住）；③ 原话「持久的线」——window 句柄主窗 reload 即失。
 *
 * 【why / 架构对齐】底部功能层.txt：功能层是一个、管线多条、同时激活直接异步。
 *   多条线 = **并行链路**：后端按 chatid 各自生成互不干扰，前端 _wsPool 每 chatid 一条 WS 并存。
 *   所以切换线 = **只切显示**（换渲染哪条线的消息），不切后端、不改后端归属状态。
 *
 * 【功能链】
 *   ＋按钮（index.html 静态声明 #ide-line-new-btn）→ openLinePicker() 弹层
 *   （全部角色卡下拉 getPartList + 该卡对话列表[复用对话列表渲染单源] + 执行端下拉 getIdeInstances）
 *   → 确认 → bindIdeInstance(manual) 绑执行端 → _openLine() 登记 + localStorage 持久
 *   → _renderLineTabs() 活动栏出对话图标 → 点图标 _switchToLine() 本窗切显示
 *   → 右键图标 → beiluConfirm 提醒 → _closeLine() 摘图标 + unbindIdeInstance
 *
 * 【影响范围】localStorage `beilu-lines`（哪几条对话挂在活动栏，持久）；活动栏 DOM 增删线图标；
 *   新建对话复用 createNewChat + bindCharToChat + classifyNewChat（conversationManager 单源）。
 * 【相交】← ide.mjs initIdeActivityBar（仅 ide 活动栏动态 import 注入）
 *   → conversationManager.mjs（createNewChat/classifyNewChat + 列表渲染单源：buildModeBadge/
 *     buildInUseLabel/buildOtherWindowBadge/compareConvOrder/loadConvMeta）→ parts.mjs（getPartList 角色卡名单源）
 *   → sendAction getChatList / bindCharToChat / bindIdeInstance → beiluDialog beiluConfirm → utils escapeHtml
 */

import { sendAction } from "../transport/sendAction.mjs";
// 列表渲染/排序全部复用对话列表的现成单源（模式徽标/在用标/另一窗口角标/排序比较器/本地元数据），
// 不在本文件重写第二套——凛倾 0726「为什么不按照我们已经有的设计去做」。
import {
  createNewChat, classifyNewChat,
  buildModeBadge, buildInUseLabel, buildOtherWindowBadge, compareConvOrder, loadConvMeta,
} from "./conversationManager.mjs";
import { beiluConfirm } from "../widgets/beiluDialog.mjs";
// 当前模式读点单源（同 preset.mjs:54 的依据：featureControls 不反向引本文件，无环）。
//   窗口是 **code 模式的资产**，判"这个窗口属不属于现在这个模式"必须读权威值，
//   不能读 window.__beiluCurrentMode —— 那个键全项目零 producer（只有本文件读过），恒 undefined。
import { getCurrentMode } from "../../panels/feature/featureControls.mjs";
// 面板路由状态单源（ide.mjs 同款读点）：窗口图标高亮要知道"聊天面板是否在前台"，
//   核不核对这个，决定了图标亮不亮是"正在看"还是"自说自话"（0727 截图双暗态病根）。
import { layoutState } from "../layout/core.mjs";
import { escapeHtml, formatRelativeTime } from "../state/utils.mjs";
// 白盒追踪单源（进 backendMonitor「运行时日志」面板）。多窗口这条链原本只有本文件自造的
//   console.log 埋点，链路断在哪只能翻控制台肉眼找——与全项目 wbTrace/wbDetect 体系脱节。
import { wbTrace, wbDetect } from "../widgets/whitebox.mjs";
import { getPartList } from "../../../../../../scripts/parts.mjs"; // 全部角色卡单源（同 backup.mjs:435）
import { showToast } from "../../../../../../scripts/toast.mjs";

/** 线登记：chatid → { char, label, ide, idePort, openedAt }。
 *  持久到 localStorage：凛倾要的是「持久的线」——刷新/重开浏览器后活动栏上的线还在，
 *  不是随内存消失的临时视图态。线本身不含消息数据，只是「哪几条对话挂在活动栏上」。 */
const _lines = new Map();
const LINES_KEY = "beilu-lines";

function _loadLines() {
  try {
    const raw = localStorage.getItem(LINES_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    for (const it of arr) if (it && it.chatid) _lines.set(it.chatid, { char: it.char || "", label: it.label || it.chatid, mode: it.mode || "", ide: it.ide || "", idePort: it.idePort ?? null, openedAt: it.openedAt || 0, home: !!it.home, draft: it.draft || "" });
    // [0727 双home洗盘] 读入时就核不变量：home 语义上只有一个，读到多个=历史污染
    //   （0727 错误追踪实证：两个 chatid 同报"主窗口，不能关闭"→全部关不掉、b 锁全失效）。
    //   污染时全部清零，真 home 由 _registerHomeWindow/chatInitDone 按当前对话重新认领——
    //   宁可短暂零 home（各线都能关、不锁），不可多 home。不在这里猜哪个是真的：hash 此刻未必就位。
    const _homes = [..._lines.values()].filter((l) => l && l.home);
    if (_homes.length > 1) {
      console.error(`[拦截] 线登记里有 ${_homes.length} 个 home 标记（只允许 1 个），已全部清零等待重新认领`);
      for (const l of _lines.values()) l.home = false;
      _saveLines();
    }
  } catch (e) { console.warn("[lineManager] 线登记读取失败:", e?.message); }
}

/** 把 cid 设为**唯一**的 home 窗口（其余一律清掉 home 标记）。
 *  home 决定两件事：能不能关（_closeLine 拒关 home）、能不能原生切换
 *  （_beiluCurWinLocked 对 home 返回 null＝不锁）。多条 home 时两个机制同时失效：
 *  所有窗口都关不掉（满屏「这是主窗口，不能关闭」），b 的绑定锁也全部失效。
 *  home 语义上只有一个——页面自带的那个容器，所以设置动作必须收口成"设一个＝清其余"。
 *  init 时跑一次即可自动洗掉 localStorage 里的历史污染。 */
function _setHomeUnique(cid) {
  let changed = false;
  for (const [k, l] of _lines) {
    const want = k === cid;
    if (!!l.home !== want) { l.home = want; changed = true; }
  }
  if (changed) { _saveLines(); _renderLineTabs(); }
  return changed;
}

function _saveLines() {
  try {
    const arr = [];
    for (const [chatid, l] of _lines) arr.push({ chatid, ...l });
    localStorage.setItem(LINES_KEY, JSON.stringify(arr));
  } catch (e) { console.warn("[lineManager] 线登记保存失败:", e?.message); }
}

// 线的 chatid 集合桥（同 window._beiluGetChatId 范式，避免 transport 层反向 import chat-core 成环）。
// 消费者：websocket.mjs 连接池逐出——已拉起的线是并行链路，其 WS 绝不能被当"闲置连接"逐掉。
window._beiluGetLineChatIds = () => [..._lines.keys()];

/** 对话被删 → 摘掉它的线（凡建 per-chat 登记必配删链，否则活动栏留死图标、点了切到不存在的对话）。
 *  producer：conversationManager.deleteConversation（本窗删对话的唯一出口）。
 *  用 window 桥而非 import：conversationManager 已被本模块 import，反向静态引会成环。 */
window._beiluDropLine = (chatid) => {
  void (async () => {
    if (!chatid || !_lines.has(chatid)) return;
    // 删的正好是眼前这个窗口 → 必须先完成回 home 的统一提交，再摘当前 DOM。
    // 动态依赖尚未准备好时旧窗口继续留在眼前，不能先删后等，制造无可见消息区的中间态。
    if (chatid === _curWinId) {
      const homeId = [..._lines.entries()].find(([cid, l]) => l && l.home && cid !== chatid)?.[0] || "";
      if (!homeId) throw new Error(`删除当前窗口 ${chatid} 前找不到主窗口落脚点`);
      const switched = await _showWin(homeId);
      // 若等待期间用户已切到第三个窗口，当前目标已经不再可见，也可以安全清理；
      // 若仍停在待删窗口，则统一提交没有成功，保留旧状态并明确失败。
      if (!switched && _curWinId === chatid) throw new Error(`删除当前窗口 ${chatid} 前切回主窗口失败`);
    }
    // 后端删对话链已经 forgetChat/清 IDE 绑定；这里只走同一个前端资源回收入口，
    // 避免复制一套漏掉 pooled WS 的 `_lines.delete + DOM.remove`。
    await _removeLineCore(chatid, { unbind: false });
  })().catch((e) => {
    console.error("[lineManager] 删除对话后的窗口清理失败:", e);
    showToast?.("error", `删除对话后的窗口清理失败：${e?.message || e}`, 6000);
  });
};

/** 活动栏线图标容器（＋号之前）：每条线一个对话图标，点=本窗切过去，右键/×=关闭。 */
let _tabsBox = null;
/** 后台线的生成态：chatid → true（正在生成）。来源=websocket 的 beilu:line-activity（非活跃线纯状态事件）。
 *  why：并行链路里其他线在后台跑，界面上必须看得见——否则用户不知道 B 线是在跑、跑完了、还是死了。 */
const _lineBusy = new Set();

/** 后端绑定快照（getIdeInstances 结果，_refreshBindHint 刷新时同步更新）。
 *  【why 不用线登记里的 idePort/ide 显示】那两个字段是**拉线那一刻的快照**、存进 localStorage 后
 *  永不更新；而后端绑定是活的（自愈重绑会换端口、实例重启编号会变）→ tooltip 会长期显示过时的
 *  执行端，用户据此判断"AI 在哪干活"就是错的。显示一律取后端真值，快照只在后端查不到时兜底。 */
let _bindSnapshot = { instances: [], bindings: {} };

/** 某条线当前真实绑定的执行端显示名（后端真值优先，回退拉线时的快照，再回退"未绑定"）。 */
function _lineIdeLabel(chatid, fallback) {
  const b = _bindSnapshot.bindings?.[chatid];
  if (!b) return fallback || "";
  const inst = (_bindSnapshot.instances || []).find((i) => i && i.port === b.port);
  if (inst) return _ideLabel(inst) + (inst.connected ? "" : "（已离线）");
  return `端口 ${b.port}（不在线）`;
}

function _renderLineTabs() {
  if (!_tabsBox) return;
  // 高亮＝当前挂在页面上的那个窗口（_curWinId），不是全局 currentChatId：
  //   窗口是并存的，"现在看的是哪个窗口"只有 _curWinId 说了算。
  const _cur = _curWinId || (() => { try { return window._beiluGetChatId?.() || ""; } catch { return ""; } })();
  // [0727 凛倾「我只让你做 code……也就是说 code 被隔离，你把隔离打破了？」]
  //   窗口是**它被开出来的那个模式**的资产：在 code 里开的窗口只属于 code。
  //   切到别的模式，这些图标就不该在活动栏上（点得到＝隔离被打破）。
  //   why 按模式分组而不是硬写"只有 code 能开窗口"：凛倾说的是隔离，code 是他当前在用的那个，
  //   不是"其余模式禁止"——按模式各持一组窗口，隔离成立且不限死。
  //   a（home）例外：它就是主界面本身，任何模式下都存在，只是内容跟着模式换。
  //   `l.mode &&` 兜底：旧登记没有 mode 字段（本次改动前存的），不因缺字段而消失，
  //   下次开窗口即自愈。
  const _nowMode = (() => { try { return getCurrentMode() || ""; } catch { return ""; } })();
  // 高亮的第二个条件：聊天面板在前台。连接/文件等面板占着视图时窗口图标不亮——
  //   亮 = "你正看着这个窗口"，视图是连接面板时它就是谎（0727 截图：线图标亮着、屏幕是连接面板）。
  const _chatFront = layoutState.ideActivePanel === "ai-chat";
  let html = "";
  let _no = 0;
  for (const [chatid, l] of _lines) {
    // [0727 凛倾「第三个图标=a=data-ide-panel="ai-chat"」] 主窗口不渲染线图标：
    //   a 的图标就是活动栏现成的「AI 对话」面板钮（点它=回主窗口，见 initLineManager 的面板钮监听）。
    //   此前 home 也出一个带编号的线图标 = 主窗口凭空两个图标（0727 凛倾「为什么又出现两个图标」）。
    //   home 登记本身保留（窗口表/搬家/锁判定都要它），只是不画图标。
    if (l.home) continue;
    if (l.mode && _nowMode && l.mode !== _nowMode) continue;
    const active = chatid === _cur && _chatFront;
    const busy = _lineBusy.has(chatid);
    const _live = _winEls.has(chatid); // DOM 还在（没被 LRU 回收）
    const _ide = _lineIdeLabel(chatid, l.ide); // 后端真值优先，不用 localStorage 里的旧快照
    _no++;
    html +=
      `<button class="ide-activity-btn${active ? " ide-activity-active" : ""}" data-line-tab="${escapeHtml(chatid)}" ` +
      `title="${escapeHtml(`#${_no} ${l.char || "?"} / ${l.label}`)}${_ide ? ` → ${escapeHtml(_ide)}` : ""}${busy ? "\n● 正在生成" : ""}${_winDirty.has(chatid) ? "\n✦ 有新消息（切过去会补上）" : ""}${_live ? "" : "\n（DOM 已回收，点开会重建）"}\n点击显示这个窗口 · 右键关闭" ` +
      `style="position:relative;flex-shrink:0;">` +
      // 窗口编号（凛倾 0727「图标左边给一个数字ui」）：贴左侧竖排，支持到三位数（100 个窗口）
      `<span style="position:absolute;left:1px;top:50%;transform:translateY(-50%);font-size:9px;line-height:1;` +
      `opacity:${active ? "0.95" : "0.55"};font-weight:${active ? "700" : "400"};pointer-events:none;">${_no}</span>` +
      `<span class="ide-activity-icon"${_live ? "" : ' style="opacity:0.5"'}><i data-ic="message"></i></span>` +
      // 右上角状态点：绿=正在生成；橙=隐藏期间有新消息未看（切过去会补上）。不改按钮尺寸不动布局
      (busy
        ? `<span style="position:absolute;top:3px;right:3px;width:6px;height:6px;border-radius:50%;background:#22c55e;"></span>`
        : (_winDirty.has(chatid)
          ? `<span style="position:absolute;top:3px;right:3px;width:6px;height:6px;border-radius:50%;background:#f59e0b;"></span>`
          : "")) +
      `</button>`;
  }
  // 全量重建会把滚动位置清零。窗口少时无感，但 100 个窗口时用户滚到下半段看第 60 条线，
  //   后台任一条线有生成活动（beilu:line-activity）就会触发重渲染 → 视图跳回顶部，
  //   等于滚动条被系统抢着往上拽。存取一次 scrollTop 即可（DOM 结构不变，位置有效）。
  const _sc = _tabsBox.scrollTop;
  _tabsBox.innerHTML = html;
  if (_sc) _tabsBox.scrollTop = _sc;
  // 激活互斥的反向半边：窗口图标亮起时摘掉面板钮（此时只可能是 ai-chat）的高亮。
  //   正向半边在 ide.mjs:35-37（点面板钮清全部 .ide-activity-btn 含线图标）；这半边原来不存在，
  //   两套激活态各亮各的 = 0727 截图双暗态。聊天维度的"当前"由窗口图标表达，一栏同刻只亮一个。
  if (_chatFront && html.includes("ide-activity-active")) {
    document.querySelectorAll('#ide-activity-bar [data-ide-panel].ide-activity-active')
      .forEach((b) => b.classList.remove("ide-activity-active"));
  }
}

/** 对话摘要 → 显示名（口径同 conversationManager：自定义名 > 首条用户消息截断 > id 截断） */
function _chatLabel(c) {
  return (
    (c && c.customName) ||
    (c && c.firstUserMessage ? String(c.firstUserMessage).slice(0, 24) : "") ||
    (c && c.chatid ? String(c.chatid).slice(0, 12) : "对话")
  );
}

/** 在线执行端名（工作区末段目录名 + 类型，无工作区时退端口号——都是用户可辨识的窗口标识）。
 *  CLI 与 YonBan 都可作为线的执行端：有 YonBan 在线时 CLI 按设计互斥离线（防指令打架+省资源），
 *  不开 VSCode 时 CLI 在线=纯本体场景的唯一执行端。故此处不筛类型，在线即可选。 */
function _ideLabel(inst) {
  const root = Array.isArray(inst?.workspaceFolders) ? inst.workspaceFolders[0] : "";
  const seg = root ? String(root).replace(/[\\/]+$/, "").split(/[\\/]/).pop() : "";
  const kind = inst?.kind === "cli" ? "本体 CLI" : "VSCode";
  return `${kind} · ${seg || "未开工作区"} (:${inst?.port})`;
}

/** 拉一条线：登记 + 在活动栏出对话图标（**不开浏览器窗口**）。
 *  【凛倾 0726 纠正】「打开一个窗口」= 本体体系里的作业窗口/线，不是 window.open：
 *    原实现 window.open 让新页面把整套应用（IDE 面板/后端管理/监控）重新加载一遍 = 嵌套。
 *    正确形态：确认后活动栏多一个对话图标，点它在**本页面内**显示那个窗口（_switchToLine）。 */
function _openLine(chatid, charName, label, ideLabel, idePort, mode) {
  // [0727 凛倾冲突规格「新建和主a重合,那么直接禁止创建」] 主窗口正在持有的对话禁止再开成副窗口：
  //   一条对话只该有一个窗口；且下方 _lines.set 是整包覆盖写，对 home 条目执行会把 home 标写丢
  //   （主窗口登记被改写成普通线=主窗口消失）。拒绝必须可见（toast+错误追踪），不静默。
  if (_lines.get(chatid)?.home) {
    console.error(`[拦截] 开新对话线被拒：${chatid} 是主窗口（a）当前持有的对话，禁止重复开窗`);
    showToast?.("warning", "这条对话就是主窗口正在显示的那条，不用开新窗口——主窗口本身就是它。");
    return false;
  }
  // 同一对话重复拉线：一条对话在活动栏上只该有一个图标（Map 天然去重），但要让用户知道
  // 「这条已经在了」而不是以为新拉了一条；执行端改绑的情况下顺带更新登记。
  const _existed = _lines.has(chatid);
  // 线登记 = 这条窗口的持久档案（角色卡 / 模式 / 执行端 / 草稿），随 localStorage 一起活着。
  //   [0727 校准] 原注释写「界面只有一套…复制 DOM 会撞 id，所以靠装载上下文而不是复制界面」——
  //   那是错的，也正是把"开窗口"做成"切对话"的借口。现在**真的复制了界面**（_createWin
  //   cloneNode 消息区容器），id 冲突用容器 id 后缀屏蔽解决（_maskIds），窗口是真并存的。
  //   登记里的这些字段不再用于"切线时整包装载"，只用于图标显示、模式归属判定和草稿。
  _lines.set(chatid, { char: charName || "", label: label || chatid, mode: mode || "", ide: ideLabel || "", idePort: idePort ?? null, openedAt: _existed ? (_lines.get(chatid).openedAt || Date.now()) : Date.now() });
  _saveLines();
  // 刚绑完执行端就把绑定快照拉一次：_bindSnapshot 的三个刷新点（初始化 / ide-instance-gone /
  //   chatInitDone）都不覆盖「刚拉线」这一刻，不补的话新线 tooltip 会显示成"未绑定"直到下次切对话。
  //   fire-and-forget：它内部会 _renderLineTabs，失败也不影响线已经建好。
  _refreshBindHint(document.getElementById("ide-line-new-btn"));
  _renderLineTabs();
  showToast?.(_existed ? "info" : "success", _existed ? `这条线已在活动栏上，已切过去` : `已拉起对话线：${label || chatid}（点活动栏图标切换）`);
  void _switchToLine(chatid); // 拉起即切过去（用户刚选完，期望立刻看到）
}

// ══════════════════════════════════════════════════════════════════
// 窗口容器（凛倾 0727 定案：开两个窗口、a 还在、切换只是显示哪个）
// ══════════════════════════════════════════════════════════════════
// 【规格】窗口 = 一份消息区副本，绑定一条对话。a=原生主窗口，b=＋号开的窗口。
//   两者并存：切到 b，a 原样留着（凛倾「不是切换窗口，是增加窗口」）。
// 【实际做法】[0727 校准] **所有窗口都挂在 DOM 上，用 hidden 显隐**，不是 detach 存内存。
//   （原注释写的是 detach 方案，代码从来不是那样——以代码为准。）
//   隐藏的窗口仍在文档里，所以它的 WS 消息能实时渲染进去、流式逐字照跑、切过去即完整；
//   detach 掉的话后台窗口就渲染不了，只能"切回来补拉"，那不叫并行。
//   id 冲突用**容器 id 后缀屏蔽**解决（_maskIds）：显示的那个持有标准名 #chat-messages，
//   隐藏的改成 #chat-messages--w<chatid> → 现成的 getElementById 链路天然打在当前窗口上。
//   窗口数不限，DOM 副本按 LRU 限量（WIN_DOM_MAX），超出的摘掉，再点按懒加载重建。
// 【范式来源】项目里现成的显隐切换：ide.mjs:40-44 侧栏面板互斥、layout.mjs switchTab。
// 窗口单元 = **消息区**（#chat-messages），不含输入区。
// 【why 不整块 #chat-container】输入区那 7 个元素（输入框/发送/上传/语音/拍照/文件/附件预览）
//   在 messageInput.mjs:50-56 是**模块顶层 const** 且事件直绑其上——cloneNode 复制 DOM 不复制
//   事件，复制出来的输入框必然是死的（能打字、Ctrl+Enter 不发、点发送没反应）。
//   而同一时刻用户只可能在一个窗口里打字，输入区共用零体感差别；每个窗口的草稿用一个变量存。
const WIN_EL_ID = "chat-messages";
/** 草稿读写（输入区共用，内容按窗口分）。
 *  存进 _lines 那条记录里 → 跟着 _saveLines 一起进 localStorage，**刷新页面不丢**。
 *  不另建一个 Map + 第二套持久化：线的登记本来就是持久的，草稿是它的一个字段。 */
function _getDraft(chatid) { return _lines.get(chatid)?.draft || ""; }
function _setDraft(chatid, text) {
  const l = _lines.get(chatid);
  if (!l) return;
  if ((l.draft || "") === (text || "")) return; // 没变就不写盘
  l.draft = text || "";
  _saveLines();
}
/** 隐藏期间收到过新消息的窗口：切回去时补拉一次（没收到就完全不动，不是每次切都重渲染）。
 *  producer=websocket.mjs 非活跃分支（那里按设计跳过后台 DOM 渲染，见 :705）。 */
const _winDirty = new Set();
/** 窗口↔容器绑定的对外出口：消息带着 chatid 来，直接取它的容器渲染进去。
 *  绑定在开窗口那一刻就建好了（_winEls.set），消费方不需要"找"、不需要按 currentChatId 判断。 */
window._beiluGetWinEl = (chatid) => _winEls.get(chatid) || null;
/** 当前显示的窗口 chatid（空串=窗口体系未启用）。消费方=subModePanel._getCurrentChatId 等
 *  共享 chrome 的"当前对话"读点：窗口并存后 hash 只是 a 的原生指针（切窗口不写 hash），
 *  "现在看的是哪条对话"唯一真值在 _curWinId——谁持有窗口表谁出这个答案（单 producer）。 */
window._beiluCurWinChatId = () => _curWinId;
/** 当前显示的窗口是否"已绑定、不可切换"（凛倾 0727：b 已经绑定了不可以切换 / a 是原生的可以切换）。
 *  返回 null＝可自由切换（a，或还没有任何窗口）；返回 {chatid,label}＝锁定，原生切换应被拒。
 *  消费方＝chat.mjs switchCharacterScope（一切切换的殊途同归点，挡一处覆盖所有入口）。 */
/** 草稿的窗口维度出口（凛倾 0727 状态包里的「输入框草稿」）。
 *  【why 有这个桥】messageInput 原本把草稿存成**全局单份**（KEYS.BEILU_CHAT_DRAFT，
 *    理由见 messageInput.mjs:73「#send_textarea 是全模式共享的同一个 DOM」）。多窗口下
 *    输入区仍然共用那一个框，但草稿必须按窗口分——两套并行写同一个框就是双源：
 *    程序给 .value 赋值不触发 input 事件 → 全局键停在上一个窗口的文本 → 刷新后
 *    _restoreDraft 把别的窗口的草稿恢复到当前窗口里。
 *  【收口方式】有窗口时草稿的唯一真值 = _lines[chatid].draft，messageInput 三个草稿函数
 *    全部委托到这里；没有窗口（lineManager 未加载/未登记）时它报 has()=false，
 *    messageInput 走原来的全局键，零行为变化。 */
window._beiluWinDraft = {
  has: () => !!_curWinId && _lines.has(_curWinId),
  get: () => _getDraft(_curWinId),
  set: (text) => _setDraft(_curWinId, text),
  clear: () => _setDraft(_curWinId, ""),
};
/** 当前显示的窗口是否"已绑定、不可切换"（凛倾 0727：b 已经绑定了不可以切换 / a 是原生的可以切换）。 */
window._beiluCurWinLocked = () => {
  if (!_curWinId) return null;
  const l = _lines.get(_curWinId);
  if (!l || l.home) return null; // a＝原生主窗口，不锁
  return { chatid: _curWinId, label: l.label || _curWinId };
};
window._beiluMarkWinDirty = (chatid) => {
  if (chatid && chatid !== _curWinId && _winEls.has(chatid)) {
    _winDirty.add(chatid);
    _renderLineTabs(); // 图标上让用户看得见"这个窗口有新内容"
  }
};
/** chatid → 该窗口的 DOM（**全部挂在页面上**，靠 hidden 显隐，不 detach） */
const _winEls = new Map();
/** 当前正在显示的窗口 chatid */
let _curWinId = "";
/**
 * 当前可见窗口的完整只读绑定包。
 *
 * code 模式已进入 lineManager 的多窗口隔离域：chatId / charName / mode 必须
 * 同时来自 `_curWinId -> _lines` 这一条登记，禁止拿可见 chatId 再拼全局角色/模式。
 * 其他模式没有多窗口绑定语义，直接返回本体当前对话/角色/模式。
 *
 * 每次返回新的 frozen 对象：消费方只能读完整包，不能改写 lineManager 内部登记。
 * code 初始化未完成/登记不完整时原样暴露空轴，交给消费方 fail-closed；
 * 不用 hash 或全局角色猜一份“看似完整”的跨窗包。
 */
window._beiluCurWinBinding = () => {
  let currentMode = "";
  try { currentMode = String(getCurrentMode() || "").trim(); } catch { /* 由消费方校验空轴 */ }
  if (currentMode === "code") {
    const line = _curWinId ? _lines.get(_curWinId) : null;
    return Object.freeze({
      chatId: line ? String(_curWinId || "").trim() : "",
      charName: line ? String(line.char || "").trim() : "",
      mode: line ? String(line.mode || "").trim() : "",
      multiWindow: true,
    });
  }
  let chatId = "";
  let charName = "";
  try { chatId = String(window._beiluGetChatId?.() || "").trim(); } catch { /* 由消费方校验空轴 */ }
  try { charName = String(window._beiluGetCharName?.() || "").trim(); } catch { /* 由消费方校验空轴 */ }
  return Object.freeze({ chatId, charName, mode: currentMode, multiWindow: false });
};
/**
 * 按 chatId 查询已登记窗口的完整绑定。异步弹窗/自动保存可在用户切窗后
 * 仍找回动作发起窗口的角色与模式，不得用当前全局角色拼接。
 */
window._beiluWinBindingForChat = (chatId) => {
  const id = String(chatId || "").trim();
  const line = id ? _lines.get(id) : null;
  if (!line) return null;
  return Object.freeze({
    chatId: id,
    charName: String(line.char || "").trim(),
    mode: String(line.mode || "").trim(),
    home: !!line.home,
    multiWindow: true,
  });
};
/** 窗口容器的挂载点（#chat-container 的父节点） */
let _winHost = null;
/** 活跃 DOM 上限（凛倾 0727「最多可以承担 100 个窗口」）：
 *  窗口**数量**不设限（登记很轻），重的是 DOM 副本。超过上限就把最久没看的那个 DOM 摘掉，
 *  只留登记与图标；再点它时按现成链路重建，用户看到的仍是那条线。 */
const WIN_DOM_MAX = 8;
/** chatid → 上次显示时刻（LRU：决定摘哪个 DOM） */
const _winTouch = new Map();
/** 可见窗口提交序号：每次切换先占一个 epoch；旧异步准备/拉取晚到时只能退出，不能覆盖新窗口。 */
let _winSwitchEpoch = 0;
/** 窗口切换的三项框架依赖只准备一次；失败时清掉 Promise，下一次允许真实重试。 */
let _winSwitchDepsPromise = null;

function _prepareWinSwitchDeps() {
  if (!_winSwitchDepsPromise) {
    _winSwitchDepsPromise = Promise.all([
      import("../transport/endpoints.mjs"),
      import("../transport/websocket.mjs"),
      import("../render/virtualQueue.mjs"),
    ]).then(([endpoints, websocket, virtualQueue]) => ({ endpoints, websocket, virtualQueue }))
      .catch((e) => {
        _winSwitchDepsPromise = null;
        throw e;
      });
  }
  return _winSwitchDepsPromise;
}

/**
 * id 后缀开关：**显示的窗口用标准 id，隐藏的窗口 id 加后缀**。
 * 【why】两个窗口同时挂在 DOM 上，#chat-messages / #send_textarea 这些 id 会重复，
 *   而全项目 1356 处 getElementById 都按标准名找元素。让隐藏窗口的 id 带后缀，
 *   标准名在任一时刻**只属于当前显示的那个窗口** → 所有现成链路零改动，天然打到当前窗口。
 */
function _maskIds(el, chatid, hide) {
  const suf = `--w${chatid}`;
  if (!el.id) return;
  if (hide) { if (!el.id.endsWith(suf)) el.id += suf; }
  else if (el.id.endsWith(suf)) el.id = el.id.slice(0, -suf.length);
  // ★ 只改**窗口容器自己**这一个 id，绝不遍历子孙（0727 修）。
  //   【为什么原来遍历是错的】容器内的子元素全是消息，它们的 id ＝ 消息 id ＝ 后端
  //   crypto.randomUUID()（models.mjs:240，fromJSON:296 兜底）——**本来就跨对话唯一，
  //   不存在冲突，不需要屏蔽**。给它们加后缀等于把正在用的 id 改掉：
  //     · StreamRenderer.renderFrame 的 document.getElementById(消息id) 落空
  //       → 后台窗口的逐字渲染彻底不工作（切回来才发现内容缺一段）
  //     · messageList 的 #edit-input-${id} / #confirm-button-${id} 等派生查询同样落空
  //   真正会撞的只有界面结构 id，而窗口单元 #chat-messages 在 index.html:877-880 是个
  //   **空 div**，内部零静态 id —— 所以要屏蔽的从头到尾就只有容器自身这一个。
}

/**
 * 多窗口不变量断言（白盒单源，不是 console 打印流水账）。
 * 【A · 标准 id 唯一】同一时刻页面上只能有一个 #chat-messages。两个并存时
 *   getElementById 恒命中靠前那个 → 新窗口的消息永远渲染不进去，而界面上毫无报错
 *   —— 这正是 0727 那次"点了没反应"的事故形态，必须做成硬断言而不是靠人眼看。
 *   失效来源：_maskIds 漏改、a 未被登记就开 b、clone 插入顺序异常。
 * 【B · 当前窗口活着】目标容器必须在文档里且已去掉 hidden。失效来源：LRU 回收了
 *   正在显示的窗口、_showWin 遍历时 _winEls 与实际 DOM 不同步。
 * 断言本身绝不影响功能：整体 try 包住，出错静默。
 */
function _wbWinInvariant(node, chatid) {
  try {
    const n = document.querySelectorAll(`#${WIN_EL_ID}`).length;
    wbDetect("window", `${node}:idUnique`, n === 1,
      `页面上有 ${n} 个 #${WIN_EL_ID}（必须恰好 1，否则新窗口消息渲染不进去）`,
      { chatid, count: n, wins: _winEls.size });
    const el = _winEls.get(chatid);
    wbDetect("window", `${node}:curLive`, !!el && el.isConnected && !el.classList.contains("hidden"),
      "当前窗口的容器不在文档里、或仍是隐藏态",
      { chatid, hasEl: !!el, connected: !!el?.isConnected });
  } catch { /* 断言不得影响功能 */ }
}

/**
 * 显示某个已存在的窗口，隐藏其余（所有可见窗口切换的唯一提交入口）。
 *
 * 提交边界：动态依赖先准备；epoch 与目标存活检查通过后，路由 chatId / WS 活跃指针 /
 * 渲染 owner 在同一个无 await 区间完成；然后才交换 DOM、写 _curWinId、派发外部事件。
 * 因而任何消费者看到 beilu:window-switched 时，发送链已经指向同一个目标。
 */
async function _showWin(chatid, { loadContent = false } = {}) {
  const target = String(chatid || "");
  const epoch = ++_winSwitchEpoch;
  if (!target) throw new Error("窗口切换目标 chatid 为空");

  // 准备阶段不改路由、不改 DOM、不改 _curWinId：依赖慢/失败时用户仍停在原窗口和原绑定。
  const deps = await _prepareWinSwitchDeps();
  if (epoch !== _winSwitchEpoch) return false;
  const targetEl = _winEls.get(target);
  if (!_lines.has(target) || !targetEl?.isConnected) {
    throw new Error(`窗口切换目标不可用: ${target}`);
  }

  const previousWinId = _curWinId;
  const previousTransportId = deps.endpoints.currentChatId;
  try {
    // 三项均为同步调用；此处至外部事件派发之间禁止 await。
    deps.virtualQueue.setActiveWindow?.(target);
    deps.endpoints.setCurrentChatId(target);
    deps.websocket.reconnectWebSocket();
  } catch (e) {
    // 同步提交失败就恢复原绑定与渲染 owner；可见 DOM 尚未动过。
    try { deps.virtualQueue.setActiveWindow?.(previousWinId); } catch { /* 原错误优先 */ }
    try {
      deps.endpoints.setCurrentChatId(previousTransportId);
      deps.websocket.reconnectWebSocket();
    } catch (restoreErr) {
      console.error("[lineManager] 窗口路由回滚失败:", restoreErr);
    }
    throw new Error(`窗口传输绑定提交失败: ${e?.message || e}`, { cause: e });
  }

  // 数据请求在外部事件前同步创建，callApi 会在这一刻冻结目标 URL；后续窗口切换不会改写该请求。
  const needsContent = loadContent || _winDirty.has(target);
  const initialDataPromise = needsContent ? deps.endpoints.getInitialData() : null;

  // 离开前把当前窗口的草稿收起来（输入区共用，内容按窗口存）
  const input = document.getElementById("send_textarea");
  if (input && previousWinId) _setDraft(previousWinId, input.value);
  for (const [cid, el] of _winEls) {
    const isTarget = cid === target;
    _maskIds(el, cid, !isTarget);
    el.classList.toggle("hidden", !isTarget);
  }
  _curWinId = target;
  _winTouch.set(target, Date.now());
  if (input) input.value = _getDraft(target);

  // 外部只在完整提交后看到切换事实；不写角色卡、模式槽或 hash。
  const line = _lines.get(target);
  window.dispatchEvent(new CustomEvent("beilu:window-switched", {
    detail: { chatid: target, char: line?.char || "", label: line?.label || "", home: !!line?.home },
  }));

  if (needsContent) {
    if (_winDirty.has(target)) wbTrace("window", "show:refetchDirty", { chatid: target });
    await _loadWinContent(target, deps, epoch, initialDataPromise);
  }
  if (epoch === _winSwitchEpoch && _curWinId === target) {
    _evictWinDom();
    _wbWinInvariant("show", target);
  }
  return epoch === _winSwitchEpoch && _curWinId === target;
}

/** 超出活跃 DOM 上限时，摘掉最久没看的那个窗口的 DOM（登记与图标保留）。
 *  懒加载的回收半边：**摘 DOM 必须连带卸渲染上下文**（与 _closeLine 同一套配对删链）。
 *  只 remove() 不卸的话，_wins 里那份 virtualList + 该窗口自己的 RAF loop 还活着，
 *  继续按帧 renderFrame 到已从文档里摘掉的孤儿容器上——回收一个泄漏一个，
 *  100 窗口场景下正是要命的地方。重建路径完好：再点 → _winEls 里没有 → _createWin
 *  重新 clone + initializeVirtualQueue 全量重载，上下文自然重建。 */
function _evictWinDom() {
  if (_winEls.size <= WIN_DOM_MAX) return;
  const cands = [..._winEls.keys()]
    .filter((cid) => cid !== _curWinId && !_lines.get(cid)?.home)
    .sort((a, b) => (_winTouch.get(a) || 0) - (_winTouch.get(b) || 0));
  while (_winEls.size > WIN_DOM_MAX && cands.length) {
    const cid = cands.shift();
    const el = _winEls.get(cid);
    try { el?.remove(); } catch { /* 已不在 DOM */ }
    _winEls.delete(cid);
    void import("../render/virtualQueue.mjs")
      .then((m) => m.dropWindowCtx?.(cid))
      .catch(() => { /* 渲染层未加载 */ });
    console.log(`[lineManager] 窗口 ${cid} 的 DOM 与渲染上下文已回收（超过 ${WIN_DOM_MAX} 个活跃窗口），再点会重建`);
  }
}

/** 新建一个窗口：复制一份界面 → 清空内容 → 挂上页面（与 a 并存）→ 用现成链路加载它的对话 */
async function _createWin(chatid) {
  const cur = document.getElementById(WIN_EL_ID);
  if (!wbDetect("window", "create:hostFound", !!cur,
    `找不到消息区 #${WIN_EL_ID}，无法复制窗口`, { chatid })) return false;
  if (!_winHost) _winHost = cur.parentNode;
  // ★ 开 b 之前必须确保 a 已在窗口表里。_registerHomeWindow 跑在 init/chatInitDone，
  //   若在它之前就点了 ＋（chatid 尚未就位的窗口期），_showWin 遍历不到 a →
  //   a 既不会被 hidden、id 也不会加后缀 → 页面上同时存在两个 #chat-messages，
  //   getElementById 命中的是 a，b 的消息永远渲染不进去。此处兜底认领。
  if (!_curWinId) {
    const _homeId = (() => { try { return window._beiluGetChatId?.() || ""; } catch { return ""; } })();
    if (_homeId && _homeId !== chatid) {
      _winEls.set(_homeId, cur);
      _winTouch.set(_homeId, Date.now());
      _curWinId = _homeId;
      if (!_lines.has(_homeId)) {
        const _c = (() => { try { return window._beiluGetCharName?.() || ""; } catch { return ""; } })();
        _lines.set(_homeId, { char: _c, label: "当前对话", mode: "", ide: "", idePort: null, openedAt: Date.now(), home: true });
        // [0727 双home确诊修] 设 home 必走唯一化收口：本兜底路径原来只 set 不洗，与旧登记里残留的
        //   home 并存 = 两个 chatid 同报"主窗口不能关闭"（0727 错误追踪实证 kx/bq 交替被拒）。
        //   _setHomeUnique 只在有变化时落盘，这里的新条目自身无变化，故显式补一次 _saveLines。
        _setHomeUnique(_homeId);
        _saveLines();
      }
      console.log("[lineManager] 兜底认领主窗口 a:", _homeId);
    }
  }
  // cloneNode(false)：只复制容器本身（class/样式/结构位置），**不复制子节点**
  //   → 新窗口的消息区天然是空的，不带上一个窗口的消息，也不用手动清
  const clone = cur.cloneNode(false);
  _maskIds(clone, chatid, true);     // 先加后缀挂上去（此刻它还没显示）
  clone.classList.add("hidden");
  _winHost.insertBefore(clone, cur.nextSibling); // 紧挨着原消息区，保持在输入区之上
  _winEls.set(chatid, clone);
  // 新容器在 initializeVirtualQueue 成功前都算脏；并发第二次点击会接管加载，不能把空壳当成已就绪窗口。
  _winDirty.add(chatid);
  wbTrace("window", "create:cloned", { chatid, wins: _winEls.size });
  const shown = await _showWin(chatid, { loadContent: true });
  if (shown) _wbWinInvariant("create", chatid);
  return shown;
}

/**
 * 用**现成链路**把某条对话的内容加载进当前挂着的窗口。
 * 【why 不用 switchToChat/switchCharacterScope】那两个是「把当前窗口切到另一条对话」的语义——
 *   会写全局角色卡指针、写后端在用指针、跑 MO-INIT，正是把 a 覆盖掉的元凶（凛倾：
 *   「不是替换角色卡、替换主窗口，是开两个窗口」）。这里只做「让这个窗口显示这条对话」：
 *   指当前 chatid → 连它的 WS（_wsPool 本就每 chatid 一条并存）→ 拉数据 → 渲染。
 */
async function _loadWinContent(chatid, deps, epoch, initialDataPromise) {
  let data = null;
  try { data = await initialDataPromise; }
  catch (e) {
    console.error("[lineManager] 窗口内容加载失败:", e);
    showToast?.("error", `这个窗口的对话数据没取到：${e?.message || e}`, 6000);
    if (_lines.has(chatid)) _winDirty.add(chatid);
    return false;
  }
  // 旧窗口的请求晚到时不调用全局渲染入口；保留脏标，下一次真正显示它时重拉。
  if (epoch !== _winSwitchEpoch || _curWinId !== chatid || !_winEls.get(chatid)?.isConnected) {
    if (_lines.has(chatid)) _winDirty.add(chatid);
    wbTrace("window", "load:staleSkipped", { chatid, epoch, currentEpoch: _winSwitchEpoch, current: _curWinId });
    return false;
  }
  try { await deps.virtualQueue.initializeVirtualQueue(data); }
  catch (e) {
    console.error("[lineManager] 窗口渲染失败:", e);
    showToast?.("error", `这个窗口的消息渲染失败：${e?.message || e}`, 6000);
    if (_lines.has(chatid)) _winDirty.add(chatid);
    return false;
  }
  // initializeVirtualQueue 在入口已冻结 ownerChatId=chatid；期间若发生更新切换，它仍只完成旧窗口
  // 自己的队列，不会解析到新窗口。完成后再次检查 epoch，禁止旧调用继续声称自己仍是当前提交。
  const stillCurrent = epoch === _winSwitchEpoch && _curWinId === chatid;
  _winDirty.delete(chatid);
  if (!stillCurrent) {
    wbTrace("window", "load:completedAfterSwitch", {
      owner: chatid,
      epoch,
      currentEpoch: _winSwitchEpoch,
      current: _curWinId,
    });
  }
  return stillCurrent;
}

/** 点线图标 = **显示那个窗口**（凛倾 0727「切窗口 = 显示这个、隐藏那个。仅此而已」）。
 *  两条分支都经同一提交入口，不写角色卡/模式/hash 等全局身份指针：
 *    · 窗口已在页面上（_winEls 有）→ _showWin 同步对齐显隐 + HTTP 路由 + WS 指针 + 渲染 owner
 *    · 第一次打开 → _createWin 复制一份消息区容器 + 用现成链路加载它的对话
 *  【why 不用 switchToChat / switchCharacterScope】（本注释 0727 校准：早先这里确实调的是
 *    switchToChat，那是错的）——那两个是「把**当前这个**窗口切到另一条对话」的替换语义，
 *    会写全局角色卡指针、写后端在用指针、跑 MO-INIT，结果就是点 b 把 a 的对话和角色卡一起
 *    顶掉（凛倾「不是你个 sb 去替换角色卡，去替换主窗口，是开两个窗口」）。
 *    要的是**增加**窗口，语义相反，不能复用。
 *  【并行链路】其他窗口不受影响：后端按 chatid 各自生成、_wsPool 每 chatid 一条 WS 并存
 *    （websocket.mjs:487，且 :502 已拉起的线永不被逐出），本函数只改「当前显示哪个」。 */
async function _switchToLine(chatid) {
  // [0727 埋定位点] 这条链有多个 await（动态 import ×3），任一处卡住/抛错，表面症状都是
  //   同一个「点了没反应」。每步留痕，卡在 await 上时最后一条 trace 就是断点。
  //   [白盒收口 0727] 原为本文件自造的 console.log，与全项目 wbTrace 体系脱节、进不了
  //   backendMonitor 运行时日志面板。改走单源（wbTrace 内部已含 console 输出，不重复打）。
  const _t = (s) => wbTrace("window", "switchLine", { step: s, chatid });
  _t("① 收到点击，进入 _switchToLine");
  const l = _lines.get(chatid);
  if (!l) {
    // 静默 return 是原来的行为：图标在、登记没了 → 点了永远没反应且无任何提示
    console.warn(`[line] ✗ 线登记里没有 ${chatid}（图标与登记不同步），本次点击无效`);
    showToast?.("warning", "这条线的登记已丢失（图标与登记不同步），请重新拉线");
    return;
  }
  try {
    // ══ 视图接管（0727 截图病根之一：日志"已显示"、屏幕还是连接面板）══
    //   窗口住在 ai-chat 侧栏面板里（moveChatContainer → #ide-panel-ai-chat，layout.mjs:315）。
    //   别的面板占前台时只切窗口显隐 = 在看不见的地方表演。先把聊天面板带到前台——
    //   走现成面板路由的单入口（活动栏按钮 click → ide.mjs 互斥/主区联动/存态一套全跑），
    //   不在这里复制第二套路由逻辑。
    if (layoutState.ideActivePanel !== "ai-chat") {
      document.querySelector('#ide-activity-bar [data-ide-panel="ai-chat"]')?.click();
      _t("①.5 聊天面板已带到前台（原前台面板不是 ai-chat）");
    }
    // ══ 切窗口 = 统一提交显示、HTTP 路由、WS 活跃指针和渲染 owner ══
    // 已在眼前也过同一入口：它能修复历史残留的路由/WS 指针漂移，并重试上次失败的脏加载。
    if (chatid === _curWinId) {
      _t("② 已在该窗口，重新对齐传输绑定");
      const shown = await _showWin(chatid);
      if (!shown) { _t("② 切换请求已被更新的窗口请求取代"); return; }
      _lineBusy.delete(chatid);
      _renderLineTabs();
      return;
    }
    if (_winEls.has(chatid)) {
      // 这个窗口已经在页面上：只是被 hidden 了 → 显示它、隐藏其余。
      //   **不拉数据、不重渲染、不写任何全局角色卡指针** —— 消息/滚动/输入框里的字原封不动。
      _t("② 显示该窗口（其余隐藏，不重新加载）");
      const shown = await _showWin(chatid);
      if (!shown) { _t("② 切换请求已被更新的窗口请求取代"); return; }
      _t("③ 已显示");
    } else {
      // 第一次打开这条线：复制一份界面，用现成链路把它的对话加载进去
      _t("② 新建窗口（复制界面 + 加载该对话）");
      const ok = await _createWin(chatid);
      if (!ok) {
        if (!_winEls.has(chatid)) showToast?.("error", "窗口创建失败（找不到界面容器）");
        else _t("② 新窗口请求已被更新的窗口请求取代");
        return;
      }
      _t("③ 新窗口已就绪");
    }
    // 绿点兜底自愈：切过去 = 当前线，生成状态由消息区直接呈现，图标绿点对它没有意义，清掉。
    //   why 需要这层：清 busy 的两个信号（message_replaced 终态 / typing_status 空列表）都可能丢
    //   —— typing_status 在 broadcast 的背压丢弃名单里，WS 断开时终态也会丢 —— 丢了绿点就常亮。
    //   切走后若这条线仍在生成，后续 stream_update 会重新点亮，不会漏报。
    _lineBusy.delete(chatid);
    _renderLineTabs(); // 高亮随当前对话走
  } catch (e) {
    console.warn("[lineManager] 切线失败:", e?.message);
    showToast?.("error", `切换对话线失败: ${e?.message || e}`);
  }
}

/** × 关闭一条线：确认提醒 → 摘图标（不删对话——线是持久的，随时可重新拉起） */
async function _closeLine(chatid) {
  const l = _lines.get(chatid);
  if (!l) return;
  // a（原生主窗口）不可关：它是页面自带的那一个容器，关掉就没有界面了
  // [T7] 拦截必须进错误追踪：console.error 走 backendMonitor 现成拦截管线（pushError），
  //   否则 0727 形态复现——用户对着满屏拒绝提示、错误追踪面板却写着"无错误"，两套不同源没法排查。
  if (l.home) {
    console.error(`[拦截] 关闭窗口被拒：${chatid} 是主窗口（home），不能关闭`);
    showToast?.("info", "这是主窗口，不能关闭");
    return;
  }
  if (chatid === _curWinId) {
    console.error(`[拦截] 关闭窗口被拒：${chatid} 是当前正在显示的窗口，请先切走`);
    showToast?.("warning", "请先切到别的窗口，再关闭这个");
    return;
  }
  const ok = await beiluConfirm(
    `关闭对话线「${l.label}」？\n只移除活动栏图标，不删除对话；后台生成不受影响，随时可重新拉起。`,
    { title: "关闭对话线", confirmText: "关闭这条线", danger: true },
  );
  if (!ok) return;
  await _removeLineCore(chatid);
}

/** 关线的共用核心：解绑执行端 + 摘登记 + 配对删 DOM/渲染上下文/脏标 + 落盘重绘。
 *  两个调用方：_closeLine（用户手动，先过 home/当前窗守卫 + beiluConfirm）、
 *  beilu:ide-instance-gone 自动关窗（T5 凛倾 0727「关闭vscode就要关闭绑定的窗口」——
 *  实例没了无需确认，窗口随实例走）。 */
async function _removeLineCore(chatid, { unbind = true } = {}) {
  // 配对解绑（凛倾 0726「停止 yonban 停止多窗口」的线侧一半）：关线即释放它对执行端的占用，
  // 否则后端绑定表留死键，该对话下次在别处打开还会被路由到这个已关的窗口。
  if (unbind) {
    try {
      await sendAction({ verb: "unbindIdeInstance", target: "plugins:beilu-memory", source: "web", payload: { chatid } });
    } catch (e) {
      console.warn("[lineManager] 解绑执行端失败（后端绑定表留有死键）:", e?.message);
    }
  }
  _lines.delete(chatid);
  // 配对清理：关窗口就把它的 DOM + 渲染上下文一并丢弃
  //   （凡建 per-窗口资源必配删链，否则页面堆死节点、渲染上下文里的 timer 也会泄漏）
  try { _winEls.get(chatid)?.remove(); } catch { /* 已不在 DOM */ }
  _winEls.delete(chatid);
  _winTouch.delete(chatid);
  _winDirty.delete(chatid); // 配对补全：脏标也随窗口走（_closeLine 原漏此键，_beiluDropLine 有）
  try {
    const [virtualQueue, websocket] = await Promise.all([
      import("../render/virtualQueue.mjs"),
      import("../transport/websocket.mjs"),
    ]);
    virtualQueue.dropWindowCtx?.(chatid);
    websocket.closeParallelWs?.(chatid);
  } catch (err) {
    // 登记/DOM 已经摘除，资源清理失败必须可见，不能留下无日志的孤儿 WS/渲染上下文。
    console.warn(`[lineManager] 窗口 ${chatid} 的渲染/连接资源清理失败:`, err?.message || err);
  }
  _saveLines();
  _renderLineTabs();
}

/**
 * ＋选择器弹层：已拉起的线（×关闭）+ 角色卡下拉 + 对话文件列表（含新建）。
 * dialog.modal/modal-box/btn 复用应用现成 daisy 风格（与 beiluDialog 同款），主题自动一致。
 */
export async function openLinePicker() {
  // 数据：对话清单（含 chars/inUseCount/usedByModes/lastMessage*）+ 全部角色卡名单（getPartList 单源）
  let chats = [];
  try {
    const r = await sendAction({ verb: "getChatList", target: "shells:chat", source: "web" });
    if (Array.isArray(r)) chats = r;
  } catch (e) {
    console.warn("[lineManager] getChatList 失败:", e?.message);
  }
  // ══ 执行端：**两套 IDE 系统的多开维度不同，检测必须分类**（凛倾 0727 纠正）══
  // 本体 CLI：多开维度 = **线**。一个 CLI 进程服务 N 条线，线的隔离靠 chatid
  //   （shell 池 session_key=chatid、工具调用带会话键）——**不存在"选哪个 CLI"**。
  // YonBan：多开维度 = **VSCode 窗口**。一窗口一实例，线↔实例 1:1，才需要选"绑哪个窗口"。
  // 【原错误模型】把"一条线必须绑一个实例"当成两套共同规则 → 单个 CLI 被当成"只能有一个窗口"，
  //   本体拉第二条线时检测不到第二个实例 = 凛倾原话「本体一建立新的多窗口就被检测到没有其他的
  //   正在运行的，只有本体的 cli」——本体的多线被套进 YonBan 的"多实例"口径里 = 嵌套。
  // 【判据】纯 YonBan → 按窗口选；纯 CLI → 唯一执行端，N 条线共用，不让用户选也不拦；
  //   hybrid/backend → 在线 CLI 与所有在线 YonBan 都是可选路由目标，由用户显式绑定。
  // 分类由后端分类器下发（getIdeInstances → ideMode/windowDimension，resolveIdeMode 单点），
  //   前端**不再自己判 kind**：谁是当前系统、窗口是什么维度，只有一个地方说了算。
  let ideMode = "none";        // "yonban" | "cli" | "hybrid" | "none"
  let windowDimension = null;  // "instance"(一窗口一实例) | "line"(一进程多线) | "backend"(按执行后端选择)
  let ideInstances = [];       // 需要用户选择的在线执行端（纯 YonBan 或 hybrid）
  let cliInstance = null;      // CLI 执行端（windowDimension==="line"，唯一，不需要选）
  try {
    const ir = await sendAction({ verb: "getIdeInstances", target: "plugins:beilu-memory", source: "web" });
    const list = (Array.isArray(ir?.instances) ? ir.instances : []).filter((i) => i && i.connected);
    ideMode = ir?.ideMode || "none";
    windowDimension = ir?.windowDimension || null;
    if (windowDimension === "instance" || windowDimension === "backend") ideInstances = list;
    else if (windowDimension === "line") cliInstance = list.find((i) => i.primary) || list[0] || null;
  } catch (e) {
    console.warn("[lineManager] getIdeInstances 失败:", e?.message);
  }

  const _charsOf = (c) => (Array.isArray(c?.chars) ? c.chars : c?.chars ? [c.chars] : []);
  // 角色卡名单 = **全部已安装角色卡**（getPartList("chars") 单源，同 backup.mjs:435 范式）。
  // 【why 不用 charList】charList 是「当前对话里的角色」，不是「有哪些角色卡」——用它的话下拉里
  //   永远只有本窗当前对话那一张卡（0726 实证：装了 5 张卡，下拉只显示"代码001"），
  //   而开新线恰恰是要去**别的**角色卡上开。_global 排除（非角色卡，同 backup.mjs 口径）。
  let chars = [];
  try {
    const _all = await getPartList("chars");
    if (Array.isArray(_all)) chars = _all.filter((c) => c && c !== "_global");
  } catch (e) {
    console.warn("[lineManager] 角色卡列表读取失败，回退对话清单反推:", e?.message);
  }
  if (!chars.length) { // 回退：从对话清单反推（getPartList 不可用时的兜底，不是主路径）
    const s = new Set();
    for (const c of chats) for (const n of _charsOf(c)) if (n) s.add(n);
    chars = [...s];
  }
  if (!chars.length) {
    showToast?.("error", "没有可用角色卡，无法开新对话线");
    return;
  }

  const dlg = document.createElement("dialog");
  dlg.className = "modal";
  dlg.innerHTML =
    `<div class="modal-box max-w-md">` +
    `<h3 class="font-bold text-base mb-2">➕ 开新对话线</h3>` +
    `<div data-role="lines"></div>` +
    `<div class="text-sm mb-1" style="opacity:0.8;">角色卡</div>` +
    `<select class="select select-sm w-full mb-2" data-role="char"></select>` +
    `<div class="text-sm mb-1" style="opacity:0.8;">绑定工具执行端</div>` +
    `<select class="select select-sm w-full mb-2" data-role="ide"></select>` +
    `<div class="text-sm mb-1" style="opacity:0.8;">对话文件</div>` +
    `<div data-role="chats" style="max-height:40vh;overflow-y:auto;border:1px solid rgba(128,128,128,0.25);border-radius:8px;"></div>` +
    `<div class="modal-action" style="display:flex;gap:0.5rem;justify-content:flex-end;">` +
    `<button type="button" class="btn btn-sm" data-role="cancel">取消</button>` +
    `<button type="button" class="btn btn-sm btn-primary" data-role="open" disabled>打开新窗口</button>` +
    `</div></div>`;
  document.body.appendChild(dlg);

  const charSel = dlg.querySelector('[data-role="char"]');
  const ideSel = dlg.querySelector('[data-role="ide"]');
  const chatBox = dlg.querySelector('[data-role="chats"]');
  const linesBox = dlg.querySelector('[data-role="lines"]');
  const openBtn = dlg.querySelector('[data-role="open"]');
  let picked = null; // { chatid: string|"__new__", label }

  for (const n of chars) {
    const o = document.createElement("option");
    o.value = n;
    o.textContent = n;
    charSel.appendChild(o);
  }

  // 执行端选择：按后端下发的多开维度分类呈现（见上方 ══ 注释）。
  //   ① 有 YonBan 窗口 → 逐窗口列出（值=实例编号=窗口权威身份，端口存 dataset 供绑定）；
  //   ② 只有 CLI → 唯一执行端、N 条线共用：不给选项让用户挑，只如实显示"共用同一个 CLI"，
  //      并照常把这条线绑到它（绑定=路由归属，多条 chatid 指同一 port 完全合法，
  //      线之间的隔离由 chatid 会话键在 CLI 侧完成，不靠多进程）；
  //   ③ hybrid/backend → 列出全部在线 CLI + YonBan，让用户逐线选择绑定；
  //   ④ 两者都没有 → 如实说明，不静默开一条没有执行端的瘸线。
  const _cliOnly = windowDimension === "line" && !!cliInstance;
  if ((windowDimension === "instance" || windowDimension === "backend") && ideInstances.length) {
    for (const inst of ideInstances) {
      const o = document.createElement("option");
      o.value = inst.instanceId || String(inst.port);
      o.dataset.port = String(inst.port);
      o.dataset.instanceId = typeof inst.instanceId === "string" ? inst.instanceId : "";
      o.textContent = _ideLabel(inst) + (inst.primary ? " · 默认" : "");
      ideSel.appendChild(o);
    }
  } else if (_cliOnly) {
    const o = document.createElement("option");
    o.value = cliInstance.instanceId || String(cliInstance.port);
    o.dataset.port = String(cliInstance.port);
    o.dataset.instanceId = typeof cliInstance.instanceId === "string" ? cliInstance.instanceId : "";
    o.textContent = `${_ideLabel(cliInstance)} · 多条线共用`;
    ideSel.appendChild(o);
    ideSel.disabled = true; // 唯一执行端：显示但不可选（没有第二个可选，给下拉是假选择）
  } else {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "（没有在线的执行端：请打开 VSCode/YonBan 或启动本体 CLI）";
    ideSel.appendChild(o);
    ideSel.disabled = true;
  }

  const renderLines = () => {
    if (!_lines.size) { linesBox.innerHTML = ""; return; }
    let html = `<div class="text-sm mb-1" style="opacity:0.8;">已拉起的线</div><div style="display:flex;flex-direction:column;gap:2px;margin-bottom:8px;">`;
    for (const [cid, l] of _lines) {
      html +=
        `<div style="display:flex;align-items:center;gap:6px;padding:2px 6px;border-radius:6px;background:rgba(128,128,128,0.08);">` +
        `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;">🧵 ${escapeHtml(l.char)} / ${escapeHtml(l.label)}${l.ide ? ` <span style="opacity:0.6;">→ ${escapeHtml(l.ide)}</span>` : ""}</span>` +
        // [T7] home 不给 ✕：主窗口必然拒关（_closeLine:home 守卫），给一个必然失败的按钮=谎——
        //   0727 事故里用户就是对着它连点出满屏"这是主窗口，不能关闭"。显示身份，不显示假操作。
        (l.home
          ? `<span style="font-size:10px;opacity:0.55;flex-shrink:0;">主窗口</span>`
          : `<button type="button" class="btn btn-xs btn-ghost" data-line-close="${escapeHtml(cid)}" title="关闭这条线（会先确认）">✕</button>`) +
        `</div>`;
    }
    linesBox.innerHTML = html + `</div>`;
  };
  linesBox.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-line-close]");
    if (!btn) return;
    await _closeLine(btn.getAttribute("data-line-close"));
    renderLines();
  });

  const renderChats = () => {
    const ch = charSel.value;
    // 排序口径复用对话列表单源（置顶>收藏>最近活跃），不另写比较器
    const _meta = loadConvMeta();
    const mine = chats.filter((c) => _charsOf(c).includes(ch)).sort((a, b) => compareConvOrder(a, b, _meta));
    picked = null;
    openBtn.disabled = true;
    let html =
      `<div data-pick="__new__" style="padding:6px 8px;cursor:pointer;font-size:13px;border-bottom:1px solid rgba(128,128,128,0.15);">➕ 新建对话</div>`;
    for (const c of mine) {
      // 行内容与既有对话列表同口径（凛倾 0726「为什么不按照我们已经有的设计去做」）：
      //   模式徽标 + 标题 + 「X·在用」+「另一窗口在用」+ 相对时间 + 第二行消息预览。
      //   原实现只有一行裸标题，一半条目显示裸 chatid（kxlb4pzx74…），用户分不清哪个是哪个。
      //   全部复用 conversationManager/utils 的现成单源函数，不在本文件重写第二套渲染。
      const _mode = _meta[c.chatid]?.mode || c.mode || "";
      const _badges = buildModeBadge(_mode) + buildInUseLabel(c.usedByModes) + buildOtherWindowBadge(c.chatid, c.inUseCount);
      // 时间无效不渲染：lastMessageTime 缺失/不可解析时 formatRelativeTime 产出「NaN天前」
      //   （0727 截图实证：线名显示成「…2855kvz7fb3NaN天前」）。有效才显示，不给用户看 NaN。
      const _ts = c.lastMessageTime ? new Date(c.lastMessageTime).getTime() : NaN;
      // [T7 NaN天前根修] 传算好的数字 _ts，不传原始值：lastMessageTime 经 JSON 往返是 ISO 字符串，
      //   而 formatRelativeTime 契约是 epoch 毫秒数字（utils.mjs:211 内部 Date.now()-timestamp），
      //   字符串进去 diff=NaN → 四段判断全跳过 → "NaN天前"。守卫用 _ts 判、实参却传原始值=
      //   检查的和传的不是同一个东西。正确范式对照：conversationManager.mjs:517。
      const _time = Number.isFinite(_ts) ? formatRelativeTime(_ts) : "";
      const _preview = c.lastMessageContent || c.firstUserMessage || "";
      const _sender = c.lastMessageSender ? `${c.lastMessageSender}: ` : "";
      html +=
        // data-label = 对话标题单源（_chatLabel）。原先线名取整行 textContent，把模式徽标/「在用」/
        //   相对时间全吃进名字里（0727 实证：线名成了「编程编程·在用2855kvz7fb3NaN天前」）。
        `<div data-pick="${escapeHtml(c.chatid)}" data-label="${escapeHtml(_chatLabel(c))}" style="padding:5px 8px;cursor:pointer;border-bottom:1px solid rgba(128,128,128,0.08);">` +
        `<div style="display:flex;align-items:center;gap:4px;font-size:12.5px;">` +
        `${_badges}<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(_chatLabel(c))}</span>` +
        (_time ? `<span style="font-size:10px;opacity:0.55;flex-shrink:0;">${escapeHtml(_time)}</span>` : "") +
        `</div>` +
        (_preview
          ? `<div style="font-size:10.5px;opacity:0.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px;">${escapeHtml(_sender + String(_preview).slice(0, 60))}</div>`
          : "") +
        `</div>`;
    }
    chatBox.innerHTML = html;
  };
  chatBox.addEventListener("click", (e) => {
    const row = e.target.closest("[data-pick]");
    if (!row) return;
    // 名字取 data-label（对话标题单源），不取整行 textContent（会把徽标/在用/时间拼进名字）
    picked = { chatid: row.getAttribute("data-pick"), label: (row.getAttribute("data-label") || row.textContent).trim() };
    openBtn.disabled = false;
    for (const el of chatBox.querySelectorAll("[data-pick]")) el.style.background = "";
    row.style.background = "rgba(128,128,128,0.18)";
    // [0727 回滚] 这里曾被我改成「点行即开线」，结果是用户只想选一下、线就自己拉起来了
    //   （凛倾实测：「我都没有点击确认，为什么会自己拉线」）。选择与执行必须分开：
    //   点行=选中，开线只由「打开新窗口」按钮触发。
  });
  charSel.addEventListener("change", renderChats);

  const close = () => { try { dlg.close(); } catch { /* 已关 */ } dlg.remove(); };
  dlg.querySelector('[data-role="cancel"]').addEventListener("click", close);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  dlg.addEventListener("click", (e) => { if (e.target === dlg) close(); });

  /**
   * 「打开这条线」动作（凛倾 0727：点对话框就该切过去）。
   * 【why 抽出来】原来这段只挂在「打开新窗口」按钮上，而点对话行的 handler **只做选中+变灰**，
   *   一行切换代码都没有 —— 用户点框、框变暗、然后什么都不发生，这就是断链。
   *   现在点行=直接执行本动作，按钮保留（键盘/无障碍入口），两处同一实现，不写第二套。
   */
  const _doOpen = async () => {
    if (!picked) return;
    const ch = charSel.value;
    const _opt = ideSel.options[ideSel.selectedIndex];
    const _idePort = _opt && _opt.dataset.port ? Number(_opt.dataset.port) : null;
    const _ideInstanceId = _opt?.dataset?.instanceId || null;
    openBtn.disabled = true;
    try {
      // 执行端在「打开弹层 → 用户挑选」这段时间里可能已经掉线（关了那个 VSCode 窗口）。
      //   绑定本身会成功（后端只记 port），但这条线的每次工具调用都会被 _connFor 判 degraded 拒绝，
      //   表现为「线拉起来了、AI 却什么都干不了」。故落地前复查一次在线状态，不在线就当场问清楚。
      if (_idePort != null) {
        let _stillLive = true;
        try {
          const _r = await sendAction({ verb: "getIdeInstances", target: "plugins:beilu-memory", source: "web" });
          const _i = (Array.isArray(_r?.instances) ? _r.instances : []).find((x) => x && x.port === _idePort);
          _stillLive = !!(_i && _i.connected);
        } catch { /* 查不到就不拦，让后端去判 */ }
        if (!_stillLive) {
          const _go = await beiluConfirm(
            `刚选的执行端「${_opt.textContent}」现在不在线了。\n仍然拉这条线的话，它的工具调用会被拒绝，直到该窗口重新打开。`,
            { title: "执行端已离线", confirmText: "仍然拉线", danger: true },
          );
          if (!_go) return;
        }
      }
      let chatid = picked.chatid;
      let label = picked.label.replace(/🪟另一窗口在用$/, "").trim();
      if (chatid === "__new__") {
        // 新建线：复用 conversationManager 单源三步（建对话/绑卡/分类），不切走本窗当前对话
        chatid = await createNewChat();
        // 建失败原来是静默 return：弹层照旧、线没建、用户以为建好了（点框"没反应"的另一半）
        if (!chatid) {
          showToast?.("error", "新建对话失败（后端没有返回对话 id），这条线没有建起来");
          return;
        }
        try {
          await sendAction({ verb: "bindCharToChat", target: "shells:chat", source: "web", scope: { chatId: chatid }, payload: { charname: ch } });
        } catch (err) {
          showToast?.("error", `绑定角色失败: ${err.message}`);
          return;
        }
        // 本窗切过去就是这条线（_openLine 末尾 _switchToLine），故正常分类+认领在用指针。
        classifyNewChat(chatid, ch);
        label = "新对话";
      }
      // 线↔执行端绑定（凛倾 0726「不可以和 yonban 联动」）：切过去之前先绑，后端据此把本线的
      // 工具调用定向到该实例；不绑=后端按无归属走主连接，正是多窗互相打到别人工作区的形态。
      if (_idePort != null) {
        try {
          // source:"manual"=用户显式指定，粘性：不被 YonBan 打开该对话时的自动上报覆盖（后端 bindChat 规则）
          await sendAction({
            verb: "bindIdeInstance",
            target: "plugins:beilu-memory",
            source: "web",
            payload: {
              chatid,
              port: _idePort,
              ...(_ideInstanceId ? { instanceId: _ideInstanceId } : {}),
              source: "manual",
            },
          });
        } catch (err) {
          showToast?.("error", `绑定执行端失败（这条线的工具调用会没有归属）: ${err.message}`);
        }
      }
      // 模式进上下文包：线在哪个模式窗口拉起，它就属于那个模式（凛倾架构：窗口级=code/work/chat/airp）。
      //   取不到就留空，切线时不切模式（沿用当前），不编一个默认值。
      let _lineMode = "";
      try { _lineMode = getCurrentMode() || ""; }
      catch (err) { console.warn("[lineManager] 取当前模式失败（线不记模式）:", err?.message); }
      const _ok = _openLine(chatid, ch, label, _opt ? _opt.textContent : "", _idePort, _lineMode);
      // 与主窗口重合被拒（_openLine 返回 false）：弹层留着让用户改选，拒因已 toast+错误追踪
      if (_ok === false) return;
      renderLines();
      // 开完就关弹层：原来不关，线已经切过去了、用户还盯着弹层，看起来同样是"没反应"。
      close();
    } finally {
      openBtn.disabled = false;
    }
  };
  openBtn.addEventListener("click", () => { void _doOpen(); });

  renderLines();
  renderChats();
  dlg.showModal();
}

/**
 * 注入「＋」按钮到活动栏底部（ide.mjs initIdeActivityBar 调用，幂等）。
 * 按钮复用 .ide-activity-btn 现成样式；margin-top:auto 沉底与面板切换钮分区。
 * @param {HTMLElement} activityBar - #ide-activity-bar
 */
/**
 * ＋号按钮兼「本线执行端」状态位（凛倾 0726「前端优化显示」）：hover 看绑到哪个窗口，
 * 执行端离线时按钮转红——用户不必进弹层就知道这条线的工具调用能不能落地。
 * 【why 复用按钮而不新增徽章】本体顶栏无现成挂点，新增元素会动布局；状态与「开线」同域，合并最省。
 */
async function _refreshBindHint(btn) {
  if (!btn) return;
  const cid = (() => { try { return window._beiluGetChatId?.() || ""; } catch { return ""; } })();
  const _base = "点击开新对话线（选角色卡/对话文件，新窗口拉一条持久的线）";
  if (!cid) { btn.title = _base; btn.style.color = ""; return; }
  try {
    const r = await sendAction({ verb: "getIdeInstances", target: "plugins:beilu-memory", source: "web" });
    // 顺带刷新绑定快照 → 线图标 tooltip 显示后端真值（不用拉线时的旧快照，见 _lineIdeLabel 注释）
    _bindSnapshot = { instances: Array.isArray(r?.instances) ? r.instances : [], bindings: r?.bindings || {} };
    _renderLineTabs();
    const b = r?.bindings?.[cid];
    if (!b) { btn.title = `本线未绑定执行端（工具调用走默认窗口）\n${_base}`; btn.style.color = ""; return; }
    const inst = (Array.isArray(r?.instances) ? r.instances : []).find((i) => i && i.port === b.port);
    const live = !!(inst && inst.connected);
    btn.title = `本线执行端：${inst ? _ideLabel(inst) : `端口 ${b.port}`}${b.source === "manual" ? "（手动指定）" : ""}\n状态：${live ? "在线" : "已离线——工具调用会被拒绝，重开该窗口或在此改绑"}\n${_base}`;
    btn.style.color = live ? "" : "#e11d48"; // 离线转红：不改布局只改色
  } catch (e) {
    console.warn("[lineManager] 绑定状态刷新失败:", e?.message);
  }
}

/** [T5 启动对账·level 半边] 断开检测原来只有"事件沿"（ide_instance_gone 广播那一刻页面在场才关窗）。
 *  断开发生在页面没开着的时候（上次会话先关 VSCode 后关浏览器），事件已错过，而线是持久的 →
 *  绑死执行端的副窗口"复活"成幽灵（0727 凛倾「我没有打开任何cli和yonban,为什么还有这两个」）。
 *  初始化时拿线的绑定跟后端连接池对一遍账：yonban 维度的线、实例已不在池/不在线 → 走同一条
 *  关窗核心（与事件沿同语义）。cli 线不动（用户手动关）；未绑定线不动；维度判不出的不动（不误杀）。 */
async function _reconcileLinesWithPool() {
  let r = null;
  try {
    r = await sendAction({ verb: "getIdeInstances", target: "plugins:beilu-memory", source: "web" });
  } catch (e) {
    console.warn("[lineManager] 启动对账跳过（连接池查询失败≠实例死亡，不据此关窗）:", e?.message);
    return;
  }
  const instances = Array.isArray(r?.instances) ? r.instances : [];
  const bindings = r?.bindings || {};
  const closed = [];
  for (const [cid, l] of [..._lines]) {
    if (!l || l.home) continue;
    const b = bindings[cid];
    if (!b) continue; // 未绑定：纯本体线，不归执行端生死管
    const inst = instances.find((i) => i && i.port === b.port);
    if (inst && inst.connected) continue; // 执行端活着
    // 维度判定：实例在池用 kind；不在池用绑定表实例编号前缀（cli_/yb_，两侧生成器的既有约定：
    //   plugins/beilu-cli/server/server.mjs resolveCliInstanceId / YonBan IdeWsServer yb_<workspaceKey>_<proc>）
    const kind = inst?.kind
      || (typeof b.instanceId === "string" ? (b.instanceId.startsWith("cli") ? "cli" : b.instanceId.startsWith("yb") ? "yonban" : null) : null);
    if (kind !== "yonban") continue;
    closed.push(l.label || cid);
    void _removeLineCore(cid);
  }
  if (closed.length) {
    showToast?.("warning", `启动检测：${closed.length} 条对话线绑定的 VSCode 窗口已不在（${closed.join("、")}），已随之关闭；对话文件未删除，可重新拉起。`, 8000);
  }
}

/** home（主对话）登记搬家：主对话的 chatid 被原生切换改掉时，把登记/DOM/渲染上下文整体
 *  改挂到新 chatid 名下。**搬家而不是新建+降级**：新建会把旧 chatid 的登记留在活动栏——
 *  一个用户从没开过的"第二个窗口"，若旧条目还残留 home 标就连删都删不掉（0727 幽灵窗口实证）。
 *  调用方：hashchange 监听（正常时序）、_registerHomeWindow（时序漏网/历史残留时补搬）。 */
function _rekeyHome(oldId, nid) {
  if (!oldId || !nid || oldId === nid) return;
  // 目标对话已经被另一个窗口持有 → 不合并（一条对话只该有一个窗口），登记让它自己处理
  if (_lines.has(nid)) return;
  const el = _winEls.get(oldId);
  const l = _lines.get(oldId);
  _winEls.delete(oldId); _winTouch.delete(oldId); _winDirty.delete(oldId); _lines.delete(oldId);
  if (el) { _winEls.set(nid, el); _winTouch.set(nid, Date.now()); }
  if (l) {
    l.mode = (() => { try { return getCurrentMode() || ""; } catch { return ""; } })();
    l.char = (() => { try { return window._beiluGetCharName?.() || ""; } catch { return ""; } })() || l.char;
    l.label = "当前对话";
    l.draft = ""; // 草稿属于那条对话，换了对话就不是它的了
    _lines.set(nid, l);
  }
  if (_curWinId === oldId) _curWinId = nid;
  void import("../render/virtualQueue.mjs")
    .then((m) => m.rekeyWindowCtx?.(oldId, nid))
    .catch(() => { /* 渲染层未加载 */ });
  _saveLines();
  _renderLineTabs();
}

export function initLineManager(activityBar) {
  // 按钮本体是 index.html 静态声明（#ide-line-new-btn，与同栏其余 9 个按钮同构）——
  // 本函数只负责绑行为。why：原「JS 动态 createElement+appendChild」的按钮存在与否取决于
  // 这段 JS 有没有跑到（缓存旧 ide.mjs / 动态 import 失败 / 上游早退，任一都让按钮凭空消失且无报错），
  // 凛倾实测「重启 30 多次没有 + 号」即此形态。UI 元素归 HTML、行为归 JS，与项目既有写法一致。
  const btn = (activityBar || document).querySelector("[data-line-new]")
    || document.getElementById("ide-line-new-btn");
  if (!btn || btn.dataset.lineBound === "1") return; // 幂等：重复 init 不重复绑
  btn.dataset.lineBound = "1";

  // 线图标容器：插在 ＋号 之前 → 活动栏形态 = [面板钮…] [线1][线2]… [＋]
  // 容器由 JS 建（线是动态的，数量随用户增删），＋号 本体仍是 HTML 静态声明。
  _tabsBox = document.createElement("div");
  _tabsBox.id = "ide-line-tabs";
  // 线可以拉很多条，而 .ide-activity-bar 是 48px 宽的 flex-col 且**没有 overflow 处理**
  // （对比 #bot-activity-bar 有 overflow-y:auto）——不给容器自己加滚动的话，十来条线就会
  // 把上面那些面板按钮挤压变形/顶出可视区。min-height:0 是 flex 子元素能滚动的前提。
  _tabsBox.style.cssText = "display:flex;flex-direction:column;align-items:center;width:100%;gap:2px;overflow-y:auto;overflow-x:hidden;min-height:0;";
  btn.parentNode?.insertBefore(_tabsBox, btn);
  _tabsBox.addEventListener("click", (e) => {
    const t = e.target.closest("[data-line-tab]");
    if (!t) return;
    e.stopPropagation(); // 线图标无 data-ide-panel，不进面板切换委托
    void _switchToLine(t.getAttribute("data-line-tab"));
  });
  _tabsBox.addEventListener("contextmenu", (e) => {
    const t = e.target.closest("[data-line-tab]");
    if (!t) return;
    e.preventDefault(); // 右键=关闭这条线（走 beiluConfirm 提醒，凛倾「点击给提醒」）
    e.stopPropagation();
    void _closeLine(t.getAttribute("data-line-tab"));
  });
  // 面板钮点击后的窗口图标重算（激活互斥反向半边的触发器）：ide.mjs 的监听清全部高亮并点亮面板钮，
  //   本监听注册晚于它（动态 import 在 layout 初始化之后），同元素同阶段按注册序稳定跑在其后——
  //   点连接/文件等面板 → 重算后窗口图标全灭（_chatFront=false）；点 ai-chat → 当前窗口图标亮回来
  //   且 _renderLineTabs 内部会摘掉 ai-chat 钮的高亮，一栏同刻只亮一个。
  activityBar?.addEventListener("click", (e) => {
    const _p = e.target.closest?.("[data-ide-panel]");
    if (!_p) return;
    // [0727 凛倾「第三个图标=a」] AI 对话面板钮就是主窗口 a 的图标：点它=回主窗口——
    //   正显示副窗口时把显示切回 home（参照现有切换代码，_switchToLine 单入口，
    //   面板本身已由 ide.mjs 的监听切好）；已在 home 则纯粹是面板切换，不多做事。
    if (_p.dataset.idePanel === "ai-chat") {
      const _homeId = [..._lines.entries()].find(([, l]) => l && l.home)?.[0] || "";
      if (_homeId && _homeId !== _curWinId) void _switchToLine(_homeId);
    }
    _renderLineTabs();
  });

  _loadLines();      // 持久的线：刷新/重开浏览器后活动栏上的线仍在

  // ★ [0727 凛倾规格] 把**当前这条对话（a）**也登记成一个窗口。
  //   不登记的话活动栏上永远只有 ＋号开出来的 b，切到 b 之后没有任何入口能回到 a
  //   ——凛倾原话：「上面的就是对话a，下面的就是对话b，a是原来的」「点击a那么他就是这个」。
  //   a 是原生窗口：它的 DOM 就是页面上现成的 #chat-container，不需要创建。
  //   chatInitDone 时再补一次（首次进来 chatid 可能还没就位）。
  const _registerHomeWindow = () => {
    const cid = (() => { try { return window._beiluGetChatId?.() || ""; } catch { return ""; } })();
    if (!cid) return;
    // 认领页面上现成的 #chat-container 作为 a 的窗口（不创建、不复制——它本来就在）
    if (!_curWinId) {
      const el = document.getElementById(WIN_EL_ID);
      if (el) {
        _winHost = el.parentNode;
        _winEls.set(cid, el);
        _winTouch.set(cid, Date.now());
        _curWinId = cid;
      }
    }
    if (_lines.has(cid)) {
      // home 的 chatId 可以不变，但角色/模式会在原生切卡或模式切换时变化。
      // 仅做 home 登记的同步，不动副窗口的已绑包；否则 producer 虽从 _lines 读，
      // 读到的却是旧 char/mode，仍会组成错误四维作用域。
      const line = _lines.get(cid);
      const charName = (() => { try { return String(window._beiluGetCharName?.() || "").trim(); } catch { return ""; } })();
      const mode = (() => { try { return String(getCurrentMode() || "").trim(); } catch { return ""; } })();
      let bindingChanged = false;
      if (charName && line.char !== charName) { line.char = charName; bindingChanged = true; }
      if (mode && line.mode !== mode) { line.mode = mode; bindingChanged = true; }
      if (bindingChanged) _saveLines();
      _setHomeUnique(cid);
      return;
    }
    // [0727 幽灵窗口根修] 主对话换了 chatid 而搬家没跑到（hashchange 时序漏网/历史残留）：
    //   先把旧 home 补搬到当前 cid——新建+降级会把旧 chatid 的登记留在活动栏，
    //   就是"没多开却出现第二个窗口"的来源。搬成了只剩唯一化，搬不成（无旧 home）才新建。
    const _prevHome = [..._lines.entries()].find(([, l]) => l && l.home)?.[0] || "";
    if (_prevHome && _prevHome !== cid) {
      _rekeyHome(_prevHome, cid);
      if (_lines.has(cid)) { _setHomeUnique(cid); return; }
    }
    const _char = (() => { try { return window._beiluGetCharName?.() || ""; } catch { return ""; } })();
    let _mode = "";
    try { _mode = getCurrentMode() || ""; } catch { /* 取不到就留空 */ }
    _lines.set(cid, { char: _char, label: "当前对话", mode: _mode, ide: "", idePort: null, openedAt: Date.now(), home: true });
    _setHomeUnique(cid); // 建完立刻收口，防旧登记里残留的 home 与它并存
  };
  _registerHomeWindow();
  window.addEventListener("beilu:chatInitDone", _registerHomeWindow);
  // chatId 不变的角色切换也要刷新 home 绑定；副窗口本来就被锁定，不会走这条变更。
  window.addEventListener("beilu:char-changed", _registerHomeWindow);

  // 草稿落盘的第二个时机：切窗口时存不住"打完字不切窗口就刷新"这一种。
  //   pagehide 覆盖刷新/关页/前后台切走（beforeunload 在移动端与 bfcache 下不可靠）。
  window.addEventListener("pagehide", () => {
    try {
      const inp = document.getElementById("send_textarea");
      if (inp && _curWinId) _setDraft(_curWinId, inp.value);
    } catch { /* 卸载期异常不影响退出 */ }
  });

  _renderLineTabs();

  // [T5 启动对账] 事件沿检测的补全半边：页面不在场时错过的"执行端已关"在这里补账（不阻塞初始化）
  void _reconcileLinesWithPool();

  // ══ [0727 凛倾「我只让你做 code……code 被隔离，你把隔离打破了？如果我切换 daoairp 会怎么样？」] ══
  //   切模式 → 把**不属于新模式**的窗口整个收起来：DOM 摘掉 + 渲染上下文卸掉 + 图标不再显示。
  //   why 必须收 DOM 而不只藏图标：留着的话那些窗口仍挂在文档里、仍各自跑着 RAF loop、
  //   仍在按 chatid 接 WS 消息渲染 —— code 的窗口在 work 模式下继续活着，隔离就只做了视觉一层。
  //   登记（_lines）保留：切回该模式图标就回来，点一下按懒加载重建。
  window.addEventListener("beilu:mode-switched", () => {
    void (async () => {
      // 模式权威已在事件派发前更新；先把 home 登记的 mode 同步为新值，
      // 使 code 窗口绑定 producer 不会在切换边沿读到旧模式。
      _registerHomeWindow();
      const now = (() => { try { return getCurrentMode() || ""; } catch { return ""; } })();
      if (!now) return;
      // 先通过统一入口完成回 home 的传输+可见提交；提交完成前不摘任何旧 DOM。
      const homeId = [..._lines.entries()].find(([, l]) => l && l.home)?.[0] || "";
      if (homeId && _curWinId && _curWinId !== homeId) {
        const switched = await _showWin(homeId);
        if (!switched && _curWinId !== homeId) return;
      }
      for (const [cid, l] of _lines) {
        if (!l || l.home || !l.mode || l.mode === now || cid === _curWinId) continue;
        if (!_winEls.has(cid)) continue;
        try { _winEls.get(cid)?.remove(); } catch { /* 已不在 DOM */ }
        _winEls.delete(cid);
        _winTouch.delete(cid);
        _winDirty.delete(cid);
        void import("../render/virtualQueue.mjs")
          .then((m) => m.dropWindowCtx?.(cid))
          .catch(() => { /* 渲染层未加载 */ });
        console.log(`[lineManager] 窗口 ${cid}（${l.mode} 模式）已随模式切换收起，切回 ${l.mode} 可重新打开`);
      }
      _renderLineTabs();
    })().catch((e) => {
      console.error("[lineManager] 模式切换后的窗口收口失败:", e);
      showToast?.("error", `模式切换后的窗口收口失败：${e?.message || e}`, 6000);
    });
  });

  // a（home 窗口）的 chatid 会被**原生切换**改掉：切模式时各模式记着各自的对话
  //   （featureControls:801 getModeChatIdKey → layout._restoreModeChatId 换 hash）、
  //   在对话列表点另一条、切角色卡，都会换。窗口表的 key 必须跟着走，
  //   否则 a 的容器还挂在旧 chatid 名下 → 按 id 直传的消息全部投递到错误的窗口。
  // 【why 挂 hashchange】它是全库统一的「当前对话变了」信号（20+ 消费者同源），
  //   且切窗口走的是 setCurrentChatId（不写 hash）→ 两件事天然分开，不会互相误触发。
  //   不用 beilu:mode-switched：那个派发于后端切换成功那一刻，早于换 hash，读到的还是旧 chatid。
  window.addEventListener("hashchange", () => {
    const nid = (() => { try { return window._beiluGetChatId?.() || ""; } catch { return ""; } })();
    if (!nid) return;
    const oldId = [..._lines.entries()].find(([, l]) => l && l.home)?.[0] || "";
    _rekeyHome(oldId, nid); // 搬家单源（内含 oldId 空/相等/目标已被持有 三个守卫）
  });

  // 后台线生成态（并行链路可见）：producer=websocket.mjs 非活跃分支的纯状态事件（不碰 DOM）。
  window.addEventListener("beilu:line-activity", (e) => {
    const d = e?.detail || {};
    if (!d.chatid || !_lines.has(d.chatid)) return; // 只关心挂在活动栏上的线
    if (d.generating) _lineBusy.add(d.chatid);
    else _lineBusy.delete(d.chatid);
    _renderLineTabs();
  });

  // [模式切换收窗 0727 凛倾「如果用户从 cli 切换到 yonban，需要关闭其他额外窗口」]
  //   窗口的含义随 IDE 系统改变：CLI 模式下"窗口"=本体内的线（一个进程按会话键分池服务多线）；
  //   YonBan 模式下"窗口"=VSCode 实例（一窗口一实例）。所以切到 YonBan 时，本体按线维度开出来的
  //   额外线在新维度里没有对应执行端，留着就是一堆工具调用会被拒的死线。
  //   保留当前正在看的那条（用户的落脚点不能被系统抽走），其余收掉并说明原因。
  //   why 由本模块执行：线的登记/图标/持久化都归 lineManager，关窗动作必须由持有者做，
  //   传输层只播报事实（websocket 只桥接事件，不替谁决定关不关）。
  window.addEventListener("beilu:ide-mode-changed", (e) => {
    const d = e?.detail || {};
    if (d.from !== "cli" || d.to !== "yonban") { _refreshBindHint(btn); return; }
    void (async () => {
      // CLI→YonBan 的收口对象是所有非 home 线。旧实现拿 hash 伪装“当前窗”并直接
      // `_lines.delete`，会遗留 DOM、virtualQueue 与 WS；若当时正在看副窗还会把可见 DOM 删成孤儿。
      const homeId = [..._lines.entries()].find(([, line]) => line?.home)?.[0] || "";
      if (!homeId) throw new Error("切换 YonBan 前找不到主窗口落脚点");
      const extra = [..._lines.entries()].filter(([, line]) => line && !line.home).map(([cid]) => cid);
      if (!extra.length) return;
      if (_curWinId !== homeId) {
        const switched = await _showWin(homeId);
        if (!switched && _curWinId !== homeId) throw new Error("无法返回主窗口，已取消额外窗口清理");
      }
      for (const cid of extra) await _removeLineCore(cid);
      showToast?.("warning", `已切换到 VSCode/YonBan 模式（窗口=VSCode 窗口），本体的 ${extra.length} 条额外对话线已收起；在 VSCode 里开新窗口即可多开。`, 6000);
    })().catch((err) => {
      console.error("[lineManager] CLI→YonBan 窗口收口失败:", err);
      showToast?.("error", `CLI→YonBan 窗口收口失败：${err?.message || err}`, 6000);
    }).finally(() => _refreshBindHint(btn));
  });

  // 绑定状态：初始化查一次 + 执行端离线推送时转红 + 切对话后重查（三个来源同一收口）
  _refreshBindHint(btn);
  // 执行端离线：当前线的提示由 websocket.mjs 出（措辞「本对话线」只对当前线成立）；
  //   **后台线**的提示归本模块——线的显示名只有 _lines 持有，谁持有身份谁出名字。
  //   不做的话：并行链路里线B 的 VSCode 被关掉，用户正看着线A，屏幕上什么都不会发生，
  //   而线B 从此刻起每次工具调用都被 degraded 拒绝（＋号只在切回线B 时才转红）。
  window.addEventListener("beilu:ide-instance-gone", (e) => {
    void (async () => {
      const d = e?.detail || {};
      const l = d.chatid ? _lines.get(d.chatid) : null;
      // [T5 凛倾 0727「关闭vscode,那么就要关闭绑定的窗口,除了主窗口.cli的话用户手动关闭」]
      //   yonban：窗口维度=VSCode 实例（一窗口一实例，resolveIdeMode 分类），实例没了这个窗口
      //   就没有存在意义 → 自动关（无需确认，窗口随实例走；对话文件不删，随时可重新拉起）。
      //   home 除外：主窗口是页面本体，不绑定即默认走主连接（后端无归属路由），不随执行端生死。
      //   cli：一进程多线（line 维度），进程停了线还在——重启 CLI 按实例编号认回，去留用户手动定 → 只提示。
      if (l && !l.home && d.kind !== "cli") {
        if (d.chatid === _curWinId) {
          // 正看着的窗口要被收走：统一提交回 home 成功后才能删除旧窗口。
          const homeId = [..._lines.entries()].find(([cid, x]) => x && x.home && cid !== d.chatid)?.[0] || "";
          if (!homeId) throw new Error(`关闭执行端窗口 ${d.chatid} 前找不到主窗口落脚点`);
          const switched = await _showWin(homeId);
          if (!switched && _curWinId === d.chatid) return;
        }
        await _removeLineCore(d.chatid);
        showToast?.("warning", `VSCode 窗口已关闭，绑定它的对话线「${l.label}」已随之关闭（对话文件未删除，可随时重新拉起）。`, 6000);
      } else if (l) {
        // cli 线 / home：不自动关（cli=一进程多线可重启认回，home=页面本体），只播报事实。
        //   [T5 0727 收口] 登记线的提示权全在这里（websocket.mjs 只兜底体系外 chatid）——
        //   当前线与后台线同一措辞，线名单源 _lines，不再按可见性分家。
        const _kind = d.kind === "cli" ? "本体 CLI" : "VSCode 窗口";
        showToast?.("warning", `对话线「${l.label}」绑定的${_kind}已停止，该线的工具调用会被拒绝；改绑或重开该窗口后恢复。`, 6000);
      }
      _refreshBindHint(btn);
    })().catch((err) => {
      console.error("[lineManager] 执行端离线后的窗口清理失败:", err);
      showToast?.("error", `执行端离线后的窗口清理失败：${err?.message || err}`, 6000);
      _refreshBindHint(btn);
    });
  });
  window.addEventListener("beilu:chatInitDone", () => { _refreshBindHint(btn); _renderLineTabs(); }); // 切对话完成 → 高亮跟着走
  btn.addEventListener("click", (e) => {
    e.stopPropagation(); // 不进活动栏面板切换委托（本按钮无 data-ide-panel，防误高亮）
    openLinePicker().catch((err) => {
      console.warn("[lineManager] 打开选择器失败:", err?.message);
      showToast?.("error", `开新对话线失败: ${err?.message || err}`);
    });
  });
}
