/**
 * beilu-memory 插件入口实现体 — 纯 Facade 路由层
 *
 * T3e·memory 组迁移（2026-07-02）：实现体从 plugins/beilu-memory/main.mjs 迁到
 *   src/yonban/core/functions/memory/main.mjs；旧位 main.mjs 换 P 型 re-export 薄壳。
 *   部件元数据（info.json / beilu-part.json / default_memory_presets.json）留 parts 树，本文件对其 import 指回旧位。
 *   已迁出成 yonban 组的依赖（scheduler→notification）用組間直达；留守旧位的依赖（ideClient/gameCompanion）指回旧位。
 *
 * 所有业务逻辑已拆分到子模块：
 *   - storage_mod/storage.mjs   : 数据层（文件I/O、缓存、预设、默认模板）
 *   - handler/replyParser.mjs   : AI回复标签解析器
 *   - storage_mod/tableEngine.mjs : 表格操作引擎 + 文本生成 + 热记忆读取
 *   - storage_mod/archiver.mjs  : <memoryArchive> 文件操作执行器
 *   - storage_mod/retrieval.mjs : 记忆搜索与检索引擎
 *   - tools/backgroundTasks.mjs : 归档流程（archive系列/endDay/autoCheck）
 *   - ai/aiRunner.mjs           : AI调用引擎（runMemoryPresetAI/P1/P2/输出队列）
 *   - (T066迁transport) yonban/core/transport/ideClient.mjs : IDE 插件 WebSocket 客户端（旧位 lib/tools/ 只剩 re-export 薄壳）
 *   - (yonban) rollback/tableSnapshot.mjs       : 表格快照（回档用）
 *   - handler/getDataHandler.mjs   : GetData 处理器
 *   - handler/setDataActions.mjs   : SetData 全部 action 处理器
 *   - handler/getPromptHandler.mjs : GetPrompt 注入链路
 *   - handler/replyHandler.mjs     : ReplyHandler 解析链路
 */

// server 骨架：从 memory/main.mjs 上 4 级到 src/（旧位 plugins/beilu-memory/main.mjs 亦 4 级——深度不变）
import { setDefaultPart } from "../../../../server/parts_loader.mjs";
import { getDeployMode } from "../security/path_confine.mjs"; // #7：server 部署(无 YonBan)不自动重连 IDE，防永久重连刷日志
import { authenticate } from "../security/auth.mjs"; // A2-3：HTTP 端点鉴权中间件（未认证→401），与全站 router.get/post(path, authenticate, handler) 同型

import { memoryCache, drainTableWrites, getMemoryDir, getUserDataDir } from "./storage_mod/storage.mjs";
import { dispatch } from "../../dispatch/dispatcher.mjs"; // [0716 T3对接首批] REST 线广播改经 bus:broadcast 出口（exits.mjs），删两处动态 import broadcast.mjs 散拼
import { ideClient } from "../../transport/ideClient.mjs"; // T066: ideClient 已迁 transport（原 T3e 留守旧位注记作废），指同库 transport 实现体
import { stopAllSchedulers } from "../notification/scheduler.mjs"; // T3e: scheduler 已迁 notification 组，組間直达
import { handleGetData } from "./handler/getDataHandler.mjs";
import { handleSetData } from "./handler/setDataActions.mjs";
import { handleGetPrompt } from "./handler/getPromptHandler.mjs";
import { handleReply } from "./handler/replyHandler.mjs";
import info from "../../../../public/parts/plugins/beilu-memory/info.json" with { type: "json" }; // T3e: 部件元数据留 parts 树，指回旧位

// ============================================================
// beilu-memory 插件导出
// ============================================================

