/**
 * commandGate.mjs — 工具执行安全门（T3a·3.6 security 组：gate 逻辑从 ideClient.mjs 抽出，2026-07-02）
 *
 * 【功能链】
 *   三条执行通道（A AI 回复 / B 前端直连 / C 分身循环）→ ideClient.callTool → gateToolExecution
 *   （fail-closed 单一 choke point）→ checkCommandSecurity（黑名单永禁/灰名单审批/能力白名单/
 *   未知 fail-closed forced ask）→ 放行才发 WS 到 YonBan。
 *   replyHandler 审批门 → evaluateWriteApprovalGate（系统强制档/策略档双档）+ B3 规则引擎
 *   evaluateRuleDecision（deny>ask>allow 最严优先，敏感默认 .env/删除类，glob/前缀规则）。
 *
 * 【why】
 *   security 组拥有执行授权逻辑（3_功能层 组7）；ideClient 文件本体是 remote 传输桥（归 transport），
 *   门逻辑与传输解耦。**fail-closed 语义一字未改**——本文件为整块搬运（ideClient.mjs 原 2286-2824 行
 *   + _isPathOutsideWorkspace + 工具集分类常量），唯一适配 = _IDE_PROJECT_ROOT 重算（本位 security/
 *   下 5 级到仓库根）。
 *   黑名单单源约定（0715 凛倾拍板重分级后）：本体默认清单为权威源，YonBan tool-infra.ts 独立副本
 *   按纵深防御 by-design 保留，两侧对齐同一「严重破坏类」永禁集（跨库交界点之一，改一侧必须同步另一侧）。
 *
 * 【关联链】
 *   ← ideClient.mjs（import 本文件 + re-export 供 replyHandler/setDataActions 旧路径不断）
 *   → data/beilu-files-settings.json（commandGate 段：failClosedUnknown/capabilities/allowChannelBExec）
 *
 * 【影响范围】
 *   改本文件 = 改全部三通道的命令拦截行为（高危）；黑/灰名单默认清单调整需同步 YonBan 副本。
 */
import fs from "node:fs";
import path from "node:path";

// R5 路径单源：beilu-files-settings.json 的 node 侧路径由 storage.getFilesSettingsPath() 统一供给，
//   删除本文件旧的 fileURLToPath 上溯 5 级本地推导，消除三头巧合对齐。
// [0722 排雷] 禁止在模块顶层调用 getFilesSettingsPath()（原 `const _FILES_SETTINGS_PATH = ...` 顶层
//   立即求值）：它读 storage 的 `const __projectRoot`，顶层调用把「storage 已初始化完」变成承重
//   不变量——storage 一旦获得任何传递到本文件的 import 边即 TDZ 崩全部插件（0722 事故实证，当时
//   本注释写的"已核实无环"被 J1-B 新增边推翻）。一律函数内取值（endpoints.mjs 同范式）。
import { getFilesSettingsPath } from "../memory/storage_mod/storage.mjs";

// ★ 抽出适配：_isPathOutsideWorkspace 供本文件 B3 引擎与 ideClient（import 回去）共用，加 export。
export const FILE_EDIT_TOOLS = new Set(["write_file", "replace_lines", "insert_at_line", "fuzzy_edit"]);
// run_script 与 run_command 同为命令执行类（_COMMAND_EXEC_TOOLS）：必须进写队列走 replyHandler
// 预检+审批门（HITL 在路径 A 上游完成，gateToolExecution 3b 对 source:"ai" 短路不重复拦）。
// 曾因不在此集落读队列直接执行 = AI 通道绕过解释器授权门（20260713 修复）。
export const WRITE_TOOLS_ALL = new Set([...FILE_EDIT_TOOLS, "run_command", "run_script", "todo_write"]);
export const PERMISSION_WRITE_TOOLS = [...FILE_EDIT_TOOLS, "todo_write"];
export const READ_TOOLS = new Set(["read_file", "list_files", "search_files", "search_by_name", "get_diagnostics", "get_status", "todo_read", "goto_definition", "find_references", "get_project_summary", "ast_search", "smart_search", "validate_html", "lint_code", "web_search"]);

// ★ T2 S1 第二轴：判断目标路径是否在工作区根之外（区外更严）。
// 未知 root / 空路径 → 返回 false（不过度拦截，行为退回到只有高敏档+要问档）。
// 相对路径按 root 解析，恒在区内；只有绝对路径越界 / `..` 逃逸 / 异盘符算区外。
export function _isPathOutsideWorkspace(targetPath, workspaceRoot) {
  if (!workspaceRoot || !targetPath) return false;
  try {
    const root = path.resolve(workspaceRoot);
    const abs = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(root, targetPath);
    const rel = path.relative(root, abs);
    return rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
  } catch {
    return false;
  }
}

// ============================================================
// 命令安全检查（W13 §2.4 + W18 Q5=B）
// ============================================================

/** 默认黑名单 — 代码只持默认值（0715 硬编码改选项：凛倾要求全部安全清单用户可配）。
 *  运行时真值 = beilu-files-settings.json commandGate.blacklist（存在即整体覆盖本默认，UI 可增删），
 *  缺省时用本默认清单。条目格式 {pattern, flags, enabled?}（RegExp 源串；enabled=false 停用不删，缺省 true），
 *  坏正则条目跳过（fail-safe 不放行别的）。总开关 commandGate.rulesEnabled=false 停用整套黑/灰名单。
 *  ★ 单源约定（2026-06-23 黑名单单源化，0715 重分级后）：本体默认清单为权威源。
 *    本体 gateToolExecution 是三通道(A AI / B 前端 / C 分身)唯一收敛闸(D3)。
 *    YonBan(tool-infra.ts COMMAND_BLACKLIST) 因跨仓库独立打包(.vsix)无法构建期共享同一物理文件
 *    (详见 框架_危险命令黑名单单源方案.md 机制 A/D)，按纵深防御 by-design 保留独立副本，
 *    两侧对齐同一「严重破坏类」集合——本默认清单增删必须手动同步 YonBan 副本。 */
