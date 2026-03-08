document.documentElement.dataset.theme =
  localStorage.getItem("theme") ||
  (window.matchMedia?.("(prefers-color-scheme: dark)")?.matches
    ? "dark"
    : "light");

// 字体大小防闪烁：在渲染前应用 font-size 到 <html>
const _fs = localStorage.getItem("beilu-font-size");
if (_fs) {
  // 兼容旧版字符串值
  const _nameMap = { xsmall: 11, small: 12, medium: 14, mlarge: 15, large: 16 };
  const _px = _nameMap[_fs] || parseInt(_fs, 10) || 14;
  if (_px !== 14) {
    document.documentElement.style.fontSize = `${_px}px`;
  }
}
