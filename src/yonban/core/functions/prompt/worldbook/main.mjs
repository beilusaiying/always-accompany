/**
 * [beilu-worldbook] — 世界书条目的存储、激活、注入管线。
 * 不管 AI 生成请求构建（那是 beilu-preset / requestBuilder 的事），
 * 不管记忆/P1 注入（那是 getPromptHandler / beilu-memory 的事）。
 *
 * 链路：configData.worldbooks (磁盘 JSON)
 *     → getAllEnabledEntries() 双开关筛选
 *     → filterEntriesByPhase() 阶段过滤 ([GENERATE:*]/[RENDER:*])
 *     → GetPrompt 三模式分流 (constant/regex/dynamic)
 *       · constant → 直接 activated[]
 *       · regex → GetActivedWorldInfoEntries() (ST 引擎，递归激活)
 *       · dynamic → loadTablesForDynamic() + checkDynamicEntry() (记忆表格检查)
 *     → 按 position 分三通道:
 *       · pos=0/1 (before/after) → worldbook_char_injections[]
 *       · pos=4 (atDepth) → worldbook_injections[] (@depth 注入)
 *       · 其他 → text[] (AN/EM 等框架原生位置)
 *     → TweakPrompt 消费注入到 prompt_struct
 *
 * 影响：写 configData → nicerWriteFileSync(CONFIG_FILE) 持久化;
 *       写 arg.extension.worldbook_memory (正则引擎 sticky/cooldown 状态)
 *
 * 相交：← getPromptHandler (调 GetPrompt, 返回值进 prompt_struct.plugin_prompts)
 *       ← beilu-preset TweakPrompt Round 1/2 (司令员模式下消费 extension.worldbook_*_injections)
 *       → GetActivedWorldInfoEntries (ST 正则引擎, ImportHandlers/SillyTavern/engine/world_info.mjs)
 *       → beilu-memory/lib/storage.mjs (动态模式读表格: getActiveMode/getModeCtxDir/getTablesFileName)
 *       (SEC-T8 wrapUntrusted 已移除，世界书直接注入原始内容)
 *
 * 关键约束：
 *   · 绑定世界书导入时 enabled 必须为 false — 否则经 globalEnabled 开关泄漏进所有角色
 *     (见 getAllEnabledEntries 双开关机制; boundMatch 独立生效无需 enabled=true)
 *   · depth 语义双轨制 — 非司令员模式 splice 精确到 N 条; 司令员模式退化为 >=1/=0 二值
 *   · 世界书是自包含闭环 — getPromptHandler.mjs 零命中 worldbook 关键词
 */
import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// [yonban T3d 迁移] 实现体从 plugins/beilu-worldbook/main.mjs 迁入 functions/prompt/worldbook/main.mjs（5 级到 src）。
//   纯搬家零逻辑改动。server/scripts 目标在 src/ 下 → 5 级 ../../../../../；plugins/ImportHandlers/shells 在
//   src/public/parts/ 下 → 5 级 + public/parts/...；config_data.json（282KB 用户世界书数据）留旧位，__pluginDir 锚回旧位。
import { createDiag } from "../../../../../server/diagLogger.mjs";
import { nicerWriteFileSync } from "../../../../../scripts/nicerWriteFile.mjs";
// SEC-T8 已移除：安全包裹与内部位置/深度系统不兼容（token膨胀+语义破坏），世界书条目直接注入原始内容
import { authenticate } from "../../security/auth.mjs";

const diag = createDiag("worldbook");

// ST 枚举常量（内联，消除对 beilu 内部 charData.mjs 的依赖）
const extension_prompt_roles = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };
const world_info_position = {
  before: 0,
  after: 1,
  ANTop: 2,
  ANBottom: 3,
  atDepth: 4,
  EMTop: 5,
  EMBottom: 6,
};

// 世界书条目 order 缺省（ST 通用约定 100）。createBlankEntry / convertSTEntry / GetData 脏数据补齐三处共用单源，
// 避免多处字面量 100 漂移。T6-C10：GetData 回包对旧脏数据（缺 order 字段的历史/手改盘 entry）补齐后，前端可删 ??100 副本。
const WORLDBOOK_DEFAULT_ORDER = 100;

// ============================================================
// GetAllEntriesByChar 首次通知集（只通知一次，不每次 GetPrompt 都刷屏）
// ============================================================
const _notifiedGetAllEntries = new Set();

// ============================================================
// 世界书动态注入标记处理（Phase 2E）
// ============================================================

/** 匹配 [GENERATE:identifier] 标记 */
const GENERATE_TAG_RE = /\[GENERATE:([^\]]+)\]/gi;

/** 匹配 [RENDER:identifier] 标记 */
const RENDER_TAG_RE = /\[RENDER:([^\]]+)\]/gi;

/**
 * 从内容中移除所有阶段标记
 * @param {string} content
 * @returns {string}
 */
function stripPhaseTags(content) {
  if (!content) return content;
  return content.replace(GENERATE_TAG_RE, "").replace(RENDER_TAG_RE, "").trim();
}

/**
 * 根据当前阶段过滤世界书条目
 *
 * 条目的 key 或 content 中包含 [GENERATE:*] 的仅在 generate 阶段注入。
 * 包含 [RENDER:*] 的仅在 render 阶段注入。
 * 不含任何标记的条目在 generate/all 阶段注入；render 阶段为 [RENDER:*] 专属——
 * 不含标记的条目不渲染（否则普通世界书条目会漏进可见对话）。
 *
 * @param {Array<object>} entries - 世界书条目列表
 * @param {string} phase - 'generate' | 'render' | 'all'
 * @returns {Array<object>}
 */
function filterEntriesByPhase(entries, phase = "all") {
  if (!entries || !Array.isArray(entries) || phase === "all")
    return entries || [];

  const result = [];
  let filtered = 0;

  for (const entry of entries) {
    const keyStr = Array.isArray(entry.key)
      ? entry.key.join(" ")
      : entry.key || "";
    const content = entry.content || "";
    const combined = keyStr + " " + content;

    GENERATE_TAG_RE.lastIndex = 0;
    const hasGenerateTag = GENERATE_TAG_RE.test(combined);

    RENDER_TAG_RE.lastIndex = 0;
    const hasRenderTag = RENDER_TAG_RE.test(combined);

    if (!hasGenerateTag && !hasRenderTag) {
      // 无标记条目：generate/all 注入隐藏 prompt；render 阶段专属 [RENDER:*]，无标记不渲染（防漏进可见对话）
      if (phase !== "render") result.push(entry);
      else filtered++;
      continue;
    }

    if (phase === "generate" && hasGenerateTag) {
      result.push({ ...entry, content: stripPhaseTags(content) });
    } else if (phase === "render" && hasRenderTag) {
      result.push({ ...entry, content: stripPhaseTags(content) });
    } else {
      filtered++;
    }
  }

  if (filtered > 0) {
    console.log(
      `[beilu-worldbook] 世界书过滤: ${entries.length} 条目, ${phase} 阶段, 过滤 ${filtered} 条`,
    );
  }

  return result;
}

// 注意: GetActivedWorldInfoEntries 仍依赖 beilu 内部模块
// 路径: 从 plugins/beilu-worldbook/ 退两级到 parts/，再进入 ImportHandlers/
// 如果 beilu 更新重构了 ImportHandlers 路径，需要同步调整
// stCompat 不可动（ST engine world_info）——只改 import 路径不动其逻辑；新位 5 级 + public/parts/ImportHandlers。
import { GetActivedWorldInfoEntries } from "../../../../../public/parts/ImportHandlers/SillyTavern/engine/world_info.mjs";
// info.json 留旧位（part 元数据）→ 指回旧位。
import info from "../../../../../public/parts/plugins/beilu-worldbook/info.json" with { type: "json" };
// F4-2/④读侧补全: 复用 beilu-memory 的 mode/路径单一权威(不在 worldbook 复制第二份 per-chatId 逻辑)
import { resolveGenerationMode, getModeCtxDir, getTablesFileName, getUserDataDir } from "../../memory/storage_mod/storage.mjs"; // T8·回切：改组内引用（T3a 暂指旧位壳的欠账，T3e memory 已入住）；resolveGenerationMode=0715 生成链 mode 单源收口（原 getActiveMode 不看 platform）
// [T074 per-user 隔离] getUserDataDir：世界书数据 per-user 目录权威（对齐 preset/yonban_config 同款范式）。
import { wbT, wbD } from "../../../../../server/wbStub.mjs";
// [0716 W1 刷新机制] 变更广播出口（与 preset/regex 静态 import dispatch 同范式，dispatcher 不依赖具体插件无环）
import { dispatch } from "../../../dispatch/dispatcher.mjs";

// ============================================================
// 持久化
// ============================================================

