/**
 * beilu-mvu — MVU 变量系统插件。不管 EJS 模板渲染（那是 beilu-ejs 的事）。
 *
 * 兼容：JS-Slash-Runner (酒馆助手) 的变量存储格式 (chat[].extension.mvu_variables)
 *
 * 链路：
 *   GetPrompt     → accumulateVariables(chatLog) 累积变量 → extension.mvu_accumulated 传给 TweakPrompt
 *   TweakPrompt(dl=1) → YAML.stringify(stat_data) → 注入 chat_log @depth=4 <status_current_variables>
 *   ReplyHandler  → parseVariableCommands 解析 <UpdateVariable>/<JSONPatch>/_.set
 *                 → 写 result.extension.mvu_variables（BuildChatLogEntryFromCharReply 持久化）
 *                 → hideVariableCommands → result.content_for_show（剥显示态变量标签）
 *
 * 影响：修改 result.extension.mvu_variables（持久化到 chatLog）；修改 result.content_for_show
 * 相交：← beilu-ejs TweakPrompt(dl=0) 读 mvu_accumulated.stat_data 构建 EJS 上下文
 *       ← beilu-regex TweakPrompt(dl=0) 在 MVU 变量注入之后应用正则
 *       → beilu-worldbook GetAllEntriesByChar 读 [InitVar] 世界书条目（变量初始化）
 */

import _ from "npm:lodash-es";
import YAML from "npm:yaml";
// [yonban T3d 迁移] 实现体从 plugins/beilu-mvu/main.mjs 迁入 functions/prompt/mvu/main.mjs（5 级到 src）。
//   纯搬家零逻辑改动。server 目标 5 级 ../../../../../；info.json 留旧位指回。mvu 数据经 setDefaultPart(username,
//   "plugins","beilu-mvu") 按 part 名字符串 keyed 落盘（非 import.meta.url），故无路径锚需求。
import { setDefaultPart } from "../../../../../server/parts_loader.mjs";
import info from "../../../../../public/parts/plugins/beilu-mvu/info.json" with { type: "json" };
import { wbT, wbD } from "../../../../../server/wbStub.mjs";
import { writeFile, mkdir } from "node:fs/promises"; // [0731 根修] 配置落盘（范式同 beilu-browser/beilu-ejs）
import { readJsonSafeSync } from "../../../../../scripts/safeJsonIO.mjs"; // [0731 根修] 配置读回（损坏备份后抛）
import { authenticate } from "../../security/auth.mjs"; // A2-3：HTTP 端点鉴权中间件（未认证→401），与全站 router.get/post(path, authenticate, handler) 同型（与同层 beilu-preset 同写法）

// M10：DIAG 探针默认关。原 8 处无条件 console.log 把用户回复正文末300字符 + stat_data 明文 dump 到后端控制台(隐私/噪声)。
// 需排查时 env BEILU_MVU_DIAG=1 开启。结构化追踪走 wbT 不受影响。
const _MVU_DIAG = (() => { try { return globalThis.Deno?.env?.get?.("BEILU_MVU_DIAG") === "1"; } catch { return false; } })();
function _mvuDiag(...args) { if (_MVU_DIAG) console.log(...args); }

// [0731 凛倾拍板"这两个默认关闭"] EJS/MVU 是酒馆角色卡适配件，默认关闭（opt-in）：
//   不用 ST 卡的用户零累积零注入；需要时在 AIRP 脚本插件管理打开（落盘持久）。
let pluginEnabled = false;
// 闭标签哨兵开关（</UpdateVariable> 美化正则触发用），默认关——无条件追加曾把哨兵
// 污染进每条落盘回复三字段并随历史回灌模型（2026-06-12 mock 铁证，N24 加开关）。
// 需要哨兵的美化正则用户经 POST /api/parts/plugins:beilu-mvu/config/setdata {append_close_sentinel:true} 开启。
let appendCloseSentinel = false;

