const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph"]);

const NAMED_CODES = Object.freeze({
  Space: "Space",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
});

/** 把真实 KeyboardEvent 规整为 Electron globalShortcut accelerator。 */
export function acceleratorFromKeyboardEvent(event) {
  if (!event || typeof event !== "object") return { error: "没有收到按键" };
  if (event.key === "Escape") return { cancelled: true };
  if (MODIFIER_KEYS.has(event.key)) return { pending: true };

  const code = String(event.code || "");
  let key = "";
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
  else key = NAMED_CODES[code] || "";
  if (!key) return { error: "这个按键暂不支持，请使用字母、数字、F1-F24 或常用功能键" };

  const modifiers = [];
  if (event.ctrlKey) modifiers.push("Ctrl");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (event.metaKey) modifiers.push("Super");
  if (!modifiers.length && !/^F\d+$/.test(key)) {
    return { error: "请至少同时按住 Ctrl、Alt、Shift 或 Win 中的一个，避免误触" };
  }
  return { accelerator: [...modifiers, key].join("+") };
}
