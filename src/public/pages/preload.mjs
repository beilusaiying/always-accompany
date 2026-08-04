document.documentElement.dataset.theme =
  localStorage.getItem("beilu-color-scheme") ||
  localStorage.getItem("theme") ||
  (window.matchMedia?.("(prefers-color-scheme: dark)")?.matches
    ? "dark"
    : "light");

// 字号防闪烁：UI、长文和等宽内容是三条独立偏好。
// 旧 beilu-font-size 只属于 content；不能再写 html.style.fontSize 压住 UI token。
const _legacyContentSizeNames = { xsmall: 11, small: 12, medium: 14, mlarge: 15, large: 16 };

function _readFontSizePreference(key, min, max, fallback, legacyNames = null) {
  let raw;
  try {
    raw = localStorage.getItem(key);
  } catch (error) {
    console.warn(`[beilu-preload] 无法读取字号设置 ${key}，使用默认值 ${fallback}px`, error);
    return fallback;
  }
  if (raw === null || raw === "") return fallback;
  const parsed = legacyNames?.[raw] ?? Number(raw);
  if (!Number.isFinite(parsed)) {
    console.warn(`[beilu-preload] 字号设置 ${key}=${JSON.stringify(raw)} 无效，使用默认值 ${fallback}px`);
    return fallback;
  }
  const clamped = Math.min(max, Math.max(min, Math.round(parsed)));
  if (clamped !== parsed) {
    console.warn(`[beilu-preload] 字号设置 ${key}=${parsed} 超出范围，限制为 ${clamped}px`);
  }
  return clamped;
}

const _fontRoot = document.documentElement;
const _uiFontSize = _readFontSizePreference("beilu-ui-font-size", 14, 20, 16);
const _contentFontSize = _readFontSizePreference("beilu-font-size", 12, 20, 14, _legacyContentSizeNames);
const _monoFontSize = _readFontSizePreference("beilu-mono-font-size", 12, 22, 14);

_fontRoot.style.setProperty("--beilu-font-size-ui", `${_uiFontSize}px`);
_fontRoot.style.setProperty("--beilu-font-size-content", `${_contentFontSize}px`);
_fontRoot.style.setProperty("--beilu-font-size-mono", `${_monoFontSize}px`);
_fontRoot.style.setProperty("--beilu-font-size", `${_contentFontSize}px`);

// 字体族同样在首帧恢复；UI 与阅读内容跟随用户设置，mono 继续由等宽角色独立管理。
try {
  const _savedFontFamily = localStorage.getItem("beilu-font-family")?.trim();
  if (_savedFontFamily) {
    _fontRoot.style.setProperty("--beilu-font-ui", _savedFontFamily);
    _fontRoot.style.setProperty("--beilu-font-content", _savedFontFamily);
    _fontRoot.style.setProperty("--beilu-font-family", _savedFontFamily);
  }
} catch (error) {
  console.warn("[beilu-preload] 无法读取系统字体设置，使用默认字体", error);
}
