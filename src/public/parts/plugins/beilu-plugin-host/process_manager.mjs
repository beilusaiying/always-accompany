/**
 * beilu-plugin-host/process_manager.mjs
 * 通用子进程管理器（扩展自 beilu-eye 的子进程管理逻辑）
 *
 * 职责：
 * - 根据 plugin.json 的 runtime 配置启动/停止子进程
 * - 管道 stdout/stderr 输出
 * - 自动安装 Python 依赖
 * - 端口自动分配
 */

import fs from "node:fs";
import path from "node:path";

import { deployGatedAllow } from "../../../../yonban/core/functions/security/path_confine.mjs";
import { getPlugin, updatePlugin } from "./plugin_registry.mjs";

// SEC-T13：用户插件 runtime 会 spawn 宿主进程（python/node/任意 executable）+ pip install 自动装依赖
//   = 服务端任意命令执行面。user-plugins/ 由 owner 手动放置（无导入路由），故：
//   - 本地单用户(local)：owner 自己机器、自己放的插件 → 放行（设计内功能）。
//   - 多用户(server)：任一用户目录自动 spawn 服务端进程 = RCE/跨账号面 → 安全默认【不 spawn】，
//     owner 显式开启（env BEILU_USER_PLUGIN_SPAWN=on 或 config.allowUserPluginSpawn=true，可在安全中心设）后放行。
//   gate 收口在 spawnPlugin 顶端（Load 自动加载 + start 动作两条 spawn 路径的唯一汇聚点）。
//   闸判定走 path_confine 的单一权威 deployGatedAllow（与 T12 等同款）。
let _userPluginSpawnWarned = false;
const _userPluginSpawnAllowed = () => deployGatedAllow("allowUserPluginSpawn", "BEILU_USER_PLUGIN_SPAWN");

// ============================================================
// 端口池（N9 修复：原 _nextPort 只增不回收 → 长期反复 reload 端口号无限增长/耗尽常用段）
//   现改为回收复用：释放的端口入空闲池，分配时先复用池中端口再自增。
//   _inUse 跟踪当前占用端口，分配/复用时确保不与在用端口冲突。
// ============================================================
const PORT_BASE = 19000;
let _nextPort = PORT_BASE;
/** @type {number[]} 已释放、可复用的端口（栈） */
const _freePorts = [];
/** @type {Set<number>} 当前占用中的端口 */
const _inUsePorts = new Set();

/**
 * 分配一个可用端口（优先复用空闲池，否则自增；保证不与在用端口冲突）
 * @returns {number}
 */
export function allocatePort() {
  let port;
  // 先尝试从空闲池取（跳过任何意外仍在占用的端口）
  while (_freePorts.length > 0) {
    const candidate = _freePorts.pop();
    if (!_inUsePorts.has(candidate)) {
      port = candidate;
      break;
    }
  }
  // 空闲池无可用 → 自增分配，跳过仍在占用的端口号
  if (port === undefined) {
    do {
      port = _nextPort++;
    } while (_inUsePorts.has(port));
  }
  _inUsePorts.add(port);
  return port;
}

/**
 * 释放端口，归还空闲池供后续复用（永久注销插件/卸载时调用）
 * @param {number} port
 */
export function releasePort(port) {
  if (typeof port !== "number" || port < PORT_BASE) return; // 0/未分配/非法值忽略
  if (!_inUsePorts.has(port)) return; // 未占用（已释放或从未分配），幂等忽略
  _inUsePorts.delete(port);
  _freePorts.push(port);
}

/**
 * 检查并安装 Python 依赖
 * @param {string} pluginDir - 插件目录
 * @param {string} depsFile - 依赖文件名（如 requirements.txt）
 * @returns {Promise<boolean>}
 */
async function ensurePythonDeps(pluginDir, depsFile) {
  const depsPath = path.join(pluginDir, depsFile);
  if (!fs.existsSync(depsPath)) return true; // 无依赖文件，跳过

  const isWindows =
    typeof Deno !== "undefined"
      ? Deno.build.os === "windows"
      : process.platform === "win32";
  const pythonCmd = isWindows ? "python" : "python3";

  try {
    console.log(`[plugin-host] 安装 Python 依赖: ${depsPath}`);
    const command = new Deno.Command(pythonCmd, {
      args: ["-m", "pip", "install", "-r", depsPath, "--quiet"],
      stdout: "piped",
      stderr: "piped",
    });
    const result = await command.output();
    if (result.success) {
      console.log(`[plugin-host] Python 依赖安装成功`);
      return true;
    }
    const stderr = new TextDecoder().decode(result.stderr);
    console.error(`[plugin-host] pip install 失败:`, stderr.substring(0, 500));
    return false;
  } catch (err) {
    console.error(`[plugin-host] Python 依赖检查失败:`, err.message);
    return false;
  }
}

/**
 * 异步管道输出（与 beilu-eye 的 pipeOutput 相同）
 * @param {ReadableStream} stream
 * @param {string} prefix
 */
async function pipeOutput(stream, prefix) {
  try {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true }).trim();
      if (text) console.log(prefix, text);
    }
  } catch {
    /* 进程已结束 */
  }
}

