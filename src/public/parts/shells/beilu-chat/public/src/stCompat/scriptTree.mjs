/**
 * @file scriptTree.mjs — tavern_helper 脚本树（ScriptTree）规范化单源
 *
 * 【why 存在】酒馆助手（JS-Slash-Runner）的 scripts 字段是 ScriptTree[] 判别联合：
 *   type:"script" 的脚本条目 与 type:"folder" 的文件夹条目（scripts:[] 内嵌脚本数组）混排
 *   （ST 源 src/type/scripts.ts:27-45 ScriptFolder/ScriptTree 定义）。
 *   beilu 原三个消费点只按扁平脚本数组处理：folder 节点连同其内部脚本被静默丢弃
 *   （装在文件夹里的角色卡脚本显示"0 个"、不运行）；旧导出卡的 legacy 键
 *   TavernHelper_scripts（ST 侧会自动迁移，见 store/settings/character.ts:14-30）全线无人读；
 *   `s.type === "script"` 严格判断还会丢掉无 type 字段的旧条目（ST zod 里 type 有默认值可缺省）。
 *   2026-08-06 收口到本模块，消费方（scriptRunner 运行链 / scriptManager 管理面）统一走这里。
 *
 * 【启用语义】对齐 ST（store/scripts.ts:83-92）：
 *   顶层脚本生效 = script.enabled；文件夹内脚本生效 = folder.enabled && script.enabled。
 *
 * 【引用保持契约】flattenScriptTrees 返回的扁平条目是树内原对象的引用（不克隆）——
 *   消费方对条目字段的原地修改（enabled/content 等）天然回写树；持久化必须保存
 *   树（trees）本身而不是扁平数组，否则文件夹结构在一次保存后被夷平。
 *
 * 【关联链】消费方：scriptRunner.loadCharacterScripts（运行）、scriptManager（管理/编辑/保存）。
 */

/** 判定 ScriptTree 节点是否为文件夹节点 */
export function isFolderNode(node) {
  return !!node && node.type === "folder" && Array.isArray(node.scripts);
}

