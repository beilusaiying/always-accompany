// langSlot.mjs — 设置面板·语言设置 slot（自 settingsSlots.mjs 拆出，2026-08-03，内容逐字搬迁）
import { sendAction } from "../../../shared/transport/sendAction.mjs";
import { storage, KEYS } from "../../../shared/state/storage.mjs";
import { getAvailableLangs, getCurrentLang, switchLang } from "../../../shared/i18n.mjs";
import { initTranslations } from "../../../../../../../scripts/i18n.mjs";

// ============================================================
// 语言设置 slot —— 覆盖式 i18n 消费方（0716 修复：旧实现写 beiluHomeLang（beilu-home 域键，
// 本壳零读方=死写）且选项硬编码 4 项、id(en-UK/ja-JP) 与覆盖式(en/ja) 不一致 → 切换无效。
// 现：选项 = shared/i18n.mjs getAvailableLangs()（locales/list.json 单源+中文本体），
// 写点 = switchLang()（beiluLang 唯一 owner，无刷新即时生效+派发 beilu-lang-change）。
// ============================================================

// fount 遗留 data-i18n（58处）读 userPreferredLanguages，其 locale id 为 en-UK/ja-JP 形制——继续同步写但做 id 映射
const FOUNT_LANG_MAP = { en: "en-UK", ja: "ja-JP" };

export async function initLanguageSlot() {
  const slot = document.getElementById("settings-language-slot");
  if (!slot) return;

  const langs = await getAvailableLangs();
  const current = getCurrentLang();

  slot.innerHTML = `
    <div class="space-y-3 mt-2">
      <div class="flex items-center gap-3">
        <span class="text-sm font-medium">界面语言</span>
        <select id="settings-lang-select" class="select select-sm select-bordered w-40">
          ${langs.map(o =>
            `<option value="${o.id}" ${o.id === current ? "selected" : ""}>${o.name}</option>`
          ).join("")}
        </select>
      </div>
      <p class="text-xs text-base-content/50">切换后立即生效</p>
    </div>
  `;

  slot.querySelector("#settings-lang-select")?.addEventListener("change", async (e) => {
    const lang = e.target.value;
    await switchLang(lang); // 唯一写点：beiluLang + 覆盖/恢复 DOM + 派发 beilu-lang-change（wiki 同步刷新）
    localStorage.setItem("beiluLangChosen", "1");
    // fount 遗留链（data-i18n 58处 + chat.beiluChat.* 113键）：写 userPreferredLanguages 后必须重跑
    // initTranslations 才会重翻——旧实现靠整页 reload 达成，reload 已删，此处显式重拉（断链补接 0716）
    try { storage.set(KEYS.USERPREFERREDLANGUAGES, JSON.stringify([FOUNT_LANG_MAP[lang] || lang])); } catch {}
    initTranslations().catch(() => { /* fount 域翻不动不阻塞覆盖式主链 */ });
    sendAction({ verb: "setSetting", target: "server:user", source: "web", payload: { key: "language", value: lang } }).catch(() => {});
  });

  // 其他入口（首次登录选择层等）切语言时同步本下拉选中态
  window.addEventListener("beilu-lang-change", (e) => {
    const sel = slot.querySelector("#settings-lang-select");
    const lang = e.detail?.lang;
    if (sel && lang && [...sel.options].some(o => o.value === lang)) sel.value = lang;
  });
}
