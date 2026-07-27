/**
 * crawlProbe.mjs — Playwright 可用性检测 + 自动安装。
 *
 * 浏览器爬取是增强功能：Playwright 包 + Chromium 内核（~150MB）。
 * 纯 fetch 拿不到 JS 渲染的搜索结果，真浏览器才行。
 *
 * 检测两层：① playwright 包可定位（node_modules） ② 浏览器内核二进制已下载
 *
 * 内核下载位置优先级：configPath > PLAYWRIGHT_BROWSERS_PATH env > <cwd>/browsers（项目根目录）。
 * 检测会同时检查项目根目录和系统默认位置（AppData），任一有即可用。
 * 自动安装目标始终是项目根目录（不装到 C 盘系统目录）。
 *
 * 导出：
 *   probeCrawlCapability(configPath?) → { available, checks, missing, browsersDir, summary }
 *   ensureBrowsers(configPath?) → Promise<{ available, dir }> — 检测不到则自动安装
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 目标内核目录（安装目标）。优先级：configPath > env > <cwd>/browsers */
export function browsersDir(configPath) {
  if (configPath && typeof configPath === "string" && configPath.trim()) return configPath.trim();
  const override = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (override && override !== "0") return override;
  return path.join(process.cwd(), "browsers");
}

/** 系统默认内核目录（仅用于兼容检测，不作为安装目标） */
function _systemBrowsersDir() {
  const home = os.homedir();
  switch (process.platform) {
    case "win32":
      return path.join(home, "AppData", "Local", "ms-playwright");
    case "darwin":
      return path.join(home, "Library", "Caches", "ms-playwright");
    default:
      return path.join(home, ".cache", "ms-playwright");
  }
}

function _hasBrowserBinary(dir) {
  try {
    if (!fs.existsSync(dir)) return false;
    return fs.readdirSync(dir).some((n) => /^chromium[-_]/i.test(n));
  } catch {
    return false;
  }
}

function _hasPlaywrightPackage() {
  const names = ["playwright", "playwright-core"];
  for (const name of names) {
    try {
      if (fs.existsSync(path.join(process.cwd(), "node_modules", name, "package.json"))) return true;
    } catch {}
  }
  return false;
}

/**
 * @param {string} [configPath] - 用户配置的内核下载目录（web_search.browsers_path）
 */
export function probeCrawlCapability(configPath) {
  const pkg = _hasPlaywrightPackage();
  const targetDir = browsersDir(configPath);
  const targetBin = _hasBrowserBinary(targetDir);
  const sysDir = _systemBrowsersDir();
  const sysBin = !targetBin && _hasBrowserBinary(sysDir);
  const effectiveDir = targetBin ? targetDir : (sysBin ? sysDir : targetDir);
  const hasBin = targetBin || sysBin;
  const available = pkg && hasBin;

  const checks = { package: pkg, browser: hasBin, platform: process.platform };
  const missing = [];
  if (!pkg) missing.push("package");
  if (!hasBin) missing.push("browser");

  return {
    available,
    checks,
    missing,
    browsersDir: effectiveDir,
    summary: available
      ? "浏览器爬取已就绪。"
      : _installing
        ? "正在自动安装浏览器内核..."
        : "浏览器爬取尚未就绪，将在需要时自动安装。",
  };
}

// ============================================================
// 自动安装（检测不到时自动执行，安装到项目根目录）
// ============================================================

let _installing = null;
// 失败冷却(2026-07-20 全链审计对齐):三处联网自装中唯本处无冷却——离线时每次搜索触发都会
// 真跑一遍 npx(慢+日志噪音)。失败后 10min 内直接返回不可用,与桌宠/缺包补装同形状。
let _installFailAt = 0;
const INSTALL_FAIL_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * 检测浏览器爬取能力，不可用时自动安装。
 * 安装目标始终是项目根目录的 browsers 子目录（不装到 C 盘）。
 * 多次并发调用共享同一个安装 promise（去重）；失败后 10min 冷却。
 * @param {string} [configPath]
 * @returns {Promise<{available: boolean, dir: string, installed?: boolean}>}
 */
export function ensureBrowsers(configPath) {
  const probe = probeCrawlCapability(configPath);
  if (probe.available) return Promise.resolve({ available: true, dir: probe.browsersDir });
  if (_installing) return _installing;
  if (Date.now() - _installFailAt < INSTALL_FAIL_COOLDOWN_MS)
    return Promise.resolve({ available: false, dir: browsersDir(configPath), cooldown: true });

  const targetDir = browsersDir(configPath);
  console.log(`[crawlProbe] 未检测到浏览器内核，自动安装到 ${targetDir} ...`);

  _installing = _doInstall(targetDir, configPath).finally(() => { _installing = null; });
  return _installing;
}

async function _doInstall(targetDir, configPath) {
  try { fs.mkdirSync(targetDir, { recursive: true }); } catch {}

  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: targetDir };

  if (typeof Deno !== "undefined" && Deno.Command) {
    const cmd = new Deno.Command("npx", {
      args: ["playwright", "install", "chromium"],
      cwd: process.cwd(),
      env,
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    const stderr = new TextDecoder().decode(output.stderr);
    if (!output.success) {
      console.error(`[crawlProbe] 自动安装失败 (code ${output.code}):`, stderr.slice(0, 300));
      _installFailAt = Date.now();
      return { available: false, dir: targetDir, error: stderr.slice(0, 200) };
    }
  } else {
    const { execFileSync } = await import("node:child_process");
    try {
      execFileSync("npx", ["playwright", "install", "chromium"], {
        cwd: process.cwd(),
        env,
        stdio: "pipe",
        timeout: 300_000,
        shell: true,
      });
    } catch (e) {
      console.error("[crawlProbe] 自动安装失败:", e.message?.slice(0, 300));
      _installFailAt = Date.now();
      return { available: false, dir: targetDir, error: e.message?.slice(0, 200) };
    }
  }

  const afterProbe = probeCrawlCapability(configPath);
  if (afterProbe.available) {
    console.log(`[crawlProbe] 浏览器内核安装完成: ${afterProbe.browsersDir}`);
    return { available: true, dir: afterProbe.browsersDir, installed: true };
  }
  console.warn("[crawlProbe] 安装命令执行完但内核仍未检测到");
  _installFailAt = Date.now();
  return { available: false, dir: targetDir };
}