const DEFAULT_COMMAND_BLACKLIST = [
  // ── 0715 凛倾拍板重分级：黑名单只留「可能严重破坏」类（数据不可恢复/系统不可启动/公开泄露）。
  //    系统设置类（shutdown/reg/netsh/net user/taskkill /f/chmod 777）降档到灰名单 forced=true
  //    （可审批放行，但即使 L4 也需确认）。YonBan tool-infra.ts 副本同步降档（两侧=同一严重破坏集）。
  /\brm\s+(-rf|-r\s+-f|-f\s+-r|-r)\b/i,
  /\bdd\s+if=/i,
  /\bmkfs\b/i,
  /\bRemove-Item\s.*-Recurse/i,
  /\bdel\s+\/s/i,
  /\bformat\s+[a-z]:/i,
  /\bdiskpart\b/i,
  /\bcurl\b[^|]*\|\s*(ba)?sh/i,
  /\bwget\b[^|]*\|\s*(ba)?sh/i,
  /\bpowershell\s+(-enc|-encodedcommand)/i,
  />\s*\/dev\/sd/i,
  /\brd\s+\/s\s+\/q\b/i,
  /\brmdir\s+\/s\s+\/q\b/i,
  // 0715 增补（严重破坏类）：删卷影副本/改引导区/安全擦盘/PS 格式化与清盘——中招即数据不可恢复或系统起不来
  /\bvssadmin\s+delete\s+shadows/i,
  /\bbcdedit\b/i,
  /\bcipher\s+\/w/i,
  /\bFormat-Volume\b/i,
  /\bClear-Disk\b/i,
  // W59: 禁止推送到公共仓库(origin=always-accompany)，只允许推private
  /\bgit\s+push\s+origin\b/i,
  /\bgit\s+push\s+https:\/\/github\.com\/beilusaiying\/always-accompany/i,
  // ★ 并集补入(原 YonBan 独有，本体缺失)：禁直推 main/master(任意远程，非仅 origin)、禁发包
  //   注：`git push --force` 在灰名单 forced=true(可 owner 审批但 L4 也确认)——force-push 到 origin
  //   已被上面 `git push origin` 硬禁覆盖；推 private 的 force 保留审批(W59「只允许推 private」设计)。
  /\bgit\s+push\s+(origin\s+)?main\b/i,
  /\bgit\s+push\s+(origin\s+)?master\b/i,
  /\bnpm\s+publish\b/i,
];

/**
 * Git push安全检查默认白名单 — 只允许推送到私人仓库（默认值，配置可覆盖）
 * W59事故教训: origin指向公共仓库，AI误推导致代码泄露
 * 运行时真值 = commandGate.gitPushAllowedRemotes（含 "*" 条目 = 不限制远程）。
 */
const DEFAULT_GIT_PUSH_ALLOWED_REMOTES = ["private"];

/** 默认灰名单 — 需要审批确认（默认值，commandGate.graylist 覆盖）。
 *  0715 凛倾拍板每条带 forced 位：
 *    forced=false → 只限到 L3（L0-L3 审批，L4 完全信任免审批）——常规开发操作 v4 不用限制；
 *    forced=true  → 即使 L4 也需确认（原「系统强制档」语义，用于可能较重破坏/系统级操作）。
 *  用户存量配置条目缺 forced 字段 → 按 true（保守，保持既有"即使L4也确认"行为）。 */
const DEFAULT_COMMAND_GRAYLIST = [
  { re: /\bnpm\s+uninstall\b/i, forced: false },
  { re: /\bgit\s+reset\b/i, forced: false },
  { re: /\bpip\s+uninstall\b/i, forced: false },
  { re: /--force\b/i, forced: false },
  { re: /\bgit\s+push\s+.*--force/i, forced: true }, // 改写远程历史，可能严重破坏 → L4 也确认
  { re: /\bgit\s+clean\b/i, forced: false },
  // W13 §6.4: 补充4条敏感git操作
  { re: /\bgit\s+branch\s+-[dD]\b/i, forced: false },  // git branch -D (强制删除分支)
  { re: /\bgit\s+checkout\s+--\s/i, forced: false },   // git checkout -- (丢弃工作区改动)
  { re: /\bgit\s+stash\s+drop\b/i, forced: false },    // git stash drop (删除stash)
  { re: /\bgit\s+rebase\b/i, forced: false },          // git rebase (改写历史)
  { re: /\bgit\s+pull\s+--rebase\b/i, forced: false }, // git pull --rebase (rebase拉取，W59事故根因)
  // ── 0715 从黑名单降档（系统设置类：可审批放行，但即使 L4 也要确认）──
  { re: /\bshutdown\b/i, forced: true },
  { re: /\brestart\b/i, forced: true },
  { re: /\breboot\b/i, forced: true },
  { re: /\breg\s+(add|delete)\b/i, forced: true },
  { re: /\bnetsh\b/i, forced: true },
  { re: /\bnet\s+(user|share)\b/i, forced: true },
  { re: /\btaskkill\s+\/f\b/i, forced: true },
  { re: /\bchmod\s+777\b/i, forced: true },
];

// ── 0715 硬编码改选项：命令安全清单运行时加载（配置覆盖默认，读写同源 = beilu-files-settings.json commandGate 段）──
// 消费方 = checkCommandSecurity（三通道闸）+ getCommandRulesReadable（前端渲染/编辑）。
// 写侧 = endpoints.mjs POST /api/security/command-rules（同文件同段），保证 UI 改完即刻生效（每次检查即时读盘，文件小无热点）。
function _reFromEntry(e) {
  if (!e || typeof e.pattern !== "string" || !e.pattern) return null;
  try {
    return new RegExp(e.pattern, typeof e.flags === "string" ? e.flags : "i");
  } catch {
    return null; // 坏正则条目跳过（不放行其他条目，fail-safe）
  }
}
function _loadCommandRules() {
  let g = {};
  try {
    const raw = fs.readFileSync(getFilesSettingsPath(), "utf-8");
    const j = JSON.parse(raw);
    g = (j && typeof j.commandGate === "object" && j.commandGate) ? j.commandGate : {};
  } catch { g = {}; }
  // 0715 开关化：条目归一为 { re, enabled, forced? }。
  //   enabled 缺省 true（单条开关，关=不参与匹配但保留在清单里）；
  //   graylist forced 缺省 true（存量条目无字段=保持"即使L4也确认"旧行为）。
  const blacklist = Array.isArray(g.blacklist)
    ? g.blacklist.map((e) => { const re = _reFromEntry(e); return re ? { re, enabled: e.enabled !== false } : null; }).filter(Boolean)
    : DEFAULT_COMMAND_BLACKLIST.map((re) => ({ re, enabled: true }));
  const graylist = Array.isArray(g.graylist)
    ? g.graylist.map((e) => { const re = _reFromEntry(e); return re ? { re, enabled: e.enabled !== false, forced: e.forced !== false } : null; }).filter(Boolean)
    : DEFAULT_COMMAND_GRAYLIST.map((d) => ({ re: d.re, enabled: true, forced: d.forced === true }));
  const gitPushAllowedRemotes = Array.isArray(g.gitPushAllowedRemotes)
    ? g.gitPushAllowedRemotes.filter((r) => typeof r === "string" && r.trim()).map((r) => r.trim())
    : DEFAULT_GIT_PUSH_ALLOWED_REMOTES;
  return {
    // 总开关：false=黑/灰名单整体停用（git push 远程白名单/解释器闸/fail-closed 不受此开关影响，各有独立开关）
    rulesEnabled: g.rulesEnabled !== false,
    blacklist,
    graylist,
    gitPushAllowedRemotes,
    customized: {
      blacklist: Array.isArray(g.blacklist),
      graylist: Array.isArray(g.graylist),
      gitPushAllowedRemotes: Array.isArray(g.gitPushAllowedRemotes),
    },
  };
}

