import info from "./info.json" with { type: "json" };
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { exec } from "node:child_process";
import { readJsonSafeSync } from "../../../../scripts/safeJsonIO.mjs"; // 配置落盘读回（损坏备份后抛，范式同 injectTexts）
// [SEC 安全同步 0722] 网络安全+输出安全接入本体安全系统单源：
//   assertSafeUrl — AI 可控 goto/newtab URL 挡私网/回环/云元数据（SSRF/内网探测，fail-closed）
//   wrapUntrusted/stripInvisibleUnicode — 网页内容（标题/快照/eval 结果）注入 AI 前过不可信边界（OWASP LLM01）
import { assertSafeUrl } from "../../../../yonban/core/functions/security/safe_fetch.mjs";
import { wrapUntrusted, stripInvisibleUnicode } from "../../../../yonban/core/functions/security/untrusted_content.mjs";
import { wbT, wbD } from "../../../../server/wbStub.mjs"; // 全线路白盒（凛倾 0722）：标签入口/逐操作成败/连接失败可观测（先例=beilu-files 同层）

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../../../../..");

const INJ_ID = "INJ-browser";
// 历代出厂默认 content（升级判据：用户副本与某一代出厂默认逐字一致=用户没改过 → 才覆写为新默认；
// 改过=用户自有版本，一字不动。范式同预设双源同步判据）
const INJ_PREV_CONTENTS = [
  `[Browser Automation]
You can control a real browser. Use <browser_op> tags:

Navigation:
  <browser_op type="goto" url="https://example.com" />
  <browser_op type="tabs" />

Page inspection:
  <browser_op type="snapshot" />  — Get page structure (accessibility tree with @N refs)
  <browser_op type="screenshot" />  — Take screenshot

Interaction (use @N refs from snapshot):
  <browser_op type="click" target="@3" />
  <browser_op type="type" target="@3" value="search text" />
  <browser_op type="press" key="Enter" />
  <browser_op type="scroll" dy="300" />

JavaScript:
  <browser_op type="eval">document.title</browser_op>

Tab management:
  <browser_op type="newtab" url="https://..." />
  <browser_op type="closetab" />

Wait:
  <browser_op type="wait" selector="css:.result" timeout="5000" />

Workflow: goto → snapshot (see structure, get @N refs) → click/type → snapshot to verify
Browser status: {{browser_status}} | Port: {{browser_port}}`,
  // 第2代出厂默认（含 sync/history；状态行仍内嵌——0722 动态宏归尾拆分前的最后一代）
  `[Browser Automation]
You can control a real browser. Use <browser_op> tags:

Navigation:
  <browser_op type="goto" url="https://example.com" />
  <browser_op type="tabs" />

Page inspection:
  <browser_op type="snapshot" />  — Get page structure (accessibility tree with @N refs)
  <browser_op type="screenshot" />  — Take screenshot

Interaction (use @N refs from snapshot):
  <browser_op type="click" target="@3" />
  <browser_op type="type" target="@3" value="search text" />
  <browser_op type="press" key="Enter" />
  <browser_op type="scroll" dy="300" />

JavaScript:
  <browser_op type="eval">document.title</browser_op>

Tab management:
  <browser_op type="newtab" url="https://..." />
  <browser_op type="closetab" />
  <browser_op type="sync" />  — Switch to the tab the user is currently viewing (work on the same page as the user)

Wait:
  <browser_op type="wait" selector="css:.result" timeout="5000" />

Browsing record:
  <browser_op type="history" />  — Recall recent browsing record (pages visited, operations done)

Workflow: goto → snapshot (see structure, get @N refs) → click/type → snapshot to verify
Browser status: {{browser_status}} | Port: {{browser_port}}`,
];
const INJ_DEFAULTS = {
  id: INJ_ID,
  name: "浏览器自动化",
  description: "AI 控制浏览器的能力说明和标签格式",
  enabled: true,
  // [0723 INJ 双层面板] builtin=系统层判据（原生功能条目归系统层，凛倾「系统层就是我们现在原生的」）。
  //   历史 false=照抄 addInjectionPrompt 用户新建默认值的遗留，致本条落「Skill 层（自建）」分层错位。
  builtin: true,
  deletable: true,
  role: "system",
  depth: 1,
  order: -50,
  autoMode: "always",
  content: `[Browser Automation]
You can control a real browser. Use <browser_op> tags:

Navigation:
  <browser_op type="goto" url="https://example.com" />
  <browser_op type="tabs" />

Page inspection:
  <browser_op type="snapshot" />  — Get page structure (accessibility tree with @N refs)
  <browser_op type="screenshot" />  — Take screenshot

Interaction (use @N refs from snapshot):
  <browser_op type="click" target="@3" />
  <browser_op type="type" target="@3" value="search text" />
  <browser_op type="press" key="Enter" />
  <browser_op type="scroll" dy="300" />

JavaScript:
  <browser_op type="eval">document.title</browser_op>

Tab management:
  <browser_op type="newtab" url="https://..." />
  <browser_op type="closetab" />
  <browser_op type="sync" />  — Switch to the tab the user is currently viewing (work on the same page as the user)

Wait:
  <browser_op type="wait" selector="css:.result" timeout="5000" />

Browsing record:
  <browser_op type="history" />  — Recall recent browsing record (pages visited, operations done)

Workflow: goto → snapshot (see structure, get @N refs) → click/type → snapshot to verify`,
};
// !!!禁止放入提示词!!! 提示词只允许住 INJ 条目和预设（凛倾 0722）：状态行 "Browser status: ..."
//   已从 INJ-browser（depth:1 头部）拆出为尾部条目 INJ-browser-status-data——条目定义在
//   beilu-memory/default_memory_presets.json（INJ 模板配置），由 storage 播种，本插件代码不持有该文本。
//   拆分原因：{{browser_status}} 随连接状态变化，混在头部说明块=缓存前缀整块失效（0722 确诊）。
//   上方 INJ_PREV_CONTENTS 第2代=拆分前最后一代出厂默认，用户副本逐字一致才升级为无状态行新默认。

