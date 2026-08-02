/**
 * [runP9.mjs] — P9 词库维护 AI 的固定 CLI 入口（002 0731拍板"固定到一个地方,直接cli"）
 *
 * 功能链：
 *   node src/scripts/runP9.mjs --char=<角色名> [--host=http://127.0.0.1:1314] [--apikey=<key>] [--dry]
 *     → POST /api/parts/plugins:beilu-memory/config/setdata {_action:"runMemoryPreset", presetId:"P9"}
 *     → 运行中的宿主 runMemoryPresetAI(P9) → <memorySearch> 读记忆 / <vocab_edit> 预览→确认写词库
 *     → 打印 AI 最终回复与执行操作统计
 *
 * why 走 HTTP 而非 in-process import：runMemoryPresetAI 依赖已 bootstrap 的服务器上下文
 *   （parts_loader/AI 源加载），脱离运行中的 server 单独 import 会卡 init（live 链路教训）。
 *   鉴权用系统现成 x-api-key（auth.mjs verifyApiKey）——key 由 002 在 apiKeys 管理生成，
 *   也可用 --cookie 传浏览器登录态 cookie 调试。
 * 影响范围：纯外部脚本，零生产代码依赖；宿主未运行/未鉴权时如实报错退出非 0。
 * 前置：P9 预设已创建（P1「P9 维护」面板一键创建，或 createMemoryPreset verb）。
 */

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const i = a.indexOf("=");
    return i === -1 ? [a.slice(2), true] : [a.slice(2), a.slice(i + 1)];
  }),
);

const host = args.host || "http://127.0.0.1:1314";
const charName = args.char || "";
if (!charName) {
  console.error("用法: node src/scripts/runP9.mjs --char=<角色名> [--host=http://127.0.0.1:1314] [--apikey=<key>|--cookie=<cookie>] [--dry]");
  process.exit(1);
}

const headers = { "Content-Type": "application/json" };
if (args.apikey) headers["x-api-key"] = String(args.apikey);
if (args.cookie) headers["Cookie"] = String(args.cookie);

const body = {
  _action: "runMemoryPreset",
  presetId: "P9",
  charDisplayName: charName,
  userDisplayName: "用户",
  chatHistory: "", // 最近对话由 P9 自己经 <memorySearch> 工具取，CLI 场景无 DOM 可拼
  dryRun: args.dry === true || args.dry === "true",
};

try {
  const res = await fetch(`${host}/api/parts/plugins:beilu-memory/config/setdata`, {
    method: "POST", headers, body: JSON.stringify(body),
  });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch { j = null; }
  if (!res.ok || !j) {
    console.error(`[runP9] HTTP ${res.status}:`, text.slice(0, 500));
    process.exit(1);
  }
  if (j.success === false) {
    console.error("[runP9] 失败:", j.error || JSON.stringify(j).slice(0, 500));
    process.exit(1);
  }
  console.log("═══ P9 词库维护运行结果 ═══");
  if (j.reply) console.log(j.reply);
  // runMemoryPreset 返回 {success, ...runMemoryPresetAI结果}：工具操作在 operations（=allExecutedOps）
  const vocabOps = (j.operations || j.executedOps || []).filter((o) => o?.type === "vocabEdit");
  if (vocabOps.length) {
    console.log("\n── 词库改动 ──");
    for (const op of vocabOps) for (const r of op.results || []) {
      console.log(`  [${r.status}] ${r.file || ""} +${r.added ?? "?"} -${r.removed ?? "?"} ~${r.modified ?? "?"} ${r.reason || ""}`);
    }
  } else {
    console.log("\n(本次无词库改动操作)");
  }
  process.exit(0);
} catch (e) {
  console.error("[runP9] 请求失败（宿主未运行?）:", e?.message || e);
  process.exit(1);
}