/** 默认命令分类配置。
 *  ★ D3 安全闸（2026-06-16，凛倾铁律「危险命令到不了 YonBan」）：
 *  - 把脚本解释器类（node/deno/bun/tsx + python/py + pip）默认 **关闭**——它们是图灵完备入口，
 *    黑名单（针对 rm/format 等具体动词）对「用允许的解释器跑任意脚本」天然无防御（run_script 绕过）。
 *    需 owner 在 command_config.json 显式开 `node:true`/`python:true`/`pip:true` 才放行（per-user 能力授权）。
 *  - git/npm/filesystem/editor 这类「非解释器、动作可被黑/灰名单覆盖」的分类保留默认开。
 *  放宽风险：开 node/python 即等于把"任意脚本执行"权交给 AI/前端，run_script 写临时文件再跑也会通行；
 *  仅在受信本地环境（owner 自用）开启。 */
export const DEFAULT_COMMAND_CATEGORIES = {
  git: true,
  npm: true,
  node: false,      // ★ D3：解释器类默认关，靠 per-user 能力授权（未授权→forced ask）
  python: false,    // ★ D3：同上
  pip: false,       // ★ D3：pip install 可拉任意包并执行 setup.py，默认关
  filesystem: true,
  editor: true,
};

/** ★ D3：解释器类分类集——这些分类未被授权时不是「静默拒」而是「forced ask（要求审批）」，
 *  使 owner 可在 consent 卡片一次性放行，而非命令直接消失（设计 S2「未授权→needsApproval forced」）。 */
const _INTERPRETER_CATEGORIES = new Set(["node", "python", "pip"]);

/**
 * 检测命令所属分类
 * @param {string} command
 * @returns {string|null} 分类名或null（未知分类）
 */
function detectCommandCategory(command) {
  const cmd = command.trim().split(/\s+/)[0].toLowerCase().replace(/\.exe$/, "");
  if (cmd === "git") return "git";
  if (["npm", "npx", "yarn", "pnpm"].includes(cmd)) return "npm";
  if (["node", "deno", "bun", "tsx", "ts-node"].includes(cmd)) return "node";
  if (["python", "python3", "py"].includes(cmd)) return "python";
  if (["pip", "pip3"].includes(cmd)) return "pip";
  if (["mkdir", "ls", "cat", "echo", "cp", "mv", "dir", "type", "copy", "move", "cd", "pwd", "touch", "head", "tail", "find", "grep", "wc", "del", "erase", "rd", "rmdir", "ren", "rename"].includes(cmd)) return "filesystem";
  if (["cursor", "code", "code-insiders"].includes(cmd)) return "editor";
  return null;
}

// ★ P0-4 结构化归一：git 全局选项（-C <path> / --git-dir / -c k=v 等）可插在
//   `git` 与子命令之间，使 `\bgit\s+reset\b` 一类基于"git 紧跟子命令"的清单匹配不到。
//   归一化把这些全局选项折叠掉，使 `git -C x reset --hard` 与 `git reset --hard` 同形匹配，
//   补齐正则未覆盖的命令形态（决策 §5① 确定性匹配）。非破坏：只新增一个待匹配视图，不放宽既有规则。
const _GIT_GLOBAL_FLAG_RUN = "(?:\\s+(?:-C\\s+\\S+|-c\\s+\\S+|--git-dir(?:=\\S+|\\s+\\S+)|--work-tree(?:=\\S+|\\s+\\S+)|--namespace(?:=\\S+|\\s+\\S+)|--exec-path(?:=\\S+)?|--bare|-P|--no-pager|--paginate|--no-replace-objects|--literal-pathspecs|--icase-pathspecs|--no-optional-locks))+";
const _GIT_NORMALIZE_RE = new RegExp("\\bgit" + _GIT_GLOBAL_FLAG_RUN, "gi");
function _normalizeGitInvocations(command) {
  if (!command || command.indexOf("git") === -1) return command;
  return command.replace(_GIT_NORMALIZE_RE, "git");
}

/**
 * 检查命令安全性
 * @param {string} command - 要执行的命令
 * @param {object} [userConfig] - 用户命令配置（与DEFAULT_COMMAND_CATEGORIES同结构）
 * @returns {{ allowed: boolean, reason?: string, needsApproval?: boolean }}
 */