// 【红线·0731 凛倾"mvu重复+多处散写/哪里来的硬开启"】enabled 等配置禁止纯内存态：SetData 只改
//   内存=重启即回默认 true=硬开启，用户关了照样跑。配置必须落盘+模块加载读回（范式同
//   beilu-browser/beilu-ejs）。开关唯一 UI=AIRP 脚本插件管理（pluginManager.mjs）；额外插件
//   管理平台的 MVU 重复条目已删（extensionsPanel.mjs 0731），禁止再加第二个控制面。
const CONFIG_PERSIST_FILE = "data/mvu-config.json";
try {
  const _saved = readJsonSafeSync(CONFIG_PERSIST_FILE, {});
  if (typeof _saved.enabled === "boolean") pluginEnabled = _saved.enabled;
  if (typeof _saved.append_close_sentinel === "boolean") appendCloseSentinel = _saved.append_close_sentinel;
} catch (e) {
  console.warn(`[beilu-mvu] ${CONFIG_PERSIST_FILE} 损坏（已备份 .corrupt.bak，用默认值继续）:`, e?.message || e);
}
let _cfgPersistTimer = null;
function _persistConfig() {
  if (_cfgPersistTimer) clearTimeout(_cfgPersistTimer);
  _cfgPersistTimer = setTimeout(async () => {
    _cfgPersistTimer = null;
    try {
      await mkdir("data", { recursive: true }).catch(() => {});
      await writeFile(CONFIG_PERSIST_FILE, JSON.stringify({ enabled: pluginEnabled, append_close_sentinel: appendCloseSentinel }, null, 2), "utf8");
    } catch (err) {
      console.warn("[beilu-mvu] 配置持久化失败:", err?.message || err);
    }
  }, 100);
}

// ============================================================
// §1 变量累积 — 对标 ST-Prompt-Template precacheVariables
// ============================================================

/**
 * 从 chatLog 中累积出最新的完整变量状态
 *
 * 对标 JS-Slash-Runner 的 _getAllVariables()：
 * 从第一楼到最后一楼，依次深度合并所有 mvu_variables，
 * 确保即使某一层只存了 delta（如初始变量楼层丢失后的回复），
 * 也能通过与之前楼层合并得到完整状态。
 *
 * 在 beilu 中存储于 chatLogEntry.extension.mvu_variables
 *
 * @param {Array} chatLog - beilu chatLog 数组
 * @returns {object|null} 完整累积状态 { stat_data: {...} } 或 null
 */
function accumulateVariables(chatLog) {
  let accumulated = null;
  for (let i = 0; i < chatLog.length; i++) {
    const vars = chatLog[i]?.extension?.mvu_variables;
    if (vars && typeof vars === "object" && Object.keys(vars).length > 0) {
      if (!accumulated) {
        accumulated = _.cloneDeep(vars);
      } else {
        // 深度合并：保留 accumulated 中已有的字段，用 vars 中的新字段覆盖
        _.merge(accumulated, vars);
      }
    }
  }
  return accumulated;
}

// ============================================================
// §2 变量初始化 — 对标 ST-Prompt-Template initial-variables
// ============================================================

/**
 * 从世界书读取 [InitVar] 条目并解析 YAML
 *
 * 对标酒馆中的 [InitialVariables] / [InitVar] 世界书条目
 * 条目特征：comment 或 key 中包含 [InitVar]，条目通常是 disabled 状态
 *
 * @param {object} arg - chatReplyRequest_t
 * @returns {Promise<object|null>} { stat_data: {...} } 或 null
 */
async function initFromWorldBook(arg) {
  const wbPlugin = arg.plugins?.["beilu-worldbook"];
  if (!wbPlugin?.interfaces?.config) return null;

  try {
    // ★ 使用 GetAllEntriesByChar 获取角色绑定世界书的所有条目（含 disabled）
    // [initvar] 条目通常是 disabled 的（不给 AI 看，只给 MVU 系统读取）
    const charName = arg.Charname || arg.char_id || "";
    // [T074 per-user] 透传 username：worldbook 已 per-user 隔离，不传则读到 _default 空 store → InitVar 找不到（跨域回归）。
    const _username = arg.username || "_default";
    let entries = [];

    if (wbPlugin.interfaces.config.GetAllEntriesByChar) {
      entries = wbPlugin.interfaces.config.GetAllEntriesByChar(charName, _username);
    } else {
      // 降级：旧版 worldbook 没有 GetAllEntriesByChar，使用 GetData
      console.log(
        "[beilu-mvu] initFromWorldBook: GetAllEntriesByChar 不可用, 降级到 GetData",
      );
      const wbData = await wbPlugin.interfaces.config.GetData({ username: _username });
      entries = wbData.entries || [];
    }

    for (const entry of entries) {
      const commentMatch = (entry.comment || "")
        .toLowerCase()
        .includes("[initvar]");
      const keyMatch =
        Array.isArray(entry.key) &&
        entry.key.some((k) => (k || "").toLowerCase().includes("[initvar]"));

      if (!commentMatch && !keyMatch) continue;

      const content = entry.content;
      if (!content || typeof content !== "string") continue;

      try {
        const parsed = YAML.parse(content);
        if (parsed && typeof parsed === "object") {
          console.log(
            "[beilu-mvu] InitVar 条目解析成功，变量结构:",
            Object.keys(parsed).join(", "),
          );
          return { stat_data: parsed };
        }
      } catch (yamlErr) {
        console.error("[beilu-mvu] InitVar YAML 解析失败:", yamlErr.message);
        wbD(null, "mvu:initvar", "yaml_parse_fail", false, `世界书 InitVar 的 YAML 解析失败，变量初始化跳过: ${yamlErr.message}`, { err: yamlErr.message });
      }
    }
  } catch (err) {
    console.error("[beilu-mvu] 读取世界书失败:", err.message);
    wbD(null, "mvu:initvar", "worldbook_read_fail", false, `读取世界书失败，变量初始化跳过: ${err.message}`, { err: err.message });
  }

  return null;
}

