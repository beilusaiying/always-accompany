/**
 * main.mjs — beilu-reach 插件实现体
 *
 * 【定位】平台触达插件：让 AI 通过 <reach> 标签获取 13 个互联网平台的结构化数据。
 *
 * 【功能链】
 *   parts_loader → Load(注册 config REST + 探测平台)
 *   → GetPrompt(注入可用平台描述 + <reach> 用法)
 *   → ReplyHandler(解析 <reach> 标签 → 路由到适配器 → pendingResult 注入)
 *   → GetData/SetData(平台状态 + 配置)
 *
 * 【关联链】
 *   ← plugins/beilu-reach/main.mjs（P 型薄壳 re-export）
 *   → config.mjs（配置单源：落盘/归一化/白名单，钩子与 execute 同源读）
 *   → doctor.mjs（runDoctor/getAvailablePlatforms）
 *   → index.mjs（dispatch 注册 functions:reach）
 *   → execute.mjs → adapters/*（平台适配器，config 在 execute 统一透传）
 */

import info from "../../../../public/parts/plugins/beilu-reach/info.json" with { type: "json" };
import { authenticate } from "../security/auth.mjs"; // config REST 端点鉴权（范式同 web/main.mjs）
import { runDoctor, getAvailablePlatforms, invalidateCache } from "./doctor.mjs";
import { executeReach } from "./execute.mjs";
import { getReachConfig, setReachConfig, REACH_DEFAULTS, REACH_CONFIG_META } from "./config.mjs"; // 配置单源：落盘+归一化+控件元数据，钩子/execute/bridge/前端面板同源读
import { getInjectText } from "../injectTexts/main.mjs";
import { wbT, wbD } from "../../../../server/wbStub.mjs"; // 全线路白盒（凛倾 0722）：标签入口/逐调用成败可观测

function _parseReachCalls(content) {
  const calls = [];
  const regex = /<reach\s+platform="([^"]+)"\s+action="([^"]+)"(?:\s+limit="(\d+)")?(?:\s+[^>]*)?>([^<]*)<\/reach>/gi;
  let m;
  while ((m = regex.exec(content)) !== null) {
    calls.push({
      platform: m[1],
      action: m[2],
      limit: m[3] ? parseInt(m[3], 10) : undefined,
      query: m[4].trim(),
      fullMatch: m[0],
    });
  }
  return calls;
}

/** 不可信平台内容出口清洗（安全同步 0722）：原自写半角→全角替换与 security/untrusted_content
 *  原语重复且缺不可见 Unicode 剥除、缺 nonce 边界标注（防伪造闭合）——收口到单源（范式=aiRunner P8 联网结果）。 */
async function _neutralize(text, sourceTag) {
  if (typeof text !== "string") {
    try { text = JSON.stringify(text, null, 2); } catch { text = String(text); }
  }
  const { wrapUntrusted, stripInvisibleUnicode } = await import("../security/untrusted_content.mjs");
  return wrapUntrusted(stripInvisibleUnicode(text), sourceTag);
}

const pluginExport = {
  info,

  async Load({ router, username }) {
    // 注册 config REST 端点（GET getdata + POST setdata + authenticate，范式同 web/main.mjs——
    // 此前 getdata 注册成 POST 而前端 sendAction 用 GET 恒 404，且两路由都漏鉴权）
    if (router) {
      router.get(/\/config\/getdata$/, authenticate, async (_req, res) => {
        try { res.json(await pluginExport.interfaces.config.GetData()); }
        catch (e) { res.status(500).json({ error: e.message }); }
      });
      router.post(/\/config\/setdata$/, authenticate, async (req, res) => {
        try { res.json(await pluginExport.interfaces.config.SetData(req.body)); }
        catch (e) { res.status(500).json({ error: e.message }); }
      });
    }

    // 后台探测平台可用性（不阻塞 Load）
    runDoctor().catch(() => {});

    // 注册为默认插件
    try {
      const { setDefaultPart } = await import("../../../../server/parts_loader.mjs");
      if (setDefaultPart) setDefaultPart(username, "plugins", "beilu-reach");
    } catch {}
  },

  async Unload() {
    invalidateCache();
  },

  interfaces: {
    config: {
      async GetData() {
        const platforms = await runDoctor();
        // meta/defaults 随下发：前端面板纯渲染，零默认值副本/零限值字面量（凛倾 0722 禁前端硬编码）
        return { platforms, config: getReachConfig(), meta: REACH_CONFIG_META, defaults: REACH_DEFAULTS };
      },
      async SetData(data) {
        if (!data) return;

        if (data._action === "doctor") {
          return await runDoctor(true);
        }

        // 归一化 merge + 落盘走 config.mjs 单源（概念域校验/布尔整数归一化/防抖持久化都在那里）
        setReachConfig(data);
        invalidateCache();
      },
    },

    chat: {
      // [0730 迁 INJ] 平台触达能力注入已迁入 INJ-plugin-reach 条目（默认关闭）。
      // 原硬编码 GetPrompt 违反铁律「GetPrompt 禁止硬编码提示词文本」，且前端 INJ 面板不可见不可控。
      async GetPrompt() { return null; },

      async ReplyHandler(reply, args) {
        if (!getReachConfig().enabled) return false;
        if (!reply?.content) return false;
        const calls = _parseReachCalls(reply.content);
        if (calls.length === 0) return false;
        const _ownerUsername = args?.username || "";

        let _chatid = null;
        try {
          const cn = args?.chat_name || "";
          if (cn.startsWith("common_chat_")) _chatid = cn.slice("common_chat_".length);
          if (!_chatid) {
            const { getAmbientChatId } = await import("../../../../server/whitebox.mjs");
            _chatid = getAmbientChatId?.() || null;
          }
        } catch {}

        const { ideClient } = await import("../../transport/ideClient.mjs");
        wbT(_chatid, "reach:tag", "ReplyHandler.calls", { n: calls.length, calls: calls.map((c) => `${c.platform}:${c.action}`) });

        for (const call of calls) {
          let entry;
          try {
            // config 由 execute.mjs 从配置单源统一透传（AI 标签/dispatch 两路同源），此处只传调用参数
            const result = await executeReach(call.platform, call.action, call.query, { limit: call.limit });
            wbD(_chatid, "reach:tag", "execute.ok", true, "", { platform: call.platform, action: call.action });
            const resultText = await _neutralize(result, `reach:${call.platform}:${call.action}`);
            entry = {
              chatid: _chatid,
              tool: `reach:${call.platform}:${call.action}`,
              params: { query: call.query, limit: call.limit },
              timestamp: new Date().toISOString(),
              result: {
                success: true,
                result: `Platform: ${call.platform}, Action: ${call.action}\nQuery: ${call.query}\n\n${resultText}`,
              },
            };
          } catch (err) {
            wbD(_chatid, "reach:tag", "execute.fail", false, String(err?.message || err).slice(0, 160), { platform: call.platform, action: call.action });
            entry = {
              chatid: _chatid,
              tool: `reach:${call.platform}:${call.action}`,
              params: { query: call.query },
              timestamp: new Date().toISOString(),
              result: {
                success: false,
                error: `reach/${call.platform}/${call.action}: ${err.message}`,
              },
            };
          }
          ideClient.enqueuePendingResult({ ...entry, ownerUsername: _ownerUsername });
        }

        return false;
      },
    },
  },
};

export default pluginExport;
