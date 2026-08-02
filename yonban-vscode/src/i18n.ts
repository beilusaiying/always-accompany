/**
 * i18n.ts -- 扩展主进程国际化（vscode.window.showXxxMessage / showInputBox / statusBar 等原生 UI 串）。
 * webview DOM 有独立覆盖式 i18n（webview-ui/i18n.js），此模块不覆盖 webview，只管主进程。
 *
 * 链路：activate() → initI18n(extensionPath) → 读 locales/{uiLang}.json → dict
 *       t("中文原文") → dict 命中返翻译 / 未命中返原文（中文本体零行为）
 *       t("模板 ${key}", { key: value }) → 参数化替换
 * 影响：只读 locales/*.json，无副作用
 * 相交：← extension.ts activate() 调 initI18n
 *       ← extension.ts / AuthService.ts / IdeWsServer.ts / YonBanProvider.ts / ConnectionService.ts 调 t()
 *       ← locales/en.json, ja.json, zh-TW.json（字典单源）
 *
 * uiLang 映射口径与 YonBanProvider.ts webview 覆盖式一致：
 *   zh-tw / zh-hant → zh-TW | zh* → zh-cn（本体，不加载） | ja → ja | 其他 → en
 */
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

let dict: Record<string, string> | null = null;

/** 初始化主进程 i18n（activate 最早处调用一次）。zh-cn = 中文本体，零行为不加载字典。 */
export function initI18n(extensionPath: string): void {
  const vsLang = vscode.env.language.toLowerCase();
  const uiLang = vsLang.startsWith("zh-tw") || vsLang.startsWith("zh-hant") ? "zh-TW"
    : vsLang.startsWith("zh") ? "zh-cn" : vsLang.startsWith("ja") ? "ja" : "en";
  if (uiLang === "zh-cn") return; // 中文本体：零行为
  try {
    dict = JSON.parse(fs.readFileSync(path.join(extensionPath, "locales", `${uiLang}.json`), "utf8"));
  } catch { dict = null; } // 字典缺失 = 诚实降级回中文
}

/** 翻译文本。dict 命中返翻译，未命中返原文。支持 ${key} 参数化替换。 */
export function t(text: string, params?: Record<string, string | number>): string {
  let out = (dict && dict[text]) || text;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      out = out.split("${" + k + "}").join(String(v));
    }
  }
  return out;
}
