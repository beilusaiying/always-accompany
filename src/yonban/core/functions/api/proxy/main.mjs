import info_dynamic from "../../../../../public/parts/serviceGenerators/AI/proxy/info.dynamic.json" with { type: "json" };
import info from "../../../../../public/parts/serviceGenerators/AI/proxy/info.json" with { type: "json" };
import { buildProviderInfo } from "../_shared/buildInfo.mjs";
import { fetchChatCompletionWithRetry } from "./lib/httpFetch.mjs";
import { buildMessagesFromPromptStruct } from "../_shared/buildMessages.mjs";
import { clearXmlFormat } from "./lib/messageTransform.mjs";

import { wbT, wbD } from "../../../../../server/wbStub.mjs";
import { createDiag } from "../../../../../server/diagLogger.mjs";

const diag = createDiag("proxy");

export default {
  info,
  interfaces: {
    serviceGenerator: {
      GetConfigDisplayContent: async () => {
        // 单源占位注入：display.mjs 在浏览器执行拿不到后端 import，此处把后端单源常量
        // 替换进占位符——provider 值域（apiAdapters.PROVIDER_ENUM）与多角色提醒默认文案
        // （roleReminding.DEFAULT_ROLE_REMINDING_TEXT），前端展示与后端行为同一张表
        const { PROVIDER_ENUM, PROVIDER_META } = await import("./lib/apiAdapters.mjs");
        const { DEFAULT_ROLE_REMINDING_TEXT } = await import("../_shared/roleReminding.mjs");
        return {
          js: fs2
            .readFileSync(path.join(import.meta.dirname, "display.mjs"), "utf-8")
            .replace("'__PROVIDER_ENUM_JSON__'", JSON.stringify(JSON.stringify(PROVIDER_ENUM)))
            .replace("'__PROVIDER_META_JSON__'", JSON.stringify(JSON.stringify(PROVIDER_META)))
            .replace("__ROLE_REMINDING_DEFAULT__", DEFAULT_ROLE_REMINDING_TEXT),
        };
      },
      // 渠道元数据（枚举+label+默认URL+坑提示）给非 display 面板的前端（beilu-chat 设置面板渠道下拉）：
      // display.mjs 走占位符注入拿同一张表，此接口是同表的第二个出口，单源仍在 apiAdapters
      GetProviderMeta: async () => {
        const { PROVIDER_ENUM, PROVIDER_META } = await import("./lib/apiAdapters.mjs");
        return { enum: PROVIDER_ENUM, meta: PROVIDER_META };
      },
      GetConfigTemplate: async () => configTemplate,
      GetSource,
    },
  },
};

const configTemplate = {
  name: "openai-proxy",
  url: "https://api.openai.com/v1/chat/completions",
  model: "",
  apikey: "",
  custom_headers: {},
  // attachment_history（凛倾 0716 定案）：历史轮文本附件策略 hide=名字占位(默认)/block=屏蔽无痕/inline=历史也全文；最后一条 user 消息附件恒全文
  // attachment_texts：附件占位/截断文案逐键覆盖（键见 textAttachment.DEFAULT_ATTACHMENT_TEXTS，空对象=全用默认）
  convert_config: { provider: "", roleReminding: true, ignoreFiles: false, attachment_history: "hide", attachment_texts: {} },
  use_stream: true,
};

