/**
 * beilu 新用户默认占位角色卡（种子卡）
 *
 * 用途：新用户首次登录时，auth.mjs login 的 copySync 把整个 default/templates/user
 *   目录拷进 data/users/{username}/，本卡随之落到 data/users/{username}/chars/新的开始/，
 *   让新用户一进 beilu-chat 就有一张可对话的角色卡（否则空目录=无卡可聊）。
 *   凛倾后续给正式默认卡时，直接替换本目录内容即可。
 *
 * 注意：此文件运行期位于 data/users/{username}/chars/{charName}/main.mjs（5 层深度），
 *   因此下方 import 相对路径基于 data/users/xxx/chars/yyy/ 计算，与其他角色卡一致。
 *   （模板存放位置 default/templates/user/chars/ 只是拷贝源，运行位置永远在 data/users 下。）
 *
 * 特性（与标准角色卡模板一致）：
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

import { buildPromptStruct } from "../../../../../src/public/parts/shells/chat/src/prompt_struct.mjs";
import {
  loadAnyPreferredDefaultPart,
  loadPart,
} from "../../../../../src/server/parts_loader.mjs";
// SEC-T8：角色卡 description/personality/scenario 等字段是不可信外部资料（ST 卡可由第三方
//   分发），全裸注入 = 间接注入面。沿用 T7 范式做结构性边界包裹（尖括号中性化 + 不可信标注）。
//   path 与本文件运行位置一致（运行期复制到 data/users/{u}/chars/{c}/main.mjs，5 级回根到 src）。
import { wrapUntrusted } from "../../../../../src/yonban/core/functions/security/untrusted_content.mjs";
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
      GetData: () => ({
        AIsource: AIsource?.filename || "",
        plugins: Object.keys(plugins),
        chardata,
      }),
      SetData: async (data) => {
        console.log(
          `[beilu-char][SetData] AIsource="${data.AIsource || "(空)"}", username="${username}", chardir="${path.basename(chardir)}"`,
        );
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

        // SEC-T8：description/personality/scenario 为角色卡不可信字段，注入前做边界包裹
        //   （尖括号中性化 + 不可信标注）。system_prompt/post_history_instructions 是作者
        //   有意保留的指令通道，不在此包裹（包裹"勿执行"会与其用途冲突）。
        if (chardata.description) {
          texts.push({
            content: wrapUntrusted(chardata.description, "角色卡:description"),
            important: 2,
            description: "char_description",
          });
        }

        if (chardata.personality) {
          texts.push({
            content: wrapUntrusted(chardata.personality, "角色卡:personality"),
            important: 2,
            description: "personality",
          });
        }

        if (chardata.scenario) {
          texts.push({
            content: wrapUntrusted(chardata.scenario, "角色卡:scenario"),
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
              "• [首页 → 系统设置 → AI 服务源](/parts/shells:beilu-home/#system)（创建和管理服务源）\n" +
              "• [聊天界面 → 右侧面板 → 对话AI设置](/parts/shells:beilu-chat/api-config/)（快速配置）\n" +
              "• [首页 → 记忆预设 → API 配置](/parts/shells:beilu-home/#memoryPreset)（记忆AI独立配置）",
          };
        }

        // 注入角色插件
        args.plugins = Object.assign({}, plugins, args.plugins);
        // N10：补 args.username（与 prompt_struct.username 同源闭包 stat.username）。beilu-files 等
        //   插件用 `_als.run({username: args?.username || "_default"})` 设 per-user 上下文；缺它 → 权限/沙箱配置
        //   回退 _default 桶，具名账号拿不到自己的 allowedPaths/autoApprove。必须在 buildPromptStruct 前补。
        args.username = username;

        // 构建提示词结构
        const _wbCid = args?.chatid || args?.chat_name?.replace("common_chat_", "") || null;
        wbT(_wbCid, "orchestrator", "GetPrompt:enter", {});
        const prompt_struct = await buildPromptStruct(args);
        // ★ 图片发送修复（2026-06-16）：buildPromptStruct 不带 username，而反代 _resolveFileHash/_readFileByHash
        //   靠 prompt_struct.username 去 data/users/{username}/shells/chat/files/{hash} 还原 file:hash 图片。
        //   缺它 → 退查 "_default" 目录 → 具名账号的图 blob 找不到 → 图片完全嵌不进。此处补回账号名。
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
        // （不改角色绑定的默认 AIsource）。全程 try/catch + 加载失败/未设回退默认源，零风险。
        let _effSource = AIsource;
        const _smApiSrc =
          prompt_struct.plugin_prompts?.["beilu-memory"]?.extension?.sub_mode_api_source ||
          prompt_struct.plugin_prompts?.["beilu-preset"]?.extension?.beilu_model_params?.api_source_override ||
          "";
        if (_smApiSrc && _smApiSrc !== AIsource?.filename) {
          try {
            const _ovSource = await loadPart(username, "serviceSources/AI/" + _smApiSrc);
            if (_ovSource?.StructCall) {
              _effSource = _ovSource;
              wbT(_wbCid, "orchestrator", "submode_source_override", { source: _smApiSrc });
            }
          } catch (e) {
            wbD(_wbCid, "orchestrator", "submode_source_override", false, "子模式 API 源加载失败，回退默认源", { source: _smApiSrc, err: e?.message });
          }
        }
        // N36 刀3：源与模型是原子覆盖单元——意图换源但未换成时撤销整组覆盖，禁止「绑定源 URL + 覆盖模型」杂交请求。
        if (_smApiSrc && _effSource === AIsource && _smApiSrc !== AIsource?.filename) {
          const _bmp = prompt_struct.plugin_prompts?.["beilu-preset"]?.extension?.beilu_model_params;
          if (_bmp && (_bmp.model_override || _bmp.api_source_override)) {
            wbD(_wbCid, "orchestrator", "submode_override_unit_cancel", false, "源覆盖未生效，整组撤销模型覆盖防杂交", { source: _smApiSrc, model: _bmp.model_override || "" });
            delete _bmp.model_override;
            delete _bmp.api_source_override;
          }
        }

        // 重新生成循环
        regen: while (true) {
          args.generation_options.base_result = result;
          wbT(_wbCid, "orchestrator", "StructCall:before", {});
          result.content_for_show = ""; // N30: 本轮重置，由源按需填充，防 regen 陈旧
          await _effSource.StructCall(prompt_struct, args.generation_options);
          wbT(_wbCid, "orchestrator", "StructCall:after", {});
          // N30: proxy 已把含 <think> 原文放进 content_for_show、纯正文放 content。
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

          // 使用全部 ReplyHandler 执行后的最终内容作为编辑态回显基线
          result.content_for_edit = result.content;

          if (continue_regen) continue regen;
          break;
        }

        return result;
      },
    },
  },
};
