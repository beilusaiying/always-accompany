/**
 * stripThinking.mjs — thinking 剥离单源（T3b·hide 组，2026-07-02 从 api/proxy/lib/messageTransform.mjs 抽出）
 *
 * 【功能链】
 *   thinking 一条命：AI 产出含 <thinking> 回复 → 前端渲染可见（保留）→ 落盘原文（保留）
 *   → 出站给 AI 前必须已死：组装历史（regex 组 TweakPrompt / memory getPromptHandler）、
 *   回喂（aiRunner）、proxy 出站（httpFetch/postProcessMessages）、placeholder（generation）
 *   ——全部经本文件 stripReasoningTags 同一实现（迁移前已单源，本批把实现落回 hide 组归位）。
 *   per-user 配置：data/users/<u>/chars/<c>/memory/_config.json 的 reasoning_tags（自定义标签对），
 *   30s TTL 缓存；剥闭合+未闭合（流中断）。内置 <think>/<thinking> 恒剥离——0720 凛倾硬性核心：
 *   「删除think和thinking,禁止让ai看到,但是人类必须看得到」。reasoning_builtin 可关开关已删
 *   （读侧忽略,写侧清存量键）,前端折叠开关同批删除（人类侧恒显示）。
 *
 * 【why】
 *   凛倾 05-18：「不要把thinking自动删除…思维链只是不发送给ai,不是说不给用户看」；
 *   06-25：「thinking的隐藏是按照正则来的…但是现在只有airp可以改」——regex 组内置硬编码副本
 *   不受用户配置控制的病灶已由 regex 改调本实现合一（T3b）。
 *   YonBan ChatService.ts:814-828 reasoning_builtin 为远程侧独立实现（交界点，不迁）。
 *
 * 【影响范围】
 *   改本文件 = 改全部出站剥离行为；messageTransform re-export 保 api 组内与 4 个 memory/chat
 *   宿主旧 import 路径不断（T8 统一切）。
 */
import fs from "node:fs";
import path from "node:path";
import { wbT } from "../../../../server/wbStub.mjs";
// 24批1（07-03）：写侧收口引 storage 单点（写盘/缓存同步）——hide→storage 单向依赖无环
import { getMemoryDir, loadJsonFileIfExists, saveJsonFile, memoryCache } from "../memory/storage_mod/storage.mjs";

const BUILTIN_THINK = { open: "<think>", close: "</think>" };
const BUILTIN_THINKING = { open: "<thinking>", close: "</thinking>" };
const REASONING_TAG_PAIRS = [BUILTIN_THINK, BUILTIN_THINKING];

// T03: 用户思维链配置缓存（30秒TTL）— per-user 缓存整份 reasoning 配置（含内置开关+自定义标签）。
// SEC 破口A：原单槽全局缓存遍历【全部用户】取首个 reasoning 配置写全局 → A 的剥离规则串到 B 的输出。
//   改 Map<username> 各人各份；只读该 username 自己的 chars。
const _userTagsCache = new Map(); // Map<username|"_default", { config, time }>
const _USER_TAGS_TTL = 30000;

/**
 * 从记忆配置加载【指定用户】的思维链配置（内置标签开关 + 自定义标签对）。
 * 同步读取，30秒 per-user 缓存避免频繁IO。单源 = _config.json：
 *   - reasoning_tags: Array<{open,close}>  自定义标签（既有字段，向后兼容）
 *   - reasoning_builtin: { think?:boolean, thinking?:boolean }  内置标签临时禁用（缺省=启用）
 * @param {string} [username] 无归因时落 "_default"（单用户 local 自然命中本人）。
 * @returns {{ builtin:{think:boolean, thinking:boolean}, custom:Array<{open:string, close:string}> }}
 */
function _loadUserReasoningConfig(username) {
  const u = username || "_default";
  const now = Date.now();
  const cached = _userTagsCache.get(u);
  if (cached && (now - cached.time) < _USER_TAGS_TTL) return cached.config;
  /** @type {{builtin:{think:boolean,thinking:boolean}, custom:Array<{open:string,close:string}>}} */
  let result = { builtin: { think: true, thinking: true }, custom: [] };
  try {
    const charsDir = path.join(import.meta.dirname, "..", "..", "..", "..", "..", "data", "users", u, "chars"); // T3b: hide/ 下 5 级到仓库根（原 api/proxy/lib 下 7 级）
    if (fs.existsSync(charsDir)) {
      // [0718 遮蔽修] 原 first-match-break：字典序第一个有 reasoning 配置的卡独占全局剥离规则，
      //   用户在当前卡面板新配的标签被静默无视（写=卡级 setReasoningTags, 读=全局单值——写读粒度错位）。
      //   剥离是出站安全域：custom 标签跨卡【聚合】（多剥无害）；builtin 开关任一卡显式禁用即禁用
      //   （禁用是用户显式动作，聚合取保守并集语义）。
      for (const c of fs.readdirSync(charsDir)) {
        const cfgPath = path.join(charsDir, c, "memory", "_config.json");
        if (!fs.existsSync(cfgPath)) continue;
        try {
          const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
          // [0720 硬化] reasoning_builtin 禁用分支已删：内置 think/thinking 恒剥离（凛倾硬性核心,AI 禁见）,
          //   盘上存量 reasoning_builtin 键由写侧 setReasoningTags 顺手清除,读侧无条件忽略。
          if (Array.isArray(cfg.reasoning_tags)) {
            for (const t of cfg.reasoning_tags) {
              if (t && t.open && t.close && !result.custom.some(x => x.open === t.open && x.close === t.close))
                result.custom.push({ open: t.open, close: t.close });
            }
          }
        } catch { /* ignore bad JSON */ }
      }
    }
  } catch { /* ignore fs errors */ }
  _userTagsCache.set(u, { config: result, time: now });
  return result;
}

