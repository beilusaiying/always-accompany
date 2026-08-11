// _shared/buildMessages.mjs — 消息构建统一管线（所有 generator 的单源）
//
// 【why】6 个 generator（proxy/claude/grok/claude-api/ollama/gemini）各自从零构建 messages
//   （遍历 chat_log→映射 role→包裹格式→system_prompt→图片注入→文本附件），每次修复改 6 遍
//   （0716 附件/0717 regen 实证）。凛倾 2026-07-18 决策：proxy 做统一管线，其他 generator 接线，
//   删除重复。pp 只有 3 个模式（merge/semi/strict）。
//
// 【消费方】proxy/main.mjs StructCall · claude/grok/claude-api/ollama/gemini 的 StructCall
// 【管线】commander 分支 / compat 分支 → 图片注入 → 宏替换 → 用户选择的 PP → 输出 messages 数组
//   provider adapt / prefill / HTTP 发送仍由各 generator 的真实发送层负责。

import {
  margeStructPromptChatLog,
  structPromptToSingleNoChatLog,
} from "../../../../../public/parts/shells/beilu-chat/src/prompt_struct.mjs";
import { assembleCommanderMessages } from "./commanderAssembly.mjs";
import { detectImageMime, isSupportedImageMime, svgBufferToText, resolveFileBuffer } from "../../image/imageInjection.mjs";
import { isTextLikeFile } from "./textAttachment.mjs";
import { maybeAppendRoleReminder } from "./roleReminding.mjs";
import { applyModelParams } from "./applyModelParams.mjs";
import { paramDefault } from "../../prompt/preset/engine/paramSchema.mjs";
import { isIdeToolResultMsg } from "../../../transport/ideTagParser.mjs";
import {
  buildChatLogMessages,
  buildCompatMessages,
  squashSystemMessages,
  postProcessMessages,
} from "../proxy/lib/messageTransform.mjs";
import { findVolatileStart } from "./volatileBoundary.mjs";

/**
 * 从 prompt_struct 构建 messages 数组（commander / compat 两分支 + 图片注入 + 宏替换）。
 *
 * !!!禁止放入提示词!!! 提示词文本只允许住 INJ 条目和预设（凛倾 0722）；本管线是消息组装层，
 * 禁止在此硬编码任何进 messages 的提示词/引导句/包装标签。唯一豁免=AI 发指令后的系统回执
 * （工具结果类，必须在对话尾部）。动态内容禁入头部 system 区（提示词缓存前缀失效，0722 确诊）。
 *
 * @param {object} prompt_struct - 结构化提示
 * @param {object} callConfig - AI 源配置（浅拷贝，本函数会就地修改 convert_config / model / model_arguments 等）
 * @param {object} [configTemplate] - 源配置模板（convert_config 默认值来源）
 * @returns {{ messages: Array<{role:string, content:string|object[]}>, useXmlFormat: boolean }}
 */