let bd = null;
let connected = false;

// 出厂默认（单源）：运行态 pluginData 由此初始化+落盘覆盖；GetData 随 meta 一并下发,
// 前端零默认值副本（凛倾 0722 禁前端硬编码）
const BROWSER_DEFAULTS = {
  enabled: true,
  port: 9222,
  driverPath: "", // 空=内置驱动 ./driver/index.mjs（随本体分发，零机器路径）；填 file:// URL 可换外部驱动
  chromePath: "",
  userDataDir: "data/browser-profile", // CWD 锚相对路径（启动时 resolve 绝对化），禁机器盘符默认值
  snapshotMaxLines: 200,
  defaultTimeout: 5000,
  defaultScrollDy: 300,
  gotoWaitUntil: "load",
  resultLabel: "[Browser Operation Results]",
  resultSeparator: "\n---\n",
  autoReconnect: true,
  recordBrowsing: true,
  historyFile: "data/browser-history.jsonl",
  historyMaxRead: 30,
};
let pluginData = { ...BROWSER_DEFAULTS };

// 配置控件元数据（默认值/限值/选项/文案单源后端，前端面板纯渲染）
const BROWSER_CONFIG_META = [
  { key: "enabled",          group: "基础设置", type: "toggle", label: "启用浏览器自动化", desc: "开启后 AI 可通过 <browser_op> 标签控制浏览器" },
  { key: "port",             group: "基础设置", type: "number", label: "CDP 调试端口",     desc: "Chrome 的 --remote-debugging-port 端口号", min: 1024, max: 65535 },
  { key: "snapshotMaxLines", group: "快照设置", type: "range",  label: "快照最大行数",     desc: "防止超长页面的 AX Tree 撑爆上下文", min: 50, max: 500, step: 50 },
  { key: "chromePath",       group: "Chrome 启动设置", type: "text", label: "Chrome 路径", desc: "Chrome 可执行文件路径，留空自动检测", placeholder: "留空则自动检测" },
  { key: "userDataDir",      group: "Chrome 启动设置", type: "text", label: "用户数据目录", desc: "--user-data-dir 参数，共享登录态", placeholder: "data/browser-profile（相对 beilu 数据目录）" },
  { key: "defaultTimeout",   group: "高级设置", type: "number", label: "默认等待超时 (ms)", desc: "wait 操作的默认超时时间", min: 1000, max: 60000, step: 1000 },
  { key: "defaultScrollDy",  group: "高级设置", type: "number", label: "默认滚动量 (px)",  desc: "scroll 操作未指定 dy 时的默认值", min: 50, max: 2000, step: 50 },
  { key: "gotoWaitUntil",    group: "高级设置", type: "select", label: "goto 等待策略",    desc: "导航后等待页面到达什么状态",
    options: [
      { value: "load", label: "load (完全加载)" },
      { value: "domcontentloaded", label: "domcontentloaded (DOM就绪)" },
      { value: "commit", label: "commit (发起即返回)" },
    ] },
  { key: "autoReconnect",    group: "高级设置", type: "toggle", label: "自动重连",         desc: "操作失败后自动尝试重新连接 Chrome" },
  { key: "recordBrowsing",   group: "高级设置", type: "toggle", label: "浏览内容记录",     desc: "记录每次浏览器操作的页面与结果摘要，AI 可通过 history 操作回溯" },
  { key: "historyFile",      group: "高级设置", type: "text",   label: "浏览记录文件",     desc: "JSONL 追加落盘路径（相对 beilu 数据目录）", placeholder: "data/browser-history.jsonl" },
  { key: "historyMaxRead",   group: "高级设置", type: "number", label: "history 回读条数", desc: "AI history 操作默认回读的最近记录条数", min: 5, max: 200 },
  { key: "resultLabel",      group: "结果格式", type: "text",   label: "结果标签",         desc: "注入 AI 上下文时的区块标题" },
  { key: "resultSeparator",  group: "结果格式", type: "text",   label: "结果分隔符",       desc: "多个操作结果之间的分隔文本", escapeNewline: true, placeholder: "\\n---\\n" },
  { key: "driverPath",       group: "驱动路径", type: "text",   label: "browser-driver 路径", desc: "留空使用内置驱动（随 beilu 分发）；填 file:// URL 可替换为外部驱动" },
];

