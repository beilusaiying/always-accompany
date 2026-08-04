/**
 * beilu 角色卡模板 — 从 ST 角色卡导入时使用
 *
 * 注意：此文件会被复制到 data/users/{username}/chars/{charName}/main.mjs
 * 因此 import 路径基于 data/users/xxx/chars/yyy/ 的 5 层深度
 *
 * 特性：
 * - 走 beilu 插件体系（beilu-preset 司令员模式接管提示词）
 * - 自动使用默认 AIsource（不需要单独配置）
 * - 开场白原样返回（display regex 由前端负责美化渲染）
 * - 角色卡的 description/personality/scenario 等通过 GetPrompt 输出
 *   交给 beilu-preset 的 TweakPrompt 接管
 *
 * @typedef {import('../../../../../src/decl/charAPI.ts').CharAPI_t} CharAPI_t
 * @typedef {import('../../../../../src/decl/pluginAPI.ts').PluginAPI_t} PluginAPI_t
 */

import fs from "node:fs";
import path from "node:path";

import { buildPromptStruct } from "../../../../../src/public/parts/shells/beilu-chat/src/prompt_struct.mjs";
import {
  loadAnyPreferredDefaultPart,
  loadPart,
} from "../../../../../src/server/parts_loader.mjs";
import { wbT, wbD } from "../../../../../src/server/wbStub.mjs";

/** @type {import('../../../../../src/decl/AIsource.ts').AIsource_t} */
let AIsource = null;
/** @type {Record<string, PluginAPI_t>} */
let plugins = {};
let username = "";

const chardir = import.meta.dirname;
const charjson = path.join(chardir, "chardata.json");
const charurl = `/parts/chars:${encodeURIComponent(path.basename(chardir))}`;

// 读取角色卡数据
let chardata = {};
try {
  chardata = JSON.parse(fs.readFileSync(charjson, "utf-8"));
} catch (e) {
  console.warn("[beilu-char] 读取 chardata.json 失败:", e.message);
}

