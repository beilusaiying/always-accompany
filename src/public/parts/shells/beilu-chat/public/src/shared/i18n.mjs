// beilu-chat 壳覆盖式 i18n（凛倾 2026-07-15 定案：覆盖式，非 fount 内容替换式）
//
// 为什么是覆盖式：中文原文即默认语言——中文模式下本模块零行为零开销；
// 切外语时才加载差量字典覆盖 DOM，originals 存原文可无损切回。
// 为什么中文原文作键：壳存量 ~7000 行硬编码中文（index.html + 136 个 mjs 的模板字符串），
// 逐条打 data-i18n 键不现实；以原文整串 exact-match 作键可零侵入覆盖存量。
// 与 beilu-home/public/src/i18n.mjs 范式同源，补上了它缺的 MutationObserver（动态节点自动翻译）。
//
// 字典文件：/parts/shells:beilu-chat/locales/{lang}.json，平铺一层：
//   { "保存": "Save", "nav.some.key": "..." }   —— 中文原文键与 data-i18n 点分键共存一张表
// 可用语言单源：locales/list.json（数组，如 [{"id":"en","name":"English"}]），缺失=仅中文。
// localStorage 键 beiluLang 与 wikiViewer.mjs 共用（同一语言态单源）；
// 切换后派发 window CustomEvent 'beilu-lang-change'（detail={lang}），与 beilu-home 同名事件对齐。
//
// 排除域：[data-i18n-skip] 子树不翻译（对话消息区等内容域必须打此标——UI 字典禁碰用户/AI 内容）。
// 已知局限：运行时拼接的含变量文本（如 `已保存 ${n} 项`）exact-match 不命中，
// 此类需消费方显式改用 t()；本模块第一期只保证静态串与属性的零侵入覆盖。

const LANG_KEY = "beiluLang";
const LOCALE_BASE = "/parts/shells:beilu-chat/locales/";
// [0727] data-tip 入表:daisyUI tooltip 组件的文案属性(backup.mjs 等 8 处中文 data-tip
// 此前不在覆盖范围=外语下不翻译);与 title 同为纯文案属性,同一 exact-match 键路径。
const TRANSLATABLE_ATTRS = ["title", "placeholder", "aria-label", "alt", "data-tip"];

let current = localStorage.getItem(LANG_KEY) || "zh-CN";
let dict = null;
const dictCache = {};
let langList = null;
let applying = false;

// 原文档案：文本节点 -> 原文；元素 -> { 属性名: 原值 }
const textOriginals = new Map();
const attrOriginals = new Map();

// 排除域分两个语义，别混用：
//   内容域 —— script/style 内是代码，textarea 内是用户输入，data-i18n-skip 是显式内容域（对话消息等）。文本一律不翻。
//   属性域 —— 只认 data-i18n-skip。textarea 的 placeholder/title 是 UI 文案（字典里本就收录着译文），必须能翻。
// 0727 根因修：原来只有一个排除函数且含 textarea，属性跟着内容一起被挡，导致全壳 53 处 textarea 可译属性
// （其中 28 处字典已有译文）永远取不到值 —— 死键。判据是字典收录本身证明设计意图要翻，缺的是机制。
function inSkippedTextSubtree(node) {
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return !!el?.closest?.("[data-i18n-skip], script, style, textarea");
}

function inSkippedAttrSubtree(node) {
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return !!el?.closest?.("[data-i18n-skip]");
}

function lookup(key) {
  if (!dict || !key) return undefined;
  return dict[key];
}

/**
 * 显式翻译函数（供 JS 动态文本改造用）。中文模式原样返回。
 * @param {string} text - 中文原文或字典键
 * @param {object} [params] - ${name} 插值参数
 * @returns {string}
 */
export function t(text, params) {
  let out = (current !== "zh-CN" && lookup(text)) || text;
  if (params) for (const [k, v] of Object.entries(params))
    out = out.replaceAll("${" + k + "}", v);
  return out;
}

export function getCurrentLang() {
  return current;
}