export function checkCommandSecurity(command, userConfig) {
  if (!command || typeof command !== "string") {
    return { allowed: false, reason: "命令为空" };
  }

  // ★ P0-4：归一化视图（折叠 git 全局选项），受限清单同时对原串与归一串匹配，
  //   任一命中即生效——覆盖 `git -C <path> <子命令>` 这种规避分类的写法。
  const _normCmd = _normalizeGitInvocations(command);

  // 0715：清单从配置加载（用户可配，缺省=默认清单），不再硬编码不可覆盖
  const _rules = _loadCommandRules();

  // 1. 黑名单检查（永久阻止档）。总开关关 / 单条禁用 → 跳过匹配。
  if (_rules.rulesEnabled) {
    for (const e of _rules.blacklist) {
      if (!e.enabled) continue;
      if (e.re.test(command) || e.re.test(_normCmd)) {
        return { allowed: false, reason: `安全规则「永久阻止」命中此命令: ${command.substring(0, 50)}` };
      }
    }
  }

  // 1.5 Git push remote白名单检查（W59: 默认只允许推到私人仓库）— 用归一串解析，防 `git -C x push origin`
  //     白名单含 "*" = 不限制远程（用户显式放开）。
  const gitPushMatch = _normCmd.match(/\bgit\s+push\b/i);
  if (gitPushMatch && !_rules.gitPushAllowedRemotes.includes("*")) {
    const pushArgs = _normCmd.replace(/.*\bgit\s+push\b/i, "").trim().split(/\s+/).filter(a => !a.startsWith("-"));
    const remote = pushArgs[0] || "";
    if (remote && !_rules.gitPushAllowedRemotes.includes(remote)) {
      return { allowed: false, reason: `禁止推送到 "${remote}"。只允许推送到: ${_rules.gitPushAllowedRemotes.join(", ") || "(空=全部禁止)"}。可在权限面板修改允许的远程。` };
    }
  }

  // 2. 灰名单检查（需要审批）。0715 每条带 forced 位：
  //    forced=true → 返回 forced:true（消费方按系统强制档，L4 也确认）；
  //    forced=false → 返回 forced:false（消费方按"最多限到 L3"处理，L4 免审批）。
  //    多条命中取最严（任一 forced=true 即 forced）。
  if (_rules.rulesEnabled) {
    let _grayHit = null;
    for (const e of _rules.graylist) {
      if (!e.enabled) continue;
      if (e.re.test(command) || e.re.test(_normCmd)) {
        if (e.forced) { _grayHit = { forced: true }; break; }
        _grayHit = _grayHit || { forced: false };
      }
    }
    if (_grayHit) {
      return { allowed: true, needsApproval: true, forced: _grayHit.forced, reason: `此命令需要用户确认: ${command.substring(0, 50)}` };
    }
  }

  // 3. 分类白名单检查
  const category = detectCommandCategory(command);
  const config = { ...DEFAULT_COMMAND_CATEGORIES, ...userConfig };
  if (category) {
    if (!config[category]) {
      // ★ D3：解释器类（node/python/pip）未授权 → 不静默拒，而是 forced ask（要求审批）。
      //   这样 owner 能在 consent 卡片一次性放行（设计 S2），命令不会无声消失。
      //   非解释器分类被显式禁用 → 仍按用户意图硬拒。
      if (_INTERPRETER_CATEGORIES.has(category)) {
        return {
          allowed: true,
          needsApproval: true,
          forced: true,
          reason: `运行脚本解释器 "${category}" 需用户确认（默认未授权，可在权限面板开启该能力）: ${command.substring(0, 50)}`,
        };
      }
      return { allowed: false, reason: `命令分类 "${category}" 已被用户禁用` };
    }
    // 已知且已授权分类 → 放行
    return { allowed: true };
  }

  // ★ D3 fail-closed（翻转原 Q5=B 的 fail-open）：未知分类的命令不再默认放行，
  //   改为「要求审批」（forced）。未知命令既不在白名单也不在黑/灰名单，无法判定安全性，
  //   默认要 HITL 而非静默执行（设计 S1 fail-closed）。owner 可在 consent 卡片放行一次。
  return {
    allowed: true,
    needsApproval: true,
    forced: true,
    reason: `未知命令分类，无法判定安全性，需用户确认: ${command.substring(0, 50)}`,
  };
}

// ============================================================
// ★ D3 统一工具执行安全闸（gateToolExecution）— 2026-06-16
//   单一 choke point：callTool（ideClient.mjs:callTool）内强制调用本闸，
//   使三条执行通道（A AI 回复 / B 前端直连 ideToolCall / C 分身循环）全部经同一闸，
//   根治「某条通道忘加闸」的结构病。fail-closed：无法判定 → 默认拦截入审批，绝不静默放行。
// ============================================================

/** ★ D3：执行命令的工具集（这些工具的 params 含可执行命令文本，必须过命令安全闸）。
 *  其余工具（read/write/edit/checkpoint 等）的写/删风险由 replyHandler 审批门 + beilu-files
 *  validateOpSecurity 等既有闸覆盖，本命令闸不重复拦（避免误冻结流水线）。 */
const _COMMAND_EXEC_TOOLS = new Set(["run_command", "exec", "run_script"]);

/** ★ D3：可配置安全行为（凛倾铁律「全部安全行为可用户自设」）。
 *  从 <项目根>/data/beilu-files-settings.json 的 commandGate 段读取（安全默认 + owner 可放宽），
 *  与 beilu-files 设置同文件，省去新增配置面板。解析失败 → 全用安全默认（fail-safe）。
 *  字段（均可省略，省略=安全默认）：
 *    - failClosedUnknown: bool（默认 true）= 未知分类命令 fail-closed 入审批。放宽风险：设 false 退回旧 fail-open，未知命令静默执行。
 *    - allowChannelBExec: bool（默认 false）= 是否允许前端直连/分身通道(B/C)即时执行命令类工具。
 *        默认 false → B/C 的命令类工具一律拦截入审批（高危不即时执行，设计 S7「前端直连不再即时执行高危」）。
 *        放宽风险：设 true = 前端面板/分身可不经 HITL 直接发命令到 YonBan。
 *  ⚠ capabilities 段已废弃（0714 单源收口）：解释器/分类能力授权的唯一存储 = per-user
 *    data/users/<u>/command_config.json（读写动作 get/setCommandConfig，UI=workPanel+权限面板同链），
 *    由路径 A（replyHandler:1555 checkCommandSecurity(cmd, userConfig)）消费。本段曾出现的
 *    capabilities 是第二存储（多源分叉），已停止读取；B/C 通道无用户上下文，按 DEFAULT
 *    fail-closed 最严处理（解释器/未知恒 forced ask，不提供放宽面）。
 *  注：高危（黑名单 rm/format、删除、解释器）始终系统强制档，owner 完全信任也走 HITL（设计 S6/S8）。 */
function _loadCommandGateConfig() {
  try {
    const raw = fs.readFileSync(getFilesSettingsPath(), "utf-8");
    const j = JSON.parse(raw);
    const g = (j && typeof j.commandGate === "object" && j.commandGate) ? j.commandGate : {};
    return {
      failClosedUnknown: g.failClosedUnknown !== false,   // 默认 true（fail-closed）
      allowChannelBExec: g.allowChannelBExec === true,    // 默认 false
    };
  } catch {
    return { failClosedUnknown: true, allowChannelBExec: false };
  }
}