// [yonban T3d 路径锚] __pluginDir 曾是全局世界书数据根（旧 CONFIG_FILE=config_data.json 282KB 单文件全用户共享）。
//   __projectRoot 仍从此锚上 5 级解析到仓库根（loadTablesForDynamic 的 data/users 拼接依赖它）。
const __pluginDir = fileURLToPath(new URL("../../../../../public/parts/plugins/beilu-worldbook", import.meta.url));
// 项目根目录（从 plugins/beilu-worldbook/ 向上5级到项目根）
const __projectRoot = join(__pluginDir, "..", "..", "..", "..", "..");

// [T074 per-user 隔离] 根因层：旧全局单文件 config_data.json（无用户维度）→ 新用户 002 看到 001 全部私有世界书。
//   目标态对齐 ST 「每用户一 worlds/ 目录」隔离原则 + beilu getUserDataDir 权威范式：
//     磁盘 = data/users/<user>/worldbooks/config_data.json（每用户独立单文件；沿用现引擎"整对象读入内存"模式，
//            不抄 ST"每书一文件"物理拆分——那要重写全部读写点，侵入极大；隔离目标由"每用户一目录"已达成）。
//   defaults：worldbook 域无 builtin/官方世界书（beilu-worldbook 目录无 defaults/，default/templates 无 worldbook）
//     → 新用户默认=空世界书列表，不播种。
function configFileFor(username) {
  return join(getUserDataDir(username), "worldbooks", "config_data.json");
}

// [T074] 内存单例 → per-user Map。旧 `let configData` 全用户共享一个对象是内存态串台根因。
//   getStore(username) 惰性加载：磁盘有 → 载入并跑旧格式迁移；磁盘无 → 空 store（新用户空列表）。
const perUserStore = new Map(); // Map<username, {active_worldbook, worldbooks}>

function saveConfigToDisk(username) {
  const user = username || "_default";
  const file = configFileFor(user);
  const store = perUserStore.get(user) || { active_worldbook: "", worldbooks: {} };
  try {
    fs.mkdirSync(dirname(file), { recursive: true });
    // 原子写(tmp+rename+D-09重试)，避免裸 writeFileSync 写盘中途崩留半截 config 致下次加载失败
    nicerWriteFileSync(file, JSON.stringify(store, null, 2));
    // [0716 W1 刷新机制] 写盘=世界书变更唯一事实点（全部 SetData 写路收口于此，读写同源）
    //   → 单点广播 worldbook_changed（regex_rules_changed/preset_list_changed 同范式，跨窗口刷新）。
    //   fire-and-forget；迁移回写也广播=幂等无害。
    try {
      dispatch({
        target: "bus:broadcast", verb: "emitAll", source: "yonban",
        payload: { username: user !== "_default" ? user : undefined, event: { type: "worldbook_changed", payload: {} } },
      }).then((_r) => { if (_r && !_r.ok) console.warn("[beilu-worldbook] worldbook_changed 广播失败:", _r?.error?.msg); }).catch(() => {});
    } catch { /* 广播不可用不影响写盘 */ }
    return true;
  } catch (e) {
    console.warn(`[beilu-worldbook] 保存配置到磁盘失败(user=${user}):`, e.message);
    return false;
  }
}

function loadConfigFromDisk(username) {
  const file = configFileFor(username || "_default");
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    }
  } catch (e) {
    console.warn(`[beilu-worldbook] 从磁盘读取配置失败(user=${username}):`, e.message);
  }
  return null;
}

// [T074] per-user store 惰性获取 + 首载磁盘迁移。所有 configData 消费点改为 getStore(username)。
//   why 惰性：worldbook 请求按用户到达，首次访问该用户时才从其目录加载（新用户磁盘无文件=空 store）。
function getStore(username) {
  const user = username || "_default";
  let store = perUserStore.get(user);
  if (store) return store;
  store = { active_worldbook: "", worldbooks: {} };
  const saved = loadConfigFromDisk(user);
  if (saved?.worldbooks) {
    store.active_worldbook = saved.active_worldbook || "";
    store.worldbooks = saved.worldbooks || {};
    migrateStoreEntries(store, user); // 旧格式迁移（原 Load 内联逻辑，抽为 per-user 函数）
  }
  perUserStore.set(user, store);
  return store;
}

// ============================================================
// 插件状态
// ============================================================

/**
 * 配置数据结构（多世界书）—— [T074] 每 user 一份，存于 perUserStore.get(username)。
 * @type {{
 *   active_worldbook: string,
 *   worldbooks: Object<string, {
 *     entries: Object<string, WorldInfoEntry>
 *   }>
 * }}
 */

/**
 * [T074] per-user store 首载磁盘后的旧格式迁移（原 Load 内联逻辑抽出，按 user store 就地迁移）。
 *   迁移项：enabled/boundCharName 补全 + ST→beilu entries 格式 + activationMode/dynamicConfig 补全。
 *   迁移后若有变更即回写该 user 磁盘。
 * @param {{active_worldbook:string, worldbooks:object}} store
 * @param {string} username
 */
function migrateStoreEntries(store, username) {
  let migrated = false;
  for (const [name, wb] of Object.entries(store.worldbooks)) {
    if (wb.enabled === undefined) wb.enabled = !wb.boundCharName; // 绑定书默认私有(false,靠boundMatch注入)，无绑定全局书默认true(保留legacy)
    if (wb.boundCharName === undefined) wb.boundCharName = "";
    if (!wb.entries) continue;
    const entriesValues = Array.isArray(wb.entries) ? wb.entries : Object.values(wb.entries);
    const needsMigration =
      Array.isArray(wb.entries) ||
      (entriesValues.length > 0 && entriesValues[0].uid === undefined && entriesValues[0].id !== undefined);
    if (needsMigration) {
      diag.log(`迁移世界书 "${name}" 的条目格式 (ST → beilu)...`);
      wb.entries = convertSTEntries(wb.entries);
      migrated = true;
    }
    if (wb.entries) {
      for (const entry of Object.values(wb.entries)) {
        if (!entry.activationMode) {
          entry.activationMode = entry.constant ? "constant" : "regex";
          migrated = true;
        }
        if (!entry.dynamicConfig) {
          entry.dynamicConfig = { columnName: "", matchType: "range", rangeMin: 0, rangeMax: 0, exactValue: "" };
          migrated = true;
        }
      }
    }
  }
  if (migrated) {
    perUserStore.set(username, store); // 确保 saveConfigToDisk 能取到
    saveConfigToDisk(username);
    console.log(`[beilu-worldbook] 旧格式数据迁移完成，已保存 (user=${username})`);
  }
}

/**
 * 创建一个空的 WorldInfoEntry
 * @param {number} uid
 * @returns {object}
 */
function createBlankEntry(uid) {
  return {
    uid,
    key: [],
    keysecondary: [],
    comment: "",
    content: "",
    constant: false,
    vectorized: false,
    useRegex: false,
    selective: true,
    selectiveLogic: 0,
    addMemo: true,
    order: WORLDBOOK_DEFAULT_ORDER,
    position: 0,
    disable: false,
    ignoreBudget: false,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: false,
    probability: 100,
    useProbability: true,
    depth: 4,
    group: "",
    groupOverride: false,
    groupWeight: 100,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: "",
    role: null,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    triggers: [],
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    displayIndex: uid,
    outletName: "",
    characterFilter: { isExclude: false, names: [], tags: [] },
    activationMode: "regex",
    dynamicConfig: {
      columnName: "",
      matchType: "range",
      rangeMin: 0,
      rangeMax: 0,
      exactValue: "",
    },
  };
}

/**
 * 将 ST 世界书原始格式的条目转换为 beilu 内部格式
 * ST 格式使用 id/keys/secondary_keys/enabled/extensions.* 等字段
 * beilu 内部格式使用 uid/key/keysecondary/disable/顶层字段 等
 * @param {object} raw - ST 格式的原始条目
 * @param {number} fallbackUid - 当无法从原始数据获取 uid 时的备用值
 * @returns {object} beilu 内部格式的条目
 */