/** 可用语言清单（含中文本体）。list.json 缺失时只有中文。 */
export async function getAvailableLangs() {
  if (langList) return langList;
  let extra = [];
  try {
    const res = await fetch(LOCALE_BASE + "list.json");
    if (res.ok) extra = await res.json();
  } catch { /* 无清单=仅中文 */ }
  langList = [{ id: "zh-CN", name: "简体中文" }, ...extra.filter(l => l?.id && l.id !== "zh-CN")];
  return langList;
}

async function loadDict(lang) {
  if (dictCache[lang]) return dictCache[lang];
  const res = await fetch(LOCALE_BASE + lang + ".json");
  if (!res.ok) throw new Error(`locale ${lang} fetch failed: ${res.status}`);
  dictCache[lang] = await res.json();
  return dictCache[lang];
}

function translateTextNode(node) {
  const raw = node.nodeValue;
  if (!raw) return;
  const trimmed = raw.trim();
  if (!trimmed) return;
  const translated = lookup(textOriginals.get(node) ?? trimmed);
  if (translated === undefined) return;
  if (!textOriginals.has(node)) textOriginals.set(node, trimmed);
  const lead = raw.slice(0, raw.indexOf(trimmed[0]));
  const tail = raw.slice(lead.length + trimmed.length);
  const next = lead + translated + tail;
  if (node.nodeValue !== next) node.nodeValue = next;
}

function translateAttrs(el) {
  for (const attr of TRANSLATABLE_ATTRS) {
    const saved = attrOriginals.get(el)?.[attr];
    const raw = saved ?? el.getAttribute(attr);
    if (!raw) continue;
    const translated = lookup(raw);
    if (translated === undefined) continue;
    if (saved === undefined) {
      if (!attrOriginals.has(el)) attrOriginals.set(el, {});
      attrOriginals.get(el)[attr] = raw;
    }
    if (el.getAttribute(attr) !== translated) el.setAttribute(attr, translated);
  }
}

// data-i18n 键式（beilu-home 同形）：dict[key] 覆盖 textContent，dict[key.attr] 覆盖属性
function translateKeyed(el) {
  const key = el.dataset.i18n;
  if (!key) return;
  const text = lookup(key);
  if (text !== undefined) {
    const tn = [...el.childNodes].find(n => n.nodeType === Node.TEXT_NODE && n.nodeValue.trim());
    if (tn) {
      if (!textOriginals.has(tn)) textOriginals.set(tn, tn.nodeValue.trim());
      tn.nodeValue = text;
    } else if (!el.children.length) {
      const cur = el.textContent.trim();
      if (cur && !textOriginals.has(el)) textOriginals.set(el, cur);
      el.textContent = text;
    }
  }
  for (const attr of TRANSLATABLE_ATTRS) {
    const v = lookup(key + "." + attr);
    if (v === undefined) continue;
    const raw = el.getAttribute(attr);
    if (raw !== null && attrOriginals.get(el)?.[attr] === undefined) {
      if (!attrOriginals.has(el)) attrOriginals.set(el, {});
      attrOriginals.get(el)[attr] = raw;
    }
    if (raw !== v) el.setAttribute(attr, v);
  }
}

// textarea 子树被 walker 整体拒（内容=用户输入，不可翻），其可译属性因此走不到 translateAttrs
// —— 在同一收口处按属性域语义单独补一遍，不在各调用点散加特例。
function translateTextareaAttrs(root) {
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
  const list = [];
  if (root.nodeType === Node.ELEMENT_NODE && root.tagName === "TEXTAREA") list.push(root);
  if (root.querySelectorAll) list.push(...root.querySelectorAll("textarea"));
  for (const ta of list) {
    if (inSkippedAttrSubtree(ta)) continue;
    translateAttrs(ta);
    translateKeyed(ta);
  }
}

