import { renderMarkdownAsString } from "../../../../../../scripts/markdown.mjs";

const WIKI_BASE = "/parts/shells:beilu-chat/wiki/";
// 覆盖式多语言：中文原文=默认语言；非中文时优先取 locales/{lang}/ 同路径覆盖层，缺失回退中文原文
const LANG_KEY = "beiluLang";
let _lang = localStorage.getItem(LANG_KEY) || "zh-CN";
let _rootIndex = null;
let _index = null;
let _indexLang = null;
let _currentFile = null;
let _audienceFilter = "user";
const _cache = {};

const ICON_MAP = {
  rocket: "🚀", layers: "📑", code: "⚙", brain: "🧠", book: "📖",
  inject: "💉", settings: "🎛", zap: "⚡", lightbulb: "💡",
  plug: "🔌", shield: "🛡", wrench: "🔧"
};

async function fetchRootIndex() {
  if (_rootIndex) return _rootIndex;
  const res = await fetch(WIKI_BASE + "index.json");
  if (!res.ok) throw new Error("wiki index fetch failed: " + res.status);
  _rootIndex = await res.json();
  return _rootIndex;
}

async function fetchIndex() {
  if (_index && _indexLang === _lang) return _index;
  _index = await fetchRootIndex();
  if (_lang !== "zh-CN") try {
    const res = await fetch(WIKI_BASE + "locales/" + _lang + "/index.json");
    if (res.ok) _index = await res.json();
  } catch { /* 覆盖层缺失，回退中文 */ }
  _indexLang = _lang;
  return _index;
}

function handleNavClick(href) {
  if (!href) return false;
  if (href.startsWith("beilu:")) {
    const path = href.slice(6);
    const [domain, ...rest] = path.split("/");
    const target = rest.join("/");
    if (domain === "settings") {
      document.querySelector(`.settings-activity-bar [data-settings-section="${target}"]`)?.click();
    } else if (domain === "mode") {
      const { switchTab } = window.__beiluLayout || {};
      if (switchTab) switchTab(target);
      document.querySelector("#settings-modal .modal-close, #settings-modal [data-close]")?.click();
    } else if (domain === "editor") {
      window.dispatchEvent(new CustomEvent("beilu:openEditorTab", { detail: target }));
      document.querySelector("#settings-modal .modal-close, #settings-modal [data-close]")?.click();
    } else if (domain === "wiki") {
      loadPage(target);
    }
    return true;
  }
  if (href.endsWith(".md")) {
    const resolved = _currentFile ? new URL(href, "http://x/" + _currentFile).pathname.slice(1) : href;
    loadPage(resolved);
    return true;
  }
  return false;
}

function updateBreadcrumb(filePath) {
  const bc = document.getElementById("wiki-breadcrumb");
  if (!bc || !_index) return;
  if (!filePath) { bc.innerHTML = ""; return; }
  let chapterTitle = "", pageTitle = "";
  for (const ch of _index.tree) {
    const found = (ch.children || []).find(c => c.file === filePath);
    if (found) { chapterTitle = ch.title; pageTitle = found.title; break; }
  }
  bc.innerHTML = `<span class="wiki-bc-home" title="首页">📖</span><span class="wiki-bc-sep">›</span><span class="wiki-bc-chapter">${chapterTitle}</span><span class="wiki-bc-sep">›</span><span class="wiki-bc-page">${pageTitle}</span>`;
  bc.querySelector(".wiki-bc-home")?.addEventListener("click", () => { _currentFile = null; showHomepage(); });
}