async function GetSource(config, { SaveConfig }) {
  config.use_stream ??= true;
  const result = {
    type: "text-chat",
    info: buildProviderInfo(info_dynamic, config),
    is_paid: false,
    extension: {},

    Call: async (prompt) =>
      fetchChatCompletionWithRetry(
        [{ role: "system", content: prompt }],
        { result: { content: "", files: [] } },
        config,
      ),

    StructCall: async (prompt_struct, options = {}) => {
      const {
        base_result = {},
        replyPreviewUpdater,
        signal,
        modelOverrides,
        aiPriority, // [0727 并发闸] "low"=分身/后台级（httpFetch 并发闸让路+串行），缺省=本体级
      } = options;
      const _wbChatid = prompt_struct?.chatid ?? prompt_struct?.chat_id ?? null;
      wbT(_wbChatid, "ai:request", "StructCall_entry", { model: config.model, charname: prompt_struct?.Charname, hasOverrides: !!modelOverrides });
      diag.debug("StructCall:", config.model, "char:", prompt_struct?.Charname || "(无)", "overrides:", modelOverrides ? Object.keys(modelOverrides).join(",") : "(无)");

      // ★ B10/B16 修复：使用局部副本，不再直接改写共享 config 对象
      // 避免并发 StructCall 之间参数串台
      const callConfig = {
        ...config,
        // SEC 破口A：把本次调用的归属用户带给 httpFetch（出站后 stripReasoningTags 按本人剥离规则，不串别的用户）
        username: prompt_struct?.username || config.username,
        model_arguments: config.model_arguments
          ? { ...config.model_arguments }
          : {},
        convert_config: config.convert_config
          ? { ...config.convert_config }
          : {},
      };

      if (modelOverrides) {
        if (modelOverrides.model) {
          callConfig.model = modelOverrides.model;
        }
        if (modelOverrides.stream !== undefined) {
          callConfig.use_stream = modelOverrides.stream;
        }
        if (modelOverrides.temperature !== undefined)
          callConfig.model_arguments.temperature = modelOverrides.temperature;
        if (modelOverrides.max_tokens !== undefined)
          callConfig.model_arguments.max_tokens = modelOverrides.max_tokens;
        if (modelOverrides.top_p !== undefined)
          callConfig.model_arguments.top_p = modelOverrides.top_p;
        // top_k/min_p：与 top_p 同通路（P系列参数设定对齐子模式，2026-07-11）
        if (modelOverrides.top_k !== undefined)
          callConfig.model_arguments.top_k = modelOverrides.top_k;
        if (modelOverrides.min_p !== undefined)
          callConfig.model_arguments.min_p = modelOverrides.min_p;
        // ★ 思考模式控制
        if (modelOverrides.include_reasoning !== undefined)
          callConfig.model_arguments.include_reasoning = modelOverrides.include_reasoning;
        // extended_thinking/thinking_budget 转发已删（2026-08-01 收口：思维链唯一入口=源 config，httpFetch 直读）
      }

      {
        // ★ 消息构建统一管线（2026-07-18 收口）：buildMessagesFromPromptStruct 是所有 generator 的单源，
        //   含 commander/compat 两分支 + 图片注入 + 宏替换。pp/adapt/prefill/HTTP 发送由 httpFetch 统一做。
        const { messages, useXmlFormat } = buildMessagesFromPromptStruct(prompt_struct, callConfig, configTemplate);
        wbT(_wbChatid, "ai:request", useXmlFormat ? "mode_compat" : "mode_commander", { msgCount: messages.length });

        const callResult = {
          content: "",
          files: [...(base_result?.files || [])],
        };
        const clearFmt = (r) => {
          if (useXmlFormat)
            r.content = clearXmlFormat(
              r.content,
              prompt_struct.alternative_charnames,
            );
          return r;
        };
        const previewUpdater = (r) => replyPreviewUpdater?.(clearFmt({ ...r }));

        wbT(_wbChatid, "ai:request", "api_call_start", { url: callConfig.url, model: callConfig.model, msgCount: messages.length, stream: callConfig.use_stream });
        diag.debug("api_call:", callConfig.model, "msgs:", messages.length, "stream:", !!callConfig.use_stream, "mode:", useXmlFormat ? "compat" : "commander", "pp:", callConfig.convert_config?.prompt_post_processing || "(无)");
        const _diagT0 = performance.now();
        await fetchChatCompletionWithRetry(
          messages,
          { signal, previewUpdater, result: callResult, ...(aiPriority ? { aiPriority } : {}) },
          callConfig,
        );
        diag.debug("api_done:", callConfig.model, `${(performance.now() - _diagT0).toFixed(0)}ms`, "contentLen:", callResult.content?.length || 0);
        wbT(_wbChatid, "ai:request", "api_call_done", { contentLen: callResult.content?.length || 0, files: callResult.files?.length || 0 });
        if (!callResult.content && (callResult.files?.length || 0) === 0) diag.warn("AI 返回空内容:", callConfig.model, callConfig.url);
        wbD(_wbChatid, "ai:request", "api_empty_result", !(!callResult.content && (callResult.files?.length || 0) === 0), "AI返回空内容", { contentLen: callResult.content?.length || 0 });
        clearFmt(callResult);

        // ★ 关键修复：将 AI 回复写回 base_result
        // 0714 根因修（thinking 对人消失·断点A）：此前只回灌 content+files，httpFetch:481 填的
        //   content_for_show（含 thinking 原文，给人看的一半）被丢——模板层每轮已重置 content_for_show=""，
        //   回落到已剥 content → 思维链对用户永久丢失（凛倾 05-18「思维链只是不发送给ai,不是不给用户看」）。
        //   双键契约（content=AI版/content_for_show=人版）必须整对回灌，缺一键=键对断配。
        if (base_result && typeof base_result === "object") {
          base_result.content = callResult.content;
          if (callResult.content_for_show) base_result.content_for_show = callResult.content_for_show;
          // [0727 终止原因入链] finish_reason 随双键契约一并回灌（httpFetch 单点捕获），
          //   回合层据此区分"自然完成(stop)"与"被截断(length等)"——0727 残句当成功收尾的病根。
          if (callResult.finish_reason) base_result.finish_reason = callResult.finish_reason;
          if (callResult.files?.length) {
            base_result.files = base_result.files || [];
            base_result.files = callResult.files;
          }
        }

        return callResult;
      }
    },

    tokenizer: {
      free: () => 0,
      encode: (p) => p,
      decode: (t) => t,
      decode_single: (t) => t,
      get_token_count: (p) => p.length,
    },
  };
  return result;
}