/**
 * 计算应剥离的思维链标签对（三态：无配置=默认两内置 / 禁用某内置=排除它 / 含自定义=追加）。
 * @param {string|{ builtin?:{think?:boolean, thinking?:boolean}, custom?:Array<{open:string,close:string}> }} [usernameOrCfg]
 *   传 string=按该 username 从磁盘单源加载；传 object=上游已持有配置时直接复用（测试用）；省略=按 "_default" 加载。
 * @returns {Array<{open:string, close:string}>}
 */
export function getReasoningTags(usernameOrCfg) {
  const cfg = (usernameOrCfg && typeof usernameOrCfg === "object")
    ? usernameOrCfg
    : _loadUserReasoningConfig(usernameOrCfg);
  const tags = [];
  // [0720 硬化] 内置标签无条件剥离（不再受 cfg.builtin 影响,object 传参路径同样硬化）
  tags.push(BUILTIN_THINK, BUILTIN_THINKING);
  if (Array.isArray(cfg.custom)) {
    for (const t of cfg.custom) if (t && t.open && t.close) tags.push({ open: t.open, close: t.close });
  }
  return tags;
}

/**
 * 写入【指定用户指定卡】的思维链配置（24批1·hide 读写收口，07-03）。
 * 【功能链】原写路只有 memory#updateConfig（extendMenuW28 写/hide 读=门面分裂，"只有airp能改"根因）——
 *   本函数=hide 组内写单点（0715 起唯一写路：setDataActions updateConfig 的 reasoning 两键分支
 *   =旧门面残枝已删，全部调用方 web/YonBan 均走本路）：与读侧 _loadUserReasoningConfig 同锚
 *   （卡级 _config.json 的 reasoning_tags 整体替换 / reasoning_builtin 浅合并），
 *   写后①清本组 _userTagsCache（修"写后 30s TTL 内剥离仍旧值"陈旧缺陷）②同步 memoryCache.config（防 getData 诊断面旧值）。
 * 【被谁消费】functions:hide#setReasoningTags verb（hide/index.mjs）→ 前端 extendMenuW28 思维链设置。
 * @param {string} username
 * @param {string} charName - 写落点卡（与 memory updateConfig 同定位；跨卡读侧扫描会命中）
 * @param {{reasoning_tags?:Array<{open:string,close:string}>, reasoning_builtin?:{think?:boolean,thinking?:boolean}}} patch
 * @returns {{success:boolean, config:object}}
 */
export function setReasoningTags(username, charName, patch = {}) {
  const configPath = path.join(getMemoryDir(username, charName), "_config.json");
  const currentConfig = loadJsonFileIfExists(configPath, { enabled: true });
  if (patch.reasoning_tags !== undefined) currentConfig.reasoning_tags = patch.reasoning_tags;
  // [0720 硬化] reasoning_builtin 已废（内置恒剥离,凛倾硬性核心）——写侧顺手清存量键,
  //   YonBan getThinkingTags 等远程读侧读不到 false 自然恒真,零改动对齐。
  delete currentConfig.reasoning_builtin;
  saveJsonFile(configPath, currentConfig);
  _userTagsCache.delete(username || "_default");
  const cacheKey = `${username}/${charName}`;
  if (memoryCache.has(cacheKey)) memoryCache.get(cacheKey).config = currentConfig;
  wbT(null, "hide", "setReasoningTags", { username, charName, nTags: currentConfig.reasoning_tags?.length ?? 0 });
  return { success: true, config: currentConfig };
}

/**
 * 从文本中剥离所有思维链标签及其内容
 * 支持闭合标签和未闭合标签（流中断场景）
 * @param {string} text
 * @param {string} [username] SEC 破口A：按该用户加载剥离规则（内置开关+自定义标签），不串别的用户
 * @param {Array<{open:string, close:string}>} [extraTags] 额外的自定义标签对
 * @returns {string}
 */
export function stripReasoningTags(text, username, extraTags) {
  if (!text) return text;
  // 单源：getReasoningTags(username) 已含该用户内置(可被用户临时禁用)+自定义标签；extraTags 为调用方临时追加
  const allTags = [...getReasoningTags(username), ...(extraTags || [])];
  let result = text;
  for (const { open, close } of allTags) {
    const cEsc = close.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!result.includes(open)) {
      // [0718 形态补全] 孤儿闭标签：AI 只写了 close 没写 open（0717 实证 </beilu_think> 残片
      //   随历史反复发回渠道）。无 open 无法界定内容范围——剥标签字面本身（内容本就不是思考体）。
      if (result.includes(close)) {
        wbT(null, "ai:transform", "strip_orphan_close", { close });
        result = result.replace(new RegExp(`${cEsc}\\s*`, "g"), "");
      }
      continue;
    }
    const oEsc = open.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 闭合标签
    result = result.replace(new RegExp(`${oEsc}[\\s\\S]*?${cEsc}\\s*`, "g"), "");
    // 未闭合标签（流中断）
    if (result.includes(open)) {
      wbT(null, "ai:transform", "strip_unclosed_tag", { open });
      result = result.replace(new RegExp(`${oEsc}[\\s\\S]*$`, "g"), "");
    }
    // 剥完成对/未闭合后仍残留的孤儿 close（开闭数量不对称）同样清字面
    if (result.includes(close)) result = result.replace(new RegExp(`${cEsc}\\s*`, "g"), "");
  }
  return result.trim();
}