// 操作/宏展示表（与 executeOp switch 的 case 域一一对应——增删 case 必须同步本表；前端零副本）
const BROWSER_OPS_META = [
  { name: "goto",       desc: "导航到指定 URL" },
  { name: "snapshot",   desc: "获取页面无障碍树（@N 引用号）" },
  { name: "screenshot", desc: "截取页面截图" },
  { name: "click",      desc: "点击元素（CSS / @N ref）" },
  { name: "type",       desc: "在输入框中输入文字" },
  { name: "press",      desc: "按下键盘按键" },
  { name: "scroll",     desc: "滚动页面" },
  { name: "eval",       desc: "执行 JavaScript" },
  { name: "tabs",       desc: "列出所有标签页" },
  { name: "newtab",     desc: "打开新标签页" },
  { name: "closetab",   desc: "关闭标签页" },
  { name: "wait",       desc: "等待元素出现" },
  { name: "sync",       desc: "同步到用户正在浏览的标签页" },
  { name: "history",    desc: "回读浏览记录" },
];
const BROWSER_MACROS_META = [
  { name: "{{browser_status}}", desc: "连接状态（connected / disconnected）" },
  { name: "{{browser_port}}",   desc: "CDP 调试端口号" },
];

// 配置落盘（data/ CWD 锚，范式同 injectTexts/reach）：此前纯内存态，重启即回默认值直到用户再开面板
const CONFIG_PERSIST_FILE = "data/browser-config.json";
try {
  const _saved = readJsonSafeSync(CONFIG_PERSIST_FILE, {});
  for (const k of Object.keys(pluginData)) if (k in _saved) pluginData[k] = _saved[k];
} catch (e) {
  console.warn(`[beilu-browser] ${CONFIG_PERSIST_FILE} 损坏（已备份 .corrupt.bak，用默认值继续）:`, e?.message || e);
}

// [0723 凛倾「修 禁止硬编码」] {{browser_status}}/{{browser_port}} 宏的 producer：连接态每次变化落盘，
//   consumer=getPromptHandler 宏池读盘透传（值域 connected/disconnected/端口号由此处持有，
//   提示词文本住 INJ 条目、代码只供数据值——0722 拆分时只建了条目没建 producer 的半接线在此补全）。
const STATUS_PERSIST_FILE = "data/browser-status.json";
async function _persistStatus() {
  try {
    await mkdir("data", { recursive: true }).catch(() => {});
    await writeFile(STATUS_PERSIST_FILE, JSON.stringify({
      status: connected ? "connected" : "disconnected",
      port: pluginData.port,
      updated: new Date().toISOString(),
    }), "utf8");
  } catch { /* 状态落盘失败不影响浏览器操作本身 */ }
}
_persistStatus(); // 模块加载即写一次真状态（防上次进程残留 stale "connected"）

let _cfgPersistTimer = null;
function _persistConfig() {
  if (_cfgPersistTimer) clearTimeout(_cfgPersistTimer);
  _cfgPersistTimer = setTimeout(async () => {
    _cfgPersistTimer = null;
    try {
      await mkdir("data", { recursive: true }).catch(() => {});
      await writeFile(CONFIG_PERSIST_FILE, JSON.stringify(pluginData, null, 2), "utf8");
    } catch (err) {
      console.warn("[beilu-browser] 配置持久化失败:", err.message);
    }
  }, 100);
}

const _pendingResults = new Map();

function _cidOf(arg) {
  return arg?.chatid ?? arg?.chat_id ?? arg?.chat_name?.replace("common_chat_", "") ?? null;
}

function _pushResult(cid, text) {
  const k = cid || "";
  const arr = _pendingResults.get(k) || [];
  arr.push(text);
  _pendingResults.set(k, arr);
}

function _drainResults(cid) {
  const k = cid || "";
  const results = _pendingResults.get(k) || [];
  const fallback = k !== "" ? (_pendingResults.get("") || []) : [];
  const all = [...results, ...fallback];
  if (all.length > 0) {
    _pendingResults.set(k, []);
    if (k !== "") _pendingResults.set("", []);
  }
  return all;
}