function convertSTEntry(raw, fallbackUid = 0) {
  const uid = raw.uid ?? raw.id ?? fallbackUid;
  const ext = raw.extensions || {};
  return {
    ...createBlankEntry(uid),
    uid,
    comment: raw.comment || "",
    content: raw.content || "",
    key: raw.key || raw.keys || [],
    keysecondary: raw.keysecondary || raw.secondary_keys || [],
    constant: !!raw.constant,
    useRegex: raw.useRegex ?? raw.use_regex ?? false,
    selective: raw.selective !== false,
    order: raw.order ?? raw.insertion_order ?? WORLDBOOK_DEFAULT_ORDER,
    disable: raw.disable ?? raw.enabled === false,
    position:
      typeof raw.position === "number" ? raw.position : (ext.position ?? 0),
    depth: raw.depth ?? ext.depth ?? 4,
    role: raw.role ?? ext.role ?? null,
    selectiveLogic: raw.selectiveLogic ?? ext.selectiveLogic ?? 0,
    excludeRecursion: raw.excludeRecursion ?? ext.exclude_recursion ?? false,
    preventRecursion: raw.preventRecursion ?? ext.prevent_recursion ?? false,
    delayUntilRecursion:
      raw.delayUntilRecursion ?? ext.delay_until_recursion ?? false,
    displayIndex: raw.displayIndex ?? ext.display_index ?? uid,
    probability: raw.probability ?? ext.probability ?? 100,
    useProbability: raw.useProbability ?? ext.useProbability ?? true,
    group: raw.group ?? ext.group ?? "",
    groupOverride: raw.groupOverride ?? ext.group_override ?? false,
    groupWeight: raw.groupWeight ?? ext.group_weight ?? 100,
    scanDepth: raw.scanDepth ?? ext.scan_depth ?? null,
    caseSensitive: raw.caseSensitive ?? ext.case_sensitive ?? null,
    matchWholeWords: raw.matchWholeWords ?? ext.match_whole_words ?? null,
    useGroupScoring: raw.useGroupScoring ?? ext.use_group_scoring ?? null,
    automationId: raw.automationId ?? ext.automation_id ?? "",
    sticky: raw.sticky ?? ext.sticky ?? 0,
    cooldown: raw.cooldown ?? ext.cooldown ?? 0,
    delay: raw.delay ?? ext.delay ?? 0,
    // ST 高级字段无损保留(此前漏映射 → 被 createBlankEntry 默认值覆盖):
    vectorized: raw.vectorized ?? ext.vectorized ?? false,
    triggers: raw.triggers ?? ext.triggers ?? [],
    ignoreBudget: raw.ignoreBudget ?? ext.ignore_budget ?? false,
    outletName: raw.outletName ?? ext.outlet_name ?? "",
    // 选择性匹配范围 match_*(ST entry.extensions)：无损透传，供导出回 ST 还原
    matchPersonaDescription: raw.matchPersonaDescription ?? ext.match_persona_description ?? false,
    matchCharacterDescription: raw.matchCharacterDescription ?? ext.match_character_description ?? false,
    matchCharacterPersonality: raw.matchCharacterPersonality ?? ext.match_character_personality ?? false,
    matchCharacterDepthPrompt: raw.matchCharacterDepthPrompt ?? ext.match_character_depth_prompt ?? false,
    matchScenario: raw.matchScenario ?? ext.match_scenario ?? false,
    matchCreatorNotes: raw.matchCreatorNotes ?? ext.match_creator_notes ?? false,
    // 激活模式：保留已有值，或根据 constant 推断
    activationMode: raw.activationMode || (raw.constant ? "constant" : "regex"),
    dynamicConfig: raw.dynamicConfig || {
      columnName: "",
      matchType: "range",
      rangeMin: 0,
      rangeMax: 0,
      exactValue: "",
    },
  };
}

/**
 * 将 entries（数组或对象）统一转换为 beilu 内部格式的对象
 * @param {Array|object} rawEntries - ST 格式的 entries（数组或对象形式）
 * @returns {object} uid 为 key 的内部格式对象
 */
function convertSTEntries(rawEntries) {
  const rawList = Array.isArray(rawEntries)
    ? rawEntries
    : Object.values(rawEntries);
  const converted = {};
  for (let i = 0; i < rawList.length; i++) {
    const entry = convertSTEntry(rawList[i], i);
    converted[String(entry.uid)] = entry;
  }
  return converted;
}

/**
 * 将 beilu 内部格式条目转回 ST character_book/lorebook 条目（convertSTEntry 的逆，字段无损回 ST extensions）
 * @param {object} e - beilu 内部格式条目
 * @returns {object} ST 格式条目
 */
function convertToSTEntry(e) {
  return {
    id: e.uid,
    keys: e.key || [],
    secondary_keys: e.keysecondary || [],
    comment: e.comment || "",
    content: e.content || "",
    constant: !!e.constant,
    selective: e.selective !== false,
    insertion_order: e.order ?? 100,
    enabled: !e.disable,
    position: (e.position ?? 0) === 0 ? "before_char" : "after_char",
    use_regex: e.useRegex ?? false,
    extensions: {
      position: e.position ?? 0,
      exclude_recursion: !!e.excludeRecursion,
      display_index: e.displayIndex ?? e.uid,
      probability: e.probability ?? 100,
      useProbability: e.useProbability !== false,
      depth: e.depth ?? 4,
      selectiveLogic: e.selectiveLogic ?? 0,
      group: e.group ?? "",
      group_override: !!e.groupOverride,
      group_weight: e.groupWeight ?? 100,
      prevent_recursion: !!e.preventRecursion,
      delay_until_recursion: e.delayUntilRecursion ?? false,
      scan_depth: e.scanDepth ?? null,
      match_whole_words: e.matchWholeWords ?? null,
      use_group_scoring: e.useGroupScoring ?? null,
      case_sensitive: e.caseSensitive ?? null,
      automation_id: e.automationId ?? "",
      role: e.role ?? null,
      vectorized: !!e.vectorized,
      sticky: e.sticky ?? 0,
      cooldown: e.cooldown ?? 0,
      delay: e.delay ?? 0,
      outlet_name: e.outletName ?? "",
      match_persona_description: !!e.matchPersonaDescription,
      match_character_description: !!e.matchCharacterDescription,
      match_character_personality: !!e.matchCharacterPersonality,
      match_character_depth_prompt: !!e.matchCharacterDepthPrompt,
      match_scenario: !!e.matchScenario,
      match_creator_notes: !!e.matchCreatorNotes,
      triggers: e.triggers ?? [],
      ignore_budget: !!e.ignoreBudget,
    },
  };
}

/**
 * 将 beilu 内部 entries(对象/数组) 转回 ST lorebook entries 数组(按 displayIndex 排序)
 * @param {Array|object} beiluEntries
 * @returns {object[]}
 */
function convertToSTEntries(beiluEntries) {
  const list = Array.isArray(beiluEntries)
    ? beiluEntries
    : Object.values(beiluEntries || {});
  return list
    .slice()
    .sort((a, b) => (a.displayIndex ?? 0) - (b.displayIndex ?? 0))
    .map(convertToSTEntry);
}

/**
 * 获取当前激活世界书的 entries 对象（用于 UI 编辑）
 * [T074] store 参数化：从指定 user 的 store 取激活世界书条目。
 * @param {{active_worldbook:string, worldbooks:object}} store
 * @returns {object|null}
 */
function getActiveEntries(store) {
  const wb = store.worldbooks[store.active_worldbook];
  return wb?.entries || null;
}

/**
 * 获取当前激活世界书的 entries 数组（用于 UI 编辑）
 * @param {{active_worldbook:string, worldbooks:object}} store
 * @returns {Array}
 */
function getActiveEntriesArray(store) {
  const entries = getActiveEntries(store);
  if (!entries) return [];
  return Object.values(entries).sort(
    (a, b) => (a.displayIndex ?? 0) - (b.displayIndex ?? 0),
  );
}

/**
 * 获取所有启用的世界书的条目（用于 GetPrompt）
 *
 * ★ 双开关机制：
 * 开关1 — 额外世界书（enabled）：全局互通，所有角色共用
 *   - enabled=true 的世界书对所有角色生效
 * 开关2 — 角色卡绑定（boundCharName）：独立生效
 *   - boundCharName 匹配当前角色时，该世界书对当前角色生效（无论 enabled 状态）
 * 去重：同一个世界书在两个开关都命中时，只注入一次
 *
 * @param {{active_worldbook:string, worldbooks:object}} store - [T074] 该 user 的世界书 store
 * @param {string} [currentCharId=''] - 当前角色 ID（part 目录名，如 "001"）
 * @param {string} [currentCharName=''] - 当前角色显示名（如 "魔法少女小圆-予你之歌"）
 * @returns {Array} 所有启用世界书中的非禁用条目
 */
function getAllEnabledEntries(store, currentCharId = "", currentCharName = "") {
  const allEntries = [];
  const injectedBooks = new Set(); // 去重：记录已注入的世界书名

  for (const [name, wb] of Object.entries(store.worldbooks)) {
    if (!wb.entries) continue;

    // 开关1：额外世界书 enabled=true → 全局生效（所有角色都注入）
    const globalEnabled = wb.enabled === true;

    // 开关2：角色卡绑定 → 只对绑定的角色生效（无论 enabled 状态）
    let boundMatch = false;
    if (wb.boundCharName && (currentCharId || currentCharName)) {
      boundMatch =
        wb.boundCharName === currentCharId ||
        wb.boundCharName === currentCharName;
    }

    // 至少命中一个开关才注入
    if (!globalEnabled && !boundMatch) continue;

    // 去重：同一世界书只注入一次
    if (injectedBooks.has(name)) continue;
    injectedBooks.add(name);

    for (const entry of Object.values(wb.entries)) {
      if (!entry.disable) allEntries.push(entry);
    }
  }
  return allEntries;
}

/**
 * 计算下一个可用的 uid
 * @param {object} entries
 * @returns {number}
 */
function getNextUid(entries) {
  if (!entries || Object.keys(entries).length === 0) return 0;
  const maxUid = Math.max(...Object.values(entries).map((e) => e.uid || 0));
  return maxUid + 1;
}