/**
 * ★ D3 统一执行闸（纯函数 + 读配置，无 WS 副作用）。
 * @param {object} a
 * @param {string} a.tool   工具名
 * @param {object} a.params 工具参数
 * @param {string} [a.source] 来源："ai"(路径A) | "frontend"(路径B) | "subagent"(路径C) | "internal"
 * @param {boolean} [a.preChecked] 调用方已在上游过命令安全闸 + 审批（路径 A），本闸放行
 * @returns {{ allowed:boolean, reason?:string, needsApproval?:boolean, forced?:boolean, riskLevel?:string }}
 */
export function gateToolExecution({ tool, params = {}, source = "unknown", preChecked = false } = {}) {
  // 0. 内部工具（_ 前缀：检查点/回档/诊断等）永远放行——它们是流水线基础设施，
  //    误拦会冻结整条流水线（设计 ⑥ 风险1）。
  if (typeof tool === "string" && tool.startsWith("_")) {
    return { allowed: true, riskLevel: "internal" };
  }

  // 1. 非命令执行类工具 → 放行（写/删风险由既有审批门/beilu-files 闸覆盖，本闸只管命令执行）。
  if (!_COMMAND_EXEC_TOOLS.has(tool)) {
    return { allowed: true };
  }

  // 2. 命令执行类（run_command / exec / run_script）：取出命令文本。
  //    ★ 债务修复(AU2 D1·确证 RCE 绕过)：run_script 的 params 是 {lang, code}（非 command 串），
  //    它执行任意代码 = 等同跑解释器 lang。合成伪命令 `<lang> <inline-code>` 交分类逻辑——
  //    node/python/bun/powershell 等解释器默认关 → forced ask；未知 lang → fail-closed。
  //    杜绝"run_script 写临时文件 + 解释器执行"绕过命令闸（C1 确证 YonBan run_script RCE）。
  const command = tool === "run_script"
    ? `${(params && (params.lang || params.language)) || "script"} <inline-code>`
    : (params && (params.command || params.cmd || params.content)) || "";
  if (!command || typeof command !== "string") {
    // 命令类工具但无命令文本 → fail-closed 拦。
    return { allowed: false, reason: "命令执行工具缺少命令文本（已按 fail-closed 拦截）", riskLevel: "high" };
  }

  const cfg = _loadCommandGateConfig();

  // 3. 过命令安全闸（黑/灰名单 + 分类白名单 + fail-closed 未知）。
  //    B/C 通道无用户上下文 → 不读能力授权（单源在 per-user command_config.json，由路径 A 消费），
  //    按 DEFAULT_COMMAND_CATEGORIES 最严处理：解释器/未知恒 forced ask。
  const sec = checkCommandSecurity(command, undefined);

  // 3a. 硬黑名单 / 显式禁用分类 → 永久拒（不可放行，设计 S2 黑名单保留为永禁硬层）。
  if (!sec.allowed) {
    return { allowed: false, reason: sec.reason, riskLevel: "high" };
  }

  // 3b. 路径 A（AI 回复）已在 replyHandler 上游过同一安全闸 + 审批门并获批 → 放行执行。
  //     （路径 A 的 graylist/forced 命令到达 callTool 时已经过 HITL，本闸不重复拦。）
  if (preChecked || source === "ai") {
    return { allowed: true, riskLevel: sec.forced ? "high" : (sec.needsApproval ? "medium" : "low") };
  }

  // 3c. 路径 B/C（前端直连 / 分身）——它们绕过 replyHandler 的命令闸 + 审批门。
  //     fail-closed：默认这些通道的命令类工具一律不即时执行（设计 S7），
  //     需要审批的（灰名单/解释器/未知 forced）更要拦；即使是 allowed&&!needsApproval 的"安全命令"，
  //     默认也不让前端/分身免 HITL 直跑（除非 owner 显式 allowChannelBExec=true）。
  if (sec.needsApproval || sec.forced) {
    return {
      allowed: false,
      needsApproval: true,
      forced: true,
      riskLevel: "high",
      reason: `🛡️ 危险命令经${source === "frontend" ? "前端直连" : source === "subagent" ? "分身" : "非AI"}通道发起，已拦截（需经 AI 审批流程或权限面板授权）: ${sec.reason || command.substring(0, 50)}`,
    };
  }
  // 安全命令（allowed && !needsApproval）经 B/C：默认仍拦（HITL），owner 放宽后放行。
  if (cfg.allowChannelBExec) {
    return { allowed: true, riskLevel: "low" };
  }
  return {
    allowed: false,
    needsApproval: true,
    riskLevel: "medium",
    reason: `🛡️ 命令经${source === "frontend" ? "前端直连" : source === "subagent" ? "分身" : "非AI"}通道发起，默认不即时执行（可在权限面板开启 allowChannelBExec 放宽）: ${command.substring(0, 50)}`,
  };
}

// ★ T2 S1 系统门：决定写操作批次是否必须走审批。
// 双档语义：
//   - 系统强制档(systemForced)：高敏/不可逆操作（灰名单命令 → _tc._forceApproval）无论用户信任等级如何
//     都强制走审批。「删库无拦截是真风险」——完全信任(Level4)也不该让 rm/format/强推 等静默自跑。
//   - 策略档(policyApproval)：普通写(requireWriteApproval / sandboxBackup)属「要问」，完全信任可跳过。
// 纯函数（无副作用），供 replyHandler 调用 + 可单测。
export function evaluateWriteApprovalGate({ writeOps, requireWriteApproval, sandboxBackup, skipApproval, workspaceRoot, allowOutsideWorkspace }) {
  const ops = Array.isArray(writeOps) ? writeOps : [];
  // _askForced = B3 规则引擎判「必问」（显式 ask 规则/敏感默认 .env·删除类/不可解析）——与高敏档同级，信任不可跳。
  const hasForceApproval = ops.some((tc) => tc && (tc._forceApproval || tc._askForced));
  // ★ T2 S1 第二轴：写/删目标在工作区外。
  //   ★ FT2（凛倾拍板 2026-06-11）：区外不再强制确认（systemForced），降级为「关闭时回 ask 非 forced」——
  //     区外裁决全部移交 B3 引擎 evaluateRuleDecision：开关 true=区外开放(交规则)、false=区外回 ask(forced=false)。
  //     gate 不再把区外计入 systemForced（forced 语义即"信任不可跳"，凛倾要求区外关闭为"非 forced"故不入 systemForced）；
  //     区外关闭后的 ask 落 policyApproval 档（requireWriteApproval/sandboxBackup，信任档可跳，符合"非 forced"）。
  //     allowOutsideWorkspace 参数透传仅供日志/兼容（gate 不再据此 systemForce）；_forceApproval 敏感命令强制确认仍保留(hasForceApproval)。
  void allowOutsideWorkspace; // FT2：区外不再经 gate 强制确认，参数保留供调用方语义对齐
  const outsideWorkspace = false; // FT2：区外档从 gate 移除，统一由 B3 引擎按开关裁决
  const systemForced = hasForceApproval || outsideWorkspace;               // 高敏档/区外档：不可被信任跳过
  const policyApproval = (!!requireWriteApproval || !!sandboxBackup) && !skipApproval; // 要问档：信任可跳
  const needApproval = ops.length > 0 && (systemForced || policyApproval);
  return { needApproval, systemForced, hasForceApproval, outsideWorkspace, policyApproval };
}

