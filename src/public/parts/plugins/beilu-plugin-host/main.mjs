/**
 * beilu-plugin-host/main.mjs
 * 通用用户级插件宿主 — beilu 插件入口
 *
 * 职责：
 * - Load() 时扫描 data/users/{username}/user-plugins/ 目录
 * - 自动加载 plugin.json 并注册到 plugin_registry
 * - 根据 runtime 配置启动子进程（复用 beilu-eye 的子进程模式）
 * - GetPrompt 钩子：收集所有用户插件的 pending 注入数据
 * - Unload() 时终止所有子进程
 * - SetData 提供管理接口（列表/启停/状态查询）
 *
 * 架构参考：beilu-eye/main.mjs（子进程 + 共享状态 + 自定义路由）
 */

import fs from "node:fs";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { setDefaultPart } from "../../../../server/parts_loader.mjs";
import info from "./info.json" with { type: "json" };
import {
  consumeAllPendingInjections,
  getAllPlugins,
  getPlugin,
  registerPlugin,
  setPendingInjection,
  unregisterPlugin,
  validateToken,
} from "./plugin_registry.mjs";
import { killPlugin, releasePort, spawnPlugin } from "./process_manager.mjs";
import { wbT, wbD } from "../../../../server/wbStub.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..", "..", "..", "..", "..");

// 主程序端口（从环境变量或默认值获取）
const MAIN_PORT = parseInt(process.env.BEILU_PORT || "1314", 10);

// 当前加载的用户名
let _currentUsername = null;

// ============================================================
// 目录扫描与插件加载
// ============================================================

/**
 * 获取用户插件目录
 * @param {string} username
 * @returns {string}
 */
function getUserPluginsDir(username) {
  return path.join(
    projectRoot,
    "data",
    "users",
    username || "_default",
    "user-plugins",
  );
}

/**
 * 扫描用户插件目录，返回有效的 plugin.json 清单
 * @param {string} username
 * @returns {Array<{ manifest: object, dir: string }>}
 */
function scanUserPlugins(username) {
  const pluginsDir = getUserPluginsDir(username);
  if (!fs.existsSync(pluginsDir)) {
    // 首次运行：创建目录，方便用户放插件
    try {
      fs.mkdirSync(pluginsDir, { recursive: true });
      console.log(`[plugin-host] 创建用户插件目录: ${pluginsDir}`);
    } catch (e) {
      console.warn(`[plugin-host] 创建插件目录失败（用户插件将无法加载）: ${pluginsDir}`, e?.message || e); // T021 留痕
    }
    return [];
  }

  const results = [];
  try {
    const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pluginDir = path.join(pluginsDir, entry.name);
      const manifestPath = path.join(pluginDir, "plugin.json");
      if (!fs.existsSync(manifestPath)) {
        console.log(`[plugin-host] 跳过 ${entry.name}：缺少 plugin.json`);
        continue;
      }
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        if (!manifest.id) {
          wbD(null, "pluginhost:load", "manifest_no_id", false, "plugin.json 缺少 id 字段", { dir: entry.name });
          console.warn(
            `[plugin-host] ${entry.name}/plugin.json 缺少 id 字段，跳过`,
          );
          continue;
        }
        results.push({ manifest, dir: pluginDir });
      } catch (err) {
        wbD(null, "pluginhost:load", "manifest_parse", false, "读取/解析 plugin.json 失败", { dir: entry.name, err: err.message });
        console.error(`[plugin-host] 读取 ${manifestPath} 失败:`, err.message);
      }
    }
  } catch (err) {
    console.error(`[plugin-host] 扫描插件目录失败:`, err.message);
  }

  return results;
}

/**
 * 加载并启动所有用户插件
 * @param {string} username
 */
async function loadAllUserPlugins(username) {
  const plugins = scanUserPlugins(username);
  wbT(null, "pluginhost:load", "scan_done", { username, count: plugins.length });
  if (plugins.length === 0) {
    console.log(
      `[plugin-host] 未发现用户插件 (${getUserPluginsDir(username)})`,
    );
    return;
  }

  console.log(`[plugin-host] 发现 ${plugins.length} 个用户插件，开始加载...`);
  for (const { manifest, dir } of plugins) {
    const entry = registerPlugin(manifest);
    wbT(null, "pluginhost:load", "register", { id: manifest.id, name: manifest.name, hasRuntime: !!manifest.runtime });
    console.log(
      `[plugin-host] 注册插件: ${manifest.id} (${manifest.name || manifest.id})`,
    );

    // 如果有 runtime 配置，启动子进程
    if (manifest.runtime) {
      await spawnPlugin(entry, dir, MAIN_PORT);
      wbD(null, "pluginhost:load", "spawn", entry.status !== "error", "插件子进程启动状态", { id: manifest.id, status: entry.status, port: entry.port, err: entry.error });
    } else {
      console.log(
        `[plugin-host] ${manifest.id}: 无 runtime 配置，仅注册（内嵌脚本模式）`,
      );
    }
  }
}

/**
 * 停止并注销所有用户插件
 */