const pluginExport = {
  // info：部件元信息（供 getPartDetails 等读取）；缺失会致 parts_loader:932 JSON.parse(undefined) 崩
  info,
  Load: async ({ router, username }) => {
    if (username) {
      setDefaultPart(username, "plugins", "beilu-memory");
      console.log("[beilu-memory] 已自动注册为默认插件 (plugins/beilu-memory)");
    } else {
      console.warn("[beilu-memory] Load: username 未提供，无法注册为默认插件！");
    }

    let _getUserByReq;
    try {
      const authMod = await import("../security/auth.mjs");
      _getUserByReq = authMod.getUserByReq;
    } catch (e) {
      console.warn("[beilu-memory] auth.mjs 未能加载，将使用默认用户名:", e.message);
    }

    if (router) {
      // ★ 路由路径：parts_router 已按 partpath 分发，这里用正则匹配避免冒号转义问题
      // 兼容 /api/parts/plugins:beilu-memory/config/getdata 和可能的变体
      const getdataPattern = /\/config\/getdata$/;
      const setdataPattern = /\/config\/setdata$/;

      router.get(
        getdataPattern,
        authenticate, // A2-3：补鉴权中间件——未认证请求在此被 401 拦截，杜绝匿名读记忆配置
        async (req, res) => {
          try {
            // [P0-C 2026-08-03 fail-closed] 原实现 getUserByReq 失败后继续（落 _default 桶/采信
            //   query username）——任务 MD P0-C 要求3：认证用户取不到必须失败关闭。
            let username;
            try { username = _getUserByReq ? (await _getUserByReq(req)).username : ""; } catch { username = ""; }
            if (!username) return res.status(401).json({ error: "Not authenticated（身份不可证明，fail-closed）" });
            const query = { ...(req.query || {}), username };
            const data = await pluginExport.interfaces.config.GetData(query);
            res.json(data);
          } catch (err) {
            res.status(500).json({ error: err.message });
          }
        },
      );

      router.post(
        setdataPattern,
        authenticate, // A2-3：补鉴权中间件——未认证请求在此被 401 拦截，杜绝匿名写记忆配置
        async (req, res) => {
          try {
            // [P0-C 2026-08-03 fail-closed] 同 getdata：认证解析失败不得回退 body username / _default。
            let username;
            try { username = _getUserByReq ? (await _getUserByReq(req)).username : ""; } catch { username = ""; }
            if (!username) return res.status(401).json({ error: "Not authenticated（身份不可证明，fail-closed）" });
            const body = { ...req.body };
            body.username = username;
            const query = { ...(req.query || {}), username };
            const result = await pluginExport.interfaces.config.SetData(body, query);
            if (result?._subModeSwitch) {
              // [0716 T3对接首批] 原动态 import broadcast.mjs 散拼改经 bus:broadcast 出口（exits.mjs 薄包装）。
              // ★ 修跨对话串台语义原样：带 chatId 时 scope 到该对话客户端(emit)，不再全广播——
              //   否则消费端(subModePanel _activeSubModesMap[当前chatId]=detail.to)会把别对话的切换
              //   盲目写进本客户端当前对话，多窗口下覆盖错。无 chatId(旧/全局)才回退全广播(emitAll)。
              //   dispatch 失败不抛、返回值不检=原 catch{/* broadcast not available */} 静默同语义（壳可选装不刷日志）。
              const _swChatId = result._subModeSwitch.chatId;
              const _swEvent = { type: "subModeSwitched", subModeSwitch: result._subModeSwitch };
              if (_swChatId)
                await dispatch({ target: "bus:broadcast", verb: "emit", source: "yonban", payload: { chatid: _swChatId, event: _swEvent } });
              else
                await dispatch({ target: "bus:broadcast", verb: "emitAll", source: "yonban", payload: { username, event: _swEvent } });
            }
            // 同步断链修复（2026-07-10）：saveSubModes 此前落盘零广播——切换有推送、配置内容没有，
            //   本体/YonBan 任一侧改子模式配置另一侧到重开面板才知道，双端同时编辑还全量互相覆盖。
            //   广播只发变更信号不带全量（消费端各自重拉 getSubModes 读回落盘真值，保存方收到重拉=幂等无害）。
            //   配置是 per-user 全局（非 per-chat），故走 broadcastAllChatUi 按 username scope。
            if (result?._subModesChanged) {
              // [0716 T3对接首批] 同上改经出口；失败静默=原语义。配置 per-user 全局，走 emitAll 按 username scope。
              await dispatch({ target: "bus:broadcast", verb: "emitAll", source: "yonban", payload: { username, event: { type: "subModesConfigChanged" } } });
            }
            // [0717 跨窗口同步] web_search 配置变更信号中继（producer=updateConfig case；消费端重拉回填四显示点）
            if (result?._webSearchConfigChanged) {
              await dispatch({ target: "bus:broadcast", verb: "emitAll", source: "yonban", payload: { username, event: { type: "webSearchConfigChanged", charName: result._webSearchConfigChanged.charName } } });
            }
            res.json(result || { success: true });
          } catch (err) {
            res.status(500).json({ error: err.message });
          }
        },
      );

      // A2-1：记忆目录路径端点——YonBan「打开记忆文件夹」(YonBanProvider.ts:541) 调
      //   GET /api/parts/plugins:beilu-memory/memory-path，期望 { path } 后 openExternal(file:path)。
      //   认证由 authenticate 中间件保证 req.user 已填充（getUserByReq 无须再 try/catch 兜底）。
      //   带 ?charName= → 返回该角色记忆目录(data/users/{user}/chars/{char}/memory)；
      //   不带 → 返回用户数据目录(data/users/{user})，作为「记忆文件夹」总入口（含全部角色 memory）。
      const memoryPathPattern = /\/memory-path$/;
      router.get(
        memoryPathPattern,
        authenticate,
        async (req, res) => {
          try {
            const username = (await _getUserByReq?.(req))?.username;
            if (!username) return res.status(401).json({ error: "Not authenticated" });
            const charName = typeof req.query?.charName === "string" ? req.query.charName : "";
            const dir = charName ? getMemoryDir(username, charName) : getUserDataDir(username);
            res.json({ path: dir });
          } catch (err) {
            res.status(500).json({ error: err.message });
          }
        },
      );
    }
    console.log("[beilu-memory] 记忆系统已加载");

    // Tokenizer 预热（非阻塞）
    import("./nlp/tokenizer.mjs").then(m => m.warmupTokenizer()).catch(() => {});

    // 调度器启动恢复（非阻塞）：重启后有启用定时任务的 user/char 拉起 scheduler（与 Unload stopAllSchedulers 对称）
    import("../notification/scheduler.mjs").then(m => m.resumeSchedulers()).catch(e => console.warn("[beilu-memory] 调度器启动恢复失败:", e?.message));

    // IDE 客户端连接（非阻塞）
    try {
      const _ideAuto = getDeployMode() !== "server"; // #7：server 模式无 YonBan→不自动重连(防永久重连刷日志)；local/desktop 照旧(YonBan 可后启)
      ideClient.connect({ autoReconnect: _ideAuto });
      console.log(`[beilu-memory] IDE 客户端已启动（自动重连=${_ideAuto}，deployMode=${getDeployMode()}）`);
    } catch (e) {
      console.warn("[beilu-memory] IDE 客户端启动失败:", e.message);
    }
  },

  Unload: async () => {
    // D-02：先 drain pending 表格写入落盘，再清缓存/停调度（防关停时未落盘表格丢失）
    try { await drainTableWrites(); } catch (e) { console.error("[beilu-memory] Unload drain 表格写入失败（可能有未落盘表格）:", e?.message || e); /* T021 留痕：关停路径尽力而为但丢数据必须留痕 */ }
    memoryCache.clear();
    try { stopAllSchedulers(); } catch { /* ignore */ }
    try { ideClient.disconnect(); } catch { /* ignore */ }
    try { const { stopAllSessions } = await import("../../../../public/parts/plugins/beilu-memory/lib/ai/gameCompanion.mjs"); stopAllSessions(); } catch { /* ignore */ } // T3e: gameCompanion 留守旧位(跨组待定)，指回旧 lib
    console.log("[beilu-memory] 记忆系统已卸载");
  },

  interfaces: {
    config: {
      // 此 SetData 是 action RPC，不是持久配置恢复器；生命周期加载阶段永不自动调用。
      loadPolicy: "never",
      GetData: (args) => handleGetData(args),
      SetData: (data, args) => handleSetData(data, args),
    },
    chat: {
      GetPrompt: (arg) => handleGetPrompt(arg),
      ReplyHandler: (reply, args) => handleReply(reply, args),
    },
  },
};

export default pluginExport;