// ★ F6「此类不再问」规则匹配（aider don't-ask-again 形态）。
// 规则按 (操作类型 tool, 路径前缀 pathPrefix) 记忆；命中 → 该 op 自动跳过审批直接执行。
// 系统强制档（_forceApproval / 区外）不可被规则跳过——删库/区外永远要问（与 evaluateWriteApprovalGate
// 的 systemForced 同语义，规则只豁免「要问档」普通写）。规范化路径：统一 / 分隔 + 平台感知大小写。
const _fsCaseInsensitive = typeof Deno !== "undefined"
  ? (Deno.build.os === "windows" || Deno.build.os === "darwin")
  : (process.platform === "win32" || process.platform === "darwin");
function _normRulePath(p) {
  const s = String(p || "").replace(/\\/g, "/");
  return _fsCaseInsensitive ? s.toLowerCase() : s;
}
// ★ B3 规则集引擎：把单条规则升级为三态 { tool, pathPrefix|glob, action: "allow"|"ask"|"deny" }。
//   旧规则文件无 action 字段 = "allow"（向后兼容，老文件不迁移）。
//   匹配优先级：deny > ask > allow（最严优先）——多条命中取最严那一档。
//   subject 匹配：r.glob（含 * ?）走 glob，否则 r.pathPrefix 走前缀（与旧 startsWith 同语义）。
// glob → RegExp（仅支持 * 任意段、? 单字符；其余字符转义）。全程小写化（_normRulePath）。
function _ruleGlobToRegExp(glob) {
  const g = _normRulePath(glob);
  let re = "";
  for (const ch of g) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}
