// 从单源 locales/*.json 生成 webview-ui/locales/*.js（webview CSP 禁内联，字典须走静态 script）
// 用法：node scripts/gen-webview-locales.js（改 locales/*.json 后重跑）
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const srcDir = path.join(root, "locales");
const outDir = path.join(root, "webview-ui", "locales");
fs.mkdirSync(outDir, { recursive: true });
for (const f of fs.readdirSync(srcDir)) {
  if (!f.endsWith(".json")) continue;
  const lang = f.slice(0, -5);
  const dict = JSON.parse(fs.readFileSync(path.join(srcDir, f), "utf8"));
  fs.writeFileSync(
    path.join(outDir, lang + ".js"),
    "// generated from locales/" + f + " — do not edit; run scripts/gen-webview-locales.js\n" +
    "window.YB_LANG=" + JSON.stringify(lang) + ";\n" +
    "window.YB_DICT=" + JSON.stringify(dict) + ";\n",
  );
  console.log(lang + ".js <-", f, Object.keys(dict).length, "keys");
}
