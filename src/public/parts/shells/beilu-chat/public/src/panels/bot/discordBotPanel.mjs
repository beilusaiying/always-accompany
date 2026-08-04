/**
 * discordBotPanel.mjs — Bot 管理面板（10 平台同构，schema 驱动）
 *
 * 功能链：
 *   initDiscordBotPanel({platform="discord"}) → PLATFORM_SCHEMA[platform]
 *     → 渲染连接凭据字段（conn[] 映射到 #dc-conn-fields input 行，secret:true=密码可切显隐）
 *     → 点「保存配置」→ POST /api/parts/shells:<shell>/config {token/...} → 后端持久化
 *     → 点「启动」→ POST /api/parts/shells:<shell>/start → bot.mjs 连接平台
 *     → 点「停止」→ POST /api/parts/shells:<shell>/stop → 断开
 *   C6 触发白名单 + 权限字段 → 渲染进 #dc-c6-fields（哪些频道/群组允许触发、角色权限）
 *   点「查看监控」→ renderBotOverviewPanel（botSidePanels.mjs 监控面板）
 *   切平台：layout.mjs 重新调用 initDiscordBotPanel({platform:"telegram"}) → 整面板替换内容
 *
 * why（schema 驱动同构 C5）：
 *   10 个 bot 平台凭据字段各不相同（Discord=单 token / Slack=两字段 / LINE=两字段 / 企微=5字段），
 *   把各平台映射为 PLATFORM_SCHEMA 对象后，面板渲染逻辑只写一份，切平台=换 schema，
 *   不再为每个平台写单独面板。后端端点路径统一为 /api/parts/shells:<shell>/...。
 *
 * 关联链：
 *   → shared/transport/api-client.mjs apiFetch（配置保存/启动/停止 REST 调用）
 *   → shared/state/utils.mjs escapeHtml（凭据字段标签 XSS 安全）
 *   → shared/widgets/beiluDialog.mjs beiluConfirm（停止 bot 二次确认）
 *   → panels/bot/botSidePanels.mjs renderBotOverviewPanel（监控面板入口）
 *   ← layout.mjs（Bot Tab 活动栏 [B] 按钮点击 / 平台切换时调用本函数）
 *   ← botSidePanels.mjs platformToShell（平台名→shell 名转换，从本模块 export）
 *
 * 影响范围：
 *   #dc-conn-fields / #dc-c6-fields DOM（凭据 + 权限字段动态渲染）；
 *   后端 discordbot/telegrambot 等壳的 config 文件（保存配置落盘）；
 *   bot 进程启停状态。
 *
 * 使用效果：
 *   切到 Bot Tab → 选平台 → 填写对应凭据字段 → 保存 → 启动；
 *   面板按平台自动适配字段数量和标签，无需为每个平台写独立 UI。
 */

import { escapeHtml as escHtml, BOT_CHAT_SYMBOL } from "../../shared/state/utils.mjs"; // 0715 收口:bot 符号前端单源
import { renderBotOverviewPanel } from "./botSidePanels.mjs";
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b：出向统一门面（shells:_bot 动态壳，payload._shell=平台壳名，verb=真动作）
import { bindContentFilterControls } from "../../shared/state/contentFilter.mjs"; // 内容过滤单 owner（与设置面板同源双向同步，0722 bot 窗口）
import { beiluConfirm, beiluPrompt } from "../../shared/widgets/beiluDialog.mjs";
import { applyParamSchemaToInputs, setParamSchema, setEnumSchema, getEnumSchema } from "../../shared/state/paramSchemaCache.mjs"; // 限值/枚举单源:后端 PARAM_SCHEMA/ENUM_SCHEMA 经 getSubModes 下发,写共享缓存
import { ENUM_FALLBACK } from "../../shared/state/enumFallback.mjs"; // 枚举离线退化单源(beilu离线铁律,与后端表等值镜像)

// ============================================================
// T072a（可操作处禁硬编码）：Bot 独立权限档位（C6，L0-L3）选项集单一权威源
// ============================================================
// why：C6 主用户权限 / 其他用户权限两个下拉（#dc-c6-owner-level / #dc-c6-default-level）
//   在同一 innerHTML 模板内各写死一份完全相同的 4 档 <option> = 前端双副本。此处抽为模块内单源，
//   两下拉同源生成，消除重复。
//   为何不复用 storage.mjs PERM_LEVEL_META（T011 IDE 权限单源）：二者语义集不同——
//   IDE 是 L0-L4（5档：只读/安全写/基础/高级/完全信任），Bot 是 L0-L3（4档：只读/读/读写需审批/完整+命令），
//   档数、每档 label 语义均不同，强行复用=授权语义错配（权限双源风险）。Bot 档位是独立语义，故独立单源。
//   value=数字字符串，后端 replyHandler 按 OwnerPermissionLevel/DefaultPermissionLevel 数字消费（回填缺省走 _clampPermLevel 双档：owner=3 / default=1）。
const DISCORD_PERM_LEVELS = [
  { value: "0", label: "L0 只读" },
  { value: "1", label: "L1 读" },
  { value: "2", label: "L2 读写(需审批)" },
  { value: "3", label: "L3 完整+命令" },
];
function _buildDiscordPermOptions() {
  return DISCORD_PERM_LEVELS
    .map(l => '<option value="' + escHtml(l.value) + '">' + escHtml(l.label) + "</option>")
    .join("");
}

// C6 默认值/触发模式选项：镜像后端单源 scripts/botContentShared.mjs
//   [P0-B 2026-08-03 fail-closed 同步] 后端默认已收紧：TriggerMode 缺省 "owner"、
//   OwnerPermissionLevel 缺省 3、DefaultPermissionLevel 缺省 1（withBotPermissionDefaults）。
//   前端仅镜像渲染，改默认/加模式只改后端再同步此处；原单常量 "all"+3 是改造前旧默认的 stale 副本
//   （分身B 链路追踪确诊的前后端默认分叉），随后端收紧拆成 owner/default 两档。
//   凛倾 07-09「前后端默认分叉」纠偏语义保留：populate/read/模板卡片消费同一钳制函数与同一默认。
const DISCORD_OWNER_PERM_DEFAULT = 3;
const DISCORD_DEFAULT_PERM_DEFAULT = 1;
const DISCORD_TRIGGER_MODES = [
  { value: "all", label: "所有人可触发" },
  { value: "owner", label: "仅主用户（默认）" },
  { value: "whitelist", label: "主用户 + 白名单" },
];
const DISCORD_TRIGGER_DEFAULT = "owner";
function _clampPermLevel(v, dflt = DISCORD_OWNER_PERM_DEFAULT) {
  const n = parseInt(v, 10);
  return DISCORD_PERM_LEVELS.some((l) => Number(l.value) === n) ? n : dflt;
}

/**
 * 平台 schema 表。conn[].key = 各壳 bot.mjs 实际读取的 config 顶层字段名（非 config.config 内）。
 * secret:true → 渲染为可切换显隐的 password 输入。
 * 字段来源核对：discordbot/telegrambot 用 token；slackbot token+appToken；
 *   linebot channelAccessToken+channelSecret；larkbot appId+appSecret；dingtalkbot clientId+clientSecret；
 *   xbot appKey+appSecret+accessToken+accessSecret；wecombot corpId+agentId+corpSecret+token+encodingAESKey；
 *   wechatbot apiUrl+apiToken。
 */
export const PLATFORM_SCHEMA = {
  discord: {
    shell: "discordbot", label: "Discord", icon: '<i data-ic="discord"></i>',
    conn: [{ key: "token", label: "Bot Token", secret: true, placeholder: "Discord Bot Token..." }],
  },
  telegram: {
    shell: "telegrambot", label: "Telegram", icon: '<i data-ic="telegram"></i>',
    conn: [{ key: "token", label: "Bot Token", secret: true, placeholder: "123456:ABC-DEF..." }],
  },
  slack: {
    shell: "slackbot", label: "Slack", icon: '<i data-ic="slack"></i>',
    conn: [
      { key: "token", label: "Bot Token (xoxb-)", secret: true, placeholder: "xoxb-..." },
      { key: "appToken", label: "App Token (xapp-)", secret: true, placeholder: "xapp-..." },
    ],
  },
  line: {
    shell: "linebot", label: "LINE", icon: '<i data-ic="line"></i>',
    conn: [
      { key: "channelAccessToken", label: "Channel Access Token", secret: true, placeholder: "long-lived channel access token" },
      { key: "channelSecret", label: "Channel Secret", secret: true, placeholder: "channel secret" },
    ],
  },
  x: {
    shell: "xbot", label: "X (Twitter)", icon: '<i data-ic="x-twitter"></i>',
    conn: [
      { key: "appKey", label: "App Key", secret: true, placeholder: "consumer / app key" },
      { key: "appSecret", label: "App Secret", secret: true, placeholder: "consumer / app secret" },
      { key: "accessToken", label: "Access Token", secret: true, placeholder: "access token" },
      { key: "accessSecret", label: "Access Secret", secret: true, placeholder: "access token secret" },
    ],
  },
  lark: {
    shell: "larkbot", label: "飞书", icon: '<i data-ic="lark"></i>',
    conn: [
      { key: "appId", label: "App ID", secret: false, placeholder: "cli_xxx" },
      { key: "appSecret", label: "App Secret", secret: true, placeholder: "app secret" },
    ],
  },
  dingtalk: {
    shell: "dingtalkbot", label: "钉钉", icon: '<i data-ic="dingtalk"></i>',
    conn: [
      { key: "clientId", label: "Client ID (AppKey)", secret: false, placeholder: "client id / app key" },
      { key: "clientSecret", label: "Client Secret", secret: true, placeholder: "client secret" },
    ],
  },
  wecom: {
    shell: "wecombot", label: "企业微信", icon: '<i data-ic="wecom"></i>',
    conn: [
      { key: "corpId", label: "Corp ID", secret: false, placeholder: "企业 ID (corpid)" },
      { key: "agentId", label: "Agent ID", secret: false, placeholder: "应用 agentid" },
      { key: "corpSecret", label: "Corp Secret", secret: true, placeholder: "应用 secret" },
      { key: "token", label: "回调 Token", secret: true, placeholder: "接收消息 Token" },
      { key: "encodingAESKey", label: "EncodingAESKey", secret: true, placeholder: "43 位 EncodingAESKey" },
    ],
  },
  wechat: {
    shell: "wechatbot", label: "微信", icon: '<i data-ic="wechat"></i>',
    conn: [
      { key: "apiUrl", label: "API 网关地址", secret: false, placeholder: "http://127.0.0.1:xxxx" },
      { key: "apiToken", label: "API Token", secret: true, placeholder: "网关鉴权 token（可选）" },
    ],
  },
};

/** 平台 → shell 名（layout / 外部可复用）。 */
export function platformToShell(platform) {
  return (PLATFORM_SCHEMA[platform] || PLATFORM_SCHEMA.discord).shell;
}

/**
 * 模块级面板状态。切平台会重复 init，window 级监听器只绑一次，
 * 通过此对象读当前选中 Bot / 平台，避免监听器随每次 init 叠加。
 */
const _botPanelState = { selectedBot: null, platform: "discord", showToast: null };

/**
 * 克隆替换元素以清空其上所有事件监听器（切平台重新 init 时防监听器叠加）。
 * 返回新元素（若原元素不存在返回 null）。
 */
function _resetElementListeners(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  const clone = el.cloneNode(true);
  el.parentNode?.replaceChild(clone, el);
  return clone;
}