function unloadAllUserPlugins() {
  const plugins = getAllPlugins();
  if (plugins.length === 0) return;
  for (const entry of plugins) {
    killPlugin(entry);
    // N9：永久注销时归还端口供后续复用（修 _nextPort 只增不回收 → 端口耗尽）
    if (entry.port) releasePort(entry.port);
    unregisterPlugin(entry.id);
  }
  console.log(`[plugin-host] 已停止并注销 ${plugins.length} 个用户插件`);
}

// ============================================================
// beilu 插件导出
// ============================================================

export default {
  info,
  Load: async (arg) => {
    const username = arg?.username || "_default";
    _currentUsername = username;
    console.log(`[plugin-host] Load() — 加载用户 ${username} 的插件`);

    // 自动注册为默认插件，确保 GetPrompt 会被 prompt_struct.mjs 调用
    if (username && username !== "_default") {
      setDefaultPart(username, "plugins", "beilu-plugin-host");
      console.log(
        `[plugin-host] 已自动注册为默认插件 (plugins/beilu-plugin-host)`,
      );
    }

    // 先清理旧的（角色切换时）
    unloadAllUserPlugins();

    // 扫描并启动
    await loadAllUserPlugins(username);
  },

  Unload: async () => {
    console.log(`[plugin-host] Unload() — 停止所有用户插件`);
    unloadAllUserPlugins();
    _currentUsername = null;
  },

  interfaces: {
    config: {
      /**
       * GetData: 返回所有用户插件的状态列表
       */
      GetData: async () => {
        const plugins = getAllPlugins().map((p) => ({
          id: p.id,
          name: p.name,
          status: p.status,
          error: p.error,
          port: p.port,
          hasPending: !!p.pendingInjection,
          hooks: p.manifest?.hooks || {},
        }));
        return {
          plugins,
          pluginsDir: _currentUsername
            ? getUserPluginsDir(_currentUsername)
            : "",
          description: "用户级插件宿主 — 管理 user-plugins/ 目录下的外部插件",
        };
      },

      /**
       * SetData: 管理接口 + 接收外部插件推送的数据
       */
      SetData: async (data) => {
        if (!data) return;
        wbT(null, "pluginhost:mcp", "setdata_dispatch", { action: data._action, pluginId: data.pluginId });

        // 接收外部插件推送的注入数据
        // 由 /api/user-plugins/:id/push 路由中转调用
        if (data._action === "push") {
          const { pluginId, token, ...pushData } = data;
          if (!validateToken(pluginId, token)) {
            wbD(null, "pluginhost:mcp", "push_token", false, "push 无效 token", { pluginId });
            console.warn(
              `[plugin-host] push: 无效 token (pluginId=${pluginId})`,
            );
            return { error: "invalid token" };
          }
          setPendingInjection(pluginId, pushData);
          wbT(null, "pluginhost:mcp", "push_ok", { pluginId });
          console.log(`[plugin-host] 收到插件 ${pluginId} 的数据推送`);
          return { ok: true };
        }

        // 重新扫描并加载插件
        if (data._action === "reload") {
          wbT(null, "pluginhost:mcp", "reload", { username: _currentUsername });
          if (_currentUsername) {
            unloadAllUserPlugins();
            await loadAllUserPlugins(_currentUsername);
          }
          return { ok: true };
        }

        // 停止指定插件
        if (data._action === "stop" && data.pluginId) {
          const entry = getPlugin(data.pluginId);
          wbD(null, "pluginhost:mcp", "stop", !!entry, "stop: 目标插件未注册", { pluginId: data.pluginId });
          if (entry) killPlugin(entry);
          return { ok: true };
        }

        // 启动指定插件
        if (data._action === "start" && data.pluginId) {
          const entry = getPlugin(data.pluginId);
          if (entry && entry.manifest?.runtime && _currentUsername) {
            const pluginDir = path.join(
              getUserPluginsDir(_currentUsername),
              data.pluginId,
            );
            await spawnPlugin(entry, pluginDir, MAIN_PORT);
            wbD(null, "pluginhost:mcp", "start", entry.status !== "error", "start: 插件子进程启动状态", { pluginId: data.pluginId, status: entry.status, err: entry.error });
          } else {
            wbD(null, "pluginhost:mcp", "start", false, "start: 插件未注册/无 runtime/无当前用户", { pluginId: data.pluginId, hasEntry: !!entry, hasRuntime: !!entry?.manifest?.runtime, hasUser: !!_currentUsername });
          }
          return { ok: true };
        }
      },
    },

    /**
     * GetPrompt: 收集所有用户插件的 pending 注入数据，注入到 AI 上下文
     * 返回 single_part_prompt_t 格式
     */
    chat: {
      GetPrompt: async () => {
        const injections = consumeAllPendingInjections();
        wbT(null, "pluginhost:call", "getprompt_consume", { injections: injections.length });
        if (injections.length === 0) {
          return { text: [], additional_chat_log: [], extension: {} };
        }

        const texts = injections.map((inj) => ({
          content: `[用户插件 ${inj.pluginId}]\n${inj.content}`,
          role: "system",
          identifier: `user-plugin-${inj.pluginId}`,
        }));

        console.log(
          `[plugin-host] GetPrompt: 注入 ${injections.length} 个插件数据`,
        );
        return {
          text: texts,
          additional_chat_log: [],
          extension: { user_plugin_injections: injections.length },
        };
      },
    },
  },
};
