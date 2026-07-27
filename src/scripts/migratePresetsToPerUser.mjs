/**
 * migratePresetsToPerUser.mjs — [T065 期4] 一次性预设存量迁移脚本（旧全局单份 → per-user data/users/<user>/presets/）。
 *
 * 【为什么】T065 把预设内容池从全局单份（public/parts/plugins/beilu-preset/{presets,registry.json,config.json,
 *   runtime_params.json}）迁到 per-user（data/users/<user>/presets/）。新用户走惰性播种（seedBuiltinsForUser，只播 builtin，
 *   过滤个人存量）；但凛倾的**存量**（自建 source=user 预设 + 个人预设(017) + 改过的激活态/active_preset_map/runtime 参数）需一次性搬进
 *   data/users/凛倾/presets/，否则凛倾登录后只看到播种的 builtin、丢失个人预设(017)与自建预设与激活态。
 *
 * 【迁移语义】（对齐 T065 规划四·五，禁运行时旧路径回退）
 *   - builtin 预设（registry source=builtin）：不迁（凛倾首访由惰性播种从 DEFAULTS_DIR 补齐，含其 deleted_builtins 尊重）。
 *   - user 预设（registry source=user，含个人预设(017) 017…）：copy 进凛倾 presets/ + 重建凛倾 registry 对应条目。
 *   - beilu-memory 生成的预设（source=beilu-memory）：同 user 类，属凛倾存量，迁入。
 *   - 全局 config.json 的 active_preset / active_preset_map / deleted_builtins：整体搬进凛倾 config.json（凛倾的窗口态与删除态）。
 *   - 全局 runtime_params.json：搬进凛倾 runtime_params.json（凛倾的采样/上下文覆盖）。
 *   - 个人预设(017)已在全局 deleted_builtins → 迁移后仍在凛倾 deleted_builtins，但个人预设(017)作为 user 预设文件已实体迁入，凛倾可正常使用
 *     （deleted_builtins 只挡「builtin 播种复活」，不挡实体 user 预设）。
 *
 * 【安全】
 *   - 幂等：写完成标记 data/users/<user>/presets/.t065_migrated；已存在则跳过（防重复覆盖用户后续改动）。
 *   - 非破坏：只 copy，不删旧全局目录（旧目录退役=期5，需凛倾授权+D盘备份，本脚本不做）。
 *   - 运行前请先 D 盘备份全局目录（本脚本不自动备份）。
 *
 * 【执行方式】（server 停时 / 启动钩子，禁在凛倾测试中启停 server）
 *   deno run -A src/scripts/migratePresetsToPerUser.mjs 凛倾
 *   或 node（需 --experimental 视版本）。默认 targetUser=凛倾，可传参覆盖。
 *   本脚本**落盘可跑但默认不执行**——由凛倾在 server 停时手动运行，或挂进 login/启动钩子。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/scripts → 上 1 级 src → public/parts/plugins/beilu-preset（旧全局目录）
const GLOBAL_PRESET_DIR = path.resolve(__dirname, "..", "public", "parts", "plugins", "beilu-preset");
const GLOBAL_PRESETS = path.join(GLOBAL_PRESET_DIR, "presets");
const GLOBAL_REGISTRY = path.join(GLOBAL_PRESET_DIR, "registry.json");
const GLOBAL_CONFIG = path.join(GLOBAL_PRESET_DIR, "config.json");
const GLOBAL_RUNTIME = path.join(GLOBAL_PRESET_DIR, "runtime_params.json");
// data/users 根：src/scripts → 上 2 级 到项目根 → data/users
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
function userPresetDir(username) {
  return path.join(PROJECT_ROOT, "data", "users", username, "presets");
}

function readJson(f, fallback) {
  try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf-8")); } catch (e) { console.warn(`读取 ${f} 失败: ${e.message}`); }
  return fallback;
}
function writeJson(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data, null, 2), "utf-8");
}

function migrate(targetUser) {
  const destDir = userPresetDir(targetUser);
  const marker = path.join(destDir, ".t065_migrated");
  if (fs.existsSync(marker)) {
    console.log(`[T065-migrate] 用户 "${targetUser}" 已迁移（标记存在），跳过。`);
    return { skipped: true };
  }
  if (!fs.existsSync(GLOBAL_REGISTRY)) {
    console.log(`[T065-migrate] 全局 registry 不存在（${GLOBAL_REGISTRY}），无存量可迁，仅写标记。`);
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString(), "utf-8");
    return { migrated: 0 };
  }

  fs.mkdirSync(destDir, { recursive: true });
  const gReg = readJson(GLOBAL_REGISTRY, { presets: {} });
  const gCfg = readJson(GLOBAL_CONFIG, {});
  const destReg = readJson(path.join(destDir, "registry.json"), { presets: {} });
  if (!destReg.presets) destReg.presets = {};

  let migrated = 0;
  for (const [name, entry] of Object.entries(gReg.presets || {})) {
    // 只迁个人存量：source ∈ {user, beilu-memory}（含个人预设(017) source=user）。builtin 走惰性播种，不迁。
    if (entry?.source === "builtin") continue;
    if (!entry?.file) continue;
    const srcFile = path.join(GLOBAL_PRESETS, entry.file);
    if (!fs.existsSync(srcFile)) { console.warn(`[T065-migrate] 存量文件缺失，跳过: ${entry.file}`); continue; }
    const destFile = path.join(destDir, entry.file);
    if (!fs.existsSync(destFile)) fs.copyFileSync(srcFile, destFile);
    destReg.presets[name] = { ...entry }; // 保留 source/description/时间戳
    migrated++;
    console.log(`[T065-migrate] 迁入个人预设: "${name}" (source=${entry.source})`);
  }
  writeJson(path.join(destDir, "registry.json"), destReg);

  // 迁 config.json：active_preset / active_preset_map / deleted_builtins（凛倾的激活态+窗口态+删除态）
  const destCfg = readJson(path.join(destDir, "config.json"), {});
  if (gCfg.active_preset) destCfg.active_preset = gCfg.active_preset;
  if (gCfg.default_preset) destCfg.default_preset = gCfg.default_preset;
  if (gCfg.active_preset_map) destCfg.active_preset_map = { ...(destCfg.active_preset_map || {}), ...gCfg.active_preset_map };
  if (gCfg.deleted_builtins) destCfg.deleted_builtins = Array.from(new Set([...(destCfg.deleted_builtins || []), ...gCfg.deleted_builtins]));
  destCfg.auto_seed_defaults = true;
  writeJson(path.join(destDir, "config.json"), destCfg);

  // 迁 runtime_params.json（凛倾的采样/上下文覆盖）
  if (fs.existsSync(GLOBAL_RUNTIME) && !fs.existsSync(path.join(destDir, "runtime_params.json"))) {
    fs.copyFileSync(GLOBAL_RUNTIME, path.join(destDir, "runtime_params.json"));
    console.log(`[T065-migrate] 迁入 runtime_params.json`);
  }

  fs.writeFileSync(marker, new Date().toISOString(), "utf-8");
  console.log(`[T065-migrate] 用户 "${targetUser}" 迁移完成: ${migrated} 个个人预设 + config/runtime。旧全局目录未删（期5 授权后处理）。`);
  return { migrated };
}

// CLI 入口（默认凛倾）——落盘可跑但需手动触发，不在 import 时自动执行。
const _isMain = (() => {
  try { return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]); } catch { return false; }
})();
if (_isMain) {
  const targetUser = process.argv[2] || "凛倾";
  migrate(targetUser);
}

export { migrate };