// 单条规则是否命中该 subject（已规范化的小写路径/命令）。命中返回 action，否则 null。
function _ruleHit(r, subject, tool) {
  if (!r || r.tool !== tool) return null;
  let matched = false;
  if (typeof r.glob === "string" && r.glob.length > 0) {
    try { matched = _ruleGlobToRegExp(r.glob).test(subject); }
    catch { matched = false; } // 坏 glob → 不命中（不放行，fail-closed 由上层兜底）
  } else {
    const prefix = _normRulePath(r.pathPrefix);
    matched = (prefix === "" || subject.startsWith(prefix));
  }
  if (!matched) return null;
  const a = r.action;
  // 旧规则无 action / 非法值 → "allow"（向后兼容：旧文件命中=skip 语义）。
  return (a === "deny" || a === "ask" || a === "allow") ? a : "allow";
}
// 敏感文件判定：.env / .env.* （但 .env.example 视为非敏感，与 KILO PermissionNext 同口径）。
// 0715 收口：basename 级判定导出，setDataActions._isSensitiveOverrideRule 同口径消费（原为本地复刻副本，D2）。
export function isSensitiveEnvBasename(base) {
  if (!base) return false;
  if (base === ".env.example") return false;
  return base === ".env" || base.startsWith(".env.") || base.startsWith(".env");
}
function _isSensitiveEnvPath(subject) {
  if (!subject) return false;
  const base = subject.slice(subject.replace(/\\/g, "/").lastIndexOf("/") + 1);
  return isSensitiveEnvBasename(base);
}
// 删除类操作判定：run_command 含 rm/del/rmdir/remove-item 等删除命令首词。
// 0715 收口：remove-item/ri（原独立 if 分支）并入集合并导出——setDataActions 的 delFirst 副本改为消费本集合（D2）。
export const DELETE_CMD_FIRST_WORDS = new Set(["rm", "rmdir", "del", "erase", "unlink", "remove-item", "ri"]);
function _isDeleteCommand(subject) {
  if (!subject) return false;
  const first = subject.trim().split(/\s+/)[0] || "";
  return DELETE_CMD_FIRST_WORDS.has(first);
}
// ★ B3 核心：裁决单条 op 的三态 action。系统强制确认两条永不豁免（保持 F6 安全语义不削弱）。
//   返回 "allow" | "ask" | "deny"。fail-closed：任何解析异常 → "ask"。
//   敏感默认规则（内置不落盘）：用户规则可把 ask→allow，但系统强制确认(_forceApproval/区外)永不被覆盖。
export function evaluateRuleAction(toolCall, rules, workspaceRoot) {
  return evaluateRuleDecision(toolCall, rules, workspaceRoot).action;
}
// ★ B3 决策含强制位：forced=true 的 ask（系统强制确认/用户显式 ask 规则/敏感默认/不可解析）必须真问，
//   即使 Level4 信任跳过(skipApproval)也不许静默放行（KILO ask=always ask 语义）；
//   forced=false 的 ask = 规则未命中的默认值，交回原审批门按 requireWriteApproval/信任档决定（行为与 F6 前一致）。
// ★ FT2（凛倾拍板 2026-06-11）：区外不再强制确认——改为可配置开关 allowOutsideWorkspace（KILO 式权限管理）。
//   allowOutsideWorkspace=true（默认）：AI 完全访问工作区外，区外操作交普通规则裁决（不再 forced ask）。
//   allowOutsideWorkspace=false：区外回 ask，但 forced=false（信任档可跳，仅是"默认要问"，非系统强制强制确认）。
//   注意：_forceApproval 显式强制确认逻辑保留不动（敏感受限清单命令永远 forced ask，不受本开关影响）。
//   options 第四参 { allowOutsideWorkspace=true } 缺省 = true（向后兼容内部 wrapper 调用 = 区外开放）。
export function evaluateRuleDecision(toolCall, rules, workspaceRoot, options) {
  try {
    const allowOutsideWorkspace = options?.allowOutsideWorkspace !== false; // 缺省/非 false → true（开放）
    const tool = toolCall?.tool || "";
    // —— 系统强制确认①：高敏档(_forceApproval) 永远走审批，规则不可豁免（不许削弱，FT2 保留）——
    if (toolCall && toolCall._forceApproval) return { action: "ask", forced: true };
    // —— 区外文件操作：FT2 开关化。开放=不拦（落普通规则）；关闭=回 ask 但 forced=false（非系统强制确认）。
    //   不在此早退——deny 规则/敏感默认（更严）仍须先裁决，区外关闭只是把"默认放行/默认值"抬到 ask 地板。
    let outsideAsk = false;
    if (tool !== "run_command" && !allowOutsideWorkspace) {
      const rawPath = toolCall?.params?.path;
      if (!!workspaceRoot && rawPath && _isPathOutsideWorkspace(rawPath, workspaceRoot)) outsideAsk = true;
    }
    // 0714 根因修（L4 完全信任仍强制审批）：todo_write 的 params 只有 content 无 path，此前落入下方
    //   「无主体 → forced ask」——在用户规则遍历之前早退，连 L4 模板的 todo_write allow 规则都是死规则，
    //   且 forced 经批次门传染整批写操作。它的真实写点固定 = {wsRoot}/.beilu/todo.md
    //   （YonBan todo-tools.ts:33/61 唯一写点），主体锚定该路径：规则（tool+路径前缀）/敏感默认/信任档全部自然工作。
    //   其余无主体情形（未知形状/坏参数）保持 fail-closed 必问不放宽。
    const subject = tool === "run_command"
      ? _normRulePath(toolCall?.params?.command)
      : tool === "todo_write"
        ? _normRulePath(toolCall?.params?.path || ".beilu/todo.md")
        : _normRulePath(toolCall?.params?.path);
    if (!subject) return { action: "ask", forced: true }; // 无主体无法裁决 → fail-closed 必问

    // —— 用户规则裁决（最严优先 deny > ask > allow）——
    let userAction = null; // null = 未命中任何用户规则
    let allowIsTargeted = false; // 命中的 allow 是否定向规则（非空前缀/glob）——通配 allow 不许覆盖敏感默认
    let allowIsL4Trust = false;  // 命中的 allow 来自 L4 完全信任模板——L4 语义=全部放行，可覆盖敏感默认
    if (Array.isArray(rules) && rules.length > 0) {
      for (const r of rules) {
        const a = _ruleHit(r, subject, tool);
        if (a === null) continue;
        if (a === "deny") { userAction = "deny"; break; } // deny 最严，提前定档
        if (a === "ask") userAction = "ask";
        else if (a === "allow" && userAction !== "ask") {
          userAction = "allow";
          if ((typeof r.glob === "string" && r.glob.length > 0) || _normRulePath(r.pathPrefix) !== "") allowIsTargeted = true;
          if (r.source === "template" && r.level >= 4) allowIsL4Trust = true;
        }
      }
    }
    if (userAction === "deny") return { action: "deny", forced: true };

    // —— 敏感默认规则（内置）：.env 读写=ask、删除类=ask。用户规则可覆盖 ask→allow ——
    let sensitiveAsk = false;
    if (tool === "run_command") {
      if (_isDeleteCommand(subject)) sensitiveAsk = true;
    } else if (_isSensitiveEnvPath(subject)) {
      sensitiveAsk = true;
    }
    if (sensitiveAsk) {
      // 定向 allow（非空前缀/glob）可覆盖敏感默认；
      // L4 完全信任模板也可覆盖——用户显式选了"完全信任"，尊重其意图。
      // L0-L3 通配 allow 不许静默吞掉敏感档。
      if (userAction === "allow" && (allowIsTargeted || allowIsL4Trust)) return { action: "allow", forced: false };
      return { action: "ask", forced: true };
    }

    if (userAction === "ask") return { action: "ask", forced: true }; // 用户显式 ask=必问
    // —— FT2 区外开关关闭：非敏感/非 deny 的区外操作抬到 ask 地板（forced=false，非系统强制确认，信任档可跳）——
    //   覆盖 allow 与默认值，让"关闭区外访问"实际生效；deny/敏感默认上面已返回，不受影响。
    if (outsideAsk) return { action: "ask", forced: false };
    if (userAction === "allow") return { action: "allow", forced: false };
    return { action: "ask", forced: false }; // 默认要问（规则未命中，交原审批门按信任档决定）
  } catch {
    return { action: "ask", forced: true }; // 任何异常 → fail-closed 必问
  }
}

// 单条 op 是否被规则「自动放行」（F6 旧调用方契约：true=skip 审批直接执行）。
// 升级为三态后，本函数 = evaluateRuleAction === "allow"。deny/ask 一律返回 false（保持或更严）。
export function matchApprovalSkipRule(toolCall, rules, workspaceRoot) {
  return evaluateRuleAction(toolCall, rules, workspaceRoot) === "allow";
}
// ★ B3 显式拒绝判定：规则裁决为 deny → 该 op 直接拒绝（不入队、按 reject 路径回结果给 AI）。
export function matchApprovalDenyRule(toolCall, rules, workspaceRoot) {
  return evaluateRuleAction(toolCall, rules, workspaceRoot) === "deny";
}
// ★ B3 L0-L4 退化为规则模板（不变式6：旧 permission_level 判断链不动，本函数仅「按 L 档生成一组规则」）。
//   不强迁、不落盘——前端面板「从模板导入」时调用，返回的规则用户可再编辑/覆盖。
//   档位语义（与现 permission_level 信任轴对齐，越高越放行）：
//     L0 严控：全部写操作 ask；L1：常规写 ask（同 L0，预留）；
//     L2：常规写 allow，删除/敏感仍 ask；L3：写+命令 allow（敏感默认仍兜底 ask）；
//     L4 完全信任：写+命令 allow（但系统强制确认 _forceApproval/区外/敏感默认在引擎层仍兜底，模板放行不了强制确认）。
//   注：tool="*" 在 _ruleHit 里按精确 tool 比较不会通配，故模板按现有写工具逐项展开（与 IDE_WRITE_TOOLS 对齐）。
// 权限模板写工具引用 canonical PERMISSION_WRITE_TOOLS（不含 run_command，它单独处理）
const _B3_WRITE_TOOLS = PERMISSION_WRITE_TOOLS;
export function buildPermissionTemplateRules(level) {
  const L = Number(level) || 0;
  const _now = new Date().toISOString();
  const mk = (tool, action) => ({ tool, pathPrefix: "", action, source: "template", level: L, createdAt: _now });
  const rules = [];
  if (L <= 1) {
    // L0/L1：所有写工具 + 命令 → ask（最严，全部要问）。
    for (const t of _B3_WRITE_TOOLS) rules.push(mk(t, "ask"));
    rules.push(mk("run_command", "ask"));
  } else if (L === 2) {
    // L2：常规写 allow；命令 ask（命令风险高，仍要问）。删除/敏感由引擎敏感默认兜底为 ask。
    for (const t of _B3_WRITE_TOOLS) rules.push(mk(t, "allow"));
    rules.push(mk("run_command", "ask"));
  } else {
    // L3/L4/L5：写 + 命令 allow。L4 敏感默认/系统强制确认仍在引擎层生效；L5 在 replyHandler 层全部跳过。
    for (const t of _B3_WRITE_TOOLS) rules.push(mk(t, "allow"));
    rules.push(mk("run_command", "allow"));
  }
  return rules;
}