export function buildMessagesFromPromptStruct(prompt_struct, callConfig, configTemplate = {}) {
  const ignoreFiles =
    callConfig.convert_config?.ignoreFiles ??
    configTemplate.convert_config?.ignoreFiles;
  const attachmentHistory =
    callConfig.convert_config?.attachment_history ??
    configTemplate.convert_config?.attachment_history;
  // 附件占位/截断文案逐键覆盖（0722 铁律迁移，键见 textAttachment.DEFAULT_ATTACHMENT_TEXTS）
  const attachmentTexts =
    callConfig.convert_config?.attachment_texts ??
    configTemplate.convert_config?.attachment_texts;
  const presetExt =
    prompt_struct.plugin_prompts?.["beilu-preset"]?.extension;
  const commanderMode =
    presetExt?.commander_mode && presetExt?.beilu_preset_messages;
  let messages;
  let useXmlFormat = true;

  if (commanderMode) {
    useXmlFormat = false;
    const modelParams = presetExt.beilu_model_params || {};
    const toApiMsg = (msg) => {
      const out = {
        role:
          msg.role === "user"
            ? "user"
            : msg.role === "assistant"
              ? "assistant"
              : "system",
        content: msg.content || "",
      };
      if (msg._identifier || msg.identifier) out._identifier = msg._identifier || msg.identifier;
      if (msg._section) out._section = msg._section;
      if (msg._name || msg.name) out._name = msg._name || msg.name;
      if (msg._source) out._source = msg._source;
      return out;
    };
    const _chatMsgs = buildChatLogMessages(prompt_struct, ignoreFiles, attachmentHistory, attachmentTexts);
    ({ messages } = assembleCommanderMessages(presetExt, {
      mapMsg: toApiMsg,
      chatSegment: _chatMsgs,
      // [0722 凛倾定案] cacheBoundary data 块前移机制已连根删除（宏在哪里，位置就在那里）：
      //   -data 条目固定留在 below 段声明位置，不再搬进聊天记录内部。
    }));
    if (modelParams.squash_system_messages)
      messages = squashSystemMessages(messages);
    const _ppIntent =
      modelParams.prompt_post_processing ||
      callConfig.convert_config?.prompt_post_processing;
    if (_ppIntent) {
      callConfig.convert_config = {
        ...callConfig.convert_config,
        prompt_post_processing: _ppIntent,
      };
    }
    if (modelParams.model_override) {
      callConfig.model = modelParams.model_override;
    }
    if (modelParams.max_context) {
      callConfig.max_context = modelParams.max_context;
    }
    const { args: _applied } = applyModelParams(modelParams, { shape: "openai", model: callConfig.model });
    const ema = { ...callConfig.model_arguments, ..._applied };
    if (modelParams.show_thoughts) ema.include_reasoning = true;
    if (
      modelParams.reasoning_effort &&
      modelParams.reasoning_effort !== "auto"
    )
      ema.reasoning_effort = modelParams.reasoning_effort;
    // extended_thinking/thinking_budget 转发已删（2026-08-01 收口：思维链唯一入口=源 config，
    //   httpFetch 直读 config，预设 modelParams 不再携带/透传 thinking 键）
    delete ema.extended_thinking;
    delete ema.thinking_budget;
    callConfig.model_arguments = ema;
    const claudeMode = modelParams.claude_prefill_mode || "off";
    if (claudeMode !== "off") {
      callConfig.convert_config.claude_prefill_mode = claudeMode;
    }
    if (modelParams.stream !== undefined) {
      callConfig.use_stream = modelParams.stream;
    }
  } else {
    const mergedChatLog = margeStructPromptChatLog(prompt_struct)
      .filter(e => !e.extension?._hidden);
    messages = buildCompatMessages(mergedChatLog, ignoreFiles, prompt_struct?.username, attachmentHistory, attachmentTexts);
    const system_prompt = structPromptToSingleNoChatLog(prompt_struct);
    if (callConfig.system_prompt_at_depth ?? 10)
      messages.splice(
        Math.max(
          messages.length - (callConfig.system_prompt_at_depth ?? 10),
          0,
        ),
        0,
        { role: "system", content: system_prompt },
      );
    else messages.unshift({ role: "system", content: system_prompt });
    if (callConfig.convert_config?.roleReminding ?? true) {
      maybeAppendRoleReminder({
        messages,
        promptStruct: prompt_struct,
        text: callConfig.convert_config?.role_reminding_text || undefined,
      });
    }
  }

  // 图片注入
  if (!ignoreFiles) {
    const _hasValidImage = messages.some((m) =>
      Array.isArray(m.content) && m.content.some((p) =>
        p.type === "image_url" && p.image_url?.url?.length > 100
      )
    );
    if (!_hasValidImage) {
      for (const m of messages) {
        if (Array.isArray(m.content)) {
          m.content = m.content.filter((p) =>
            p.type !== "image_url" || (p.image_url?.url?.length > 100)
          );
          if (m.content.length === 1 && m.content[0].type === "text") {
            m.content = m.content[0].text;
          }
        }
      }
    }
    if (!_hasValidImage) {
      const _chatLog = prompt_struct.chat_log || [];
      let _lastUserIdx = -1;
      for (let _ii = _chatLog.length - 1; _ii >= 0; _ii--) {
        if (_chatLog[_ii].role === "user") { _lastUserIdx = _ii; break; }
      }
      // 文本类附件（含 .svg/image/svg+xml，isTextLikeFile 单源判据）不进图片兜底注入：
      // 它们已由 buildEntryAttachmentText 文本附件链全文注入，这里再转一份=双份污染上下文；
      // svg 走图片链还曾致 400（0727 事故）。本过滤对齐框架既有"svg=文本"概念。
      const _isEmbeddableImageFile = (f) =>
        (f.mime_type || f.type || "").startsWith("image/") && f.buffer && !isTextLikeFile(f);
      // [P2-2 0805] 图片源=本轮窗口（最后一条 user 起到末尾）内最近一条带图片附件的条目。
      //   原来只读最后一条 user 的 files → 工具/插件在本轮生成的图片（如 beilu-ppt 把 PNG 预览
      //   挂在回复气泡 reply.files）永远进不了视觉链，AI 审查 PPT 只能看字符画（凛倾 0805
      //   「直接修PPT注入」）。窗口不越过最后一条 user → 历史图片不复发嵌入（零 token 复发
      //   成本设计保留）；deepseek 等无视觉渠道由 providerPatch image_url 剥离兜底。
      let _imgSrcIdx = -1;
      if (_lastUserIdx >= 0) {
        for (let _ii = _chatLog.length - 1; _ii >= _lastUserIdx; _ii--) {
          if ((_chatLog[_ii].files || []).some(_isEmbeddableImageFile)) { _imgSrcIdx = _ii; break; }
        }
      }
      const _imgFiles = _imgSrcIdx >= 0
        ? (_chatLog[_imgSrcIdx].files || []).filter(_isEmbeddableImageFile)
        : [];
      if (_imgFiles.length > 0) {
        const _imgParts = [];
        const _username = prompt_struct.username || callConfig.username || "_default";
        for (const f of _imgFiles) {
          let _b64 = "";
          let _bytes = null;
          const _resolved = resolveFileBuffer(f, _username);
          if (Buffer.isBuffer(_resolved) && _resolved.length > 0) {
            _bytes = _resolved;
            _b64 = _resolved.toString("base64");
          } else if (typeof f.buffer === "string" && !f.buffer.startsWith("file:")) {
            _b64 = f.buffer;
            try {
              const _bb = Buffer.from(_b64, "base64");
              if (_bb.length > 0) _bytes = _bb;
            } catch { /* 非法 base64 → _bytes 留空，走降级 */ }
          }
          if (!_b64) continue;
          // ★ 支持集闸（imageInjection 单源）：magic bytes 权威判型——jpeg/png/gif/webp 全部
          //   可 magic 识别，检测不到 = 一定不是真支持图片，声明 mime 不作数（错标 png 的 SVG
          //   曾靠声明混进请求 → API 400 整轮报废，0727 空回复事故）。
          //   违规修复（凛倾 0727"直接转"）：历史会话里已存在这种附件也要能继续发——
          //   SVG=XML 文本 → 直接转成源码文本进上下文；其余不支持格式 → 文本说明降级。
          const _detected = _bytes ? detectImageMime(_bytes) : null;
          if (_detected && isSupportedImageMime(_detected)) {
            _imgParts.push({ type: "image_url", image_url: { url: `data:${_detected};base64,${_b64}` } });
          } else {
            const _svgText = _bytes ? svgBufferToText(_bytes, f.mime_type || f.type) : null;
            if (_svgText) {
              _imgParts.push({ type: "text", text: `[SVG 源码 ${f.name || ""}]:\n${_svgText}` });
              console.warn(`[buildMessages] SVG 附件已转文本源码（${f.name || "unnamed"}）`);
            } else {
              const _mtLabel = _detected || f.mime_type || f.type || "unknown";
              _imgParts.push({ type: "text", text: `[附件: 图片 ${f.name || "unnamed"}（格式 ${_mtLabel} 不受视觉模型支持，未嵌入）]` });
              console.warn(`[buildMessages] 跳过不支持的图片附件 ${_mtLabel}（${f.name || "unnamed"}）：视觉通道仅收 jpeg/png/gif/webp`);
            }
          }
        }
        if (_imgParts.length > 0) {
          for (let _jj = messages.length - 1; _jj >= 0; _jj--) {
            if (messages[_jj].role === "user") {
              const _c = messages[_jj].content;
              messages[_jj].content = Array.isArray(_c)
                ? [..._c, ..._imgParts]
                : [{ type: "text", text: _c || "" }, ..._imgParts];
              break;
            }
          }
        }
      }
    }
  }

  // 宏替换——[0722 审计 M3 值源追认] 与 marco.evaluateMacros 的 env.char/env.user 同源
  //   （preset/main.mjs:2999 env.char=ps.Charname，本处直接读同一 prompt_struct.Charname），
  //   无值分裂；本块是 evaluateMacros 未覆盖路径（compat/漏网 {{char}}）的幂等兜底，非第二引擎。
  //   契约：若 env.char 赋值源改动，此处必须同步（同源契约，改一处查两处）。
  const _charName = prompt_struct.Charname || "";
  const _userName = prompt_struct.UserCharname || "";
  if (_charName || _userName) {
    const _replaceMacros = (s) => {
      let r = s;
      if (_charName) r = r.replace(/\{\{char\}\}/gi, _charName);
      if (_userName) r = r.replace(/\{\{user\}\}/gi, _userName);
      return r;
    };
    for (const msg of messages) {
      if (typeof msg.content === "string") {
        if (msg.content.includes("{{")) msg.content = _replaceMacros(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const _part of msg.content) {
          if (_part && _part.type === "text" && typeof _part.text === "string" && _part.text.includes("{{")) {
            _part.text = _replaceMacros(_part.text);
          }
        }
      }
    }
  }

  // 用户按 AI 源显式开启时，只在最终请求的消息副本上把 IDE 工具回执改为 user。
  // 必须放在 PP 合并之前：否则工具回执可能先与相邻 system 合并，随后会把整段提示词一起降级。
  // 识别规则复用 ideTagParser 单一真源；聊天记录本体、普通 system、消息文本和顺序均不修改。
  if (callConfig.convert_config?.ide_tool_results_as_user === true) {
    let _convertedToolResults = 0;
    messages = messages.map((message) => {
      if (message.role !== "system" || !isIdeToolResultMsg(message)) return message;
      _convertedToolResults++;
      return { ...message, role: "user" };
    });
    if (_convertedToolResults > 0) {
      console.log(`[buildMessages] IDE 工具结果出站角色 system→user: ${_convertedToolResults} 条`);
    }
  }

  // 2026-07-29：PP 必须在所有 generator 上是同一个功能。旧代码在这里无条件 merge，
  // 同时只有 proxy/httpFetch 真正消费 prompt_post_processing，导致 none 不是真关闭，
  // claude-api/gemini/grok/ollama/claude 等直连 generator 又完全忽略用户选择。
  // 共享出口先按本轮有效配置执行；proxy 会在 tail-prefill/resume 后按同一值幂等再执行一次。
  const _finalPostProcess =
    callConfig.convert_config?.prompt_post_processing || "none";
  messages = postProcessMessages(messages, _finalPostProcess);

  // [0722 审计 M2 收口] 易变区起点在最终输出形状上用单源判据计算（merge 后索引不再漂移；
  //   mapMsg 已剥元数据故靠 volatileBoundary 的正文标签判据），随返回值流向断点消费方
  //   （claude-api 直连等），终结"权威边界算了就丢、消费方各自反推"的双源病。
  const volatileStart = findVolatileStart(messages);

  return { messages, useXmlFormat, volatileStart };
}