/** @type {CharAPI_t} */
export default {
  info: {
    "": {
      name: chardata.name || path.basename(chardir),
      avatar: fs.existsSync(path.join(chardir, "public", "image.png"))
        ? charurl + "/image.png"
        : "",
      description:
        (chardata.creator_notes || chardata.description || "").split("\n")[0] ||
        "",
      description_markdown:
        chardata.creator_notes || chardata.description || "",
      version: chardata.character_version || "1.0",
      author: chardata.creator || "",
      tags: chardata.tags || [],
    },
  },

  Load: (stat) => {
    username = stat.username;
  },

  interfaces: {
    config: {
      // 首次角色加载也需要执行 SetData({})，以沿用既有默认 AI 源初始化链。
      loadPolicy: "always",
      GetData: () => ({
        AIsource: AIsource?.filename || "",
        plugins: Object.keys(plugins),
        chardata,
      }),
      SetData: async (data) => {
        console.log(
          `[beilu-char][SetData] AIsource="${data.AIsource || "(空)"}", username="${username}", chardir="${path.basename(chardir)}"`,
        );
        // [2026-08-01 改卡不重载修] chardata 分支——对齐 SillyTavern/Template/main.mjs:110-112：
        //   update-char 端点保存 chardata.json 后经此分支刷新模块级 chardata + info → 改卡当场生效。
        if (data.chardata) {
          chardata = data.chardata;
        }
        if (data.AIsource)
          AIsource = await loadPart(
            username,
            "serviceSources/AI/" + data.AIsource,
          );
        else
          AIsource = await loadAnyPreferredDefaultPart(
            username,
            "serviceSources/AI",
          );
        console.log(
          `[beilu-char][SetData] AIsource 加载结果: filename="${AIsource?.filename || "(null)"}", type="${AIsource?.type || "?"}"`,
        );
        if (data.plugins)
          plugins = Object.fromEntries(
            await Promise.all(
              data.plugins.map(async (x) => [
                x,
                await loadPart(username, "plugins/" + x),
              ]),
            ),
          );
      },
    },
    chat: {
      /**
       * 开场白 — 原样返回 first_mes / alternate_greetings
       * display regex 由前端 beilu-chat 负责美化渲染
       */
      GetGreeting: (_args, index) => {
        const greetings = [
          chardata.first_mes,
          ...(chardata.alternate_greetings || []),
        ].filter((x) => x);
        if (!greetings.length) return { content: "" };
        if (index >= greetings.length) throw new Error("Invalid index");
        return { content: greetings[index] };
      },

      GetGroupGreeting: (_args, index) => {
        const greetings = [
          ...(chardata.extensions?.group_greetings || []),
          ...(chardata.group_only_greetings || []),
        ].filter((x) => x);
        if (index >= greetings.length) throw new Error("Invalid index");
        return { content: greetings[index] };
      },

      /**
       * GetPrompt — 将角色卡数据作为 text[] 输出
       * beilu-preset 司令员模式会在 TweakPrompt 中接管这些内容
       */
      GetPrompt: (_args) => {
        const texts = [];

        if (chardata.system_prompt) {
          texts.push({
            content: chardata.system_prompt,
            important: 3,
            description: "system_prompt",
          });
        }

        if (chardata.description) {
          texts.push({
            content: chardata.description,
            important: 2,
            description: "char_description",
          });
        }

        if (chardata.personality) {
          texts.push({
            content: chardata.personality,
            important: 2,
            description: "personality",
          });
        }

        if (chardata.scenario) {
          texts.push({
            content: chardata.scenario,
            important: 1,
            description: "scenario",
          });
        }

        if (chardata.mes_example) {
          texts.push({
            content: chardata.mes_example,
            important: -1,
            description: "mes_examples",
          });
        }

        if (chardata.post_history_instructions) {
          texts.push({
            content: chardata.post_history_instructions,
            important: 0,
            description: "post_history_instructions",
          });
        }

        // depth_prompt（如果有）
        const dp = chardata.extensions?.depth_prompt;
        if (dp?.prompt) {
          texts.push({
            content: dp.prompt,
            important: 0,
            description: `depth_prompt_d${dp.depth || 4}`,
          });
        }

        return {
          text: texts,
          additional_chat_log: [],
          extension: {},
        };
      },

      /**
       * GetReply — 标准 beilu 模式
       * 使用默认 AIsource + buildPromptStruct + 插件 ReplyHandler
       */
      GetReply: async (args) => {
        // 防御性重试：用户可能在看到提示后已配置 AI 源，但角色卡的变量仍为 null
        if (!AIsource) {
          try {
            AIsource = await loadAnyPreferredDefaultPart(
              username,
              "serviceSources/AI",
            );
          } catch (e) {
            console.warn("[beilu-char] 重试加载 AI 源失败:", e.message);
          }
        }

        if (!AIsource) {
          return {
            content:
              "请先配置 AI 源，可在以下位置设置：\n" +
              "• [聊天界面 → 右侧面板 → 对话AI设置](/parts/shells:beilu-chat/api-config/)（快速配置）",
          };
        }

        // 注入角色插件
        args.plugins = Object.assign({}, plugins, args.plugins);
        // N10：补 args.username（与 :283 prompt_struct.username 同源闭包 stat.username）。beilu-files GetPrompt(main.mjs:2856)/
        //   ReplyHandler(:2903) 用 `_als.run({username: args?.username || "_default"})` 设 per-user 上下文；缺它 → 权限/沙箱配置
        //   回退 _default 桶，具名账号(凛倾)拿不到自己的 allowedPaths/autoApprove（违 T27 已定的 per-user A 全量）。必须在 buildPromptStruct 前补。
        args.username = username;

        // ★ MVU 诊断：确认插件列表和 ReplyHandler 可用性
        console.log("[beilu-char-template MVU DIAG] GetReply 被调用");
        console.log(
          "[beilu-char-template MVU DIAG] 模板自身 plugins keys:",
          Object.keys(plugins).join(",") || "(空)",
        );
        console.log(
          "[beilu-char-template MVU DIAG] args.plugins keys:",
          Object.keys(args.plugins).join(",") || "(空)",
        );
        const _replyHandlerPlugins = Object.entries(args.plugins)
          .filter(([, p]) => p?.interfaces?.chat?.ReplyHandler)
          .map(([name]) => name);
        console.log(
          "[beilu-char-template MVU DIAG] 有 ReplyHandler 的插件:",
          _replyHandlerPlugins.join(",") || "(无)",
        );
        if (!args.plugins["beilu-mvu"]) {
          console.log(
            "[beilu-char-template MVU DIAG] ✗ beilu-mvu 不在 args.plugins 中!",
          );
        } else {
          const mvuPlugin = args.plugins["beilu-mvu"];
          console.log(
            "[beilu-char-template MVU DIAG] beilu-mvu 存在, interfaces:",
            !!mvuPlugin?.interfaces,
            ", chat:",
            !!mvuPlugin?.interfaces?.chat,
            ", ReplyHandler:",
            !!mvuPlugin?.interfaces?.chat?.ReplyHandler,
          );
        }

        // 构建提示词结构
        const _wbCid = args?.chatid || args?.chat_name?.replace("common_chat_", "") || null;
        wbT(_wbCid, "orchestrator", "GetPrompt:enter", {});
        const prompt_struct = await buildPromptStruct(args);
        // ★ 图片发送修复（2026-06-16）：buildPromptStruct 不带 username，而反代 _resolveFileHash/_readFileByHash
        //   靠 prompt_struct.username 去 data/users/{username}/shells/chat/files/{hash} 还原 file:hash 图片。
        //   缺它 → 退查 "_default" 目录 → 具名账号(如"凛倾")的图 blob 找不到 → 图片完全嵌不进 → AI 看不到图。
        //   单用户默认装是 _default 才恰好能用；具名账号一律丢图。此处补回账号名(闭包 username)。
        prompt_struct.username = username;

        /** @type {import('../../../../../src/public/parts/shells/chat/decl/chatLog.ts').chatReply_t} */
        const result = {
          content: "",
          logContextBefore: [],
          logContextAfter: [],
          files: [],
          extension: {},
        };

        function AddLongTimeLog(entry) {
          entry.charVisibility = [args.char_id];
          result?.logContextBefore?.push?.(entry);
          prompt_struct.char_prompt.additional_chat_log.push(entry);
        }

        // 构建更新预览管线
        args.generation_options ??= {};
        const oriReplyPreviewUpdater =
          args.generation_options?.replyPreviewUpdater;
        let replyPreviewUpdater = (_args, r) => oriReplyPreviewUpdater?.(r);
        for (const GetReplyPreviewUpdater of [
          ...Object.values(args.plugins)
            .map((plugin) => plugin.interfaces?.chat?.GetReplyPreviewUpdater)
            .filter(Boolean),
        ])
          replyPreviewUpdater = GetReplyPreviewUpdater(replyPreviewUpdater);

        args.generation_options.replyPreviewUpdater = (r) =>
          replyPreviewUpdater(args, r);

        // 子模式/分身独立 API 源：prompt 带 sub_mode_api_source / api_source_override 时，本轮改用该源
        // （不改角色绑定的默认 AIsource）。此前 api_source_override 零消费端=子模式配的独立源永不生效。
        // [D3 0804] 加载失败不再无条件静默回退角色源：按 extension.sub_mode_fallback_policy 分支——
        //   fail_closed（默认）=可见未发送错误（同上方"请先配置 AI 源"形制，零 StructCall）；
        //   explicit_fallback=先试 sub_mode_fallback_source 再默认源，wbD 留痕 requested/actual。
        //   （235734 病根：UI 声称"跟随全局默认源"，实际静默用角色 AIsource——三处权威不一致）
        let _effSource = AIsource;
        const _smExt = prompt_struct.plugin_prompts?.["beilu-memory"]?.extension;
        const _smApiSrc =
          _smExt?.sub_mode_api_source ||
          prompt_struct.plugin_prompts?.["beilu-preset"]?.extension?.beilu_model_params?.api_source_override ||
          "";
        if (_smApiSrc && _smApiSrc !== AIsource?.filename) {
          let _ovErr = "";
          try {
            const _ovSource = await loadPart(username, "serviceSources/AI/" + _smApiSrc);
            if (_ovSource?.StructCall) {
              _effSource = _ovSource;
              wbT(_wbCid, "orchestrator", "submode_source_override", { source: _smApiSrc });
            } else _ovErr = "源无 StructCall";
          } catch (e) {
            _ovErr = e?.message || String(e);
          }
          if (_effSource === AIsource) {
            const _fbPolicy = _smExt?.sub_mode_fallback_policy || "fail_closed";
            const _fbName = _smExt?.sub_mode_fallback_source || "";
            if (_fbPolicy === "explicit_fallback") {
              if (_fbName && _fbName !== AIsource?.filename) {
                try {
                  const _fbSrc = await loadPart(username, "serviceSources/AI/" + _fbName);
                  if (_fbSrc?.StructCall) _effSource = _fbSrc;
                } catch { /* fallback 源也失败 → 落默认源（explicit_fallback 契约允许） */ }
              }
              wbD(_wbCid, "orchestrator", "submode_source_fallback", _effSource !== AIsource, "子模式源加载失败，explicit_fallback 生效", {
                requested: _smApiSrc,
                actual: _effSource !== AIsource ? _fbName : (AIsource?.filename || "(默认源)"),
                err: _ovErr,
              });
            } else {
              // fail_closed：本轮零请求，错误可见（不无提示改用角色绑定源=不伪造"子模式源在工作"）
              wbD(_wbCid, "orchestrator", "submode_source_override", false, "子模式 API 源加载失败，fail_closed 未发送", { source: _smApiSrc, err: _ovErr });
              return {
                content:
                  `子模式配置的 API 源「${_smApiSrc}」加载失败（${_ovErr}），本轮请求未发送。\n` +
                  "请在子模式设置中修正 API 源，或把该子模式的「源失败策略」改为显式回退。",
              };
            }
          }
        }
        // N36 刀3：源与模型是原子覆盖单元——意图换源但未换成（加载失败/无 StructCall）时
        // 撤销整组覆盖，禁止「绑定源 URL + 覆盖模型」杂交请求（分派单_子模式归属闸只闸源不闸模型 二B）。
        if (_smApiSrc && _effSource === AIsource && _smApiSrc !== AIsource?.filename) {
          const _bmp = prompt_struct.plugin_prompts?.["beilu-preset"]?.extension?.beilu_model_params;
          if (_bmp && (_bmp.model_override || _bmp.api_source_override)) {
            wbD(_wbCid, "orchestrator", "submode_override_unit_cancel", false, "源覆盖未生效，整组撤销模型覆盖防杂交", { source: _smApiSrc, model: _bmp.model_override || "" });
            delete _bmp.model_override;
            delete _bmp.api_source_override;
          }
        }

        // 重新生成循环（无次数上限，由 ReplyHandler 语义控制终止）
        regen: while (true) {
          args.generation_options.base_result = result;
          wbT(_wbCid, "orchestrator", "StructCall:before", {});
          result.content_for_show = ""; // N30: 本轮重置，由源（proxy 思维链分离）按需填充，防 regen 陈旧
          await _effSource.StructCall(prompt_struct, args.generation_options);
          wbT(_wbCid, "orchestrator", "StructCall:after", {});
          // N30(凛倾拍板"思维链直接正则隐藏"): proxy 已把含 <think> 原文放进 content_for_show、纯正文放 content。
          // - content_for_show: 只在源没给时回落 content，禁止覆盖（前端折叠/正则隐藏的料源）
          // - content_for_edit: 同取含思维链原文，"查看编辑"回显完整文本
          result.content_for_show = result.content_for_show || result.content;
          result.content_for_edit = result.content_for_show;
          let continue_regen = false;
          const _replyHandlerEntries = Object.entries(args.plugins).filter(
            ([, plugin]) => plugin.interfaces?.chat?.ReplyHandler,
          );
          wbT(_wbCid, "orchestrator", "ReplyChain:enter", {
            n: _replyHandlerEntries.length,
          });
          for (let _i = 0; _i < _replyHandlerEntries.length; _i++) {
            const _pluginName = _replyHandlerEntries[_i][0] || _i;
            const replyHandler =
              _replyHandlerEntries[_i][1].interfaces.chat.ReplyHandler;
            wbT(_wbCid, "orchestrator", "ReplyStep:before", {
              plugin: _pluginName,
            });
            try {
              const _regen = await replyHandler(result, {
                ...args,
                prompt_struct,
                AddLongTimeLog,
              });
              wbT(_wbCid, "orchestrator", "ReplyStep:after", {
                plugin: _pluginName,
                regen: !!_regen,
              });
              if (_regen) continue_regen = true;
            } catch (_e) {
              // 单插件异常隔离：不中断整条 ReplyHandler 链，跳过当前插件继续后续
              console.error(
                `[beilu-char-template] ReplyHandler 插件 "${_pluginName}" 抛异常，已隔离跳过:`,
                _e,
              );
              wbT(_wbCid, "orchestrator", "ReplyStep:error", {
                plugin: _pluginName,
                error: String(_e?.message || _e),
              });
            }
          }
          wbT(_wbCid, "orchestrator", "ReplyChain:exit", {});

          // 0714 根因修（thinking 对人消失·断点B）：原 `content_for_edit = result.content` 用已剥 thinking 的
          //   AI 版覆盖 :348 设的含原文版，直接打破 N30 契约（:346「content_for_edit 同取含思维链原文」），
          //   且编辑保存回写三键 → thinking 永久销毁。改为缺失才回落：链上（mvu 哨兵等）已设的含原文版不覆盖。
          result.content_for_edit = result.content_for_edit || result.content;

          if (continue_regen) {
            continue regen;
          }
          break;
        }

        return result;
      },
    },
  },
};