/**
 * 根病5：模式字段归一（activationMode 权威 ↔ constant 派生跟随）。
 * 所有写入口（update_entry/add_entry/convertSTEntry）写完后调一次，保证两字段永远一致。
 * 规则：activationMode 为准；constant = (activationMode === "constant")；
 *   旧 UI 只发 constant 时：仅当原 activationMode 不存在或为 constant/regex 才据 constant 推断，
 *   dynamic 受保护不被覆盖（回归点 §1.5.1）。
 */
function normalizeEntryMode(entry, propsWritten) {
  if (!entry) return;
  if (propsWritten?.activationMode !== undefined) {
    entry.constant = (entry.activationMode === "constant");
  } else if (propsWritten?.constant !== undefined && !propsWritten?.activationMode) {
    if (!entry.activationMode || entry.activationMode === "constant" || entry.activationMode === "regex") {
      entry.activationMode = entry.constant ? "constant" : "regex";
    }
  }
  if (entry.activationMode && entry.constant !== (entry.activationMode === "constant")) {
    entry.constant = (entry.activationMode === "constant");
  }
}

// ============================================================
// 动态提示词：读取记忆表格数据
// ============================================================

/**
 * 加载指定角色的记忆表格数据（供 dynamic 模式条目检查）。
 *
 * 链路：GetPrompt 动态分支 → 本函数 → checkDynamicEntry()
 *       路径解析全走 beilu-memory 单一权威（resolveGenerationMode/getModeCtxDir/getTablesFileName），
 *       不在 worldbook 复制第二份 per-chatId 路径逻辑。
 *
 * @param {string} username - 用户名
 * @param {string} charName - 角色 ID（part 目录名，非显示名）
 * @param {string} chatId - 会话 ID（per-chatId 模式下定位 work_ctx/<chatId> 目录）
 * @param {object} [arg] - 生成请求（0715 mode 单源收口：生成链两调用点传入，bot 壳请求按
 *   platform 判 bot 不随 web 漂移；显示链 update_entry 无请求对象不传=纯 config 链，行为同旧）
 * @returns {Array|null} 表格数组，失败/不存在返回 null
 */
function loadTablesForDynamic(username, charName, chatId, arg = null) {
  if (!charName) return null;
  const user = username || "_default";
  const memDir = join(
    __projectRoot,
    "data",
    "users",
    user,
    "chars",
    charName,
    "memory",
  );
  // F4-2/④读侧补全: per-chatId 模式 + work_ctx/<chatId> 路径，全走 beilu-memory 单一权威。
  //   (旧版读全局 active_mode + root 表，④ 把 work/code 表移 <mode>_ctx/<chatId> 后会读旧/空)
  const activeMode = resolveGenerationMode(arg, user, charName, chatId);
  const tablesFile = getTablesFileName(activeMode);
  const tablesPath = join(getModeCtxDir(memDir, activeMode, chatId), tablesFile);
  try {
    if (!fs.existsSync(tablesPath)) {
      diag.debug(`动态模式: ${tablesFile} 不存在:`, tablesPath);
      return null;
    }
    const raw = JSON.parse(fs.readFileSync(tablesPath, "utf-8"));
    return raw?.tables || null;
  } catch (e) {
    diag.warn(`动态模式: 读取 ${tablesFile} 失败:`, e.message);
    return null;
  }
}

/**
 * 检查动态条目是否应该激活
 * @param {object} entry - 世界书条目（含 dynamicConfig）
 * @param {Array} tables - 记忆表格数组
 * @returns {boolean}
 */
function checkDynamicEntry(entry, tables) {
  const config = entry.dynamicConfig;
  if (!config?.columnName) return false;
  let colFound = false;
  for (const table of tables) {
    if (table.enabled === false) continue;
    const colIndex = (table.columns || []).indexOf(config.columnName);
    if (colIndex === -1) continue;
    colFound = true;
    for (const row of table.rows || []) {
      const cellValue = row[colIndex];
      if (cellValue == null || cellValue === "") continue;
      if (config.matchType === "exact") {
        if (String(cellValue).trim() === String(config.exactValue).trim())
          return true;
      } else {
        const numVal = parseFloat(cellValue);
        if (
          !isNaN(numVal) &&
          numVal >= config.rangeMin &&
          numVal <= config.rangeMax
        )
          return true;
      }
    }
  }
  if (!colFound && tables.length > 0) {
    console.warn(`[beilu-worldbook] dynamic条目"${entry.comment || entry.uid}"引用列"${config.columnName}"在所有启用表格中不存在（可能列名已改）`);
  }
  return false;
}

// ============================================================
// beilu-worldbook 插件
// ============================================================