/**
 * 续轮判定 peek（不消费）：本会话是否有 browser 操作结果待注入。
 * 供 generation.mjs 自动继续级联查询（与 beilu-files hasPendingOpResultsForSession /
 * aiRunner hasPendingChatSearchForChat 同范式收口）。消费仍由续轮 GetPrompt 的 _drainResults。
 * why（0727 窗口静默死亡事故）：回复只含 browser 操作时，标签被剥+结果只进本插件私有队列，
 * 续轮判定原来看不见此队列 → 判"纯文本"停续 → [Error]/结果永远到不了 AI，会话假死。
 */
export function hasPendingResultsForChat(cid) {
  const k = cid || "";
  return ((_pendingResults.get(k) || []).length + (k !== "" ? (_pendingResults.get("") || []).length : 0)) > 0;
}

// Chrome 自启冷却时间戳（防 ensureConnected 高频调用时风暴式拉起多个实例）
let _lastAutoLaunchAt = 0;
// [0731 多开根修] 连续"拉起 Chrome 但附着超时"熔断计数：达 2 停止自启。
//   why：拉起后端口仍不就绪的主因是同 user-data-dir 已有 Chrome 实例在跑（Windows Chrome 单实例
//   转发：再执行 chrome.exe 只在既有实例上开新窗口、--remote-debugging-port 被忽略）——此时每次
//   重试都只多开一个窗口、永远产不出端口，60s 冷却挡不住窗口无限累积。熔断后错误外显
//   （wbD + 面板状态），用户在面板点"同步"（显式动作）清零重试。
let _launchFailStreak = 0;

/**
 * 附着到 Chrome 调试端口；失败时按需自启 Chrome。
 * 【红线·0731 凛倾"每次都自动打开"确诊】自启浏览器只许发生在"真的要用浏览器"的路径
 *   （AI browser_op 执行 / 用户面板显式同步），插件 Load/服务启动期禁自启（allowLaunch=false
 *   只附着探测）——否则每次打开项目都无条件弹一个 Chrome（启动器已开一个默认浏览器=用户看到双开）。
 * @param {boolean} [allowLaunch=true] - false=只尝试附着已存在的实例，绝不拉起新 Chrome
 */
async function ensureConnected(allowLaunch = true) {
  if (connected && bd) return true;
  try {
    if (!bd) {
      const driverUrl = pluginData.driverPath || new URL("./driver/index.mjs", import.meta.url).href;
      bd = await import(driverUrl);
    }
    await bd.connect(pluginData.port);
    connected = true;
    _persistStatus(); // 状态宏 producer：连接成功落盘
    return true;
  } catch (e) {
    wbD(null, "browser:conn", "connect.fail", false, String(e?.message || e).slice(0, 160), { port: pluginData.port, driver: pluginData.driverPath || "builtin" });
    if (!allowLaunch) return false; // 启动期/纯探测路径：附着不上就到此为止，不弹窗口
    // [0731 多开根修] 拉起前先探端口：/json/version 有响应=Chrome 调试实例活着，附着失败是驱动层
    //   问题——此时再执行 chrome.exe 不会产生新端口，只会在既有实例上多开一个窗口，禁止 launch。
    const _st = await checkChromeStatus();
    if (_st.connected) {
      wbD(null, "browser:conn", "portAliveAttachFail", false, "调试端口活着但驱动附着失败（不自启，防多开窗口）", { port: pluginData.port });
      return false;
    }
    // [0727 凛倾"浏览器自己启动"] 驱动是纯附着模式，9222 没起=附着必败且此前只能等人手启
    //   （窗口假死事故的环境根因）。此处接入 launchChrome（原为从未被调用的死函数）：
    //   附着失败 → 自启 Chrome → 短轮询重附着。60s 冷却防连败风暴/多开实例；
    //   autoReconnect=false（面板可关）时不自启，尊重用户显式关闭。
    if (pluginData.autoReconnect && _launchFailStreak < 2 && Date.now() - _lastAutoLaunchAt > 60000) {
      _lastAutoLaunchAt = Date.now();
      const l = await launchChrome();
      wbT(null, "browser:conn", "autolaunch", { ok: !!l.ok, pid: l.pid || null, error: l.error || null });
      if (l.ok && bd) {
        // Chrome 冷启动到调试端口就绪需数秒，1s 间隔轮询附着（上限 10s）
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          try {
            await bd.connect(pluginData.port);
            connected = true;
            _launchFailStreak = 0; // 自启成功附着=环境正常，熔断计数清零
            _persistStatus();
            console.log(`[beilu-browser] Chrome 自启并附着成功 (pid=${l.pid}, 等待${i + 1}s)`);
            return true;
          } catch { /* 端口未就绪，继续等 */ }
        }
        _launchFailStreak++;
        wbD(null, "browser:conn", "autolaunch.attachTimeout", false, `Chrome 已启动但 10s 内调试端口未就绪（连续${_launchFailStreak}次${_launchFailStreak >= 2 ? "，自启已熔断——疑似同配置 Chrome 已在运行，请关闭后在面板点同步重试" : ""}）`, { port: pluginData.port });
      }
    }
    return false;
  }
}