/**
 * Bot 预设模板（设计：前端计划/Bot模式_界面设计.md §Bot模板系统 → 5 个预设模板）
 *
 * 纯前端：模板 = 预填充的可视化配置字段（OwnerUserName/MaxMessageDepth/触发模式/频道...）。
 *
 * 权限/触发字段必须真写（凛倾 07-09「功能是否有效,这个的话你直接做」）：
 *   卡片宣称的「权限: L0/L1/L2」此前无生产者（config 不含档位字段→后端默认全 L3），是装饰。
 *   消费链：OwnerPermissionLevel/DefaultPermissionLevel → botContentShared resolveBotPermissionLevel
 *     → chat_log._permissionLevel → resolveRequestBotPermission → beilu-files file_op +
 *     beilu-memory ideToolCall/delegate/modeSwitch 策略点；TriggerMode → checkBotTriggerAllowed
 *     （owner 永放行，owner=仅主用户，all=所有人）。档位语义=DISCORD_PERM_LEVELS（L0 只读…L3 完整+命令）。
 *
 * 单源纪律（凛倾 07-09「同一键多处散写/绕过收口/双键不同步」纠偏）：
 *   · config 只写与后端模板（GetBotConfigTemplate=GetSimpleBotConfigTemplate+withBotPermissionDefaults）
 *     不同的 delta，基础默认（depth 20/fetch 30/@触发/私聊开/TriggerMode all…）不复写——
 *     创建时 _applyTemplate 以后端模板为基底合并，后端改默认前端自动跟。
 *   · 卡片「权限」标签从 config.OwnerPermissionLevel 经 DISCORD_PERM_LEVELS 派生（_tplPermLabel），
 *     不再独立 level 键（曾与 config 无绑定=双键漂移源）。
 */
const BOT_TEMPLATES = {
  companion: {
    icon: '<i data-ic="message"></i>', label: "陪伴", desc: "公共频道角色扮演 · 记忆同步 · 无工具",
    config: {
      OwnerPermissionLevel: 0, DefaultPermissionLevel: 0,
    },
  },
  assistant: {
    icon: '<i data-ic="clipboard"></i>', label: "助手", desc: "私人助手 · 读取文件 · 可派任务",
    config: {
      TriggerMode: "owner",
      // L2 非 L1：desc 宣称「可派任务」，delegate/parallelDelegate 通道在 replyHandler N42 闸是 L<2 拒
      //   ——L1 会让卡片宣称落空（file_op 读 L1 即可，但派任务需 ≥2；L2 写操作仍强制进审批队列有闸）。
      OwnerPermissionLevel: 2, DefaultPermissionLevel: 0,
    },
  },
  minimal: {
    icon: '<i data-ic="shield"></i>', label: "最小", desc: "纯聊天 · 零风险 · 无工具无记忆",
    config: {
      MaxMessageDepth: 10, MaxFetchCount: 20,
      PrivateChatEnabled: false,
      OwnerPermissionLevel: 0, DefaultPermissionLevel: 0,
    },
  },
  work: {
    icon: '<i data-ic="wrench"></i>', label: "工作", desc: "Owner 专用 · 读写文件 · 委派+IDE",
    config: {
      MaxMessageDepth: 30, MaxFetchCount: 40,
      TriggerMode: "owner",
      OwnerPermissionLevel: 2, DefaultPermissionLevel: 0,
    },
  },
  custom: {
    icon: '<i data-ic="settings"></i>', label: "自定义", desc: "空白配置 · 全部手动设置",
    config: {},
  },
};

/** 模板卡片「权限」标签：从 config 档位派生（无档位=自选，走后端默认）。 */
function _tplPermLabel(t) {
  const lv = t?.config?.OwnerPermissionLevel;
  const meta = lv !== undefined ? DISCORD_PERM_LEVELS.find((l) => Number(l.value) === Number(lv)) : null;
  return meta ? meta.label : "自选";
}

/**
 * Bot API 工厂：按 shell 名生成端点集（10 壳端点同构，仅 part 前缀不同）。
 */
function makeBotApi(shell) {
  // T6b：全走 sendAction 的 shells:_bot 动态壳路由，payload._shell=shell（后端 /api/parts/shells:<shell>/...）；
  //   sendAction 直接返回解析体（原 _dcFetch 的 !ok→throw + json 由 apiFetch/门面承担），verb=真动作。
  const _act = (verb, payload) => sendAction({ verb, target: "shells:_bot", source: "web", payload: { _shell: shell, ...payload } });
  return {
    getBotList: () => _act("getBotList", {}),
    getBotConfig: (name) => _act("getBotConfig", { botname: name }),
    setBotConfig: (name, config) => _act("setBotConfig", { botname: name, config }),
    newBotConfig: (name) => _act("newBotConfig", { botname: name }),
    deleteBotConfig: (name) => _act("deleteBotConfig", { botname: name }),
    startBot: (name) => _act("startBot", { botname: name }),
    stopBot: (name) => _act("stopBot", { botname: name }),
    getRunningBotList: () => _act("getRunningBotList", {}),
    getBotConfigTemplate: (charname) => _act("getBotConfigTemplate", { charname }),
    clearContext: (name) => _act("clearContext", { botname: name }),
    getMessageLog: (name, since) => _act("getMessageLog", { botname: name, since }),
    getActiveChannels: (name) => _act("getActiveChannels", { botname: name }),
    setMessageLogSize: (name, size) => _act("setMessageLogSize", { botname: name, size }),
  };
}

/**
 * 初始化 Discord Bot 面板
 * @param {object} deps - { showToast, getCurrentCharId, getPartList }
 */