// 从一条 pending op 派生一条「此类不再问」规则：tool + 路径前缀（取目录段，文件名级太窄）。
// run_command → 取命令首词作前缀（如 "npm install x" → "npm "）；文件类 → 取所在目录 + "/"。
export function deriveApprovalSkipRule(op) {
  const tool = op?.tool || "";
  if (!tool) return null;
  // 「此类不再问」语义 = allow（自动放行）。显式带 action/source，与三态规则集统一。
  if (tool === "run_command") {
    const cmd = String(op?.params?.command || "").trim();
    const first = cmd.split(/\s+/)[0] || cmd;
    return first
      ? { tool, pathPrefix: first, action: "allow", source: "user" }
      : { tool, pathPrefix: "", action: "allow", source: "user" };
  }
  const p = op?.params?.path || op?.absPath || "";
  const norm = String(p).replace(/\\/g, "/");
  const slash = norm.lastIndexOf("/");
  const prefix = slash >= 0 ? norm.slice(0, slash + 1) : "";
  return { tool, pathPrefix: prefix, action: "allow", source: "user" };
}

// W61: AI幻觉防护 — 检查命令是否存在（W13设计）
export async function validateCommandExists(command) {
  if (!command || typeof command !== "string") return { exists: true }; // 空命令不检查
  // 提取第一个单词作为命令名
  const cmdName = command.trim().split(/\s+/)[0].replace(/^["']|["']$/g, "");
  // 跳过内置命令和shell关键字
  const builtins = ["cd", "echo", "export", "set", "if", "for", "while", "do", "done", "then", "fi", "case", "esac", "function", "return", "exit", "source", ".", "alias", "unalias", "type", "hash", "pwd", "pushd", "popd", "dirs", "let", "eval", "exec", "trap", "wait", "kill", "true", "false", "test", "[", "[[", "cat", "ls", "cp", "mv", "rm", "mkdir", "touch", "chmod", "chown", "grep", "sed", "awk", "find", "head", "tail", "sort", "wc", "curl", "wget"];
  if (builtins.includes(cmdName)) return { exists: true };
  // 跳过路径形式（/usr/bin/xxx 或 ./xxx）
  if (cmdName.includes("/") || cmdName.includes("\\")) return { exists: true };

  try {
    const isWindows = typeof Deno !== "undefined" ? Deno.build.os === "windows" : process.platform === "win32";
    const checkCmd = isWindows ? `where ${cmdName} 2>nul` : `which ${cmdName} 2>/dev/null`;
    const proc = new Deno.Command(isWindows ? "cmd" : "sh", {
      args: isWindows ? ["/c", checkCmd] : ["-c", checkCmd],
      stdout: "piped", stderr: "null",
    });
    const { code } = await proc.output();
    if (code !== 0) {
      return { exists: false, warning: `命令 "${cmdName}" 在系统中未找到，可能是AI幻觉` };
    }
    return { exists: true };
  } catch {
    return { exists: true }; // 检查失败时不阻塞
  }
}

/**
 * 返回命令安全规则的可读列表（供前端 API 端点动态渲染/编辑，不硬编码副本）。
 * 0715：返回运行时 live 清单（配置覆盖后的真值），条目含 regex 原串（编辑用）+ pattern 可读串（展示用）；
 * customized 标记各清单是否已被配置覆盖（UI「恢复默认」判断）；defaults 供恢复默认时前端预览。
 */
const _regexToReadable = (re) => re.source
  .replace(/\\b/g, "").replace(/\\s\+/g, " ").replace(/\\/g, "")
  .replace(/\(\?:.*?\)/g, "").replace(/\[.*?\]/g, "?");
// 0715 开关化：条目 {re, enabled, forced?} → {pattern, regex, flags, enabled, forced?}（forced 仅灰名单条目携带）
const _reListSerialize = (list) => list.map((e) => ({
  pattern: _regexToReadable(e.re), regex: e.re.source, flags: e.re.flags,
  enabled: e.enabled !== false,
  ...(typeof e.forced === "boolean" ? { forced: e.forced } : {}),
}));
export function getCommandRulesReadable() {
  const _rules = _loadCommandRules();
  return {
    rulesEnabled: _rules.rulesEnabled,
    blacklist: _reListSerialize(_rules.blacklist),
    graylist: _reListSerialize(_rules.graylist),
    gitPushAllowedRemotes: [..._rules.gitPushAllowedRemotes],
    customized: { ..._rules.customized },
    defaults: {
      blacklist: _reListSerialize(DEFAULT_COMMAND_BLACKLIST.map((re) => ({ re, enabled: true }))),
      graylist: _reListSerialize(DEFAULT_COMMAND_GRAYLIST.map((d) => ({ re: d.re, enabled: true, forced: d.forced === true }))),
      gitPushAllowedRemotes: [...DEFAULT_GIT_PUSH_ALLOWED_REMOTES],
    },
    defaultCategories: { ...DEFAULT_COMMAND_CATEGORIES },
  };
}