async function ensureINJ(username) {
  try {
    const injPath = resolve(
      PROJECT_ROOT,
      `data/users/${username || "_default"}/chars/_global/memory/_memory_presets/_injections.json`,
    );
    let data;
    try {
      data = JSON.parse(await readFile(injPath, "utf8"));
    } catch {
      return;
    }
    // 真实文件形状 = { injection_prompts: [...] }（002/_default/模板三落点实测一致）。
    // 原裸数组假设 Array.isArray(data) 恒 false → 首装/升级从未生效过（0722 凛倾"INJ需要同步到002和用户"时确诊）
    const list = data?.injection_prompts;
    if (!Array.isArray(list)) return;
    // 姊妹条目 INJ-browser-status-data（模板播种，本插件为功能 owner）：存量副本 builtin 元字段同批归位
    //   （0723 模板已改 true；storage 播种不更新存量、syncDefaultPresets 更新集不含 builtin——此处是存量唯一自愈口）
    const _statusInj = list.find((e) => e.id === `${INJ_ID}-status-data`);
    let _statusDirty = false;
    if (_statusInj && _statusInj.builtin !== true) { _statusInj.builtin = true; _statusDirty = true; }
    const existing = list.find((e) => e.id === INJ_ID);
    if (existing) {
      let _dirty = false;
      // 元字段对齐（0723）：builtin 是出厂元数据（INJ 面板系统层判据）非用户可改域，
      //   与出厂值不一致即对齐——修存量副本 builtin:false 落 Skill 层的分层错位；content/enabled 等用户域不受此影响
      if (existing.builtin !== INJ_DEFAULTS.builtin) { existing.builtin = INJ_DEFAULTS.builtin; _dirty = true; }
      // 出厂默认升级：仅当用户副本与某代出厂默认逐字一致（=没改过）才覆写为新默认；改过一字不动
      if (existing.content !== INJ_DEFAULTS.content && INJ_PREV_CONTENTS.includes(existing.content)) {
        existing.content = INJ_DEFAULTS.content;
        _dirty = true;
      }
      if (_dirty || _statusDirty) await writeFile(injPath, JSON.stringify(data, null, 2), "utf8");
      return;
    }
    list.push({ ...INJ_DEFAULTS });
    await writeFile(injPath, JSON.stringify(data, null, 2), "utf8");
  } catch { /* best-effort */ }
}

/**
 * 浏览内容记录：每个成功执行的浏览器操作追加一行 JSONL（时间/会话/操作/页面 URL+标题/结果摘要）。
 * why：参照 ego 的浏览沉淀能力——AI 与用户都能回溯"浏览器去过哪、做了什么、看到什么"；
 * AI 侧经 <browser_op type="history"> 回读，形成跨轮浏览记忆。
 * 落盘 data/browser-history.jsonl（CWD 锚，范式同 injectTexts/reach 配置落盘），recordBrowsing 可关。
 */
async function _recordOp(cid, op, resultText) {
  if (!pluginData.recordBrowsing) return;
  try {
    let url = "", title = "";
    try { url = await bd.page.url(); title = await bd.page.title(); } catch { /* 页面态不可读不阻断记录 */ }
    const entry = {
      ts: new Date().toISOString(),
      chatid: cid || null,
      op: op.type,
      url, title,
      detail: String(resultText || "").slice(0, 2000),
    };
    await mkdir(dirname(pluginData.historyFile) || ".", { recursive: true }).catch(() => {});
    await appendFile(pluginData.historyFile, JSON.stringify(entry) + "\n", "utf8");
  } catch { /* 记录失败不影响操作本身 */ }
}