export async function initDiscordBotPanel(deps) {
  const { showToast, getCurrentCharId, getPartList } = deps;
  const platform = deps.platform || "discord";
  const schema = PLATFORM_SCHEMA[platform] || PLATFORM_SCHEMA.discord;
  const DC_API = makeBotApi(schema.shell);

  // 重入保护：切平台会重复调用本函数。上一轮的轮询计时器挂在 window，先清掉。
  try {
    if (window.__beiluBotPanelTimers) {
      const { logTimer, runTimer } = window.__beiluBotPanelTimers;
      if (logTimer) clearInterval(logTimer);
      if (runTimer) clearInterval(runTimer);
    }
  } catch {}

  _botPanelState.platform = platform;
  _botPanelState.showToast = showToast;

  // 切平台重新 init：克隆替换所有「会被 addEventListener」的元素，清掉上一轮平台的监听器，
  // 防止多平台来回切换时回调叠加（旧平台 API 与新平台 API 都触发）。
  [
    "dc-bot-select", "dc-bot-new", "dc-bot-delete", "dc-empty-new",
    "dc-char-select", "dc-bind-current", "dc-save", "dc-start-stop",
    "dc-clear-context", "dc-edit-inj3", "dc-log-size-apply",
    "dc-platform-inj-save", "dc-ensure-botchat",
  ].forEach(_resetElementListeners);

  const botSelect = document.getElementById("dc-bot-select");
  const newBtn = document.getElementById("dc-bot-new");
  const deleteBtn = document.getElementById("dc-bot-delete");
  const configCard = document.getElementById("dc-config-card");
  const emptyState = document.getElementById("dc-empty-state");
  const emptyNewBtn = document.getElementById("dc-empty-new");
  const charSelect = document.getElementById("dc-char-select");
  const bindCurrentBtn = document.getElementById("dc-bind-current");

  // ---- 连接凭据字段：按平台 schema 动态渲染进 #dc-conn-fields ----
  const connHost = document.getElementById("dc-conn-fields");
  /** @type {Record<string, HTMLInputElement>} key → input 元素 */
  const connInputs = {};
  if (connHost) {
    connHost.innerHTML = schema.conn
      .map((f) => {
        const inputId = `dc-conn-${f.key}`;
        const type = f.secret ? "password" : "text";
        const toggle = f.secret
          ? `<button type="button" class="btn btn-xs btn-ghost btn-square" data-conn-toggle="${inputId}" title="显示/隐藏"><i data-ic="eye"></i></button>`
          : "";
        return `<div class="form-control">
          <label class="label py-0.5"><span class="label-text text-xs">${escHtml(f.label)}</span></label>
          <div class="flex gap-1">
            <input type="${type}" id="${inputId}" class="input input-xs input-bordered flex-1 font-mono text-xs" placeholder="${escHtml(f.placeholder || "")}" />
            ${toggle}
          </div>
        </div>`;
      })
      .join("");
    schema.conn.forEach((f) => {
      connInputs[f.key] = document.getElementById(`dc-conn-${f.key}`);
    });
    connHost.querySelectorAll("[data-conn-toggle]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const inp = document.getElementById(btn.dataset.connToggle);
        if (!inp) return;
        inp.type = inp.type === "password" ? "text" : "password";
        // 成对 toggle 整对转 data-ic：内容为内部常量无用户数据，textContent→innerHTML 才能渲染 <i>
        btn.innerHTML = inp.type === "password" ? '<i data-ic="eye"></i>' : '<i data-ic="eye-off"></i>';
      });
    });
  }

  // ---- C6 触发白名单 + 独立权限 L0-L3：渲染进 #dc-c6-fields（10 平台同构） ----
  const c6Host = document.getElementById("dc-c6-fields");
  if (c6Host) {
    c6Host.innerHTML = `
      <div class="text-[10px] text-base-content/50 mt-1"><i data-ic="shield"></i> 触发白名单 + 权限 (C6)</div>
      <div class="form-control">
        <label class="label py-0.5"><span class="label-text text-xs">触发模式</span></label>
        <select id="dc-c6-trigger-mode" class="select select-xs select-bordered w-full">
          ${DISCORD_TRIGGER_MODES.map((m) => '<option value="' + escHtml(m.value) + '">' + escHtml(m.label) + "</option>").join("")}
        </select>
      </div>
      <div class="form-control">
        <label class="label py-0.5"><span class="label-text text-xs">白名单用户ID（whitelist 模式生效，逗号分隔）</span></label>
        <input id="dc-c6-allowed-ids" type="text" class="input input-xs input-bordered w-full font-mono" placeholder="用户ID1, 用户ID2..." />
      </div>
      <div class="flex gap-2">
        <div class="form-control flex-1">
          <label class="label py-0.5"><span class="label-text text-xs">主用户权限</span></label>
          <select id="dc-c6-owner-level" class="select select-xs select-bordered w-full">${_buildDiscordPermOptions()}</select>
        </div>
        <div class="form-control flex-1">
          <label class="label py-0.5"><span class="label-text text-xs">其他用户权限</span></label>
          <select id="dc-c6-default-level" class="select select-xs select-bordered w-full">${_buildDiscordPermOptions()}</select>
        </div>
      </div>
      <div class="text-[10px]" style="color:var(--beilu-amber-70)">默认 all + L3（保持现状不破坏现有 Bot）；收紧靠手动配置。待凛倾刷新验证。</div>`;
  }

  // ---- 平台相关文案更新（空状态图标/标题/描述/按钮 + INJ-3 标题/title/预览，全部跟随 schema 单源）----
  const emptyIcon = document.getElementById("dc-empty-icon");
  // schema.icon 现为 '<i data-ic="...">'（唯一消费点，内部常量无用户数据），textContent→innerHTML 才能渲染图标
  if (emptyIcon) emptyIcon.innerHTML = schema.icon;
  const emptyTitle = document.querySelector("#dc-empty-state p.text-sm");
  if (emptyTitle) emptyTitle.textContent = `${schema.label} Bot`;
  const emptyDesc = document.querySelector("#dc-empty-state p.text-xs");
  if (emptyDesc) emptyDesc.textContent = `创建一个 Bot 配置，让你的角色卡在 ${schema.label} 上线`;
  const emptyNewText = document.getElementById("dc-empty-new-text");
  if (emptyNewText) emptyNewText.textContent = `新建 ${schema.label} Bot`;
  // INJ-3 标题/预览不跟随平台：INJ-3 是单条 autoMode="bot" 门控注入，10 平台共用同一条，
  // 按平台显示「${平台} Bot 提示词」会误导用户以为每平台各有一条（改 Telegram 的=改全部）。静态文案在 index.html。

  const c6TriggerMode = document.getElementById("dc-c6-trigger-mode");
  const c6AllowedIds = document.getElementById("dc-c6-allowed-ids");
  const c6OwnerLevel = document.getElementById("dc-c6-owner-level");
  const c6DefaultLevel = document.getElementById("dc-c6-default-level");

  const configJson = document.getElementById("dc-config-json");
  const saveBtn = document.getElementById("dc-save");
  const saveStatus = document.getElementById("dc-save-status");
  const startStopBtn = document.getElementById("dc-start-stop");
  const statusDot = document.getElementById("dc-status-dot");
  const statusText = document.getElementById("dc-status-text");
  const clearContextBtn = document.getElementById("dc-clear-context");

  // ---- Bot 行为字段：模板驱动渲染（0716 病征7修复，凛倾「前端丧失后端可调项」）----
  // 字段集单源=后端 getBotConfigTemplate 实际键集（含存量配置键），前端只持展示元数据字典；
  // 后端模板加键→前端自动渲染（字典缺失=键名直显+类型按值推断），消灭前后端双清单漂移。
  // 原静态表单按 discord 9 字段写死渲染 10 平台：OwnerUserId 在 lark/line/wecom/xbot 填了永不被读、
  // xbot PollIntervalMs/MaxTweetLength、wechat OwnerWxid/TriggerOnGroupMention 等后端可调项前端丢失
  //（病征扫描 §3.1/3.2 双向缺口清单）。渲染范式=同文件 #dc-c6-fields JS 渲染先例。
  const vcHost = document.getElementById("dc-visual-config");
  // 展示元数据（label/hint/type 是纯展示域；min/max 只保留原静态表单既有值，不新造限值——限值权威在后端）
  // 件14：字段元数据后端单源（botContentShared BOT_CONFIG_FIELD_META，业界四家共识=schema 携带 label）。
  // 原前端字典纯删——与后端模板键集漂移病（新键加了模板没加 meta=裸键）就此根治。预取 fire-and-forget：
  // 未到前渲染=裸键 label 兜底（诚实降级非断链），到后下次渲染即刷新；meta 全局静态与壳无关，任一壳拉取即可。
  let VC_FIELD_META = {};
  sendAction({ verb: "getConfigFieldMeta", target: "shells:_bot", source: "web", payload: { _shell: "discordbot" } })
    .then((m) => { if (m && typeof m === "object") VC_FIELD_META = m; })
    .catch(() => { /* 拉取失败=裸键显示 */ });
  /** 当前渲染的行为控件：key → { el, kind }。populate 渲染时重建，read 遍历收值。 */
  let _vcControls = new Map();
  /** 行为字段根归一：xbot 模板凭据外层已后端归一平层（0716 P4，9 壳统一形），本函数保留职责=
   *  存量错位配置自愈（历史 xbot 模板形={凭据..., config:{行为}} 曾致 _applyTemplate 把整模板铺进
   *  config → 行为字段落 config.config.config，壳读 botConfig.config 读不到用户修改）——
   *  读侧含 config 子对象则下钻、写侧落平级；平层输入原样透传。 */
  function _vcBehaviorRoot(obj) {
    if (obj && typeof obj.config === "object" && obj.config !== null && !Array.isArray(obj.config)) return obj.config;
    return obj || {};
  }
  function _vcKindOf(key, val) {
    const m = VC_FIELD_META[key];
    if (m) return m.type;
    if (typeof val === "boolean") return "bool";
    if (typeof val === "number") return "number";
    if (Array.isArray(val)) return "array";
    return "text";
  }
  /** 按字段源对象的键集渲染行为表单（键集=后端模板/存量配置真值，非前端清单）。 */
  function renderVisualConfig(src) {
    if (!vcHost) return;
    _vcControls = new Map();
    const exclude = new Set(["TriggerMode", "AllowedUserIDs", "OwnerPermissionLevel", "DefaultPermissionLevel", "char", "config", ...schema.conn.map((f) => f.key)]);
    const keys = Object.keys(src || {}).filter((k) => !exclude.has(k));
    const texts = [], bools = [];
    for (const k of keys) (_vcKindOf(k, src[k]) === "bool" ? bools : texts).push(k);
    let html = `<div class="text-[10px] text-base-content/50 mt-1">Bot 行为（字段随 ${escHtml(schema.label)} 后端模板）</div>`;
    for (const k of texts) {
      const m = VC_FIELD_META[k] || {};
      const kind = _vcKindOf(k, src[k]);
      const attrs = kind === "number"
        ? `type="number"${Number.isFinite(m.min) ? ` min="${m.min}"` : ""}${Number.isFinite(m.max) ? ` max="${m.max}"` : ""}`
        : `type="text"${m.placeholder ? ` placeholder="${escHtml(m.placeholder)}"` : ""}`;
      html += `<div class="form-control">
        <label class="label py-0.5"><span class="label-text text-xs">${escHtml(m.label || k)}</span></label>
        <input id="dc-vc-${escHtml(k)}" ${attrs} class="input input-xs input-bordered w-full"${m.hint ? ` title="${escHtml(m.hint)}"` : ""} />
      </div>`;
    }
    if (bools.length) {
      html += `<div class="text-[10px] text-base-content/50 mt-1">触发模式</div><div class="flex flex-col gap-1">`;
      for (const k of bools) {
        const m = VC_FIELD_META[k] || {};
        html += `<label class="label cursor-pointer justify-start gap-2 py-0.5">
          <input id="dc-vc-${escHtml(k)}" type="checkbox" class="toggle toggle-xs ${k === "ReplyToAllMessages" ? "toggle-warning" : "toggle-primary"}" />
          <span class="label-text text-xs">${escHtml(m.label || k)}</span>
        </label>`;
      }
      html += `</div>`;
    }
    vcHost.innerHTML = html;
    for (const k of keys) {
      const el = document.getElementById("dc-vc-" + k);
      if (el) _vcControls.set(k, { el, kind: _vcKindOf(k, src[k]) });
    }
  }

  // 消息日志元素
  const dcLogStatus = document.getElementById("dc-log-status");
  const dcLogList = document.getElementById("dc-log-list");
  const dcLogEmpty = document.getElementById("dc-log-empty");
  let _dcLogTimer = null;
  let _dcRunTimer = null;
  let _dcLastLogTs = 0;

  /** 面板状态 */
  let _dcBotList = [];
  let _dcSelectedBot = null;
  let _dcSelectedBotChar = ""; // 选中 Bot 已落盘的绑定角色（平台注入存储作用域，非表单未保存值）
  let _dcRunningBots = [];

  /** 填充可视化配置表单（cfg = bot config 的 config 子对象或模板 merge 产物；先按其键集渲染再填值）。
   *  渲染与填值同源（键集=cfg 真值键），bool 直取 !!值——原按字段各写 !==false/!! 的缺省语义已无必要。 */
  function populateVisualConfig(cfg) {
    const src = _vcBehaviorRoot(cfg || {});
    renderVisualConfig(src);
    for (const [k, { el, kind }] of _vcControls) {
      const v = src[k];
      if (kind === "bool") el.checked = !!v;
      else if (kind === "array") el.value = (Array.isArray(v) ? v : []).join(", ");
      else el.value = v ?? "";
    }
    // ---- C6 字段（默认走 _clampPermLevel 双档单源，与 readVisualConfig/后端 fail-closed 默认同源） ----
    if (c6TriggerMode) c6TriggerMode.value = src.TriggerMode || DISCORD_TRIGGER_DEFAULT;
    if (c6AllowedIds)
      c6AllowedIds.value = (Array.isArray(src.AllowedUserIDs) ? src.AllowedUserIDs : []).join(", ");
    if (c6OwnerLevel)
      c6OwnerLevel.value = String(_clampPermLevel(src.OwnerPermissionLevel, DISCORD_OWNER_PERM_DEFAULT));
    if (c6DefaultLevel)
      c6DefaultLevel.value = String(_clampPermLevel(src.DefaultPermissionLevel, DISCORD_DEFAULT_PERM_DEFAULT));
  }

  /** 从可视化表单读取配置（含 C6 字段，写入 config.config）。
   *  只收当前渲染过的键（=本平台后端模板/存量键集），不再写死 discord 字段清单；
   *  number 留空/非法时省略该字段（merge 保留 advancedConfig/后端模板值），不写假默认。 */
  function readVisualConfig() {
    const cfg = {};
    for (const [k, { el, kind }] of _vcControls) {
      if (kind === "bool") cfg[k] = !!el.checked;
      else if (kind === "number") {
        const n = parseInt(el.value, 10);
        if (Number.isFinite(n)) cfg[k] = n;
      } else if (kind === "array")
        cfg[k] = (el.value || "").split(",").map((s) => s.trim()).filter(Boolean);
      else cfg[k] = (el.value || "").trim();
    }
    // ---- C6 触发白名单 + 权限（默认与 populateVisualConfig/后端同源，缺元素不再静默落 0） ----
    cfg.TriggerMode = c6TriggerMode?.value || DISCORD_TRIGGER_DEFAULT;
    cfg.AllowedUserIDs = (c6AllowedIds?.value || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    cfg.OwnerPermissionLevel = _clampPermLevel(c6OwnerLevel?.value, DISCORD_OWNER_PERM_DEFAULT);
    cfg.DefaultPermissionLevel = _clampPermLevel(c6DefaultLevel?.value, DISCORD_DEFAULT_PERM_DEFAULT);
    return cfg;
  }

  /** 渲染单条日志到消息日志面板 */
  function renderDcLogEntry(entry) {
    const div = document.createElement("div");
    const typeColor =
      entry.type === "user"
        ? "border-info"
        : entry.type === "error"
          ? "border-error"
          : "border-success";
    div.className = `p-1.5 rounded bg-base-300/50 border-l-2 ${typeColor}`;
    const timeStr = new Date(entry.timestamp).toLocaleTimeString();
    const icon =
      entry.type === "user" ? '<i data-ic="person"></i>' : entry.type === "error" ? '<i data-ic="warning"></i>' : '<i data-ic="bot"></i>';
    let html = `<div class="flex items-center gap-1 opacity-60 text-[10px] mb-0.5">
      <span>${icon}</span>
      <span class="font-semibold">${escHtml(entry.author || "")}</span>
      <span>${escHtml(entry.channelName || "")}</span>
      <span>${timeStr}</span>
    </div>
    <div class="whitespace-pre-wrap break-words">${escHtml((entry.content || "").slice(0, 200))}${(entry.content || "").length > 200 ? "..." : ""}</div>`;
    if (entry.type === "ai" && entry.fullContent) {
      html += `<div class="dc-full-toggle cursor-pointer text-warning text-[10px] mt-0.5 select-none"><i data-ic="file"></i> 展开原始内容</div>
      <div class="dc-full-content hidden mt-1 p-1 bg-base-100 rounded text-[10px] opacity-80 max-h-40 overflow-y-auto whitespace-pre-wrap">${escHtml(entry.fullContent)}</div>`;
    }
    div.innerHTML = html;
    const _tgl = div.querySelector(".dc-full-toggle");
    if (_tgl) _tgl.addEventListener("click", () => div.querySelector(".dc-full-content")?.classList.toggle("hidden"));
    dcLogList?.appendChild(div);
  }

  /**
   * 把日志条目镜像到主区域 #bot-main（设计上的「AI控制台」+「平台对话镜像」，
   * 原先无任何 producer 是死区）。控制台只收 ai/error，镜像收全部。
   */
  function renderBotMainEntry(entry) {
    const timeStr = new Date(entry.timestamp).toLocaleTimeString();
    const icon =
      entry.type === "user" ? '<i data-ic="person"></i>' : entry.type === "error" ? '<i data-ic="warning"></i>' : '<i data-ic="bot"></i>';
    const mirrorLog = document.getElementById("bot-mirror-log");
    if (mirrorLog) {
      const m = document.createElement("div");
      const c =
        entry.type === "user"
          ? "border-info"
          : entry.type === "error"
            ? "border-error"
            : "border-success";
      m.className = `p-1.5 rounded bg-base-300/40 border-l-2 ${c}`;
      m.innerHTML = `<div class="flex items-center gap-1 opacity-60 text-[10px] mb-0.5"><span>${icon}</span><span class="font-semibold">${escHtml(entry.author || "")}</span><span>${escHtml(entry.channelName || "")}</span><span>${timeStr}</span></div><div class="whitespace-pre-wrap break-words text-xs">${escHtml(entry.content || "")}</div>`;
      mirrorLog.appendChild(m);
      const mirror = document.getElementById("bot-mirror");
      if (mirror) mirror.scrollTop = mirror.scrollHeight;
    }
    if (entry.type === "ai" || entry.type === "error") {
      const consoleLog = document.getElementById("bot-console-log");
      if (consoleLog) {
        const c = document.createElement("div");
        c.className = `p-1.5 rounded bg-base-300/40 border-l-2 ${entry.type === "error" ? "border-error" : "border-success"}`;
        const text = entry.fullContent || entry.content || "";
        c.innerHTML = `<div class="flex items-center gap-1 opacity-60 text-[10px] mb-0.5"><span>${icon}</span><span>${escHtml(entry.channelName || "")}</span><span>${timeStr}</span></div><div class="whitespace-pre-wrap break-words">${escHtml(text)}</div>`;
        consoleLog.appendChild(c);
        const consoleBox = document.getElementById("bot-console");
        if (consoleBox) consoleBox.scrollTop = consoleBox.scrollHeight;
      }
    }
  }

  /** 清空主区域镜像/控制台 */
  function clearBotMain() {
    const m = document.getElementById("bot-mirror-log");
    if (m) m.innerHTML = "";
    const c = document.getElementById("bot-console-log");
    if (c) c.innerHTML = "";
  }

  /** 轮询消息日志 */
  async function pollDcLog() {
    if (!_dcSelectedBot) return;
    try {
      const running = _dcRunningBots.includes(_dcSelectedBot);
      if (dcLogStatus) dcLogStatus.textContent = running ? "运行中" : "未运行";
      if (!running) return;
      const data = await DC_API.getMessageLog(
        _dcSelectedBot,
        _dcLastLogTs || undefined,
      );
      if (data.logs && data.logs.length > 0) {
        for (const entry of data.logs) {
          renderDcLogEntry(entry);
          renderBotMainEntry(entry);
          if (entry.timestamp > _dcLastLogTs) _dcLastLogTs = entry.timestamp;
        }
        if (dcLogEmpty) dcLogEmpty.classList.add("hidden");
        const logContainer = document.getElementById("dc-message-log");
        if (logContainer) logContainer.scrollTop = logContainer.scrollHeight;
      }
    } catch {
      /* 静默 */
    }
  }

  /** 启动日志轮询 */
  function startDcLogPolling() {
    stopDcLogPolling();
    _dcLastLogTs = 0;
    if (dcLogList) dcLogList.innerHTML = "";
    clearBotMain();
    if (dcLogEmpty) dcLogEmpty.classList.remove("hidden");
    pollDcLog();
    _dcLogTimer = setInterval(pollDcLog, 5000);
    _registerTimers();
  }

  /** 把两个轮询计时器登记到 window，供切平台重新 init 时统一清理。 */
  function _registerTimers() {
    window.__beiluBotPanelTimers = { logTimer: _dcLogTimer, runTimer: _dcRunTimer };
  }

  /** 停止日志轮询 */
  function stopDcLogPolling() {
    if (_dcLogTimer) {
      clearInterval(_dcLogTimer);
      _dcLogTimer = null;
    }
  }

  if (!botSelect) return;

  // ---- 加载数据 ----
  async function loadBotList() {
    try {
      _dcBotList = await DC_API.getBotList();
      _dcRunningBots = await DC_API.getRunningBotList();
    } catch (err) {
      console.warn("[Discord Bot] 加载 Bot 列表失败:", err.message);
      _dcBotList = [];
      _dcRunningBots = [];
    }
    renderBotSelect();
    // Bot 总览（设计 §Bot总览面板）：列表刷新后聚合跨 Bot 统计，注入 #bot-side-list 末尾
    renderBotOverviewPanel().catch(() => { /* 静默：总览失败不影响列表 */ });
  }

  function renderBotSelect() {
    botSelect.innerHTML =
      '<option value="" disabled selected>(选择 Bot)</option>';
    _dcBotList.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      const isRunning = _dcRunningBots.includes(name);
      opt.textContent = name + (isRunning ? " 🟢" : "");
      botSelect.appendChild(opt);
    });

    if (_dcBotList.length === 0) {
      emptyState?.classList.remove("hidden");
      if (configCard) configCard.classList.add("hidden");
      if (deleteBtn) deleteBtn.disabled = true;
    } else {
      emptyState?.classList.add("hidden");
    }

    if (_dcSelectedBot && _dcBotList.includes(_dcSelectedBot)) {
      botSelect.value = _dcSelectedBot;
    }
  }

  async function loadCharList() {
    if (!charSelect) return;
    try {
      const chars = await getPartList("chars");
      charSelect.innerHTML = '<option value="">(未绑定)</option>';
      chars.forEach((name) => {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        charSelect.appendChild(opt);
      });
    } catch (e) {
      // T021 弹出：原静默=下拉只剩"(未绑定)"，用户无从得知是真没角色还是加载失败
      (_botPanelState.showToast || window._beiluToast)?.("角色列表加载失败: " + (e?.message || e), "error");
    }
  }

  // bot 预设口（凛倾0706 6口之③；[0716 凛倾定案]「绑定」概念删除，对齐「当前正在使用」单链）：
  //   线级真值 active_preset_map[<平台线chatid>:bot]（switch_preset 权威写口，即改即生效，
  //   每平台线各自预设互不覆盖；生成读侧 resolveActivePresetName map 最优先）
  //   > 全局 active_preset（无线级覆盖时的回退，resolveActivePresetName 既有回退链）。
  //   有当前平台线→下拉写线级（选空=clear 回退全局）；无线→下拉显示/切换全局当前预设。
  //   预设名格式=registry key 原样（preset_list=Object.keys(presets)，与 hasPreset 同源）。
  //   onchange 覆盖式赋值（非 addEventListener），平台切换重进不叠加，不需进 _resetElementListeners 名单。
  async function loadPresetBinding() {
    const presetSelect = document.getElementById("dc-preset-select");
    if (!presetSelect) return;
    let _lineChatId = "";
    try {
      const charname = charSelect?.value || _dcSelectedBotChar;
      if (charname) {
        const cur = await sendAction({ verb: "newBotChat", target: "shells:chat", source: "web", payload: { charname, platform, peek: true } });
        _lineChatId = cur?.chatid || "";
      }
    } catch { /* 无线=未设置(0725 没有全局,无回退值) */ }
    try {
      const data = await sendAction({ verb: "getData", target: "plugins:beilu-preset", source: "web" });
      const presets = data?.preset_list || [];
      // [0725 凛倾「没有全局」] 原"(用全局当前预设)"文案+语义废除:无线级覆盖=未设置(诚实空,不注入预设)
      presetSelect.innerHTML = `<option value="">(未设置)</option>`;
      presets.forEach((p) => {
        const opt = document.createElement("option");
        opt.value = p;
        opt.textContent = p.replace(/\.json$/i, "");
        presetSelect.appendChild(opt);
      });
      const _lineVal = _lineChatId ? (data?.active_preset_map?.[`${_lineChatId}:bot`] || data?.active_preset_map?.[_lineChatId] || "") : "";
      // 线级有覆盖显覆盖；无覆盖/无线停在"(未设置)"——语义即真值（0725 没有全局,无记录=不注入预设）
      presetSelect.value = _lineVal || "";
    } catch (e) {
      (_botPanelState.showToast || window._beiluToast)?.("预设列表加载失败: " + (e?.message || e), "error");
    }
    presetSelect.onchange = async () => {
      try {
        if (_lineChatId) {
          // 线级真值：switch_preset 权威写口（显式 mode:"bot"，与生成读键同源）
          await sendAction({
            verb: "updatePresetConfig", target: "plugins:beilu-preset", source: "web",
            payload: { switch_preset: presetSelect.value
              ? { name: presetSelect.value, chatid: _lineChatId, mode: "bot" }
              : { clear: true, chatid: _lineChatId, mode: "bot" } },
          });
          (_botPanelState.showToast || window._beiluToast)?.(presetSelect.value
            ? `本平台线预设「${presetSelect.value.replace(/\.json$/i, "")}」（即改即生效）`
            : "已清除本线预设覆盖", "success");
        } else if (presetSelect.value) {
          // [0725 凛倾「没有全局」] 原"无线切换全局当前预设"分支废除(后端无坐标切换已同批废除)——
          //   无平台线时预设无处可挂,诚实提示;先建线(选角色/首条消息)再选预设。
          (_botPanelState.showToast || window._beiluToast)?.("当前无平台线,无法切换预设(先绑定角色/建线)", "error");
          presetSelect.value = "";
        }
      } catch (e) {
        (_botPanelState.showToast || window._beiluToast)?.("预设切换失败: " + (e?.message || e), "error");
      }
    };
  }

  // 平台专属注入（凛倾 07-09「可以设置单独的平台注入」）：条目 = autoMode:"bot" + platform:<平台> 的
  //   injection_prompts 项，后端门控只在该平台 bot 会话注入（getPromptHandler bot 分支 platform 限定）；
  //   INJ-3（无 platform 字段）= 10 平台共用层。
  //   存储作用域 = 选中 Bot 已落盘的绑定角色卡：bot 生成 loadMemoryPresets(username, char_id=绑定角色)，
  //   写到别的 char = 读 A 写 B 不生效，故未绑角色时禁用编辑并提示。
  let _platformInjId = null; // 当前平台+当前绑定角色下已存在的条目 id（null=尚无，保存走 addInjectionPrompt）
  async function loadPlatformInjection() {
    const enabledEl = document.getElementById("dc-platform-inj-enabled");
    const contentEl = document.getElementById("dc-platform-inj-content");
    const saveEl = document.getElementById("dc-platform-inj-save");
    const hintEl = document.getElementById("dc-platform-inj-hint");
    const titleEl = document.getElementById("dc-platform-inj-title");
    if (!enabledEl || !contentEl || !saveEl) return;
    if (titleEl) titleEl.textContent = `${schema.label} 平台专属注入`;
    _platformInjId = null;
    const botChar = _dcSelectedBotChar;
    const noChar = !botChar;
    enabledEl.disabled = noChar;
    contentEl.disabled = noChar;
    saveEl.disabled = noChar;
    if (hintEl) hintEl.textContent = noChar
      ? "先给 Bot 绑定角色卡并保存（注入存于绑定角色的记忆预设，随该角色生效）"
      : `仅 ${schema.label} 平台的 Bot 会话注入（存于角色卡「${botChar}」）；上方 INJ-3 为全平台共用层`;
    if (noChar) { enabledEl.checked = false; contentEl.value = ""; return; }
    try {
      const data = await sendAction({ verb: "getData", target: "plugins:beilu-memory", source: "web", payload: { char_id: botChar } });
      const entry = (data?.injection_prompts || []).find((p) => p.autoMode === "bot" && p.platform === platform);
      _platformInjId = entry?.id || null;
      enabledEl.checked = !!entry?.enabled;
      contentEl.value = entry?.content || "";
    } catch (e) {
      (_botPanelState.showToast || window._beiluToast)?.("平台注入加载失败: " + (e?.message || e), "error");
    }
  }

  // ── Bot 参数覆盖（Bot 子模式）────────────────────────────────────────────
  // 0723 凛倾「专门做bot的参数,类似子模式,每个外部bot一个,可增可减,不要硬编码」。
  // 实体=sub_modes 框架 modeGroup:"bot" 条目（yonban_config 单源）；增删=saveSubModes/deleteSubMode
  // 通用 verb；线级激活=setActiveSubMode {id,chatId}（写 active_sub_modes_map[平台线chatid]）/
  // {clear:true,chatId}（回「无覆盖」）。生成读侧与 code/work 子模式同链（getPromptHandler
  // sub_mode_* ext → preset mergeRuntimeParams），_activeMode="bot" 时守卫放行 modeGroup:"bot"。
  // 纯参数实体：不设 presetName/label 以外任何提示词字段（铁律：代码不产生进对话文本）。
  let _bsmAllModes = []; // getSubModes 全量（saveSubModes 整表覆盖需要完整数组，只动 bot 条目）
  let _bsmLineChatId = "";
  let _bsmApiSources = null; // getAISources 缓存（null=未拉过）
  const _BSM_NUM_FIELDS = [
    // [model_params 键, DOM id, schema 键]（键名对齐 getPromptHandler B18 副本读法/PARAM_SCHEMA）
    ["temperature", "dc-bsm-temperature", "temperature"],
    ["max_tokens", "dc-bsm-max-tokens", "max_tokens"],
    ["max_context", "dc-bsm-max-context", "max_context"],
    ["top_p", "dc-bsm-top-p", "top_p"],
    ["top_k", "dc-bsm-top-k", "top_k"],
    ["min_p", "dc-bsm-min-p", "min_p"],
  ];

  async function _bsmFetchApiSources() {
    // 空数组不当缓存（拉取失败/瞬时空会被 [] 真值卡死，源列表永不重试）；非空才复用
    if (_bsmApiSources && _bsmApiSources.length) return _bsmApiSources;
    try {
      const list = await sendAction({ verb: "getAISources", target: "shells:serviceSourceManage", source: "web" });
      _bsmApiSources = Array.isArray(list) ? list.map((s) => (typeof s === "string" ? s : s.name || s.id || String(s))) : [];
    } catch { _bsmApiSources = []; }
    return _bsmApiSources;
  }

  async function _bsmFillForm(id) {
    const form = document.getElementById("dc-bsm-form");
    const delBtn = document.getElementById("dc-bsm-del");
    if (delBtn) delBtn.disabled = !id;
    if (!form) return;
    if (!id) { form.classList.add("hidden"); return; }
    const sm = _bsmAllModes.find((m) => m.id === id);
    if (!sm) { form.classList.add("hidden"); return; }
    form.classList.remove("hidden");
    const mp = (sm.model_params && typeof sm.model_params === "object") ? sm.model_params : {};
    const modelEl = document.getElementById("dc-bsm-model");
    if (modelEl) modelEl.value = mp.model || "";
    const srcSel = document.getElementById("dc-bsm-api-source");
    if (srcSel) {
      const sources = await _bsmFetchApiSources();
      srcSel.innerHTML = `<option value="">(不覆盖)</option>`;
      // 已存覆盖值不在列表（源列表拉取失败/源被改名）也补进选项——否则回显失真成"(不覆盖)"，
      // 用户改别的字段点保存会把 api_source 覆盖误清（读侧失真→写侧丢数据）
      const _srcOpts = (mp.api_source && !sources.includes(mp.api_source)) ? [mp.api_source, ...sources] : sources;
      _srcOpts.forEach((s) => {
        const o = document.createElement("option");
        o.value = s; o.textContent = s;
        srcSel.appendChild(o);
      });
      srcSel.value = mp.api_source || "";
    }
    for (const [key, elId] of _BSM_NUM_FIELDS) {
      const el = document.getElementById(elId);
      if (el) el.value = (mp[key] !== undefined && mp[key] !== null) ? mp[key] : "";
    }
    // 枚举两项：选项集=共享缓存(getSubModes enum_schema 权威) → ENUM_FALLBACK 离线退化;
    // 首项"(不覆盖)"=表单空项语义(归表单不归选项集);已存值不在集内也补option(防读侧失真→写侧误清,同 api_source)
    for (const [key, elId] of [["prompt_post_processing", "dc-bsm-post-process"], ["claude_prefill_mode", "dc-bsm-prefill-mode"]]) {
      const el = document.getElementById(elId);
      if (!el) continue;
      const _schemaOpts = getEnumSchema()?.[key]?.options;
      const opts = (Array.isArray(_schemaOpts) && _schemaOpts.length) ? _schemaOpts : (ENUM_FALLBACK[key] || []);
      el.innerHTML = `<option value="">(不覆盖)</option>`;
      const cur = mp[key] || "";
      const _all = (cur && !opts.some((o) => o.value === cur)) ? [{ value: cur, label: cur }, ...opts] : opts;
      _all.forEach((o) => {
        const opt = document.createElement("option");
        opt.value = o.value; opt.textContent = o.label || o.value;
        if (o.title) opt.title = o.title;
        el.appendChild(opt);
      });
      el.value = cur;
    }
    // 预填充开关：布尔三态（undefined=不覆盖 / true / false，对齐 getPromptHandler 确诊-B 语义）
    const prefEl = document.getElementById("dc-bsm-prefill-enabled");
    if (prefEl) prefEl.value = mp.prefill_enabled === true ? "on" : mp.prefill_enabled === false ? "off" : "";
    // 限值单源：后端 PARAM_SCHEMA 覆盖静态退化值（缓存未到=保留 HTML 属性，下次打开覆盖）
    applyParamSchemaToInputs(_BSM_NUM_FIELDS.map(([, elId, schemaKey]) => [schemaKey, elId]));
  }

  async function loadBotSubModePanel() {
    const sel = document.getElementById("dc-bsm-select");
    if (!sel) return;
    // 平台线 chatid（同 loadPresetBinding 的 peek 链：无线=控件只管全局实体增删，激活选择禁用）
    _bsmLineChatId = "";
    try {
      const charname = charSelect?.value || _dcSelectedBotChar;
      if (charname) {
        const cur = await sendAction({ verb: "newBotChat", target: "shells:chat", source: "web", payload: { charname, platform, peek: true } });
        _bsmLineChatId = cur?.chatid || "";
      }
    } catch { /* 无线 */ }
    let _bsmActiveMap = {};
    try {
      const data = await sendAction({ verb: "getSubModes", target: "plugins:beilu-memory", source: "web" });
      _bsmAllModes = Array.isArray(data?.sub_modes) ? data.sub_modes : [];
      // getSubModes 一并返回 active_sub_modes_map（0713 键收口后端单源下发）——不再另发 setActiveSubMode 空读
      _bsmActiveMap = data?.active_sub_modes_map || {};
      // 后端权威 schema 随包下发→写共享缓存（param_schema 限值/enum_schema 枚举集,全面板共享,无效入参模块内自忽略）
      setParamSchema(data?.param_schema);
      setEnumSchema(data?.enum_schema);
    } catch (e) {
      (_botPanelState.showToast || window._beiluToast)?.("Bot 子模式列表加载失败: " + (e?.message || e), "error");
      return;
    }
    const botModes = _bsmAllModes.filter((m) => (m.modeGroup || "code") === "bot");
    sel.innerHTML = `<option value="">(无覆盖，用预设参数)</option>`;
    botModes.forEach((m) => {
      const o = document.createElement("option");
      o.value = m.id; o.textContent = m.label || m.id;
      sel.appendChild(o);
    });
    // 本线激活回显（active_sub_modes_map[平台线chatid]，与生成读侧 resolveActiveSubModeId 同键）
    const activeId = _bsmLineChatId ? (_bsmActiveMap[_bsmLineChatId] || "") : "";
    sel.value = botModes.some((m) => m.id === activeId) ? activeId : "";
    await _bsmFillForm(sel.value);

    // onchange 覆盖式赋值（同 loadPresetBinding 范式：平台切换重进不叠加监听）
    sel.onchange = async () => {
      try {
        if (!_bsmLineChatId) {
          await _bsmFillForm(sel.value); // 无线：仅浏览/编辑参数实体，不写激活
          return;
        }
        if (sel.value) {
          await sendAction({ verb: "setActiveSubMode", target: "plugins:beilu-memory", source: "web", payload: { id: sel.value, chatId: _bsmLineChatId } });
          (_botPanelState.showToast || window._beiluToast)?.("本平台线参数覆盖已启用（即改即生效）", "success");
        } else {
          await sendAction({ verb: "setActiveSubMode", target: "plugins:beilu-memory", source: "web", payload: { clear: true, chatId: _bsmLineChatId } });
          (_botPanelState.showToast || window._beiluToast)?.("已取消本线参数覆盖（回预设基线）", "success");
        }
        await _bsmFillForm(sel.value);
      } catch (e) {
        (_botPanelState.showToast || window._beiluToast)?.("参数覆盖切换失败: " + (e?.message || e), "error");
      }
    };

    const addBtn = document.getElementById("dc-bsm-add");
    if (addBtn) addBtn.onclick = async () => {
      try {
        const label = await beiluPrompt("Bot 子模式名称", "");
        if (!label || !label.trim()) return;
        // id 规则对齐 registerModeIds /^[\w-]+$/：bot- 前缀 + 时间戳 base36（用户改名只动 label）
        const id = "bot-" + Date.now().toString(36);
        const entry = { id, label: label.trim(), modeGroup: "bot", enabled: true, model_params: {} };
        await sendAction({ verb: "saveSubModes", target: "plugins:beilu-memory", source: "web", payload: { sub_modes: [..._bsmAllModes, entry] } });
        await loadBotSubModePanel();
        const sel2 = document.getElementById("dc-bsm-select");
        if (sel2) { sel2.value = id; sel2.onchange(); }
      } catch (e) {
        (_botPanelState.showToast || window._beiluToast)?.("新增失败: " + (e?.message || e), "error");
      }
    };

    const delBtn = document.getElementById("dc-bsm-del");
    if (delBtn) delBtn.onclick = async () => {
      const id = sel.value;
      if (!id) return;
      const sm = _bsmAllModes.find((m) => m.id === id);
      if (!(await beiluConfirm(`删除 Bot 子模式「${sm?.label || id}」？（各平台线的激活引用会一并清除）`))) return;
      try {
        // deleteSubMode 通用级联：sub_modes 表 + active_sub_modes_map 全部指向键
        await sendAction({ verb: "deleteSubMode", target: "plugins:beilu-memory", source: "web", payload: { id } });
        await loadBotSubModePanel();
      } catch (e) {
        (_botPanelState.showToast || window._beiluToast)?.("删除失败: " + (e?.message || e), "error");
      }
    };

    const saveBtn = document.getElementById("dc-bsm-save");
    if (saveBtn) saveBtn.onclick = async () => {
      const id = sel.value;
      const sm = _bsmAllModes.find((m) => m.id === id);
      if (!sm) return;
      if (!sm.model_params || typeof sm.model_params !== "object") sm.model_params = {};
      const mp = sm.model_params;
      const modelV = document.getElementById("dc-bsm-model")?.value?.trim() || "";
      if (modelV) mp.model = modelV; else delete mp.model;
      const srcV = document.getElementById("dc-bsm-api-source")?.value || "";
      if (srcV) mp.api_source = srcV; else delete mp.api_source;
      for (const [key, elId] of _BSM_NUM_FIELDS) {
        const raw = document.getElementById(elId)?.value;
        // 空=不覆盖（删键）；显式值原样存（0 为 temperature/top_p 合法值，禁 truthy 判定）
        if (raw === "" || raw === undefined || raw === null) delete mp[key];
        else mp[key] = Number(raw);
      }
      // 枚举两项：空=不覆盖删键
      for (const [key, elId] of [["prompt_post_processing", "dc-bsm-post-process"], ["claude_prefill_mode", "dc-bsm-prefill-mode"]]) {
        const v = document.getElementById(elId)?.value || "";
        if (v) mp[key] = v; else delete mp[key];
      }
      // 预填充开关三态：""=不覆盖删键；on/off→布尔（false 是有效意图，消费端 !== undefined 判定）
      const prefV = document.getElementById("dc-bsm-prefill-enabled")?.value || "";
      if (prefV === "on") mp.prefill_enabled = true;
      else if (prefV === "off") mp.prefill_enabled = false;
      else delete mp.prefill_enabled;
      try {
        await sendAction({ verb: "saveSubModes", target: "plugins:beilu-memory", source: "web", payload: { sub_modes: _bsmAllModes } });
        (_botPanelState.showToast || window._beiluToast)?.("Bot 子模式参数已保存（本线激活时下一轮生效）", "success");
      } catch (e) {
        (_botPanelState.showToast || window._beiluToast)?.("参数保存失败: " + (e?.message || e), "error");
      }
    };
  }

  async function loadBotConfig(botname) {
    _dcSelectedBot = botname;
    _botPanelState.selectedBot = botname;
    if (deleteBtn) deleteBtn.disabled = !botname;
    // 内容过滤窗口（用户级，与选中 bot/平台无关）：幂等绑定+每次进面板回显最新值
    //（设置面板可能改过；模块内已绑则只 refresh 不重复挂监听）
    bindContentFilterControls({
      msgId: "dc-cf-msg-blacklist",
      userId: "dc-cf-user-blacklist",
      radioName: "dc-blacklist-filter-mode",
    });

    if (!botname) {
      configCard?.classList.add("hidden");
      updateRunStatus(false);
      _dcSelectedBotChar = "";
      loadPlatformInjection();
      loadBotChatBinding();
      loadPresetBinding();
      loadBotSubModePanel();
      return;
    }

    try {
      const config = await DC_API.getBotConfig(botname);
      // [0716 竞态守卫] 快速连点两个 bot 时慢响应后到：_dcSelectedBot 已是新值而这里还想应用旧 bot
      // 的配置 → 表单显示 A、保存写进 B（模板驱动化后字段集也会错平台）。选中态=单一权威，
      // await 后核对不一致即丢弃过期响应（后发的那次 loadBotConfig 自己会填对）。
      if (_dcSelectedBot !== botname) return;
      configCard?.classList.remove("hidden");
      _dcSelectedBotChar = config.char || "";
      loadPlatformInjection();
      loadBotChatBinding();
      loadPresetBinding();
      loadBotSubModePanel();

      // 连接凭据：按平台 schema 回填各字段（值在 bot config 顶层）
      schema.conn.forEach((f) => {
        if (connInputs[f.key]) connInputs[f.key].value = config[f.key] || "";
      });
      if (charSelect) charSelect.value = config.char || "";

      populateVisualConfig(config.config || {});

      if (configJson) {
        try {
          // _vcBehaviorRoot：高级 JSON 框显示归一后的行为层（存量 xbot 错位形含嵌套 config 死键，
          // 原样显示→保存读回→合并回写=死键永洗不掉，且下次 populate 时 _vcBehaviorRoot 见 config
          // 子键下钻到死键层=自愈被劫持。显示与保存同源归一，死键在下一次保存被洗平）。
          configJson.value = JSON.stringify(_vcBehaviorRoot(config.config || {}), null, 2);
        } catch {
          configJson.value = "{}";
        }
      }

      const isRunning = _dcRunningBots.includes(botname);
      updateRunStatus(isRunning);

      // 派发 bot-selected 事件,让外部(sidebar header)显示当前 Bot 绑定的角色
      try {
        window.dispatchEvent(new CustomEvent("beilu:bot-selected", {
          detail: { botname, charname: config.char || "", platform },
        }));
      } catch {}
    } catch (err) {
      showToast(`加载 Bot 配置失败: ${err.message}`, "error");
    }
  }

  function updateRunStatus(isRunning) {
    if (statusDot) {
      statusDot.className = `w-2.5 h-2.5 rounded-full ${isRunning ? "bg-success" : "bg-base-content/20"}`;
    }
    if (statusText) {
      statusText.textContent = isRunning ? "运行中" : "未运行";
      statusText.className = `text-xs ${isRunning ? "text-success" : "text-base-content/50"}`;
    }
    if (startStopBtn) {
      startStopBtn.disabled = !_dcSelectedBot;
      startStopBtn.textContent = isRunning ? "⏹ 停止" : "▶ 启动";
      startStopBtn.className = `btn btn-xs ${isRunning ? "btn-error" : "btn-success"}`;
    }
  }

  // ---- 事件绑定 ----

  botSelect.addEventListener("change", () => {
    loadBotConfig(botSelect.value);
  });

  /**
   * 应用模板：创建 Bot 后用模板预填充配置并持久化。
   * 复用 populateVisualConfig（填表单）+ setBotConfig（落盘），纯前端。
   */
  async function _applyTemplate(name, charName, tplKey) {
    const tpl = BOT_TEMPLATES[tplKey] || BOT_TEMPLATES.custom;
    const deltas = tpl.config || {};
    await DC_API.newBotConfig(name);
    // 自定义/空 delta 且未绑角色：不下发，读侧走后端默认
    if (Object.keys(deltas).length === 0 && !charName) return;
    // 收口（凛倾 07-09「绕过收口」纠偏）：newBotConfig 落的是 {}，字段默认的单一权威=后端
    //   GetBotConfigTemplate（GetSimpleBotConfigTemplate + withBotPermissionDefaults C6）。
    //   以后端模板为基底、模板 delta 覆盖，前端不整份自造 config（防基础键散写+前后端默认分叉）。
    let base = {};
    try {
      // _vcBehaviorRoot：xbot 模板凭据外层已后端归一平层（0716 P4，9 壳统一形）——此处包裹保留用于
      // 存量错位配置自愈（历史 {appKey..., config:{行为}} 形曾致 config.config.config 错位病）+平层透传无害。
      base = _vcBehaviorRoot((await DC_API.getBotConfigTemplate(charName || "")) || {});
    } catch { /* 无角色/模板取不到 → 仅下发 delta，读侧后端默认兜底 */ }
    try {
      // delta 只覆盖 base 已有键（0716）：BOT_TEMPLATES delta 按 discord 语义写（MaxFetchCount/
      // PrivateChatEnabled），非该平台键直接铺进=落死键（模板驱动渲染后还会显示成永不生效的控件）。
      // 平台没有的能力不硬造键；跨平台语义映射（如"关私聊"对 telegram 应写 TriggerOnPrivate）待模板卡片系统按归一化矩阵深改。
      const _fitDeltas = Object.keys(base).length ? Object.fromEntries(Object.entries(deltas).filter(([k]) => k in base)) : deltas; // base 空（模板取不到降级态）=原样下发 delta，读侧后端默认兜底
      await DC_API.setBotConfig(name, {
        token: "",
        char: charName || "",
        config: { ...base, ..._fitDeltas },
      });
    } catch (e) {
      // 落盘失败不致命：Bot 已建，提示用户手动保存
      console.warn("[Discord Bot] 模板配置落盘失败:", e.message);
    }
  }

  /** 新建 Bot：模板选择弹窗（设计 §Bot模板系统） */
  function handleNewBot() {
    // 已存在的弹窗先清掉
    document.getElementById("dc-newbot-modal")?.remove();

    const charOptions = charSelect
      ? Array.from(charSelect.options)
          .filter((o) => o.value)
          .map((o) => `<option value="${escHtml(o.value)}">${escHtml(o.textContent)}</option>`)
          .join("")
      : "";
    const curChar = (typeof getCurrentCharId === "function" && getCurrentCharId()) || "";

    const tplCards = Object.entries(BOT_TEMPLATES)
      .map(
        ([key, t], i) => `
        <button type="button" class="dc-tpl-card text-left p-2 rounded border ${i === 0 ? "border-base-300" : "border-base-300"}" ${i === 0 ? `style="border-color:var(--beilu-amber);background:var(--beilu-amber-10)"` : ""} data-tpl="${key}">
          <div class="text-sm font-semibold">${t.icon} ${escHtml(t.label)}</div>
          <div class="text-[11px] opacity-60 mt-0.5">${escHtml(t.desc)}</div>
          <div class="text-[10px] opacity-50 mt-1">权限: ${escHtml(_tplPermLabel(t))}</div>
        </button>`,
      )
      .join("");

    const modal = document.createElement("div");
    modal.id = "dc-newbot-modal";
    modal.className =
      "fixed inset-0 flex items-center justify-center bg-black/40"; modal.style.zIndex = "var(--z-diag)"; // 层级表单一权威(index.css)禁硬编码9999
    modal.innerHTML = `
      <div class="bg-base-100 rounded-lg shadow-xl w-[440px] max-w-[92vw] max-h-[88vh] overflow-y-auto p-4 space-y-3">
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-bold"><i data-ic="plus"></i> 新建 Bot</h3>
          <button id="dc-newbot-x" class="btn btn-xs btn-ghost">✕</button>
        </div>
        <div class="form-control">
          <label class="label py-0.5"><span class="label-text text-xs">Bot 名称</span></label>
          <input id="dc-newbot-name" type="text" class="input input-sm input-bordered w-full text-xs" placeholder="例如：贝露" autocomplete="off" />
        </div>
        <div class="form-control">
          <label class="label py-0.5"><span class="label-text text-xs">绑定角色</span></label>
          <select id="dc-newbot-char" class="select select-sm select-bordered w-full text-xs">
            <option value="">(暂不绑定)</option>
            ${charOptions}
          </select>
        </div>
        <div>
          <div class="text-xs font-semibold opacity-60 mb-1">选择模板</div>
          <div class="grid grid-cols-2 gap-1.5">${tplCards}</div>
        </div>
        <div class="flex gap-2 pt-1">
          <button id="dc-newbot-create" class="btn btn-sm flex-1 text-white" style="background:var(--beilu-amber);border-color:var(--beilu-amber)">创建</button>
          <button id="dc-newbot-cancel" class="btn btn-sm btn-ghost">取消</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    let _selectedTpl = Object.keys(BOT_TEMPLATES)[0];
    const cards = Array.from(modal.querySelectorAll(".dc-tpl-card"));
    cards.forEach((c) =>
      c.addEventListener("click", () => {
        cards.forEach((x) => {
          x.style.borderColor = ""; x.style.background = "";
          x.classList.add("border-base-300");
        });
        c.style.borderColor = "var(--beilu-amber)"; c.style.background = "var(--beilu-amber-10)";
        c.classList.remove("border-base-300");
        _selectedTpl = c.dataset.tpl;
      }),
    );

    const charSel = modal.querySelector("#dc-newbot-char");
    if (charSel && curChar) charSel.value = curChar;

    const close = () => modal.remove();
    modal.querySelector("#dc-newbot-x")?.addEventListener("click", close);
    modal.querySelector("#dc-newbot-cancel")?.addEventListener("click", close);
    modal.addEventListener("click", (e) => { if (e.target === modal) close(); });

    const nameInput = modal.querySelector("#dc-newbot-name");
    nameInput?.focus();

    modal.querySelector("#dc-newbot-create")?.addEventListener("click", async () => {
      const trimmed = (nameInput?.value || "").trim();
      if (!trimmed) { showToast("请输入 Bot 名称", "warning"); return; }
      if (_dcBotList.includes(trimmed)) {
        showToast(`Bot "${trimmed}" 已存在`, "warning");
        return;
      }
      const charName = charSel?.value || "";
      const createBtn = modal.querySelector("#dc-newbot-create");
      if (createBtn) createBtn.disabled = true;
      try {
        await _applyTemplate(trimmed, charName, _selectedTpl);
        showToast(`Bot "${trimmed}" 已创建（模板：${BOT_TEMPLATES[_selectedTpl]?.label || "自定义"}）`, "success");
        close();
        await loadBotList();
        botSelect.value = trimmed;
        await loadBotConfig(trimmed);
      } catch (err) {
        showToast(`创建失败: ${err.message}`, "error");
        if (createBtn) createBtn.disabled = false;
      }
    });
  }

  newBtn?.addEventListener("click", handleNewBot);
  emptyNewBtn?.addEventListener("click", handleNewBot);

  deleteBtn?.addEventListener("click", async () => {
    if (!_dcSelectedBot) return;
    if (!await beiluConfirm(`确定删除 Bot "${_dcSelectedBot}" 吗？`)) return;
    try {
      if (_dcRunningBots.includes(_dcSelectedBot)) {
        await DC_API.stopBot(_dcSelectedBot);
      }
      await DC_API.deleteBotConfig(_dcSelectedBot);
      showToast(`Bot "${_dcSelectedBot}" 已删除`, "success");
      _dcSelectedBot = null;
      await loadBotList();
      configCard?.classList.add("hidden");
    } catch (err) {
      showToast(`删除失败: ${err.message}`, "error");
    }
  });

  bindCurrentBtn?.addEventListener("click", () => {
    const charId = getCurrentCharId();
    if (charId && charSelect) {
      charSelect.value = charId;
      showToast(`已绑定当前角色: ${charId}`, "info");
    } else {
      showToast("当前没有加载角色卡", "warning");
    }
  });

  // 连接字段的显隐切换在动态渲染时已逐字段绑定（data-conn-toggle）。

  saveBtn?.addEventListener("click", async () => {
    if (!_dcSelectedBot) return;

    let advancedConfig = {};
    if (configJson) {
      try {
        // _vcBehaviorRoot：写侧落平级（用户粘贴/存量残留的错位形 {…, config:{行为}} 归一到行为层，
        // 防嵌套 config 死键回写——与 populate 填充侧 :864 同源归一，闭合"显示→保存"链）。
        advancedConfig = _vcBehaviorRoot(JSON.parse(configJson.value || "{}"));
      } catch (err) {
        showToast("高级配置 JSON 格式错误: " + err.message, "error");
        return;
      }
    }

    const visualCfg = readVisualConfig();
    const mergedConfig = { ...advancedConfig, ...visualCfg };

    // 连接凭据：按平台 schema 收集各字段到 config 顶层
    const config = {
      char: charSelect?.value || "",
      config: mergedConfig,
    };
    schema.conn.forEach((f) => {
      // 0714 trim 扫尾：token/host 类凭据粘贴常带首尾空白，脏值落盘=连接静默失败（同文件 Owner 字段已 trim，唯 conn 漏）
      config[f.key] = (connInputs[f.key]?.value || "").trim();
    });

    try {
      await DC_API.setBotConfig(_dcSelectedBot, config);
      if (saveStatus) {
        saveStatus.innerHTML = '<i data-ic="check"></i> 已保存';
        saveStatus.className = "text-xs text-center text-success";
        saveStatus.classList.remove("hidden");
        setTimeout(() => saveStatus.classList.add("hidden"), 2000);
      }
      showToast("Bot 配置已保存", "success");
      // 绑定角色可能刚改：平台注入/对话线指针键/线级预设都跟随绑定角色，同步刷新
      if (_dcSelectedBotChar !== (charSelect?.value || "")) {
        _dcSelectedBotChar = charSelect?.value || "";
        loadPlatformInjection();
        loadBotChatBinding();
        loadPresetBinding();
        loadBotSubModePanel();
      }
    } catch (err) {
      if (saveStatus) {
        saveStatus.innerHTML = '<i data-ic="cross"></i> 保存失败';
        saveStatus.className = "text-xs text-center text-error";
        saveStatus.classList.remove("hidden");
      }
      showToast(`保存失败: ${err.message}`, "error");
    }
  });

  startStopBtn?.addEventListener("click", async () => {
    if (!_dcSelectedBot) return;
    startStopBtn.disabled = true;

    try {
      const isRunning = _dcRunningBots.includes(_dcSelectedBot);
      if (isRunning) {
        await DC_API.stopBot(_dcSelectedBot);
        showToast(`Bot "${_dcSelectedBot}" 已停止`, "info");
      } else {
        await DC_API.startBot(_dcSelectedBot);
        showToast(`Bot "${_dcSelectedBot}" 已启动`, "success");
      }
      _dcRunningBots = await DC_API.getRunningBotList();
      updateRunStatus(_dcRunningBots.includes(_dcSelectedBot));
      renderBotSelect();
    } catch (err) {
      showToast(`操作失败: ${err.message}`, "error");
    } finally {
      startStopBtn.disabled = false;
    }
  });

  charSelect?.addEventListener("change", async () => {
    const charName = charSelect.value;
    if (!charName) return;
    const _atBot = _dcSelectedBot; // [0716 竞态守卫] await 模板期间用户切 bot/再改 char → 过期响应丢弃
    try {
      const template = _vcBehaviorRoot((await DC_API.getBotConfigTemplate(charName)) || {});
      if (_dcSelectedBot !== _atBot || charSelect.value !== charName) return;
      if (template && Object.keys(template).length > 0) {
        // 改绑角色时不能用模板覆盖已保存配置（会清掉 OwnerUserId/触发频道等）。
        // 以当前已落盘配置(高级JSON)为准，模板仅补缺失字段。_vcBehaviorRoot 同 _applyTemplate（xbot 凭据外层归一）。
        let current = {};
        try {
          current = _vcBehaviorRoot(JSON.parse(configJson?.value || "{}"));
        } catch {
          current = {};
        }
        const merged = { ...template, ...current };
        populateVisualConfig(merged);
        if (configJson) configJson.value = JSON.stringify(merged, null, 2);
      }
    } catch {
      /* 静默 */
    }
  });

  // INJ-3 编辑按钮 → 切换到注入提示词面板
  document.getElementById("dc-edit-inj3")?.addEventListener("click", () => {
    const injSection = document.getElementById("right-section-injection");
    if (injSection) {
      const collapseInput = injSection.querySelector('input[type="checkbox"]');
      if (collapseInput && !collapseInput.checked) collapseInput.checked = true;
      injSection.scrollIntoView({ behavior: "smooth", block: "start" });
      showToast("请在右栏找到 INJ-3 Bot 平台提示词进行编辑（10 平台共用）", "info");
    } else {
      showToast("请在右栏 → 注入提示词 中找到 INJ-3 进行编辑", "info");
    }
  });

  // bot 对话线切换器（凛倾 07-09「也可以切换……绑定死=设计浪费」，生效模型同 07-08 预设定调：
  //   指针=运行时真值，切换动作即改即生效，壳每条消息按指针取零缓存）。
  //   下拉=本平台全部 bot 对话线（getChatList 过滤 🤖[平台] 前缀，跨角色可选=角色也不绑死）；
  //   选中项=当前指针（peek 只查不建）；onchange=切指针；「新建」=fresh 新线并切（旧线保留存档）。
  async function loadBotChatBinding() {
    const sel = document.getElementById("dc-botchat-select");
    const statusEl = document.getElementById("dc-botchat-status");
    if (!sel) return;
    const charname = charSelect?.value || _dcSelectedBotChar;
    sel.innerHTML = '<option value="">(未绑定，首条消息自动创建)</option>';
    if (statusEl) statusEl.textContent = "";
    sel.disabled = !charname;
    if (!charname) return;
    try {
      const [list, cur] = await Promise.all([
        sendAction({ verb: "getChatList", target: "shells:chat", source: "web" }),
        sendAction({ verb: "newBotChat", target: "shells:chat", source: "web", payload: { charname, platform, peek: true } }),
      ]);
      const prefix = `${BOT_CHAT_SYMBOL}[${platform}]`;
      (Array.isArray(list) ? list : [])
        .filter((c) => (c.customName || "").startsWith(prefix))
        .forEach((c) => {
          const opt = document.createElement("option");
          opt.value = c.chatid;
          opt.textContent = `${c.customName}（${String(c.chatid).slice(0, 6)}…）`;
          sel.appendChild(opt);
        });
      if (cur?.chatid) {
        if (![...sel.options].some((o) => o.value === cur.chatid)) {
          const opt = document.createElement("option");
          opt.value = cur.chatid;
          opt.textContent = cur.name || cur.chatid;
          sel.appendChild(opt);
        }
        sel.value = cur.chatid;
        if (statusEl) statusEl.textContent = `当前上下文线：${cur.name}（${cur.chatid}）`;
      }
    } catch (e) {
      (_botPanelState.showToast || window._beiluToast)?.("对话线列表加载失败: " + (e?.message || e), "error");
    }
    // onchange 覆盖式赋值（与 presetSelect 同款），平台切换重进不叠加
    sel.onchange = async () => {
      if (!sel.value) return; // 空项=维持"首条消息自动创建"语义，不主动切
      const cn = charSelect?.value || _dcSelectedBotChar;
      if (!cn) return;
      try {
        const r = await sendAction({ verb: "newBotChat", target: "shells:chat", source: "web", payload: { charname: cn, platform, chatid: sel.value } });
        if (r?.error) throw new Error(r.error);
        if (statusEl) statusEl.textContent = `当前上下文线：${r.name || sel.value}（${r.chatid}）`;
        showToast(`已切换对话线「${r.name || sel.value}」（下条消息生效）`, "success");
        loadPresetBinding(); // 线级预设跟线走，切线后刷新回显
        loadBotSubModePanel(); // 线级参数覆盖同跟线
      } catch (e) {
        showToast(`切换失败: ${e?.message || e}`, "error");
        loadBotChatBinding();
      }
    };
  }

  // 「新建」=fresh 新线并切指针（旧线保留存档，仍被普通列表按符号屏蔽）
  document.getElementById("dc-ensure-botchat")?.addEventListener("click", async () => {
    const charname = charSelect?.value || _dcSelectedBotChar;
    if (!charname) {
      showToast("请先选择绑定角色卡", "warning");
      return;
    }
    if (!await beiluConfirm(`为「${charname}」在 ${schema.label} 新建对话线并切换？\n（旧对话线保留存档，可随时切回）`)) return;
    try {
      const r = await sendAction({ verb: "newBotChat", target: "shells:chat", source: "web", payload: { charname, platform, fresh: true } });
      if (r?.error) throw new Error(r.error);
      showToast(`已新建并切换对话线「${r.name}」`, "success");
      loadBotChatBinding();
      loadPresetBinding(); // 新线无线级覆盖=回显全平台默认
      loadBotSubModePanel(); // 新线无参数覆盖记录=回显(无覆盖)
    } catch (e) {
      showToast(`新建对话线失败: ${e?.message || e}`, "error");
    }
  });

  // 平台专属注入保存：已有条目 → updateInjectionPrompt；无 → addInjectionPrompt（带 platform 字段）。
  //   charName=已落盘绑定角色（与 bot 生成读取同源）。
  document.getElementById("dc-platform-inj-save")?.addEventListener("click", async () => {
    if (!_dcSelectedBotChar) return;
    const enabledEl = document.getElementById("dc-platform-inj-enabled");
    const contentEl = document.getElementById("dc-platform-inj-content");
    const common = { charName: _dcSelectedBotChar, enabled: !!enabledEl?.checked, content: contentEl?.value || "" };
    try {
      if (_platformInjId) {
        const r = await sendAction({ verb: "updateInjectionPrompt", target: "plugins:beilu-memory", source: "web", payload: { injectionId: _platformInjId, ...common } });
        if (r?.error) throw new Error(r.error);
      } else {
        const r = await sendAction({
          verb: "addInjectionPrompt", target: "plugins:beilu-memory", source: "web",
          payload: {
            ...common,
            name: `${schema.label} 平台注入`,
            description: `仅 ${schema.label} 平台的 Bot 会话注入（autoMode=bot + platform 限定）`,
            role: "system", depth: 999, order: 310, autoMode: "bot", platform,
          },
        });
        if (r?.error) throw new Error(r.error);
        _platformInjId = r?.id || null;
      }
      showToast(`已保存 ${schema.label} 平台注入`, "success");
    } catch (e) {
      showToast(`平台注入保存失败: ${e?.message || e}`, "error");
    }
  });

  clearContextBtn?.addEventListener("click", async () => {
    if (!_dcSelectedBot) return;
    if (!await beiluConfirm("确定要清除所有频道的聊天上下文吗？\n（记忆表格将保留）"))
      return;
    clearContextBtn.disabled = true;
    try {
      const result = await DC_API.clearContext(_dcSelectedBot);
      showToast(
        `上下文已清除（${result.clearedChannels || 0} 个频道）`,
        "success",
      );
      _dcLastLogTs = 0;
      if (dcLogList) dcLogList.innerHTML = "";
      clearBotMain();
      if (dcLogEmpty) dcLogEmpty.classList.remove("hidden");
    } catch (err) {
      showToast(`清除失败: ${err.message}`, "error");
    } finally {
      clearContextBtn.disabled = false;
    }
  });

  // 日志条数上限：调用 setlogsize（需 Bot 运行中，后端 SetMessageLogSize 钳 1-200）
  document
    .getElementById("dc-log-size-apply")
    ?.addEventListener("click", async () => {
      if (!_dcSelectedBot) return;
      if (!_dcRunningBots.includes(_dcSelectedBot)) {
        showToast("Bot 未运行，启动后才能调整日志条数", "warning");
        return;
      }
      const sizeEl = document.getElementById("dc-log-size");
      const size = parseInt(sizeEl?.value) || 20;
      try {
        const result = await DC_API.setMessageLogSize(_dcSelectedBot, size);
        if (sizeEl && result?.maxSize) sizeEl.value = result.maxSize;
        showToast(`日志上限已设为 ${result?.maxSize ?? size} 条`, "success");
      } catch (err) {
        showToast(`设置失败: ${err.message}`, "error");
      }
    });

  // ---- 平台命令清单（后端 BOT_COMMAND_REGISTRY 单源；前端零命令清单）----
  // 范式同 VC_FIELD_META：预取 fire-and-forget + 失败降级，不在前端保留任何命令名/用法字面量。
  // 命令表是全局静态（与壳/角色/平台无关，9 壳同一套），故只拉一次、不随平台切换重拉。
  let _cmdMetaLoaded = false;
  async function loadBotCommandMeta() {
    const host = document.getElementById("dc-cmd-list");
    if (!host || _cmdMetaLoaded) return;
    try {
      const meta = await sendAction({ verb: "getBotCommandMeta", target: "shells:_bot", source: "web", payload: { _shell: schema.shell } });
      const cmds = Array.isArray(meta?.commands) ? meta.commands : [];
      if (!cmds.length) throw new Error("空命令表");
      host.innerHTML = cmds.map((c) => `
        <div class="bg-base-300/50 rounded-lg p-2 space-y-1">
          <div class="flex items-center gap-1.5">
            <code class="text-xs font-semibold">${escHtml(c.word)}</code>
            <span class="text-xs opacity-70">${escHtml(c.label || "")}</span>
            ${c.ownerOnly ? `<span class="badge badge-xs badge-outline">仅主用户</span>` : ""}
          </div>
          <div class="text-[10px] text-base-content/50">${escHtml(c.desc || "")}</div>
          ${(Array.isArray(c.subs) ? c.subs : []).map((s) => `
            <div class="flex items-start gap-2 text-[10px]">
              <code class="shrink-0 opacity-80">${escHtml(s.usage)}</code>
              <span class="text-base-content/50">${escHtml(s.desc || "")}</span>
            </div>`).join("")}
        </div>`).join("");
      _cmdMetaLoaded = true;
    } catch {
      // 诚实降级：拉不到就说拉不到，不伪造一份前端清单（伪造=与后端漂移的病根）
      host.innerHTML = `<div class="text-[10px] text-warning">命令清单拉取失败，请重试或检查后端。</div>`;
    }
  }
  const _cmdSection = document.getElementById("dc-cmd-section");
  if (_cmdSection) _cmdSection.ontoggle = () => {
    if (_cmdSection.open) loadBotCommandMeta();
  };

  // ---- 对话记录（只读）：bot 线在 bot 模式下的唯一可见面 ----
  // 凛倾 07-09「前端其他的屏蔽,只有在bot模式出现」——左栏那半句（屏蔽）早已落地
  // （conversationManager:464 无条件滤 BOT_CHAT_SYMBOL），本视图补的是「在 bot 模式出现」那半句。
  // 数据源全部是后端既有分页端点：getLogLengthVisible 取长度 → getLog 取尾部窗口（scope.chatId 传线 id）。
  // 只读：无发送/编辑入口（发送在平台侧，编辑走 web 主对话面），避免与主对话面职责重叠。
  const _HIST_WINDOW = 50; // 一次拉取的尾部条数（够看清最近对话，又不把大文件整个拽进前端）
  /** 用后端 chat 列表填线下拉（与 loadPresetBinding 同源：按 🤖[平台] 前缀筛当前平台的线）。 */
  async function _histFillLines() {
    const sel = document.getElementById("dc-hist-line");
    if (!sel) return;
    sel.innerHTML = "";
    try {
      const list = await sendAction({ verb: "getChatList", target: "shells:chat", source: "web" });
      const prefix = `${BOT_CHAT_SYMBOL}[${platform}]`;
      const lines = (Array.isArray(list) ? list : []).filter((c) => (c.customName || "").startsWith(prefix));
      if (!lines.length) {
        sel.innerHTML = `<option value="">（本平台还没有对话线）</option>`;
        return;
      }
      for (const c of lines) {
        const o = document.createElement("option");
        o.value = c.chatid;
        o.textContent = `${c.customName}（${String(c.chatid).slice(0, 6)}…）`;
        sel.appendChild(o);
      }
      // 默认选中当前绑定线（peek 只查不建，与 loadPresetBinding 同款链路）
      try {
        const charname = charSelect?.value || _dcSelectedBotChar;
        if (charname) {
          const cur = await sendAction({ verb: "newBotChat", target: "shells:chat", source: "web", payload: { charname, platform, peek: true } });
          if (cur?.chatid && [...sel.options].some((o) => o.value === cur.chatid)) sel.value = cur.chatid;
        }
      } catch { /* 无绑定=保持首项 */ }
    } catch {
      sel.innerHTML = `<option value="">（对话列表拉取失败）</option>`;
    }
  }
  /** 渲染选中线的尾部消息（只读）。 */
  async function _histRender() {
    const sel = document.getElementById("dc-hist-line");
    const host = document.getElementById("dc-hist-list");
    const meta = document.getElementById("dc-hist-meta");
    if (!sel || !host) return;
    const cid = sel.value;
    if (!cid) { host.innerHTML = ""; if (meta) meta.textContent = ""; return; }
    host.innerHTML = `<div class="text-[10px] opacity-50">加载中…</div>`;
    try {
      const len = Number(await sendAction({ verb: "getLogLengthVisible", target: "shells:chat", source: "web", scope: { chatId: cid } })) || 0;
      const start = Math.max(0, len - _HIST_WINDOW);
      const log = len ? await sendAction({ verb: "getLog", target: "shells:chat", source: "web", scope: { chatId: cid }, payload: { start, end: len } }) : [];
      const arr = Array.isArray(log) ? log : [];
      if (meta) meta.textContent = `共 ${len} 条，显示最近 ${arr.length} 条`;
      if (!arr.length) { host.innerHTML = `<div class="text-[10px] opacity-50">（这条线还没有消息——bot 收到第一条平台消息后才会写入）</div>`; return; }
      host.innerHTML = arr.map((e) => {
        const isUser = e?.role === "user";
        const body = e?.content_for_show || e?.content || "";
        return `<div class="rounded p-1.5 ${isUser ? "bg-primary/10" : "bg-base-300/50"}">
          <div class="text-[10px] opacity-60">${escHtml(e?.name || (isUser ? "用户" : "AI"))}</div>
          <div class="text-xs whitespace-pre-wrap break-words">${escHtml(String(body).slice(0, 2000))}</div>
        </div>`;
      }).join("");
    } catch (e) {
      // 诚实降级：说清是拉取失败，不显示空列表冒充"没有消息"
      host.innerHTML = `<div class="text-[10px] text-warning">对话记录拉取失败：${escHtml(e?.message || String(e))}</div>`;
      if (meta) meta.textContent = "";
    }
  }
  const _histSection = document.getElementById("dc-hist-section");
  if (_histSection) _histSection.ontoggle = async () => {
    if (!_histSection.open) return;
    await _histFillLines();
    await _histRender();
  };
  {
    const _histSel = document.getElementById("dc-hist-line");
    if (_histSel) _histSel.onchange = () => { _histRender(); }; // 覆盖式赋值：平台切换重进不叠加监听
    const _histBtn = document.getElementById("dc-hist-refresh");
    if (_histBtn) _histBtn.onclick = async () => { await _histFillLines(); await _histRender(); };
  }

  // ---- 初始加载 ----
  await loadCharList();
  await loadPresetBinding();
  await loadBotSubModePanel();
  await loadBotList();
  loadBotCommandMeta();

  if (_dcBotList.length > 0) {
    botSelect.value = _dcBotList[0];
    await loadBotConfig(_dcBotList[0]);
  }

  startDcLogPolling();

  // 定期刷新运行状态（每 10 秒）
  if (_dcRunTimer) clearInterval(_dcRunTimer);
  _dcRunTimer = setInterval(async () => {
    const botPanel = document.getElementById("center-tab-bot");
    if (!botPanel || botPanel.classList.contains("hidden")) return;
    try {
      _dcRunningBots = await DC_API.getRunningBotList();
      if (_dcSelectedBot) {
        updateRunStatus(_dcRunningBots.includes(_dcSelectedBot));
      }
    } catch {
      /* 静默 */
    }
  }, 10000);
  _registerTimers();

  console.log(`[beilu-chat] Bot 面板已初始化（平台=${platform}, shell=${schema.shell}）`);
}
