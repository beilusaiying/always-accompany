/**
 * envCheck.mjs — 启动环境健康检查（可选依赖探测 + 缺失引导）
 *
 * 链路：server.mjs init() 完成后异步调用 runEnvCheck()（不阻塞启动）
 *       → 逐项探测 Python/Chrome/ffmpeg/git/node
 *       → 结果打印到控制台 + 存内存供 /api/v1/monitor/env 查询
 *       → 前端首次加载可拉取状态，展示缺失提醒 + 安装链接
 *
 * why：早期用户首次启动时缺可选依赖（Python/Chrome 等）会在使用对应功能时
 *      遇到裸 ENOENT 错误，无法自诊。统一检测 + 前置告知 = 用户自助修复。
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const _isWindows = process.platform === "win32";
const _isMac = process.platform === "darwin";

let _envStatus = null;

// 下载链接/安装命令——按平台
const INSTALL_GUIDES = {
  git: {
    desc: "版本管理（记忆快照/回档/GitHub 集成）",
    win: { cmd: "winget install Git.Git", url: "https://git-scm.com/download/win" },
    mac: { cmd: "xcode-select --install", url: "https://git-scm.com/download/mac" },
    linux: { cmd: "sudo apt install git", url: "https://git-scm.com/download/linux" },
  },
  python: {
    desc: "语音转录(STT) / 图片压缩 / 演示文稿(PPT) / DuckDuckGo 搜索",
    win: { cmd: null, url: "https://www.python.org/downloads/" },
    mac: { cmd: "brew install python3", url: "https://www.python.org/downloads/" },
    linux: { cmd: "sudo apt install python3", url: "https://www.python.org/downloads/" },
  },
  chrome: {
    desc: "浏览器调试连接 / Playwright 网页搜索引擎",
    win: { cmd: null, url: "https://www.google.com/chrome/" },
    mac: { cmd: null, url: "https://www.google.com/chrome/" },
    linux: { cmd: null, url: "https://www.google.com/chrome/" },
    extra: "Playwright 内核（无需完整 Chrome）：npx playwright install chromium",
  },
  ffmpeg: {
    desc: "音视频格式转换（AI 上传前自动转码）",
    win: { cmd: "winget install FFmpeg", url: "https://ffmpeg.org/download.html" },
    mac: { cmd: "brew install ffmpeg", url: "https://ffmpeg.org/download.html" },
    linux: { cmd: "sudo apt install ffmpeg", url: "https://ffmpeg.org/download.html" },
  },
  node: {
    desc: "CLI 插件子进程",
    win: { cmd: "winget install OpenJS.NodeJS.LTS", url: "https://nodejs.org/" },
    mac: { cmd: "brew install node", url: "https://nodejs.org/" },
    linux: { cmd: "sudo apt install nodejs", url: "https://nodejs.org/" },
  },
};

function _platformKey() {
  return _isWindows ? "win" : _isMac ? "mac" : "linux";
}

function _execPromise(cmd, args, timeout = 5000) {
  return new Promise((resolve) => {
    try {
      const child = execFile(cmd, args, { timeout, stdio: ["ignore", "pipe", "pipe"] }, (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, error: err.code || err.message });
        resolve({ ok: true, version: (stdout || stderr || "").trim().split("\n")[0] });
      });
      child.on("error", (e) => resolve({ ok: false, error: e.code || e.message }));
    } catch (e) {
      resolve({ ok: false, error: e.code || e.message });
    }
  });
}

async function _checkGit() {
  return _execPromise("git", ["--version"]);
}

async function _checkPython() {
  const cmd = _isWindows ? "python" : "python3";
  const r = await _execPromise(cmd, ["--version"]);
  if (r.ok) return { ...r, cmd };
  if (!_isWindows) {
    const r2 = await _execPromise("python", ["--version"]);
    if (r2.ok) return { ...r2, cmd: "python" };
  }
  return { ...r, cmd };
}

function _findChrome() {
  const candidates = _isWindows ? [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    (process.env.LOCALAPPDATA || "") + "\\Google\\Chrome\\Application\\chrome.exe",
  ] : _isMac ? [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    `${process.env.HOME || ""}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
  ] : [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return { ok: true, path: p }; } catch {}
  }
  return { ok: false };
}

async function _checkFfmpeg() {
  const r = await _execPromise("ffmpeg", ["-version"]);
  if (r.ok) return r;
  // npm bundled fallback
  try {
    const { path: ffPath } = await import("@ffmpeg-installer/ffmpeg");
    if (ffPath && fs.existsSync(ffPath)) return { ok: true, version: "(bundled @ffmpeg-installer)", path: ffPath };
  } catch {}
  return r;
}

async function _checkNode() {
  return _execPromise("node", ["--version"]);
}

/**
 * 异步执行全部环境检查，结果存内存。
 * 不阻塞启动——调用方 fire-and-forget。
 */