async function _readHistory(limit) {
  try {
    const raw = await readFile(pluginData.historyFile, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

async function checkChromeStatus() {
  try {
    const http = await import("node:http");
    return new Promise((resolve) => {
      http.default.get(`http://localhost:${pluginData.port}/json/version`, (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          try {
            const info = JSON.parse(data);
            resolve({ connected: true, browser: info.Browser || "Chrome", userAgent: info["User-Agent"] || "" });
          } catch {
            resolve({ connected: false });
          }
        });
      }).on("error", () => resolve({ connected: false }));
    });
  } catch {
    return { connected: false };
  }
}

function launchChrome() {
  return new Promise((done) => {
    const chrome = pluginData.chromePath || _detectChromePath();
    if (!chrome) {
      done({ ok: false, error: "未找到 Chrome，请在设置中指定路径或安装 Chrome: https://www.google.com/chrome/" });
      return;
    }
    const args = [
      `--remote-debugging-port=${pluginData.port}`,
      `--user-data-dir=${resolve(pluginData.userDataDir || "data/browser-profile")}`,
    ];
    try {
      const cmd = `"${chrome}" ${args.join(" ")}`;
      const child = exec(cmd);
      child.unref?.();
      done({ ok: true, pid: child.pid });
    } catch (e) {
      done({ ok: false, error: e.message });
    }
  });
}

function _detectChromePath() {
  const candidates = process.platform === "win32" ? [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    (process.env.LOCALAPPDATA || "") + "\\Google\\Chrome\\Application\\chrome.exe",
  ] : process.platform === "darwin" ? [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    `${process.env.HOME || ""}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
  ] : [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];
  try {
    for (const p of candidates) {
      if (p && existsSync(p)) return p;
    }
  } catch {}
  return null;
}

const TAG_REGEX = /<browser_op\s+([^>]*?)\/?>(?:([\s\S]*?)<\/browser_op>)?/gi;
const ATTR_REGEX = /(\w+)\s*=\s*"([^"]*)"/g;

function parseOps(content) {
  const ops = [];
  let match;
  TAG_REGEX.lastIndex = 0;
  while ((match = TAG_REGEX.exec(content)) !== null) {
    const attrStr = match[1];
    const body = match[2]?.trim() || "";
    const attrs = {};
    let am;
    ATTR_REGEX.lastIndex = 0;
    while ((am = ATTR_REGEX.exec(attrStr)) !== null) {
      attrs[am[1]] = am[2];
    }
    ops.push({ type: attrs.type || "unknown", attrs, body, raw: match[0] });
  }
  return ops;
}

async function executeOp(op) {
  if (!(await ensureConnected())) {
    return `[Error] Browser not connected. Start Chrome with --remote-debugging-port=${pluginData.port}`;
  }
  try {
    switch (op.type) {
      case "goto": {
        await assertSafeUrl(op.attrs.url); // AI 可控 URL 恒不可信：挡内网/云元数据探测
        await bd.page.goto(op.attrs.url, { waitUntil: pluginData.gotoWaitUntil });
        const title = await bd.page.title();
        const url = await bd.page.url();
        return `[Navigation] ${title}\nURL: ${url}`;
      }
      case "snapshot": {
        const snap = await bd.page.snapshot();
        const lines = snap.split("\n");
        const max = pluginData.snapshotMaxLines;
        const limited = lines.length > max
          ? lines.slice(0, max).join("\n") + `\n... (${lines.length - max} more lines)`
          : snap;
        return `[Page Snapshot]\n${limited}`;
      }
      case "screenshot": {
        const path = await bd.page.screenshot();
        return `[Screenshot] Saved to: ${path}`;
      }
      case "click": {
        await bd.page.click(op.attrs.target);
        return `[Clicked] ${op.attrs.target}`;
      }
      case "type": {
        await bd.page.fill(op.attrs.target, op.attrs.value || op.body);
        return `[Typed] "${op.attrs.value || op.body}" into ${op.attrs.target}`;
      }
      case "press": {
        await bd.page.press(op.attrs.key);
        return `[Pressed] ${op.attrs.key}`;
      }
      case "scroll": {
        const dx = Number(op.attrs.dx) || 0;
        const dy = Number(op.attrs.dy) || pluginData.defaultScrollDy;
        await bd.page.mouse.wheel(dx, dy);
        return `[Scrolled] dx=${dx}, dy=${dy}`;
      }
      case "eval": {
        const result = await bd.page.evaluate(op.body || op.attrs.expr);
        return `[Eval Result]\n${JSON.stringify(result, null, 2)}`;
      }
      case "tabs": {
        const tabs = await bd.browser.listTabs();
        const lines = tabs.map((t) => `  [${t.targetId}] ${t.title} | ${t.url}`);
        return `[Open Tabs] ${tabs.length}\n${lines.join("\n")}`;
      }
      case "newtab": {
        const _u = op.attrs.url || "about:blank";
        if (/^https?:\/\//i.test(_u)) await assertSafeUrl(_u); // about:blank 等非 http 目标无出站语义
        const id = await bd.browser.newTab(_u);
        return `[New Tab] ${id}`;
      }
      case "closetab": {
        await bd.browser.closeTab(op.attrs.id);
        return `[Tab Closed] ${op.attrs.id || "current"}`;
      }
      case "wait": {
        const selector = op.attrs.selector || op.attrs.target;
        const timeout = Number(op.attrs.timeout) || pluginData.defaultTimeout;
        const found = await bd.page.waitForSelector(selector, { timeout });
        return found ? `[Found] ${selector}` : `[Timeout] ${selector} not found within ${timeout}ms`;
      }
      case "sync": {
        const tab = await bd.browser.syncToUserTab();
        return `[Synced to user's tab] ${tab.title}\nURL: ${tab.url}`;
      }
      case "history": {
        const limit = Number(op.attrs.limit) || pluginData.historyMaxRead;
        const entries = await _readHistory(limit);
        if (entries.length === 0) return "[Browsing Record] (empty)";
        const lines = entries.map((e) =>
          `${e.ts} [${e.op}] ${e.title || ""} ${e.url || ""}`.trim());
        return `[Browsing Record] last ${entries.length}\n${lines.join("\n")}`;
      }
      default:
        return `[Error] Unknown browser_op type: ${op.type}`;
    }
  } catch (e) {
    if (pluginData.autoReconnect) { connected = false; _persistStatus(); } // 状态宏 producer：断连落盘
    return `[Error] ${op.type}: ${e.message}`;
  }
}