/**
 * 启动用户插件子进程
 * @param {object} entry - 注册表条目（from plugin_registry）
 * @param {string} pluginDir - 插件目录绝对路径
 * @param {number} mainPort - 主程序端口号
 * @returns {Promise<boolean>} 是否启动成功
 */
export async function spawnPlugin(entry, pluginDir, mainPort) {
  const manifest = entry.manifest;
  const runtime = manifest.runtime;
  if (!runtime) {
    console.error(`[plugin-host] ${entry.id}: 缺少 runtime 配置`);
    updatePlugin(entry.id, { status: "error", error: "缺少 runtime 配置" });
    return false;
  }

  // SEC-T13：server 多用户部署默认不 spawn 用户插件子进程（防服务端 RCE/跨账号）；owner 可显式开启。
  if (!_userPluginSpawnAllowed()) {
    if (!_userPluginSpawnWarned) {
      _userPluginSpawnWarned = true;
      console.warn("[SEC-T13] server 部署模式下用户插件子进程默认不启动（防服务端 RCE）；owner 可设 env BEILU_USER_PLUGIN_SPAWN=on 或 config.allowUserPluginSpawn=true 开启。");
    }
    updatePlugin(entry.id, {
      process: null,
      status: "blocked",
      error: "server 模式未授权运行用户插件子进程（owner 可在安全中心开启）",
    });
    return false;
  }

  // 确定命令和参数
  let command;
  let args;
  const isWindows =
    typeof Deno !== "undefined"
      ? Deno.build.os === "windows"
      : process.platform === "win32";

  switch (runtime.type) {
    case "python": {
      command = isWindows ? "python" : "python3";
      // 安装依赖
      if (runtime.deps) {
        const depsOk = await ensurePythonDeps(pluginDir, runtime.deps);
        if (!depsOk) {
          updatePlugin(entry.id, {
            status: "error",
            error: "Python 依赖安装失败",
          });
          return false;
        }
      }
      args = [path.join(pluginDir, runtime.entry)];
      break;
    }
    case "node": {
      command = "node";
      args = [path.join(pluginDir, runtime.entry)];
      break;
    }
    case "executable": {
      const entryPath = path.join(pluginDir, runtime.entry);
      command = entryPath;
      args = [];
      break;
    }
    default:
      console.error(
        `[plugin-host] ${entry.id}: 不支持的 runtime.type: ${runtime.type}`,
      );
      updatePlugin(entry.id, {
        status: "error",
        error: `不支持的 runtime.type: ${runtime.type}`,
      });
      return false;
  }

  // 端口
  const port = entry.port || allocatePort();
  updatePlugin(entry.id, { port, status: "starting" });

  // 启动子进程
  try {
    console.log(
      `[plugin-host] 启动插件 ${entry.id}: ${command} ${args.join(" ")}`,
    );
    const cmd = new Deno.Command(command, {
      args: [
        ...args,
        "--port",
        String(port),
        "--main-port",
        String(mainPort),
        "--token",
        entry.token,
      ],
      cwd: pluginDir,
      stdout: "piped",
      stderr: "piped",
    });

    const proc = cmd.spawn();
    updatePlugin(entry.id, {
      process: proc,
      status: "running",
      error: null,
    });
    console.log(`[plugin-host] 插件 ${entry.id} 已启动 (PID: ${proc.pid})`);

    // 异步监听退出
    // N9 修复：退出回调按 id 误改新 entry —— 进程退出时同 id 可能已被 reload 成新实例（新 proc）。
    //   回调闭包捕获本次的 proc 引用作为代际标识；触发时先核对当前注册表 entry.process 是否仍是本 proc，
    //   不是则说明已是新代际（新进程在跑），跳过，不把新实例误置为 stopped。
    const __markStoppedIfCurrent = () => {
      const cur = getPlugin(entry.id);
      if (cur && cur.process !== proc) {
        // 已被新实例替换，旧回调不动新 entry
        console.log(
          `[plugin-host] 插件 ${entry.id} 旧进程退出回调跳过（已被新实例替换）`,
        );
        return;
      }
      updatePlugin(entry.id, { process: null, status: "stopped" });
    };
    proc.status
      .then((status) => {
        console.log(
          `[plugin-host] 插件 ${entry.id} 进程退出, code: ${status.code}`,
        );
        __markStoppedIfCurrent();
      })
      .catch(() => {
        __markStoppedIfCurrent();
      });

    // 管道输出
    pipeOutput(proc.stdout, `[${entry.name}]`);
    pipeOutput(proc.stderr, `[${entry.name} ERR]`);

    return true;
  } catch (err) {
    console.error(`[plugin-host] 插件 ${entry.id} 启动失败:`, err.message);
    updatePlugin(entry.id, {
      process: null,
      status: "error",
      error: err.message,
    });
    return false;
  }
}

/**
 * 停止用户插件子进程
 * Windows 用 SIGKILL（与 beilu-eye 一致）
 * @param {object} entry - 注册表条目
 */
export function killPlugin(entry) {
  if (entry.process) {
    try {
      entry.process.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    updatePlugin(entry.id, {
      process: null,
      status: "stopped",
      error: null,
    });
    console.log(`[plugin-host] 插件 ${entry.id} 已终止`);
  }
}
