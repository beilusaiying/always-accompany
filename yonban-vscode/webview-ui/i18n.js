// YonBan webview 覆盖式 i18n（beilu 多语言体系：中文原文=本体，外语=差量字典覆盖）
// 机制：以中文原文整串为键 exact-match 覆盖文本节点/title/placeholder/aria-label 属性；
//   MutationObserver 兜住动态写入（showToast/textContent=/innerHTML= 都会产生 mutation）。
// 语言与字典由扩展进程注入（YonBanProvider.getHtmlContent 内联 window.YB_LANG / window.YB_DICT，
//   语言取 vscode.env.language 映射；zh-cn 或无字典时本文件零行为）。
// 与 beilu-chat 壳 shared/i18n.mjs 同范式；差异：VSCode 显示语言会话内不变，无需原文恢复层。
(function () {
  "use strict";
  window.YB = window.YB || {};

  const dict = window.YB_DICT || null;
  const lang = window.YB_LANG || "zh-cn";

  function t(text, params) {
    let out = (dict && dict[text]) || text;
    if (params) for (const k of Object.keys(params))
      out = out.split("${" + k + "}").join(params[k]);
    return out;
  }
  window.YB.i18n = { t, lang };

  if (!dict || lang === "zh-cn" || lang === "zh") return; // 中文本体：零行为

  const ATTRS = ["title", "placeholder", "aria-label"];

  function translateTextNode(node) {
    const raw = node.nodeValue;
    if (!raw) return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    const translated = dict[trimmed];
    if (translated === undefined || translated === trimmed) return;
    const lead = raw.slice(0, raw.indexOf(trimmed[0]));
    const tail = raw.slice(lead.length + trimmed.length);
    node.nodeValue = lead + translated + tail;
  }

  function translateAttrs(el) {
    for (const attr of ATTRS) {
      const v = el.getAttribute(attr);
      if (!v) continue;
      const translated = dict[v];
      if (translated !== undefined && translated !== v) el.setAttribute(attr, translated);
    }
  }

  let applying = false;

  function translateTree(root) {
    applying = true;
    try {
      if (root.nodeType === Node.TEXT_NODE) { translateTextNode(root); return; }
      if (root.nodeType !== Node.ELEMENT_NODE) return;
      const tag = root.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA") return;
      translateAttrs(root);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
          if (n.nodeType === Node.ELEMENT_NODE) {
            const t2 = n.tagName;
            if (t2 === "SCRIPT" || t2 === "STYLE" || t2 === "TEXTAREA") return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let n;
      while ((n = walker.nextNode()))
        if (n.nodeType === Node.TEXT_NODE) translateTextNode(n);
        else translateAttrs(n);
    } finally {
      applying = false;
    }
  }

  const observer = new MutationObserver(function (muts) {
    if (applying) return;
    for (const m of muts) {
      if (m.type === "childList") m.addedNodes.forEach(function (node) { translateTree(node); });
      else if (m.type === "characterData") { applying = true; try { translateTextNode(m.target); } finally { applying = false; } }
      else if (m.type === "attributes" && m.target.nodeType === Node.ELEMENT_NODE) {
        applying = true; try { translateAttrs(m.target); } finally { applying = false; }
      }
    }
  });

  function start() {
    translateTree(document.body);
    observer.observe(document.body, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ATTRS,
    });
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);
})();