const pluginExport = {
  info,

  Init: async ({ username }) => {
    await ensureINJ(username);
  },

  Load: async ({ router, username }) => {
    // config REST 端点（范式同 web/main.mjs Load）：此前 Load 不注册任何路由，
    // 前端 _browserSyncBackend POST 恒 404 被静默吞 = 所有面板设置从未到达后端
    if (router) {
      const { authenticate } = await import("../../../../yonban/core/functions/security/auth.mjs");
      router.get(/\/config\/getdata$/, authenticate, async (_req, res) => {
        try { res.json(await pluginExport.interfaces.config.GetData()); }
        catch (e) { res.status(500).json({ error: e.message }); }
      });
      router.post(/\/config\/setdata$/, authenticate, async (req, res) => {
        try { await pluginExport.interfaces.config.SetData(req.body); res.json({ success: true }); }
        catch (e) { res.status(500).json({ error: e.message }); }
      });
      // 控制端点（面板控制界面消费）：手动同步到用户当前标签页 / 清空浏览记录
      router.post(/\/control\/sync$/, authenticate, async (_req, res) => {
        try {
          // [0731 多开根修] 用户显式同步=自启熔断的复位口（用户已处理环境冲突后由此重试）
          _launchFailStreak = 0;
          if (!(await ensureConnected())) return res.status(409).json({ error: "浏览器未连接" });
          const tab = await bd.browser.syncToUserTab();
          res.json({ ok: true, tab });
        } catch (e) { res.status(500).json({ error: e.message }); }
      });
      router.post(/\/control\/clear-history$/, authenticate, async (_req, res) => {
        try {
          await writeFile(pluginData.historyFile, "", "utf8"); // 清空=截断记录文件（用户主动操作）
          res.json({ ok: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
      });
    }
    await ensureINJ(username);
    // 【红线·0731】启动期只附着已存在的调试实例（allowLaunch=false），禁自启 Chrome——
    //   原裸 ensureConnected() 在每次服务启动时都拉起一个 Chrome 窗口（用户"打开项目开2次浏览器"
    //   事故：启动器开默认浏览器 + 此处弹自动化 Chrome）。自启只归"真的要用浏览器"路径
    //   （executeOp / 面板同步）。
    ensureConnected(false).catch(() => {});
  },

  Unload: async () => {
    if (bd && connected) {
      try { bd.disconnect(); } catch {}
      connected = false;
      _persistStatus(); // 状态宏 producer：卸载断开落盘
    }
  },

  interfaces: {
    config: {
      GetData: async () => ({
        enabled: pluginData.enabled,
        port: pluginData.port,
        driverPath: pluginData.driverPath,
        chromePath: pluginData.chromePath,
        userDataDir: pluginData.userDataDir,
        snapshotMaxLines: pluginData.snapshotMaxLines,
        defaultTimeout: pluginData.defaultTimeout,
        defaultScrollDy: pluginData.defaultScrollDy,
        gotoWaitUntil: pluginData.gotoWaitUntil,
        resultLabel: pluginData.resultLabel,
        resultSeparator: pluginData.resultSeparator,
        autoReconnect: pluginData.autoReconnect,
        recordBrowsing: pluginData.recordBrowsing,
        historyFile: pluginData.historyFile,
        historyMaxRead: pluginData.historyMaxRead,
        recentHistory: await _readHistory(10),
        connected,
        // meta/defaults/ops/macros 单源下发：前端面板纯渲染（凛倾 0722 禁前端硬编码）
        meta: BROWSER_CONFIG_META,
        defaults: BROWSER_DEFAULTS,
        ops: BROWSER_OPS_META,
        macros: BROWSER_MACROS_META,
      }),
      SetData: async (data) => {
        if (!data) return;
        if (data.enabled !== undefined) pluginData.enabled = data.enabled;
        if (data.port !== undefined) pluginData.port = Number(data.port);
        if (data.driverPath !== undefined) pluginData.driverPath = data.driverPath;
        if (data.chromePath !== undefined) pluginData.chromePath = data.chromePath;
        if (data.userDataDir !== undefined) pluginData.userDataDir = data.userDataDir;
        if (data.snapshotMaxLines !== undefined) pluginData.snapshotMaxLines = Number(data.snapshotMaxLines);
        if (data.defaultTimeout !== undefined) pluginData.defaultTimeout = Number(data.defaultTimeout);
        if (data.defaultScrollDy !== undefined) pluginData.defaultScrollDy = Number(data.defaultScrollDy);
        if (data.gotoWaitUntil !== undefined) pluginData.gotoWaitUntil = data.gotoWaitUntil;
        if (data.resultLabel !== undefined) pluginData.resultLabel = data.resultLabel;
        if (data.resultSeparator !== undefined) pluginData.resultSeparator = data.resultSeparator;
        if (data.autoReconnect !== undefined) pluginData.autoReconnect = data.autoReconnect;
        if (data.recordBrowsing !== undefined) pluginData.recordBrowsing = data.recordBrowsing;
        if (data.historyFile !== undefined) pluginData.historyFile = data.historyFile;
        if (data.historyMaxRead !== undefined) pluginData.historyMaxRead = Number(data.historyMaxRead);
        _persistConfig();
      },
    },

    chat: {
      GetPrompt: async (arg) => {
        // ⚠ [铁律] GetPrompt 禁止硬编码提示词文本。引导文案走 injectTexts/fillInjectText（用户可配），操作说明走 INJ 条目。shadowBuild 会检测并隐藏 >200 字符的非宏内容。
        if (!pluginData.enabled) return null;

        const textEntries = [];

        const cid = _cidOf(arg);
        const results = _drainResults(cid);
        if (results.length > 0) {
          textEntries.push({
            content: pluginData.resultLabel + "\n" + results.join(pluginData.resultSeparator),
            description: "beilu-browser results",
            important: true,
          });
        }

        return {
          text: textEntries,
          additional_chat_log: [],
          extension: {
            macro_env: {
              browser_status: connected ? "connected" : "disconnected",
              browser_port: String(pluginData.port),
            },
          },
        };
      },

      ReplyHandler: async (reply, args) => {
        if (!pluginData.enabled) return false;
        if (!reply || !reply.content) return false;

        const ops = parseOps(reply.content);
        if (ops.length === 0) return false;

        const cid = _cidOf(args);
        wbT(cid, "browser:tag", "ops", { n: ops.length, types: ops.map((o) => o.type) });
        // [0727 凛倾] AI 打算操作浏览器 → 本体先通知一声（WS browser_op_notice → 前端
        //   toast+桌面通知+提示音，消费在 websocket.mjs 事件分发）。经 bus:broadcast 统一出口
        //   （范式同 memory replyHandler orb_message）。通知失败不阻断操作。
        if (cid) {
          try {
            const { dispatch } = await import("../../../../yonban/core/dispatch/dispatcher.mjs");
            await dispatch({
              target: "bus:broadcast", verb: "emit", source: "beilu-browser",
              payload: { chatid: cid, event: { type: "browser_op_notice", payload: { ops: ops.map((o) => o.type), connected } } },
            });
          } catch (e) { wbD(cid, "browser:notice", "broadcast", false, e?.message || String(e)); }
        }
        for (const op of ops) {
          const result = await executeOp(op);
          // executeOp 失败不抛而是返回 [Error] 文本（回喂 AI 自纠），白盒在此统一判定成败
          const _ok = !String(result).startsWith("[Error]");
          wbD(cid, "browser:op", op.type, _ok, _ok ? "" : String(result).slice(0, 160));
          // 网页内容（标题/AX 快照/eval 结果）=不可信外部文本，注入前过不可信边界
          //（nonce 边界+全角尖括号+不可见 Unicode 剥除，范式同 reach/aiRunner P8）
          const safe = wrapUntrusted(stripInvisibleUnicode(result), `browser:${op.type}`);
          _pushResult(cid, safe);
          await _recordOp(cid, op, result);
        }

        reply.content = reply.content.replace(TAG_REGEX, "").trim();

        if (args?.AddLongTimeLog) {
          args.AddLongTimeLog({
            name: "beilu-browser",
            time_stamp: Date.now(),
            role: "system",
            content: `Executed ${ops.length} browser operation(s): ${ops.map((o) => o.type).join(", ")}`,
            files: [],
            extension: { source: "beilu-browser" },
          });
        }

        return false;
      },
    },
  },
};

export default pluginExport;