function showHomepage() {
  const contentEl = document.getElementById("wiki-content-area");
  if (!contentEl || !_index) return;
  const cards = _index.tree.map(ch => {
    const icon = ICON_MAP[ch.icon] || "📄";
    const count = (ch.children || []).filter(c => matchAudience(c.audience)).length;
    if (count === 0) return "";
    const firstFile = (ch.children || []).find(c => matchAudience(c.audience))?.file;
    return `<div class="wiki-home-card" data-file="${firstFile || ""}"><div class="wiki-home-icon">${icon}</div><div class="wiki-home-title">${ch.title}</div><div class="wiki-home-count">${count} 篇</div></div>`;
  }).join("");
  contentEl.innerHTML = `<div class="wiki-homepage"><h2 class="wiki-home-heading">${_index.title || "beilu 使用手册"}</h2><div class="wiki-home-grid">${cards}</div></div>`;
  contentEl.querySelectorAll(".wiki-home-card[data-file]").forEach(card => {
    card.addEventListener("click", () => { if (card.dataset.file) loadPage(card.dataset.file); });
  });
  updateBreadcrumb(null);
}

async function loadPage(filePath, force = false) {
  if (!force && _currentFile === filePath) return;
  _currentFile = filePath;
  const contentEl = document.getElementById("wiki-content-area");
  if (!contentEl) return;
  contentEl.innerHTML = '<p class="text-xs opacity-40">加载中...</p>';

  try {
    let res = null;
    if (_lang !== "zh-CN")
      res = await fetch(WIKI_BASE + "locales/" + _lang + "/" + filePath).catch(() => null);
    if (!res?.ok) res = await fetch(WIKI_BASE + filePath);
    if (!res.ok) {
      contentEl.innerHTML = `<p class="text-sm text-error">页面不存在: ${filePath}</p>`;
      return;
    }
    const md = await res.text();
    const html = await renderMarkdownAsString(md, _cache, { trusted: true });
    contentEl.innerHTML = `<article class="wiki-article prose prose-sm max-w-none">${html}</article>`;
    contentEl.querySelectorAll("a[href]").forEach(a => {
      const href = a.getAttribute("href");
      if (href?.startsWith("beilu:") || href?.endsWith(".md")) {
        a.classList.add("wiki-nav-link");
        a.addEventListener("click", e => { e.preventDefault(); handleNavClick(href); });
      }
    });
    contentEl.scrollTop = 0;
  } catch (e) {
    contentEl.innerHTML = `<p class="text-sm text-error">加载失败: ${e.message}</p>`;
  }

  updateBreadcrumb(filePath);
  document.querySelectorAll("#wiki-sidebar .wiki-item").forEach(el => {
    el.classList.toggle("wiki-item-active", el.dataset.file === filePath);
  });
  const activeItem = document.querySelector("#wiki-sidebar .wiki-item-active");
  if (activeItem) {
    const sec = activeItem.closest(".wiki-section");
    if (sec && !sec.classList.contains("wiki-section-open")) sec.classList.add("wiki-section-open");
  }
}

function matchAudience(itemAudience) {
  if (!itemAudience || itemAudience.length === 0) return true;
  return itemAudience.includes(_audienceFilter);
}

function renderSidebar(tree) {
  const sidebar = document.getElementById("wiki-sidebar");
  if (!sidebar) return;
  sidebar.innerHTML = "";

  for (const chapter of tree) {
    const visibleChildren = (chapter.children || []).filter(c => matchAudience(c.audience));
    if (visibleChildren.length === 0) continue;

    const section = document.createElement("div");
    section.className = "wiki-section";
    const icon = ICON_MAP[chapter.icon] || "";

    const header = document.createElement("div");
    header.className = "wiki-section-header";
    header.innerHTML = `<span class="wiki-chevron">&#9654;</span><span class="wiki-section-icon">${icon}</span><span>${chapter.title}</span>`;
    header.addEventListener("click", () => {
      section.classList.toggle("wiki-section-open");
    });
    section.appendChild(header);

    const list = document.createElement("div");
    list.className = "wiki-section-list";

    for (const item of visibleChildren) {
      const el = document.createElement("div");
      el.className = "wiki-item";
      el.textContent = item.title;
      el.dataset.file = item.file;
      el.addEventListener("click", () => loadPage(item.file));
      list.appendChild(el);
    }

    section.appendChild(list);
    sidebar.appendChild(section);
  }
}