function translateTree(root) {
  applying = true;
  try {
    if (root.nodeType === Node.TEXT_NODE) {
      if (!inSkippedTextSubtree(root)) translateTextNode(root);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === Node.ELEMENT_NODE) {
          const tag = n.tagName;
          if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA") return NodeFilter.FILTER_REJECT;
          if (n.hasAttribute("data-i18n-skip")) return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    if (root.nodeType === Node.ELEMENT_NODE && !inSkippedAttrSubtree(root)) {
      translateAttrs(root);
      translateKeyed(root);
    }
    let n;
    while ((n = walker.nextNode()))
      if (n.nodeType === Node.TEXT_NODE) translateTextNode(n);
      else { translateAttrs(n); translateKeyed(n); }
    translateTextareaAttrs(root);
  } finally {
    applying = false;
  }
}

function restoreAll() {
  applying = true;
  try {
    for (const [node, original] of textOriginals) {
      if (node.isConnected === false) { textOriginals.delete(node); continue; }
      if (node.nodeType === Node.TEXT_NODE) {
        const raw = node.nodeValue ?? "";
        const trimmed = raw.trim();
        const lead = trimmed ? raw.slice(0, raw.indexOf(trimmed[0])) : raw;
        const tail = trimmed ? raw.slice(lead.length + trimmed.length) : "";
        node.nodeValue = lead + original + tail;
      } else node.textContent = original;
    }
    for (const [el, attrs] of attrOriginals) {
      if (!el.isConnected) { attrOriginals.delete(el); continue; }
      for (const [attr, v] of Object.entries(attrs)) el.setAttribute(attr, v);
    }
    textOriginals.clear();
    attrOriginals.clear();
  } finally {
    applying = false;
  }
}

const observer = new MutationObserver(muts => {
  if (applying || !dict) return;
  for (const m of muts) {
    if (m.type === "childList")
      // 属性域判据：新增的 textarea 自身要进（翻 placeholder），其内容仍由 translateTree 内的 walker 与文本域判据挡住
      m.addedNodes.forEach(node => { if (!inSkippedAttrSubtree(node)) translateTree(node); });
    else if (m.type === "characterData") {
      // JS 运行时写入了新文本：旧档案作废（原文已被消费方主动替换），按新值重新匹配
      textOriginals.delete(m.target);
      if (!inSkippedTextSubtree(m.target)) translateTextNode(m.target);
    } else if (m.type === "attributes" && m.target.nodeType === Node.ELEMENT_NODE) {
      const rec = attrOriginals.get(m.target);
      if (rec) delete rec[m.attributeName];
      if (!inSkippedAttrSubtree(m.target)) { translateAttrs(m.target); translateKeyed(m.target); }
    }
  }
});

function startObserver() {
  observer.observe(document.body, {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: [...TRANSLATABLE_ATTRS, "data-i18n"],
  });
}

/**
 * 切换语言。zh-CN=恢复原文并停表；其他=加载字典全量覆盖+观察动态节点。
 * @param {string} lang
 */
// 语言反映到文档根：CSS 按语言适配（字号/控件宽度/字体栈——译文长度差异的布局适配钩子，
// 规则写在 css 里选择器 html[data-beilu-lang="en"] 等）；lang 属性同步给 a11y/字体栈
function applyLangAttrs(lang) {
  document.documentElement.lang = lang;
  if (lang === "zh-CN") delete document.documentElement.dataset.beiluLang;
  else document.documentElement.dataset.beiluLang = lang;
}

export async function switchLang(lang) {
  if (lang === current) return;
  observer.disconnect();
  restoreAll();
  current = lang;
  localStorage.setItem(LANG_KEY, lang);
  applyLangAttrs(lang);
  if (lang !== "zh-CN") {
    try {
      dict = await loadDict(lang);
    } catch (e) {
      console.warn("[i18n] 字典加载失败，回退中文:", e);
      dict = null;
      current = "zh-CN";
      localStorage.setItem(LANG_KEY, current);
      applyLangAttrs(current);
      window.dispatchEvent(new CustomEvent("beilu-lang-change", { detail: { lang: current } }));
      return;
    }
    translateTree(document.body);
    startObserver();
  } else dict = null;
  window.dispatchEvent(new CustomEvent("beilu-lang-change", { detail: { lang } }));
}

/** 启动：恢复上次语言。中文=零行为。 */
export async function initI18n() {
  if (current === "zh-CN") return;
  const saved = current;
  current = "zh-CN"; // 让 switchLang 的同值早退失效，走完整加载
  await switchLang(saved);
}