// ============================================================
// §3 JSON Patch — 严格对标 ST-Prompt-Template json-patch.ts
// ============================================================

/**
 * 将 JSON Pointer (RFC 6901) 转换为 lodash 路径数组
 *
 * 对标 ST-Prompt-Template convertJsonPointerToLodashPath
 * @see https://tools.ietf.org/html/rfc6901
 *
 * @param {string} pointer - JSON Pointer 字符串 (如 "/a/b/0")
 * @returns {string[]} lodash 路径数组 (如 ['a', 'b', '0'])
 */
function convertJsonPointerToLodashPath(pointer) {
  if (typeof pointer !== "string") {
    throw new Error("Path must be a string.");
  }
  if (pointer === "") return [];
  if (pointer.charAt(0) !== "/") {
    throw new Error('Invalid JSON Pointer: must start with "/".');
  }
  // RFC 6901: ~1 → /, ~0 → ~
  const segments = pointer
    .substring(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  for (const seg of segments) {
    if (seg === "__proto__" || seg === "constructor" || seg === "prototype") {
      throw new Error(`Prototype pollution attempt blocked: "${seg}".`);
    }
  }
  return segments;
}

/**
 * 将指向 /stat_data/... 的 JSON Pointer 归一化为 stat_data 根对象下的路径
 *
 * 当前 applyJsonPatch() 的 doc 参数本身就是 stat_data，
 * 所以 AI 若输出 /stat_data/秋浸月/好感度，必须先归一化成 /秋浸月/好感度，
 * 否则会被错误写成 stat_data.stat_data.*。
 *
 * @param {string} pointer
 * @returns {string}
 */
function normalizeJsonPointerForStatDataRoot(pointer) {
  if (typeof pointer !== "string" || pointer === "") return pointer;
  if (pointer === "/stat_data") return "";
  if (pointer.startsWith("/stat_data/")) {
    return pointer.slice("/stat_data".length);
  }
  return pointer;
}

/**
 * 对 JSON Patch 数组做 stat_data 根路径归一化
 *
 * @param {Array} patches
 * @returns {Array}
 */
function normalizePatchesForStatDataRoot(patches) {
  return patches.map((patch) => {
    if (!patch || typeof patch !== "object") return patch;

    const normalizedPatch = { ...patch };
    if (typeof normalizedPatch.path === "string") {
      normalizedPatch.path = normalizeJsonPointerForStatDataRoot(
        normalizedPatch.path,
      );
    }
    if (typeof normalizedPatch.from === "string") {
      normalizedPatch.from = normalizeJsonPointerForStatDataRoot(
        normalizedPatch.from,
      );
    }
    return normalizedPatch;
  });
}

/**
 * 应用 JSON Patch (RFC 6902)。严格对标 ST-Prompt-Template jsonPatch。
 *
 * 支持: add, replace, remove, move, copy, test, set, assign, delta
 * 其中 delta 为 beilu 扩展：在现有数值上加增量（如好感度+3），不存在时初始化。
 *
 * 链路：parseVariableCommands → normalizePatchesForStatDataRoot → 本函数
 * 约束：
 *   - path 已经过 normalizeJsonPointerForStatDataRoot 去掉 /stat_data 前缀（因为 doc 本身就是 stat_data）
 *   - 原型污染防护：convertJsonPointerToLodashPath 拒绝 __proto__/constructor/prototype
 *   - cloneDeep(doc)：不修改原文档，返回新文档
 *
 * @param {object} doc - 原始文档（通常是 stat_data）
 * @param {Array} patches - RFC 6902 操作数组
 * @returns {object} 应用补丁后的新文档
 */
function applyJsonPatch(doc, patches) {
  let newDoc = _.cloneDeep(doc);

  for (const patch of patches) {
    const { op, path, value } = patch;
    const isRootPath = path === "";
    const isRootFromPath = patch.from === "";
    const fromPath =
      patch.from === ""
        ? []
        : patch.from
          ? convertJsonPointerToLodashPath(patch.from)
          : undefined;
    const lodashPath = isRootPath ? [] : convertJsonPointerToLodashPath(path);

    switch (op) {
      // 对标 ST-Prompt-Template: 同时支持 set/assign 别名
      case "set":
      case "assign":
      case "add":
      case "replace": {
        if (isRootPath) {
          newDoc = _.cloneDeep(value);
          break;
        }

        const lastSegment = lodashPath[lodashPath.length - 1];
        if (lastSegment === "-") {
          // 数组末尾追加: /path/to/array/-
          const parentPath = lodashPath.slice(0, -1);
          const parent = _.get(newDoc, parentPath);
          if (Array.isArray(parent)) {
            parent.push(value);
          } else {
            console.warn(
              `[beilu-mvu] jsonPatch: Cannot push to non-array at: ${parentPath.join(".")}`,
            );
          }
        } else {
          _.set(newDoc, lodashPath, value);
        }
        break;
      }

      case "remove": {
        if (isRootPath) {
          newDoc = {};
        } else if (!_.unset(newDoc, lodashPath)) {
          console.warn(
            `[beilu-mvu] jsonPatch: Path "${path}" could not be removed.`,
          );
        }
        break;
      }

      case "move": {
        const valueToMove = isRootFromPath
          ? _.cloneDeep(newDoc)
          : _.get(newDoc, fromPath);
        if (_.isUndefined(valueToMove)) {
          console.error(
            `[beilu-mvu] jsonPatch: Cannot move from non-existent path: "${patch.from}"`,
          );
          break;
        }
        // 对标 ST-Prompt-Template: remove *before* set
        if (isRootFromPath) {
          newDoc = {};
        } else {
          _.unset(newDoc, fromPath);
        }
        if (isRootPath) {
          newDoc = _.cloneDeep(valueToMove);
        } else {
          _.set(newDoc, lodashPath, valueToMove);
        }
        break;
      }

      case "copy": {
        const valueToCopy = isRootFromPath
          ? _.cloneDeep(newDoc)
          : _.get(newDoc, fromPath);
        if (_.isUndefined(valueToCopy)) {
          console.error(
            `[beilu-mvu] jsonPatch: Cannot copy from non-existent path: "${patch.from}"`,
          );
          break;
        }
        if (isRootPath) {
          newDoc = _.cloneDeep(valueToCopy);
        } else {
          _.set(newDoc, lodashPath, _.cloneDeep(valueToCopy));
        }
        break;
      }

      case "delta": {
        // delta 操作：在现有数值基础上加增量（如好感度+3）
        // 对标角色卡 JSONPatch 中常见的 { "op": "delta", "path": "/stat_data/好感度", "value": 3 }
        if (isRootPath) {
          console.warn(
            `[beilu-mvu] jsonPatch: Cannot apply delta to root path`,
          );
          break;
        }
        const currentValue = _.get(newDoc, lodashPath);
        if (typeof currentValue === "number" && typeof value === "number") {
          _.set(newDoc, lodashPath, currentValue + value);
        } else if (currentValue === undefined && typeof value === "number") {
          // 路径不存在时，初始化为 delta 值
          _.set(newDoc, lodashPath, value);
        } else {
          console.warn(
            `[beilu-mvu] jsonPatch: delta requires numeric values, got current=${typeof currentValue}, value=${typeof value} at "${path}"`,
          );
          // 容错：如果当前值可以转为数字，尝试转换后相加
          const numCurrent = Number(currentValue);
          const numValue = Number(value);
          if (!isNaN(numCurrent) && !isNaN(numValue)) {
            _.set(newDoc, lodashPath, numCurrent + numValue);
          }
        }
        break;
      }

      case "test": {
        const existingValue = isRootPath ? newDoc : _.get(newDoc, lodashPath);
        if (!_.isEqual(existingValue, value)) {
          console.warn(`[beilu-mvu] jsonPatch: Test failed at "${path}"`);
        }
        break;
      }

      default:
        console.warn(`[beilu-mvu] jsonPatch: Unsupported operation: "${op}"`);
    }
  }

  return newDoc;
}

// ============================================================
// §4 变量命令解析 — 对标 JS-Slash-Runner Mvu.parseMessage
// ============================================================

/**
 * 从 AI 输出中解析变量更新命令
 *
 * 支持三种格式:
 * 1. _.set('path', value) — MVU 原始格式
 * 2. <UpdateVariable><JSONPatch>[...]</JSONPatch></UpdateVariable> — 主要格式
 * 3. 独立 <JSONPatch>[...]</JSONPatch>
 *
 * @param {string} content - AI 原始输出
 * @param {object} currentState - 当前变量状态 { stat_data: {...} }
 * @returns {{ newState: object, hasChanges: boolean }}
 */
function parseVariableCommands(content, currentState) {
  let newState = _.cloneDeep(currentState);
  let hasChanges = false;

  if (!newState.stat_data) newState.stat_data = {};

  // 格式1: _.set('path', value) — 对标 mvuPolyfill.mjs
  const setRegex = /_\.set\s*\(\s*['"]([^'"]+)['"]\s*,\s*([\s\S]+?)\s*\)/g;
  let match;
  while ((match = setRegex.exec(content)) !== null) {
    let path = match[1];
    const valueStr = match[2].trim();

    // 移除 stat_data. 前缀
    path = path.replace(/^stat_data\./, "");

    // 原型污染防护：拒绝含 __proto__/constructor/prototype 段的路径
    const _segs = _.toPath(path);
    if (
      _segs.some(
        (s) => s === "__proto__" || s === "constructor" || s === "prototype",
      )
    ) {
      continue;
    }

    try {
      const value = JSON.parse(valueStr);
      _.set(newState.stat_data, path, value);
      hasChanges = true;
    } catch {
      // 非合法 JSON，尝试作为字符串处理（去除引号）
      let value = valueStr;
      if (
        (value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"'))
      ) {
        value = value.slice(1, -1);
      }
      _.set(newState.stat_data, path, value);
      hasChanges = true;
    }
  }

  // 格式2 & 3: <JSONPatch>[...]</JSONPatch>
  // 对标 ST-Prompt-Template json-patch.ts
  const patchRegex = /<JSONPatch>\s*([\s\S]*?)\s*<\/JSONPatch>/g;
  while ((match = patchRegex.exec(content)) !== null) {
    try {
      const patches = JSON.parse(match[1]);
      if (Array.isArray(patches) && patches.length > 0) {
        const normalizedPatches = normalizePatchesForStatDataRoot(patches);
        newState.stat_data = applyJsonPatch(
          newState.stat_data,
          normalizedPatches,
        );
        hasChanges = true;
        wbT(null, "mvu", "jsonpatch:applied", { n: normalizedPatches.length });
      }
    } catch (e) {
      wbD(null, "mvu", "jsonpatch:catch", false, e.message, {});
      console.error("[beilu-mvu] JSONPatch 解析失败:", e.message);
    }
  }

  return { newState, hasChanges };
}

// ============================================================
// §5 content_for_show — 隐藏变量命令
// ============================================================

/**
 * 补全缺失的 </UpdateVariable> 末尾哨兵
 *
 * 主人要求这里只保留闭标签本身，用于正则美化触发，
 * 不要求存在 <UpdateVariable> 开标签。
 *
 * @param {string} content - AI 原始输出
 * @returns {{ content: string, appended: boolean }} 修复结果
 */
function ensureUpdateVariableClosed(content) {
  if (!content || typeof content !== "string") {
    return { content: content || "", appended: false };
  }

  const hasCloseTag = /<\/UpdateVariable>/i.test(content);
  if (hasCloseTag) {
    return { content, appended: false };
  }

  return {
    content: content.trimEnd() + "\n</UpdateVariable>",
    appended: true,
  };
}

/**
 * 生成 content_for_show，隐藏变量更新命令。
 *
 * 需要隐藏:
 * - <UpdateVariable>...</UpdateVariable> 整块（含 <Analysis> 和 <JSONPatch>）
 * - 独立 <JSONPatch>...</JSONPatch>
 * - _.set(...) 命令
 * - <StatusPlaceHolderImpl /> 占位标签（Phase 3.2：前端会自动注入，不需要保留在存储内容中）
 *
 * 链路：ReplyHandler → 本函数 → 返回清理后的 content_for_show
 * 约束：不要删除 regexCore protectJsonSegments 保护的段——本函数在 ReplyHandler 中，
 *       protectJsonSegments 只在 applyRegexRules 内部使用，二者不交叉
 *
 * @param {string} content - AI 原始输出
 * @returns {string} 清理后的显示内容
 */
function hideVariableCommands(content) {
  let cleaned = content;
  // 隐藏 <UpdateVariable>...</UpdateVariable>
  cleaned = cleaned.replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/g, "");
  // 隐藏独立 <JSONPatch>...</JSONPatch>
  cleaned = cleaned.replace(/<JSONPatch>[\s\S]*?<\/JSONPatch>/g, "");
  // 隐藏 _.set(...) 命令
  cleaned = cleaned.replace(
    /_\.set\s*\(\s*['"][^'"]+['"]\s*,\s*[\s\S]+?\s*\)\s*/g,
    "",
  );
  // ★ Phase 3.2：清除 StatusPlaceHolderImpl（前端会自动注入，不需要保留在存储内容中）
  cleaned = cleaned.replace(/<StatusPlaceHolderImpl\s*\/?>/gi, "");
  // 清理多余空行
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return cleaned;
}

// ============================================================
// §6 插件主体
// ============================================================

const pluginExport = {
  info,

  Load: async ({ username, router }) => {
    console.log("[beilu-mvu] MVU 变量系统插件加载中...");

    // ★ 自注册为默认插件，确保 getAllDefaultParts 能发现它
    if (username) {
      setDefaultPart(username, "plugins", "beilu-mvu");
      console.log("[beilu-mvu] 已自动注册为默认插件 (plugins/beilu-mvu)");
    }

    // 注册 HTTP API 端点
    router.get(
      "/api/parts/plugins\\:beilu-mvu/config/getdata",
      authenticate, // A2-3：补鉴权——杜绝匿名读 MVU 变量系统配置
      async (req, res) => {
        try {
          const data = await pluginExport.interfaces.config.GetData();
          res.json(data);
        } catch (err) {
          console.error("[beilu-mvu] GetData error:", err);
          res.status(500).json({ error: err.message });
        }
      },
    );

    router.post(
      "/api/parts/plugins\\:beilu-mvu/config/setdata",
      authenticate, // A2-3：补鉴权——杜绝匿名写 MVU 变量系统配置（append_close_sentinel 等）
      async (req, res) => {
        try {
          await pluginExport.interfaces.config.SetData(req.body);
          res.json({ success: true });
        } catch (err) {
          console.error("[beilu-mvu] SetData error:", err);
          res.status(500).json({ error: err.message });
        }
      },
    );

    console.log("[beilu-mvu] MVU 变量系统插件已加载");
  },

  Unload: async () => {
    console.log("[beilu-mvu] MVU 变量系统插件已卸载");
  },

  interfaces: {
    config: {
      GetData: async () => ({
        enabled: pluginEnabled,
        append_close_sentinel: appendCloseSentinel,
        // 控件元数据单源下发（0722 禁前端硬编码）：前端设置面纯渲染
        meta: [
          { key: "enabled", group: "基础设置", type: "toggle", label: "启用变量系统", desc: "MVU 变量累积与注入（SillyTavern MVU 兼容）" },
          { key: "append_close_sentinel", group: "基础设置", type: "toggle", label: "闭标签哨兵", desc: "在注入尾部追加闭合哨兵，防变量块被截断" },
        ],
      }),

      SetData: async (data) => {
        if (data?.enabled !== undefined) {
          pluginEnabled = !!data.enabled;
          console.log(`[beilu-mvu] 插件${pluginEnabled ? "已启用" : "已禁用"}`);
        }
        if (data?.append_close_sentinel !== undefined) {
          appendCloseSentinel = !!data.append_close_sentinel;
          console.log(`[beilu-mvu] 闭标签哨兵${appendCloseSentinel ? "已开启" : "已关闭"}`);
        }
        // [0731 根修] 每次 SetData 落盘（防重启回默认=硬开启，红线见文件头 CONFIG_PERSIST_FILE 处）
        _persistConfig();
      },
    },

    chat: {
      /**
       * GetPrompt — 从 chatLog 累积变量，必要时初始化
       *
       * 返回值通过 extension.mvu_accumulated 传递给 TweakPrompt
       * 不在此处注入文本 — 文本注入由 TweakPrompt 完成
       */
      GetPrompt: async (arg) => {
        // ⚠ [铁律] GetPrompt 禁止硬编码提示词文本。引导文案走 injectTexts/fillInjectText（用户可配），操作说明走 INJ 条目。shadowBuild 会检测并隐藏 >200 字符的非宏内容。
        const _cid = arg?.chatid || arg?.chat_name?.replace("common_chat_", "") || null;
        wbT(_cid, "mvu", "GetPrompt:enter", {});
        // [2026-08-01 批① mvu 零失效修] 同 sandbox 修——worker isolate 的 let 是 import 快照，盘读同步
        try { const _dc = readJsonSafeSync(CONFIG_PERSIST_FILE, {}); if (typeof _dc.enabled === 'boolean') pluginEnabled = _dc.enabled; } catch {}
        if (!pluginEnabled)
          return { text: [], additional_chat_log: [], extension: {} };

        const chatLog = arg.chat_log || [];

        // 1. 累积变量 — 对标 precacheVariables
        let currentState = accumulateVariables(chatLog);

        // 2. 无变量时从世界书初始化 — 对标 initial-variables.ts
        if (!currentState) {
          currentState = await initFromWorldBook(arg);
          if (currentState && chatLog.length > 0) {
            // 写入第一条消息的 extension（随 chatLog 持久化）
            chatLog[0].extension = chatLog[0].extension || {};
            chatLog[0].extension.mvu_variables = currentState;
            console.log("[beilu-mvu] 变量已初始化并写入第一条消息");
          }
        }

        if (!currentState?.stat_data) {
          return { text: [], additional_chat_log: [], extension: {} };
        }

        // 通过 extension 传递给 TweakPrompt，不在此处注入文本
        wbT(_cid, "mvu", "GetPrompt:exit", {
          accLen: currentState?.stat_data
            ? Object.keys(currentState.stat_data).length
            : 0,
        });
        return {
          text: [],
          additional_chat_log: [],
          extension: {
            mvu_accumulated: currentState,
          },
        };
      },

      /**
       * TweakPrompt — 变量 YAML 注入
       *
       * 执行时机:
       * - detail_level=2: beilu-worldbook 注入世界书条目
       * - detail_level=1: beilu-mvu 注入变量 YAML ← 这里
       * - detail_level=0: beilu-ejs 执行 EJS 渲染
       *
       * 对标: JS-Slash-Runner setExtensionPrompt (at depth)
       */
      TweakPrompt: (arg, prompt_struct, my_prompt, detail_level) => {
        // 在 detail_level=1 执行（世界书在 detail_level=2 已注入完毕）
        if (detail_level !== 1 || !pluginEnabled) return;

        const currentState = my_prompt?.extension?.mvu_accumulated;
        if (!currentState?.stat_data) {
          return;
        }

        // 注入变量 YAML 到 chat_log (at depth)
        const yamlText = YAML.stringify(currentState.stat_data);
        // depth=4: 从聊天记录末尾往前数 4 条插入，使变量上下文贴近最新对话（与世界书 @depth 默认一致）
        const depth = 4;
        if (prompt_struct.chat_log && Array.isArray(prompt_struct.chat_log)) {
          const insertIndex = Math.max(
            0,
            prompt_struct.chat_log.length - depth,
          );
          prompt_struct.chat_log.splice(insertIndex, 0, {
            role: "system",
            content: `<status_current_variables>\n${yamlText}</status_current_variables>`,
            name: "mvu_variables",
            extension: { ephemeral: true },
          });
          console.log(
            "[beilu-mvu] YAML 变量已注入 chat_log, 位置:",
            insertIndex,
            ", 变量 keys:",
            Object.keys(currentState.stat_data).join(", "),
          );
        }
      },

      /**
       * ReplyHandler — 解析 AI 输出中的变量更新命令。
       *
       * 对标: JS-Slash-Runner Mvu.parseMessage (_.set) + ST-Prompt-Template json-patch.ts (JSONPatch)
       *
       * 链路：replyHandler.mjs 插件链 → 本函数
       *       → parseVariableCommands(content, currentState) 解析三种格式
       *       → result.extension.mvu_variables = newState（随 chatLog 持久化）
       *       → content_for_show = 保留带标签原文（供 markdownOnly display regex 匹配）
       *       → hideVariableCommands → 剥显示态变量标签
       * 影响：修改 result.extension / result.content / result.content_for_show / result.content_for_edit
       * 约束：
       *   - appendCloseSentinel 默认关（N24）——开启时在 content 末尾追加 </UpdateVariable> 供美化正则触发
       *   - content_for_show 保留带 XML 标签原文，_stripAllTags 在 beilu-memory ReplyHandler 中做
       *
       * @returns {boolean} false — 不触发重新生成
       */
      ReplyHandler: (result, request) => {
        const _cid = request?.chatid || request?.chat_name?.replace("common_chat_", "") || null;
        wbT(_cid, "mvu", "ReplyHandler:enter", {});
        if (!pluginEnabled) {
          _mvuDiag(
            "[beilu-mvu DIAG] ReplyHandler: pluginEnabled=false, 跳过",
          );
          return false;
        }

        let content = result.content;
        if (!content || typeof content !== "string") {
          _mvuDiag(
            "[beilu-mvu DIAG] ReplyHandler: content 为空或非字符串, 跳过",
          );
          return false;
        }

        // 闭标签哨兵（美化正则触发用）——仅开关开启时追加（N24：默认关，防落盘污染+历史回灌）
        if (appendCloseSentinel) {
          const normalizedContent = ensureUpdateVariableClosed(content);
          if (normalizedContent.appended) {
            content = normalizedContent.content;
            result.content = content;
            console.log("[beilu-mvu] 已在 content 末尾追加 </UpdateVariable>");
          }
        }

        // 检查内容中是否存在变量命令标签
        const hasVariableTags = /<UpdateVariable>|<JSONPatch>|_\.set\s*\(/.test(
          content,
        );

        _mvuDiag(
          "[beilu-mvu DIAG] ReplyHandler: hasVariableTags=" +
            hasVariableTags +
            ", contentLen=" +
            content.length,
        );
        // 额外诊断：显示 content 末尾 300 字符
        _mvuDiag(
          "[beilu-mvu DIAG] ReplyHandler: content 末尾300字符:",
          content.slice(-300),
        );

        if (hasVariableTags) {
          // 获取当前变量状态：
          // 1. 优先取 chat_log 中最近一次持久化结果
          // 2. 首轮/无历史时退回本轮 GetPrompt 累积态
          // 3. 仍为空则从空 stat_data 开始，确保首轮也能解析并落盘
          const currentState =
            accumulateVariables(request.chat_log || []) ||
            _.cloneDeep(
              request.prompt_struct?.plugin_prompts?.["beilu-mvu"]?.extension
                ?.mvu_accumulated || { stat_data: {} },
            );

          // 解析变量更新命令
          const { newState, hasChanges } = parseVariableCommands(
            content,
            currentState,
          );

          wbT(_cid, "mvu", "parseVarCommands", {
            n: (content.match(/<UpdateVariable>|<JSONPatch>|_\.set\s*\(/g) || []).length,
            hasChanges,
          });

          _mvuDiag(
            "[beilu-mvu DIAG] ReplyHandler: parseVariableCommands 结果: hasChanges=" +
              hasChanges +
              ", newState keys=" +
              (newState ? Object.keys(newState).join(",") : "null"),
          );
          if (newState?.stat_data) {
            _mvuDiag(
              "[beilu-mvu DIAG] ReplyHandler: stat_data keys=" +
                Object.keys(newState.stat_data).join(","),
            );
            _mvuDiag(
              "[beilu-mvu DIAG] ReplyHandler: stat_data 内容:",
              JSON.stringify(newState.stat_data).substring(0, 500),
            );
          }

          if (hasChanges) {
            // 写入完整的更新后状态到 result.extension
            // BuildChatLogEntryFromCharReply 会将 result.extension 持久化
            result.extension = result.extension || {};
            result.extension.mvu_variables = newState;
            _mvuDiag(
              "[beilu-mvu DIAG] ★ 变量已写入 result.extension.mvu_variables, keys:",
              Object.keys(newState).join(","),
            );
          }

          // 保留带 XML / JSONPatch 的显示态原文，供 markdownOnly display regex 长期匹配。
          // 参考 JS-Slash-Runner / ST 模板：显示链应基于原始消息文本，而不是先在插件层剥掉标签。
          result.content_for_show = result.content_for_show || content;
        }

        // 如果显示态存在，也同步追加哨兵，供依赖 </UpdateVariable> 的美化正则使用（同受 N24 开关控制）
        if (appendCloseSentinel && result.content_for_show) {
          const normalizedShow = ensureUpdateVariableClosed(
            result.content_for_show,
          );
          if (normalizedShow.appended) {
            result.content_for_show = normalizedShow.content;
            console.log(
              "[beilu-mvu] 已在 content_for_show 末尾追加 </UpdateVariable>",
            );
          }
        }

        // 同步编辑态：保证"查看编辑"能看到最终的末尾哨兵。
        // 0714 根因修（thinking 对人消失·断点B同族）：原 = result.content（已剥 thinking 的 AI 版）——
        //   把 N30 契约「content_for_edit=含思维链原文」的编辑副本覆盖掉，且编辑保存会把无 thinking 版回写三键=永久销毁。
        //   改取 content_for_show（此刻=含 thinking 原文+哨兵已追加 :808-817，变量标签剥离在 :824 之后才发生，编辑态保留标签）；
        //   show 缺失（源未分离）时回落 content，行为与旧版等价。
        result.content_for_edit = result.content_for_show || result.content;

        // clean content_for_show: strip variable operation tags
        if (result.content_for_show) {
          result.content_for_show = hideVariableCommands(result.content_for_show);
        }

        wbT(_cid, "mvu", "ReplyHandler:exit", {});
        return false; // 不触发重新生成
      },
    },
  },
};

export default pluginExport;