function filterSidebar(query) {
  if (!_index) return;
  const q = query.trim().toLowerCase();
  document.querySelectorAll("#wiki-sidebar .wiki-section").forEach(sec => {
    let anyVisible = false;
    sec.querySelectorAll(".wiki-item").forEach(item => {
      const match = !q || item.textContent.toLowerCase().includes(q);
      item.style.display = match ? "" : "none";
      if (match) anyVisible = true;
    });
    sec.style.display = anyVisible ? "" : "none";
    if (q && anyVisible) sec.classList.add("wiki-section-open");
  });
}

export async function initWiki() {
  const container = document.querySelector('.settings-section[data-section="wiki"]');
  if (!container) return;

  container.innerHTML = `
    <div class="wiki-layout">
      <div class="wiki-sidebar-wrapper">
        <div class="wiki-toolbar">
          <input type="text" id="wiki-search" class="input input-xs input-bordered w-full" placeholder="搜索...">
          <div class="wiki-audience-tabs">
            <button class="wiki-aud-btn wiki-aud-active" data-aud="user">使用者</button>
            <button class="wiki-aud-btn" data-aud="beginner">新手</button>
            <button class="wiki-aud-btn" data-aud="developer">开发者</button>
          </div>
          <select id="wiki-lang" class="select select-xs select-bordered w-full" style="display:none"></select>
        </div>
        <div id="wiki-sidebar" class="wiki-sidebar"></div>
      </div>
      <div class="wiki-main">
        <div id="wiki-breadcrumb" class="wiki-breadcrumb"></div>
        <div id="wiki-content-area" class="wiki-content"></div>
      </div>
    </div>
  `;

  container.querySelectorAll(".wiki-aud-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      _audienceFilter = btn.dataset.aud;
      container.querySelectorAll(".wiki-aud-btn").forEach(b => b.classList.toggle("wiki-aud-active", b === btn));
      renderSidebar(_index.tree);
      _currentFile = null;
      showHomepage();
    });
  });

  document.getElementById("wiki-search").addEventListener("input", e => filterSidebar(e.target.value));

  try {
    const index = await fetchIndex();
    initLangSelector();
    renderSidebar(index.tree);
    showHomepage();
  } catch (e) {
    container.querySelector("#wiki-sidebar").innerHTML = `<p class="text-xs text-error p-2">加载目录失败: ${e.message}</p>`;
  }
}

// 壳覆盖式 i18n（shared/i18n.mjs）切语言时同步 wiki（同一 beiluLang 键，事件驱动刷新已打开的面板）
window.addEventListener("beilu-lang-change", async (e) => {
  const lang = e.detail?.lang;
  if (!lang || lang === _lang) return;
  _lang = lang === "zh-cn" ? "zh-CN" : lang;
  const sel = document.getElementById("wiki-lang");
  if (sel && [...sel.options].some(o => o.value === _lang)) sel.value = _lang;
  if (!_index) return; // wiki 未初始化过，无需刷新
  const index = await fetchIndex();
  renderSidebar(index.tree);
  if (_currentFile) { loadPage(_currentFile, true); updateBreadcrumb(_currentFile); }
  else showHomepage();
});

function initLangSelector() {
  const sel = document.getElementById("wiki-lang");
  if (!sel) return;
  const langs = _rootIndex?.languages;
  if (!Array.isArray(langs) || langs.length < 2) return;
  if (!langs.some(l => l.id === _lang)) _lang = "zh-CN";
  sel.innerHTML = langs.map(l => `<option value="${l.id}"${l.id === _lang ? " selected" : ""}>${l.name}</option>`).join("");
  sel.style.display = "";
  sel.addEventListener("change", async () => {
    _lang = sel.value;
    localStorage.setItem(LANG_KEY, _lang);
    const index = await fetchIndex();
    renderSidebar(index.tree);
    if (_currentFile) {
      loadPage(_currentFile, true);
      updateBreadcrumb(_currentFile);
    } else showHomepage();
  });
}