// ============================================================
// [0807 §七#4 backward 老卡迁移] 节点形状规范化，逐字对齐酒馆助手 type/backward.ts：
//   ST 侧读到旧格式会自动迁移（转换后写回）；beilu 此前只兜底键位置不兜底节点形状——
//   老卡三类旧形状：裸 ScriptData 按钮丢（buttons[] 无人读）、ScriptItem 整壳当脚本
//   （enabled/content 在 .value 里→静默不跑）、旧 folder（value 数组）整个被当"脚本"内部全丢。
//   规范化在 readTavernScriptTrees 出口做（单源，运行/管理/AIRP 全消费方受益）；
//   已是新格式的节点【原样引用】返回（引用保持契约不破坏），仅旧形状节点产新对象——
//   scriptManager 保存树时旧卡即自愈升级为新格式（与 ST 迁移后写回同语义）。
// ============================================================
function _newUuid() {
  try { return crypto.randomUUID(); } catch { return "s-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
}

/** 裸/旧 ScriptData → 新 Script 形状（backward.ts:30-47）；已是新形状原样引用返回 */
function _normalizeScriptData(item) {
  if (!item || typeof item !== "object") return null;
  if (item.button && typeof item.button === "object") return item; // 新形状：button 对象已在
  return {
    type: "script",
    enabled: !!item.enabled,
    name: item.name || "",
    id: item.id || _newUuid(),
    content: item.content || "",
    info: item.info || "",
    button: { enabled: true, buttons: Array.isArray(item.buttons) ? item.buttons : [] },
    data: (item.data && typeof item.data === "object") ? item.data : {},
    export_with: { data: true, button: true },
  };
}

/** 单节点规范化（顺序对齐 backward.ts ScriptTree union 判别） */
function _normalizeNode(node) {
  if (!node || typeof node !== "object") return null;
  if (node.type === "folder" && Array.isArray(node.scripts)) return node; // 新 folder 原样
  if (node.type === "folder" && Array.isArray(node.value)) {
    // 旧 folder（backward.ts:56-78）：无 enabled 字段，迁移语义=enabled:true
    return {
      type: "folder", enabled: true, name: node.name || "", id: node.id || _newUuid(),
      icon: node.icon || "fa-solid fa-folder", color: node.color || "",
      scripts: node.value.map(_normalizeScriptData).filter(Boolean),
    };
  }
  if (node.type === "script" && node.value && typeof node.value === "object" && !("content" in node)) {
    return _normalizeScriptData(node.value); // ScriptItem（backward.ts:50-55）取 .value
  }
  if (node.type === "script" || (node.button && typeof node.button === "object")) return node; // 新 script 原样
  if (!node.type) return _normalizeScriptData(node); // 裸 ScriptData（无 type）
  return node; // 未知形状原样保留，不静默丢（诚实原则）
}

/** 树级规范化：新格式树零转换零新对象（引用不变）；含旧形状节点才产新数组 */
export function normalizeScriptTrees(trees) {
  if (!Array.isArray(trees)) return [];
  let changed = false;
  const out = [];
  for (const node of trees) {
    const n = _normalizeNode(node);
    if (n === null) { changed = true; continue; }
    if (n !== node) changed = true;
    out.push(n);
  }
  return changed ? out : trees;
}

/**
 * 从 charData 读出 ScriptTree 数组（不展开）。
 * 顺序：顶层 extensions（beilu 落盘权威层）→ data.extensions（未解包 V3 原卡）；
 * 新键 tavern_helper.scripts 优先，legacy 键 TavernHelper_scripts（扁平脚本数组）兜底。
 * @param {object} charData
 * @returns {Array<object>} ScriptTree 数组（可能含 folder 节点）；无脚本返回 []
 */
export function readTavernScriptTrees(charData) {
  const exts = [charData?.extensions, charData?.data?.extensions];
  for (const ext of exts) {
    const s = ext?.tavern_helper?.scripts;
    if (Array.isArray(s)) return normalizeScriptTrees(s); // [0807 §七#4] 出口规范化（新格式零开销原引用）
  }
  for (const ext of exts) {
    const legacy = ext?.TavernHelper_scripts;
    if (Array.isArray(legacy)) return normalizeScriptTrees(legacy);
  }
  return [];
}

/**
 * 把 ScriptTree 展开成扁平脚本列表（保持树内顺序：文件夹内脚本原位展开）。
 * 非 folder 节点一律按脚本处理（不苛求 type === "script"，兼容无 type 的旧条目）。
 * @param {Array<object>} trees
 * @returns {{scripts: Array<object>, meta: Map<string, {folderId: string, folderName: string, folderEnabled: boolean}>}}
 *   scripts 为树内原对象引用；meta 按 script.id 记录所属文件夹信息（顶层脚本无 meta 条目）
 */
export function flattenScriptTrees(trees) {
  const scripts = [];
  const meta = new Map();
  for (const node of Array.isArray(trees) ? trees : []) {
    if (isFolderNode(node)) {
      for (const s of node.scripts) {
        if (!s || typeof s !== "object") continue;
        scripts.push(s);
        if (s.id != null) meta.set(s.id, { folderId: node.id, folderName: node.name || "", folderEnabled: !!node.enabled });
      }
    } else if (node && typeof node === "object") {
      scripts.push(node);
    }
  }
  return { scripts, meta };
}

/**
 * 脚本是否实际生效（对齐 ST 语义：文件夹内还要求文件夹本身 enabled）。
 * @param {object} script
 * @param {Map<string, {folderEnabled: boolean}>} [meta] - flattenScriptTrees 产出的 meta
 */
export function isEffectivelyEnabled(script, meta) {
  if (!script?.enabled) return false;
  const m = script?.id != null ? meta?.get(script.id) : undefined;
  return m ? !!m.folderEnabled : true;
}

/**
 * 从树中按 id 删除脚本（顶层或文件夹内）。不删除文件夹节点本身。
 * @returns {boolean} 是否找到并删除
 */
export function removeScriptFromTrees(trees, scriptId) {
  if (!Array.isArray(trees)) return false;
  for (let i = 0; i < trees.length; i++) {
    const node = trees[i];
    if (isFolderNode(node)) {
      const j = node.scripts.findIndex((s) => s?.id === scriptId);
      if (j >= 0) { node.scripts.splice(j, 1); return true; }
    } else if (node?.id === scriptId) {
      trees.splice(i, 1);
      return true;
    }
  }
  return false;
}