const pluginExport = {
  info,

  Load: async ({ router }) => {
    console.log("[beilu-worldbook] 插件加载中...");

    // [T074 per-user] Load 时不再预载全局单例（旧行为：一次性 loadConfigFromDisk 到共享 configData）。
    //   数据改为按用户惰性加载：每个请求经 getStore(username) 首次访问该用户时，从其
    //   data/users/<user>/worldbooks/config_data.json 载入 + 旧格式迁移（见 getStore/migrateStoreEntries）。
    //   新用户磁盘无文件 → 空 store（空世界书列表）。这样 Load 阶段不知道用户身份也不会串台。
    try {
      console.log("[beilu-worldbook] 插件就绪（per-user 惰性加载，Load 阶段不预载全局数据）");
    } catch (e) {
      console.warn("[beilu-worldbook] 加载配置失败:", e.message);
    }

    // ---- 注册 HTTP API 端点 ----
    // [T074] 加 authenticate + 透传 req.user.username → GetData 按用户隔离（次要消费方，主链路走 verb wbGetData）。
    router.get(
      "/api/parts/plugins\\:beilu-worldbook/config/getdata",
      authenticate,
      async (req, res) => {
        try {
          const _user = req.user?.username || req.query.username || "_default";
          const data = await pluginExport.interfaces.config.GetData({ username: _user });
          res.json(data);
        } catch (err) {
          console.error("[beilu-worldbook] GetData error:", err);
          res.status(500).json({ error: err.message });
        }
      },
    );

    // ---- Lorebook API 端点（供前端 stCompat 世界书 polyfill 使用） ----
    // 支持两种查询方式：
    //   ?book=世界书名称  — 按名称查找
    //   ?charName=角色名  — 按角色绑定查找（优先，更可靠）
    router.get(
      "/api/parts/plugins\\:beilu-worldbook/lorebook/entries",
      authenticate,
      async (req, res) => {
        try {
          const bookName = req.query.book;
          const charName = req.query.charName;
          // [T074] 按用户取 store（req.user 由 authenticate 注入；query.username 兜底供 stCompat）。
          const _user = req.user?.username || req.query.username || "_default";
          const _store = getStore(_user);

          let wb = null;
          let resolvedName = "";

          // 策略1：通过角色名查绑定的世界书（最可靠）
          if (charName) {
            for (const [name, candidate] of Object.entries(
              _store.worldbooks,
            )) {
              if (candidate.boundCharName === charName) {
                wb = candidate;
                resolvedName = name;
                console.log(
                  `[beilu-worldbook] lorebook/entries: 通过角色 "${charName}" 找到绑定世界书 "${name}"`,
                );
                break;
              }
            }
          }

          // 策略2：精确名称匹配
          if (!wb && bookName) {
            wb = _store.worldbooks[bookName];
            if (wb) resolvedName = bookName;
          }

          // 策略3：模糊名称匹配（角色卡中的 world 名称可能与导入的世界书名不同）
          if (!wb && bookName) {
            const allNames = Object.keys(_store.worldbooks);
            const fuzzyMatch = allNames.find(
              (name) =>
                name.includes(bookName) ||
                bookName.includes(name) ||
                name
                  .replace(/[\s世界书]/g, "")
                  .includes(bookName.replace(/[\d.]/g, "")) ||
                bookName
                  .replace(/[\d.]/g, "")
                  .includes(name.replace(/[\s世界书]/g, "")),
            );
            if (fuzzyMatch) {
              console.log(
                `[beilu-worldbook] lorebook/entries: 模糊匹配 "${bookName}" → "${fuzzyMatch}"`,
              );
              wb = _store.worldbooks[fuzzyMatch];
              resolvedName = fuzzyMatch;
            }
          }

          if (!wb) {
            const queryDesc = charName
              ? `角色="${charName}"`
              : `名称="${bookName}"`;
            console.warn(
              `[beilu-worldbook] lorebook/entries: 未找到世界书 (${queryDesc})，可用: [${Object.keys(_store.worldbooks).join(", ")}]`,
            );
            return res.json({ entries: [], resolvedName: "" });
          }

          // 返回所有条目（含禁用条目），MVU 需要读取 [initvar] 条目（通常是禁用的）
          const entries = wb.entries ? Object.values(wb.entries) : [];
          // 按 displayIndex 排序
          entries.sort((a, b) => (a.displayIndex ?? 0) - (b.displayIndex ?? 0));
          console.log(
            `[beilu-worldbook] lorebook/entries: "${resolvedName}" → ${entries.length} 条目`,
          );
          res.json({ entries, resolvedName });
        } catch (err) {
          console.error("[beilu-worldbook] lorebook/entries error:", err);
          res.status(500).json({ error: err.message });
        }
      },
    );

    router.get(
      "/api/parts/plugins\\:beilu-worldbook/lorebook/char-books",
      authenticate,
      async (req, res) => {
        try {
          const charName = req.query.charName;
          // [T074] 按用户取 store。
          const _user = req.user?.username || req.query.username || "_default";
          const _store = getStore(_user);
          const result = { primary: "", books: [] };
          if (charName) {
            for (const [name, wb] of Object.entries(_store.worldbooks)) {
              if (wb.boundCharName === charName) {
                result.books.push(name);
                if (!result.primary) result.primary = name;
              }
            }
          }
          res.json(result);
        } catch (err) {
          console.error("[beilu-worldbook] lorebook/char-books error:", err);
          res.status(500).json({ error: err.message });
        }
      },
    );

    router.post(
      "/api/parts/plugins\\:beilu-worldbook/config/setdata",
      authenticate,
      async (req, res) => {
        try {
          const result = await pluginExport.interfaces.config.SetData(req.body, { username: req.user?.username, query: req.query });
          res.json(result ?? { success: true });
        } catch (err) {
          console.error("[beilu-worldbook] SetData error:", err);
          res.status(500).json({ error: err.message });
        }
      },
    );
  },

  Unload: async () => {
    console.log("[beilu-worldbook] 插件卸载");
  },

  interfaces: {
    config: {
      /**
       * 获取角色绑定世界书的所有条目（含 disabled）
       *
       * 专为 beilu-mvu 的 initFromWorldBook 设计：
       * MVU 需要读取 [initvar] 条目来获取初始变量，
       * 而 [initvar] 条目通常是 disabled 状态（不给 AI 看，只给 MVU 系统读取）。
       *
       * @param {string} charName - 角色名（用于查找绑定的世界书）
       * @param {string} [username] - [T074] 用户名（per-user store 选择；缺省 _default）
       * @returns {Array} 所有条目（含 disabled），找不到则返回空数组
       */
      GetAllEntriesByChar: (charName, username) => {
        if (!charName) return [];
        const _store = getStore(username);
        for (const [name, wb] of Object.entries(_store.worldbooks)) {
          if (wb.boundCharName === charName && wb.entries) {
            const entries = Object.values(wb.entries);
            // 只在首次通知，不每次 GetPrompt 都刷屏
            const key = `found:${charName}`;
            if (!_notifiedGetAllEntries.has(key)) {
              _notifiedGetAllEntries.add(key);
              console.log(
                `[beilu-worldbook] GetAllEntriesByChar("${charName}"): 找到世界书 "${name}", ${entries.length} 条目(含disabled)`,
              );
            }
            return entries;
          }
        }
        // 未找到也只通知一次
        const key = `miss:${charName}`;
        if (!_notifiedGetAllEntries.has(key)) {
          _notifiedGetAllEntries.add(key);
          console.log(
            `[beilu-worldbook] GetAllEntriesByChar("${charName}"): 未找到绑定世界书`,
          );
        }
        return [];
      },

      /**
       * 获取插件配置数据
       * [T074] 洞①修复：原签名 `()` 无 user 维度 → 读全局单例 → 新用户看到别人全部世界书。
       *   现接 ctx.username（verb 层 wbGetData 透传 context.user）→ getStore(user) 按用户隔离。
       * @param {{username?:string}} [ctx]
       */
      GetData: async (ctx) => {
        const store = getStore(ctx?.username);
        const rawEntries = getActiveEntriesArray(store);
        // T6-C10: 对旧脏数据（历史遗留/手改盘导致缺 order 字段的 entry）在回包处补齐 order，
        // 使前端可删 ??100 副本。仅生成回包副本，不改 store 内对象引用，不写盘（GetData 是读路）。
        const entries = rawEntries.map((e) =>
          e && e.order == null ? { ...e, order: WORLDBOOK_DEFAULT_ORDER } : e,
        );
        // 构建世界书列表（含 enabled/boundCharName 信息）
        const worldbook_details = {};
        for (const [name, wb] of Object.entries(store.worldbooks)) {
          worldbook_details[name] = {
            enabled: wb.enabled === true,
            boundCharName: wb.boundCharName || "",
            entry_count: wb.entries ? Object.keys(wb.entries).length : 0,
          };
        }
        return {
          active_worldbook: store.active_worldbook,
          worldbook_list: Object.keys(store.worldbooks),
          worldbook_details,
          entry_count: entries.length,
          entries: entries,
        };
      },

      /**
       * 设置插件配置
       *
       * 支持的操作：
       * - import_worldbook: 导入 ST 世界书 JSON
       * - switch_worldbook: 切换激活世界书
       * - delete_worldbook: 删除指定世界书
       * - rename_worldbook: 重命名世界书
       * - create_worldbook: 新建空白世界书
       * - toggle_entry: 切换条目启用/禁用
       * - update_entry: 修改条目属性
       * - add_entry: 新增条目
       * - delete_entry: 删除条目
       * - reorder_entries: 重排序条目
       */
      SetData: async (data, ctx) => {
        if (!data) return;
        // [T074] 全部世界书写操作落到 ctx.username 的 store（原直接改全局 configData → 串台根因）。
        //   ctx.username 由 verb 层 wbSetData 盖章 context.user（唯一权威）；saveConfigToDisk(ctx.username) 写该 user 目录。
        const store = getStore(ctx?.username);

        if (data._action === "syncColumnRefs") {
          const { renames = [], deleted = [] } = data;
          let renamed = 0, warned = 0;
          for (const wb of Object.values(store.worldbooks)) {
            if (!wb.entries) continue;
            for (const entry of Object.values(wb.entries)) {
              if (entry.activationMode !== "dynamic" || !entry.dynamicConfig?.columnName) continue;
              const col = entry.dynamicConfig.columnName;
              const hit = renames.find(r => r.oldName === col);
              if (hit) { entry.dynamicConfig.columnName = hit.newName; renamed++; continue; }
              if (deleted.includes(col)) { entry.dynamicConfig.columnName = ""; warned++; }
            }
          }
          if (renamed > 0 || warned > 0) saveConfigToDisk(ctx?.username);
          return { success: true, renamed, warned };
        }

        // 导出世界书为 ST lorebook JSON（只读，不落盘）。convertToSTEntry 逆向，高级字段无损回 ST
        if (data.export_worldbook) {
          const name = data.export_worldbook.name || store.active_worldbook;
          const wb = store.worldbooks[name];
          if (!wb) {
            return { _result: { success: false, error: `世界书 "${name}" 不存在` } };
          }
          const stJson = { entries: convertToSTEntries(wb.entries) };
          return {
            _result: {
              success: true,
              name,
              st_json: JSON.stringify(stJson, null, 2),
            },
          };
        }

        // 导入世界书（ST 格式 → beilu 内部格式）
        if (data.import_worldbook) {
          const { json, name, boundCharName } = data.import_worldbook;
          if (json?.entries) {
            const convertedEntries = convertSTEntries(json.entries);
            // 绑定书默认 enabled=false：boundMatch(getAllEnabledEntries:430)已让它私有注入到绑定角色；
            // 设 enabled=true 会经 globalEnabled(:425 wb.enabled===true)泄漏进所有角色(与"绑定=私有"矛盾，
            // ST 语义里 character lorebook≠global)。导入一律默认关闭，全局生效需用户在"额外世界书"手动启用。
            const shouldEnable = false;
            store.worldbooks[name] = {
              entries: convertedEntries,
              enabled: shouldEnable,
              boundCharName: boundCharName || "",
            };
            store.active_worldbook = name;
            const count = Object.keys(convertedEntries).length;
            console.log(
              `[beilu-worldbook] 世界书已导入: "${name}" (${count} 条目${boundCharName ? ", 绑定: " + boundCharName + "(私有注入)" : ", 默认关闭"})`,
            );
          }
        }

        // 切换激活世界书
        if (data.switch_worldbook) {
          const { name } = data.switch_worldbook;
          if (store.worldbooks[name]) {
            store.active_worldbook = name;
            console.log(`[beilu-worldbook] 已切换到世界书: "${name}"`);
          }
        }

        // 删除世界书
        if (data.delete_worldbook) {
          const { name } = data.delete_worldbook;
          if (store.worldbooks[name]) {
            delete store.worldbooks[name];
            console.log(`[beilu-worldbook] 已删除世界书: "${name}"`);
            // 如果删除的是当前激活的，自动切换到其他世界书
            if (name === store.active_worldbook) {
              const remaining = Object.keys(store.worldbooks);
              store.active_worldbook =
                remaining.length > 0 ? remaining[0] : "";
              console.log(
                `[beilu-worldbook] 已自动切换到: "${store.active_worldbook || "(无)"}"`,
              );
            }
          }
        }

        // 重命名世界书
        if (data.rename_worldbook) {
          const { old_name, new_name } = data.rename_worldbook;
          if (
            store.worldbooks[old_name] &&
            !store.worldbooks[new_name]
          ) {
            store.worldbooks[new_name] = store.worldbooks[old_name];
            delete store.worldbooks[old_name];
            if (store.active_worldbook === old_name) {
              store.active_worldbook = new_name;
            }
            console.log(
              `[beilu-worldbook] 世界书已重命名: "${old_name}" → "${new_name}"`,
            );
          }
        }

        // 新建空白世界书
        if (data.create_worldbook) {
          const { name } = data.create_worldbook;
          if (!name) {
            console.warn("[beilu-worldbook] create_worldbook: 缺少名称");
          } else if (store.worldbooks[name]) {
            console.warn(`[beilu-worldbook] 世界书 "${name}" 已存在`);
          } else {
            store.worldbooks[name] = {
              entries: {},
              enabled: false,
              boundCharName: "",
            };
            if (!store.active_worldbook) {
              store.active_worldbook = name;
            }
            console.log(`[beilu-worldbook] 空白世界书已创建: "${name}"`);
          }
        }

        // 启用/禁用世界书
        if (data.toggle_worldbook) {
          const { name, enabled } = data.toggle_worldbook;
          if (store.worldbooks[name]) {
            store.worldbooks[name].enabled = !!enabled;
            console.log(
              `[beilu-worldbook] 世界书 "${name}" 已${enabled ? "启用" : "禁用"}`,
            );
          }
        }

        // 绑定世界书到角色（独立机制，不联动 enabled 开关）
        // ★ 双开关机制：绑定是独立开关，不影响额外世界书的全局 enabled 状态
        if (data.bind_worldbook) {
          const { name, charName } = data.bind_worldbook;
          if (store.worldbooks[name]) {
            store.worldbooks[name].boundCharName = charName || "";
            if (charName) {
              console.log(
                `[beilu-worldbook] 世界书 "${name}" 已绑定到角色: ${charName}（绑定独立生效，不改变 enabled=${store.worldbooks[name].enabled}）`,
              );
            } else {
              console.log(
                `[beilu-worldbook] 世界书 "${name}" 已解除角色绑定（不改变 enabled=${store.worldbooks[name].enabled}）`,
              );
            }
          }
        }

        // 按角色名清理绑定的世界书（删除角色卡时调用）
        if (data.removeByChar) {
          const { charName } = data.removeByChar;
          if (charName) {
            const toRemove = [];
            for (const [name, wb] of Object.entries(store.worldbooks)) {
              if (wb.boundCharName === charName) toRemove.push(name);
            }
            for (const name of toRemove) {
              delete store.worldbooks[name];
              if (store.active_worldbook === name) {
                const remaining = Object.keys(store.worldbooks);
                store.active_worldbook =
                  remaining.length > 0 ? remaining[0] : "";
              }
            }
            if (toRemove.length > 0) {
              console.log(
                `[beilu-worldbook] 已清理角色 "${charName}" 绑定的 ${toRemove.length} 个世界书: ${toRemove.join(", ")}`,
              );
            }
          }
        }

        // N5：entry 增删改启停以前命中与否都不 return（端点恒 200），前端只判 res.ok → 假成功。
        //   现逐块捕获真实结果(无激活世界书/条目不存在/持久化失败)，经 _result 上浮。
        let _entryResult = null;

        // 切换条目启用/禁用
        if (data.toggle_entry) {
          const { uid, disabled } = data.toggle_entry;
          const entries = getActiveEntries(store);
          if (!entries) _entryResult = { success: false, error: "无激活世界书" };
          else {
            const key = String(uid);
            if (entries[key]) {
              entries[key].disable = disabled;
              diag.log(
                `条目${disabled ? "禁用" : "启用"}: uid=${uid}, "${entries[key].comment || ""}"`,
              );
              _entryResult = { success: true, uid };
            } else _entryResult = { success: false, error: `条目不存在: uid=${uid}` };
          }
        }

        // 修改条目
        if (data.update_entry) {
          const { uid, props } = data.update_entry;
          const entries = getActiveEntries(store);
          if (!entries) _entryResult = { success: false, error: "无激活世界书" };
          else if (!props) _entryResult = { success: false, error: "缺少 props" };
          else {
            const key = String(uid);
            if (entries[key]) {
              // 逐个字段更新，防止覆盖整个条目
              for (const [prop, value] of Object.entries(props)) {
                entries[key][prop] = value;
              }
              normalizeEntryMode(entries[key], props);
              diag.log(
                `条目更新: uid=${uid}, 字段=[${Object.keys(props).join(",")}]`,
              );
              _entryResult = { success: true, uid };
              // 根病4：dynamic 条目 columnName 存在性校验（档1 警告不阻止，引导>禁止）
              const _updEntry = entries[key];
              if (_updEntry.activationMode === "dynamic" && _updEntry.dynamicConfig?.columnName && ctx?.username) {
                try {
                  const _charName = data.update_entry.charName || ctx.query?.charName || "";
                  const _chatId = data.update_entry.chatId || ctx.query?.chatId || "";
                  const _tables = await loadTablesForDynamic(ctx.username, _charName, _chatId);
                  const _colName = _updEntry.dynamicConfig.columnName;
                  const _colExists = (_tables || []).some(t => t.columns && t.columns.indexOf(_colName) >= 0);
                  if (!_colExists) {
                    _entryResult.warning = `列名 "${_colName}" 不在当前记忆表格中，该条目可能永不激活`;
                  }
                } catch (_e) { /* 校验失败不阻止保存 */ }
              }
            } else _entryResult = { success: false, error: `条目不存在: uid=${uid}` };
          }
        }

        // 新增条目
        if (data.add_entry) {
          const entries = getActiveEntries(store);
          if (!entries) _entryResult = { success: false, error: "无激活世界书" };
          else {
            const uid = getNextUid(entries);
            const newEntry = createBlankEntry(uid);
            // 合并自定义属性
            if (data.add_entry.props) {
              Object.assign(newEntry, data.add_entry.props);
              newEntry.uid = uid; // 确保 uid 不被覆盖
            }
            entries[String(uid)] = newEntry;
            normalizeEntryMode(newEntry, data.add_entry.props);
            diag.log(`条目新增: uid=${uid}, "${newEntry.comment || ""}"`);
            _entryResult = { success: true, uid };
          }
        }

        // 删除条目
        if (data.delete_entry) {
          const { uid } = data.delete_entry;
          const entries = getActiveEntries(store);
          if (!entries) _entryResult = { success: false, error: "无激活世界书" };
          else {
            const key = String(uid);
            if (entries[key]) {
              const comment = entries[key].comment || "";
              delete entries[key];
              diag.log(`条目删除: uid=${uid}, "${comment}"`);
              _entryResult = { success: true, uid };
            } else _entryResult = { success: false, error: `条目不存在: uid=${uid}` };
          }
        }

        // 重排序条目（更新 displayIndex）
        if (data.reorder_entries) {
          const { order } = data.reorder_entries; // order: uid[]
          const entries = getActiveEntries(store);
          if (!entries) _entryResult = { success: false, error: "无激活世界书" };
          else if (!Array.isArray(order)) _entryResult = { success: false, error: "order 必须为数组" };
          else {
            order.forEach((uid, index) => {
              const key = String(uid);
              if (entries[key]) {
                entries[key].displayIndex = index;
              }
            });
            _entryResult = { success: true };
          }
        }

        // 持久化到磁盘（[T074] 落 ctx.username 的 per-user 目录）
        const _saved = saveConfigToDisk(ctx?.username);
        if (_entryResult) {
          if (_entryResult.success && !_saved) _entryResult = { success: false, error: "持久化到磁盘失败" };
          return { _result: _entryResult };
        }
        // worldbook 级操作(import/switch/delete/rename/create/toggle/bind 等)未写 _entryResult：统一上浮磁盘写结果，
        // 不再 return undefined → 路由 ??{success:true} 谎报（N5 修了 entry 级，此为同类漏入口补齐：写盘失败如实报错）
        return { _result: _saved ? { success: true } : { success: false, error: "持久化到磁盘失败" } };
      },
    },

    chat: {
      /**
       * GetPrompt — 世界书注入管线入口：筛选+激活+分通道构建提示词。
       *
       * 链路：getPromptHandler 21步中调用 → 本函数 → 返回值写入
       *       prompt_struct.plugin_prompts["beilu-worldbook"]，
       *       由 TweakPrompt 或 beilu-preset 消费。
       *
       * 流程：
       *   1. getAllEnabledEntries(charId, charName) — 双开关筛选
       *   2. filterEntriesByPhase(entries, "generate") — 阶段过滤
       *   3. 三模式分流:
       *      · constant → 直接推入 activated[]
       *      · regex → 转 ST wiEntries 格式 → GetActivedWorldInfoEntries()
       *        (含 scan_depth/sticky/cooldown/probability/递归激活)
       *      · dynamic → loadTablesForDynamic() + checkDynamicEntry()
       *   4. 按 position 分三通道输出:
       *      · worldbook_injections (pos=4 @depth)
       *      · worldbook_char_injections (pos=0/1 before/after)
       *      · text[] (pos=2/3/5/6 AN/EM 等)
       *
       * 影响：写 arg.extension.worldbook_memory (正则引擎 sticky/cooldown 状态持久化);
       *       SEC-T8 wrapUntrusted() 已移除（与内部位置/深度系统不兼容：token膨胀+语义破坏，见文件头注释）——
       *       三个 position 分支（:1464 _wrappedContent）现直通 entry.content，不再中性化。
       *
       * 约束：generate 阶段调用; [RENDER:*] 条目被静默滤除（由 GetRenderEntries 消费）。
       *       条目内容现直通注入（SEC-T8 已移除）——如需重新引入中性化，判等三个 position 分支需保持共用单源，避免双重包裹。
       *
       * @param {object} arg - chatReplyRequest_t (含 char_id/Charname/chat_log/extension 等)
       * @returns {{ text: Array, additional_chat_log: Array, extension: { worldbook_injections, worldbook_char_injections } }}
       */
      GetPrompt: (arg) => {
        const _cid = arg?.chatid || arg?.chat_name?.replace("common_chat_", "") || null;
        wbT(_cid, "worldbook", "GetPrompt:enter", {});
        // char_id 是 part 目录名（如 "001"），Charname 是角色显示名（如 "魔法少女小圆-予你之歌"）
        const charId = arg?.char_id || "";
        const charName = arg?.Charname || "";
        const username = arg?.username || "_default";
        // [T074] 按用户取世界书 store（arg.username 由 requestBuilder.mjs:128 塞入 → 已达实现体）。
        const store = getStore(username);

        // ★ DIAG: 输出所有世界书的状态，帮助定位"额外世界书未注入"（gated，默认静默，BEILU_DIAG=worldbook 重现）
        diag.debug(
          `GetPrompt called: charId="${charId}", charName="${charName}", worldbooks:`,
          Object.entries(store.worldbooks)
            .map(
              ([n, wb]) =>
                `"${n}"(enabled=${wb.enabled}, bound="${wb.boundCharName}", entries=${wb.entries ? Object.keys(wb.entries).length : 0})`,
            )
            .join(", "),
        );

        let entryArray = getAllEnabledEntries(store, charId, charName);

        // ★ DIAG: 输出 getAllEnabledEntries 结果（gated）
        diag.debug(
          `getAllEnabledEntries("${charId}", "${charName}") → ${entryArray.length} 条目`,
        );
        wbT(_cid, "worldbook", "entries", { n: entryArray.length });

        if (entryArray.length === 0) {
          return { text: [], additional_chat_log: [], extension: {} };
        }

        // Phase 2E: 按阶段过滤条目（GetPrompt 在生成阶段调用）
        entryArray = filterEntriesByPhase(entryArray, "generate");
        if (entryArray.length === 0) {
          return { text: [], additional_chat_log: [], extension: {} };
        }

        // ---- 3模式分流 ----
        const constantEntries = [];
        const regexEntries = [];
        const dynamicEntries = [];

        for (const entry of entryArray) {
          const mode =
            entry.activationMode || (entry.constant ? "constant" : "regex");
          if (mode === "constant") {
            constantEntries.push(entry);
          } else if (mode === "dynamic") {
            dynamicEntries.push(entry);
          } else {
            regexEntries.push(entry);
          }
        }

        diag.debug(
          `GetPrompt 3模式分流: charId="${charId}", constant=${constantEntries.length}, regex=${regexEntries.length}, dynamic=${dynamicEntries.length}`,
        );

        // ---- 常驻条目：直接激活 ----
        const activated = [...constantEntries];
        if (constantEntries.length > 0) {
          diag.debug(
            `常驻条目激活: ${constantEntries.length} 条 [${constantEntries.map((e) => e.comment || e.uid).join(", ")}]`,
          );
        }

        // ---- 正则条目：送入 ST 世界书激活引擎 ----
        if (regexEntries.length > 0) {
          const wiEntries = regexEntries.map((e) => ({
            ...e,
            keys: Array.isArray(e.key) ? [...e.key] : e.key ? [e.key] : [],
            secondary_keys: Array.isArray(e.keysecondary)
              ? [...e.keysecondary]
              : e.keysecondary
                ? [e.keysecondary]
                : [],
            enabled: !e.disable,
            constant: false, // 强制关闭，常驻模式已在上方处理
            extensions: {
              position: e.position,
              role: e.role ?? extension_prompt_roles.SYSTEM,
              selectiveLogic: e.selectiveLogic ?? 0,
              case_sensitive: e.caseSensitive,
              match_whole_words: e.matchWholeWords,
              // B11(20260610): 透传条目级 scan_depth 给 ST 激活引擎（world_info.mjs 消费 entrie.extensions.scan_depth）。
              // e.scanDepth 来自本文件 :243 解析（raw.scanDepth ?? ext.scan_depth ?? null）；此前未透传 → 条目级深度无效。
              scan_depth: e.scanDepth,
              exclude_recursion: e.excludeRecursion,
              prevent_recursion: e.preventRecursion,
              delay_until_recursion: e.delayUntilRecursion ? 1 : 0,
              delay: e.delay,
              sticky: e.sticky,
              cooldown: e.cooldown,
              useProbability: e.useProbability,
              probability: e.probability,
            },
          }));

          const chatLog = arg.chat_log || [];
          const env = {
            user: arg.UserCharname || "User",
            char: arg.Charname || "Character",
          };
          const memory = arg.extension?.worldbook_memory || {};

          try {
            const regexActivated = GetActivedWorldInfoEntries(
              wiEntries,
              chatLog,
              env,
              memory,
            );
            if (arg.extension) {
              arg.extension.worldbook_memory = memory;
            }
            activated.push(...regexActivated);
            diag.debug(`正则引擎激活: ${regexActivated.length} 条`);
          } catch (err) {
            diag.error("正则引擎错误:", err);
            // 该角色的 regex 模式世界书条目全部静默丢失 → 映射到前端面板告警。
            wbD(null, "worldbook:regex", "engine_error", false, `世界书正则引擎错误，regex 条目丢失: ${err?.message || err}`, { err: err?.message || String(err) });
          }
        }

        // ---- 动态条目：检查记忆表格 ----
        if (dynamicEntries.length > 0) {
          diag.time("dynamicCheck");
          const tables = loadTablesForDynamic(username, charId, _cid, arg);
          if (tables) {
            for (const entry of dynamicEntries) {
              if (checkDynamicEntry(entry, tables)) {
                activated.push(entry);
                diag.debug(
                  `动态条目激活: "${entry.comment}" (列: ${entry.dynamicConfig?.columnName})`,
                );
              }
            }
          } else {
            diag.debug("动态模式: 无法加载表格数据，跳过动态条目");
          }
          diag.timeEnd("dynamicCheck");
        }

        if (activated.length === 0) {
          return { text: [], additional_chat_log: [], extension: {} };
        }

        // ★ DIAG: 详细输出激活结果（旧裸 console.log 已删，下方 diag.log gated 版覆盖核心激活条数；
        //   逐条明细可 BEILU_DIAG=worldbook 时由 diag.debug 重现）
        diag.log(`GetPrompt 总激活: ${activated.length} 条`);

        // 按 position 分类构建提示词
        const textEntries = [];
        const chatLogInjections = [];
        const charInjections = [];
        let beforeCount = 0,
          afterCount = 0,
          depthCount = 0,
          otherCount = 0;

        for (const entry of activated) {
          const pos =
            entry.extensions?.position ??
            entry.position ??
            world_info_position.before;
          const role = entry.extensions?.role ?? extension_prompt_roles.SYSTEM;
          const depth = entry.depth ?? 4;
          const order = entry.order ?? 100;

          const roleMap = {
            [extension_prompt_roles.SYSTEM]: "system",
            [extension_prompt_roles.USER]: "user",
            [extension_prompt_roles.ASSISTANT]: "assistant",
          };

          const _wrappedContent = entry.content;

          if (pos === world_info_position.atDepth) {
            // 按 @depth 注入到聊天记录中
            chatLogInjections.push({
              content: _wrappedContent,
              role: roleMap[role] || "system",
              depth: depth,
            });
            depthCount++;
          } else if (
            pos === world_info_position.before ||
            pos === world_info_position.after
          ) {
            charInjections.push({
              content: _wrappedContent,
              position: pos,
              order: order,
            });
            if (pos === world_info_position.before) beforeCount++;
            else afterCount++;
          } else {
            textEntries.push({
              content: _wrappedContent,
              important: 0,
            });
            otherCount++;
          }
        }

        diag.debug(
          `注入构建: before=${beforeCount}, after=${afterCount}, @depth=${depthCount}, other=${otherCount}`,
        );

        return {
          text: textEntries,
          additional_chat_log: [],
          extension: {
            worldbook_injections: chatLogInjections,
            worldbook_char_injections: charInjections,
          },
        };
      },

      /**
       * GetRenderEntries — 渲染阶段世界书条目（K4 [RENDER:*] 渲染相线）
       *
       * 设计原话（main.mjs:50 JSDoc + 设计总集 batch22 MD6）：
       *   「包含 [RENDER:*] 的仅在 render 阶段注入」
       * GetPrompt 在 generate 阶段调用，[RENDER:*] 条目被 filterEntriesByPhase(.,"generate")
       * 静默滤除 → 永不可见。本方法是 render 阶段消费端：激活 [RENDER:*] 条目并把内容
       * 返回给前端在消息渲染时显示（生成期隐藏、渲染期显示）。
       *
       * 激活口径与 GetPrompt 对齐：
       *   - constant 模式：直接激活（渲染期最常见用法：常驻状态栏/装饰块）
       *   - regex 模式：若调用方提供 chat_log，送 ST 激活引擎做关键词匹配
       *   - dynamic 模式：检查记忆表格（需 charId/username）
       * 仅返回含 [RENDER:*] 标记的条目（filterEntriesByPhase(.,"render") 保证），
       * stripPhaseTags 已剥除标记，content 为纯展示内容。
       *
       * @param {object} arg - { char_id, Charname, username, chat_log? }
       * @returns {{ entries: Array<{content:string, comment:string, uid:any}> }}
       */
      GetRenderEntries: (arg) => {
        const charId = arg?.char_id || "";
        const charName = arg?.Charname || "";
        const username = arg?.username || "_default";
        const _cid = arg?.chatid || arg?.chat_name?.replace("common_chat_", "") || null; // F4-2: per-chatId 表隔离
        const store = getStore(username); // [T074] 按用户取世界书 store

        let entryArray = getAllEnabledEntries(store, charId, charName);
        if (entryArray.length === 0) return { entries: [] };

        // render 阶段过滤：只保留含 [RENDER:*] 的条目（render 分支激活，generate-only/无标记被滤）
        entryArray = filterEntriesByPhase(entryArray, "render");
        if (entryArray.length === 0) return { entries: [] };

        // 3模式分流（与 GetPrompt 同口径）
        const constantEntries = [];
        const regexEntries = [];
        const dynamicEntries = [];
        for (const entry of entryArray) {
          const mode =
            entry.activationMode || (entry.constant ? "constant" : "regex");
          if (mode === "constant") constantEntries.push(entry);
          else if (mode === "dynamic") dynamicEntries.push(entry);
          else regexEntries.push(entry);
        }

        const activated = [...constantEntries];

        // 正则条目：有 chat_log 才送引擎（前端渲染通常只激活 constant；regex 可选）
        if (regexEntries.length > 0 && Array.isArray(arg?.chat_log) && arg.chat_log.length) {
          const wiEntries = regexEntries.map((e) => ({
            ...e,
            keys: Array.isArray(e.key) ? [...e.key] : e.key ? [e.key] : [],
            secondary_keys: Array.isArray(e.keysecondary)
              ? [...e.keysecondary]
              : e.keysecondary
                ? [e.keysecondary]
                : [],
            enabled: !e.disable,
            constant: false,
            extensions: {
              position: e.position,
              role: e.role ?? extension_prompt_roles.SYSTEM,
              selectiveLogic: e.selectiveLogic ?? 0,
              case_sensitive: e.caseSensitive,
              match_whole_words: e.matchWholeWords,
              scan_depth: e.scanDepth,
            },
          }));
          try {
            const regexActivated = GetActivedWorldInfoEntries(
              wiEntries,
              arg.chat_log,
              { user: charName || "User", char: charName || "Character" },
              {},
            );
            activated.push(...regexActivated);
          } catch (err) {
            diag.error("[render] 正则引擎错误:", err);
          }
        }

        // 动态条目：检查记忆表格
        if (dynamicEntries.length > 0) {
          const tables = loadTablesForDynamic(username, charId, _cid, arg);
          if (tables) {
            for (const entry of dynamicEntries) {
              if (checkDynamicEntry(entry, tables)) activated.push(entry);
            }
          }
        }

        const entries = activated.map((e) => ({
          content: stripPhaseTags(e.content || ""),
          comment: e.comment || "",
          uid: e.uid,
          order: e.order ?? 100,
        }));
        // 按 order 稳定排序（渲染显示顺序）
        entries.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
        diag.log(`[render] GetRenderEntries: charId="${charId}" → ${entries.length} 条 [RENDER:*]`);
        return { entries };
      },

      /**
       * TweakPrompt — 非司令员模式下将 GetPrompt 产出注入到 prompt_struct。
       * 司令员模式下跳过（由 beilu-preset Round 1/2 从 extension 读取，统一处理）。
       *
       * 链路：GetPrompt 返回 → prompt_struct.plugin_prompts["beilu-worldbook"] → 本函数消费
       *
       * 两类注入：
       *   1. before/after (worldbook_char_injections) → prompt_struct.char_prompt.text
       *      · before: important = -1000 + order（排在角色描述最前）
       *      · after:  important =  1000 + order（排在角色描述最后）
       *   2. @depth (worldbook_injections) → splice 进 prompt_struct.chat_log
       *      · insertIndex = chatLog.length - depth（从末尾往前数 depth 条）
       *      · 消息体 name="world_info", ephemeral=true
       *
       * 影响：直接修改 prompt_struct.char_prompt.text 和 prompt_struct.chat_log（原地 push/splice）
       *
       * 约束：
       *   · 仅 detail_level=2（第一轮）执行，避免三轮 TweakPrompt 重复注入
       *   · 司令员模式下本函数直接 return，不要在此处加逻辑——司令员消费在 beilu-preset
       *   · depth 语义：非司令员模式精确 splice N 条位置; 司令员模式退化为 >=1/=0 二值阈值
       *     （两通道不一致是设计特性非 bug）
       */
      TweakPrompt: (arg, prompt_struct, my_prompt, detail_level) => {
        // 只在第一轮（detail_level=2）执行，避免三轮重复注入
        if (detail_level !== undefined && detail_level !== 2) return;

        // ---- 检测司令员模式 ----
        // 司令员模式下，beilu-preset 会接管所有注入工作（通过 extension 数据），
        // worldbook 不应直接修改 prompt_struct，否则会导致重复注入
        const commanderMode =
          prompt_struct.plugin_prompts?.["beilu-preset"]?.extension
            ?.commander_mode;
        wbT(
          arg?.chatid || arg?.chat_name?.replace("common_chat_", "") || null,
          "worldbook",
          "TweakPrompt",
          { commander: !!commanderMode },
        );
        if (commanderMode) {
          diag.debug(
            "TweakPrompt: 检测到司令员模式，跳过直接注入（由 beilu-preset 统一处理）",
          );
          return;
        }

        // ---- 1. before/after 角色描述注入（非司令员模式） ----
        const charInjections = my_prompt?.extension?.worldbook_char_injections;
        if (charInjections?.length && prompt_struct?.char_prompt?.text) {
          for (const injection of charInjections) {
            const important =
              injection.position === world_info_position.before
                ? -1000 + (injection.order || 0) // before: 非常小的 important → 排在最前面
                : 1000 + (injection.order || 0); // after: 非常大的 important → 排在最后面
            prompt_struct.char_prompt.text.push({
              content: injection.content,
              important: important,
            });
          }
          diag.debug(
            `TweakPrompt char注入: ${charInjections.length} 条 (before/after → char_prompt.text)`,
          );
        }

        // ---- 2. @depth 聊天记录注入（非司令员模式） ----
        const injections = my_prompt?.extension?.worldbook_injections;
        if (
          !injections ||
          !Array.isArray(injections) ||
          injections.length === 0
        )
          return;
        if (!prompt_struct?.chat_log) return;

        const chatLog = prompt_struct.chat_log;

        for (const injection of injections) {
          const depth = injection.depth ?? 4;
          // 计算注入位置：从末尾往前数 depth 条
          const insertIndex = Math.max(0, chatLog.length - depth);

          chatLog.splice(insertIndex, 0, {
            role: injection.role || "system",
            content: injection.content,
            name: "world_info",
            extension: { ephemeral: true },
          });
        }
        diag.debug(
          `TweakPrompt @depth注入: ${injections.length} 条 → chat_log (共${chatLog.length}条)`,
        );
      },
    },
  },
};

export default pluginExport;

// 导出 ST→beilu 世界书条目转换器（单一权威源）。
// 供 beilu-home import-char 的「插件未加载」磁盘 fallback 分支复用，
// 与插件内 import_worldbook action（:872 走同一 convertSTEntries）同口径，
// 避免另写一份转换副本。纯追加，不改任何现有行为。
export { convertSTEntries };