export async function runEnvCheck() {
  const pk = _platformKey();
  const [git, python, ffmpeg, node] = await Promise.all([
    _checkGit(),
    _checkPython(),
    _checkFfmpeg(),
    _checkNode(),
  ]);
  const chrome = _findChrome();

  const items = [
    { name: "git", result: git, guide: INSTALL_GUIDES.git },
    { name: "python", result: python, guide: INSTALL_GUIDES.python },
    { name: "chrome", result: chrome, guide: INSTALL_GUIDES.chrome },
    { name: "ffmpeg", result: ffmpeg, guide: INSTALL_GUIDES.ffmpeg },
    { name: "node", result: node, guide: INSTALL_GUIDES.node },
  ];

  // 运行时版本信息（借鉴 SillyTavern: "Node version: ... Running in ..."）
  const denoVer = typeof Deno !== "undefined" ? Deno.version?.deno : null;
  const nodeVer = process.version;
  console.log(`  [beilu] 运行环境: ${denoVer ? `Deno ${denoVer}` : `Node ${nodeVer}`} | ${process.platform} ${process.arch}`);

  // Win10 长路径警告（MAX_PATH 260，node_modules 嵌套易超限）
  if (_isWindows && process.cwd().length > 60) {
    console.warn(`  [beilu] 注意: 项目路径较深（${process.cwd().length} 字符），Windows 下 node_modules 安装可能因路径超长(260)失败`);
    console.warn(`         建议将项目移至较短路径（如 D:\\beilu\\）`);
  }

  _envStatus = {
    checkedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    runtime: denoVer ? `Deno ${denoVer}` : `Node ${nodeVer}`,
    items: items.map((it) => ({
      name: it.name,
      ok: it.result.ok,
      version: it.result.version || it.result.path || null,
      desc: it.guide.desc,
      install: it.result.ok ? null : {
        ...(it.guide[pk] || {}),
        extra: it.guide.extra || null,
      },
    })),
  };

  // 控制台输出
  const missing = _envStatus.items.filter((it) => !it.ok);
  const found = _envStatus.items.filter((it) => it.ok);

  if (found.length) {
    console.log(`  [beilu] 环境检查: ${found.map((it) => `${it.name} ✓`).join("  ")}`);
  }
  if (missing.length) {
    console.log(`  [beilu] 可选依赖未检测到（对应功能不可用，核心不受影响）:`);
    for (const it of missing) {
      const guide = it.install;
      let hint = `         · ${it.name} — ${it.desc}`;
      if (guide?.url) hint += `\n           下载: ${guide.url}`;
      if (guide?.cmd) hint += `\n           命令行安装: ${guide.cmd}`;
      if (guide?.extra) hint += `\n           ${guide.extra}`;
      console.log(hint);
    }
  }

  return _envStatus;
}

/** 获取最近一次检查结果（尚未完成时返回 null）。 */
export function getEnvStatus() {
  return _envStatus;
}

/** 注册 /api/v1/monitor/env 端点。 */
export function registerEnvCheckRoutes(router, authenticate) {
  router.get("/api/v1/monitor/env", authenticate, (_req, res) => {
    if (!_envStatus) {
      return res.json({ ready: false, message: "环境检查尚未完成" });
    }
    res.json({ ready: true, ..._envStatus });
  });
}

/**
 * 生成统一的"依赖缺失"错误消息——供各调用点替换裸 ENOENT。
 * @param {"git"|"python"|"chrome"|"ffmpeg"|"node"} name
 * @returns {string} 包含描述 + 安装命令/链接的可读错误文案
 */
export function missingDepMessage(name) {
  const guide = INSTALL_GUIDES[name];
  if (!guide) return `未找到 ${name}`;
  const pk = _platformKey();
  const g = guide[pk] || {};
  let msg = `未找到 ${name}（${guide.desc}）`;
  if (g.url) msg += `\n下载地址: ${g.url}`;
  if (g.cmd) msg += `\n命令行安装: ${g.cmd}`;
  if (guide.extra) msg += `\n${guide.extra}`;
  return msg;
}
