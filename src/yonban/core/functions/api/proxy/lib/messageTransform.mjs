/**
 * proxy/lib/messageTransform.mjs
 * 消息序列构建与后处理
 *
 * 导出：
 *   buildChatLogMessages(prompt_struct, ignoreFiles, attachmentHistory = "hide", attachmentTexts) → Array
 *   postProcessMessages(messages, type) → Array
 *   mergeConsecutiveRoles(messages) → Array
 *   squashSystemMessages(messages) → Array
 */

/** @typedef {import('../../../../../../decl/prompt_struct.ts').prompt_struct_t} prompt_struct_t */

import fs_mt from "node:fs";
import { wbT, wbD } from "../../../../../../server/wbStub.mjs";
import path_mt from "node:path";
import { escapeRegExp } from "../../../../../../scripts/escape.mjs";
import { detectImageMime, isSupportedImageMime, svgBufferToText } from "../../../image/imageInjection.mjs";
// [0717 regen断链根修] commander 分支此前直读 prompt_struct.chat_log，五路 additional_chat_log
//   （AddLongTimeLog 工具结果回喂通道）全丢 → 模板 regen 续轮每轮拿到与首轮相同的上下文从头重跑
//   （日志实锤：单 GetReply 内 8 连轮 messages 恒 3→3，用户体感"完成后消失重新开始"）。
//   改经 margeStructPromptChatLog 单源合并（compat 分支 main.mjs:252 同源），marge 内建
//   charVisibility 过滤 + logContextBefore/After 展平。import 走 chat 桥接壳（export * 透传），
//   与 proxy/grok/claude-api 各源同路径。
import { margeStructPromptChatLog } from "../../../../../../public/parts/shells/beilu-chat/src/prompt_struct.mjs";
// [0716 附件传导链修] 文本附件处理单源（md/txt/json/代码等 → 正文文本块/历史占位），见该模块头注释
import { buildEntryAttachmentText, isTextLikeFile, findLastUserIndex, findLastUserFilesIndex } from "../../_shared/textAttachment.mjs";

// ★ 思维链标签配置
// 默认支持 <think> 和 <thinking>，用户可通过配置扩展或临时禁用内置标签
// ★ T3b·hide 组：thinking 剥离单源（BUILTIN 标签/用户配置加载/getReasoningTags/stripReasoningTags）
//   已抽出归 hide 组。本文件 import 自用（:205 postProcessMessages）+ re-export 保外部宿主
//   （aiRunner/getPromptHandler/replyHandler/generation/httpFetch）import 路径不断。
import { getReasoningTags, stripReasoningTags } from "../../../hide/stripThinking.mjs";
export { getReasoningTags, stripReasoningTags } from "../../../hide/stripThinking.mjs";

/** 从 file:hash 读取实际文件数据（同步） */
function _resolveFileHash(buffer, username) {
  if (typeof buffer !== "string" || !buffer.startsWith("file:")) return null;
  const hash = buffer.slice(5);
  const _dataRoot = path_mt.join(import.meta.dirname, "..", "..", "..", "..", "..", "..", "..", "data", "users");
  // 尝试当前用户
  for (const u of [username, "_default"]) {
    if (!u) continue;
    const fp = path_mt.join(_dataRoot, u, "shells", "chat", "files", hash);
    if (fs_mt.existsSync(fp)) return fs_mt.readFileSync(fp);
  }
  return null;
}

// ============================================================
// 司令员模式辅助函数
// ============================================================

/**
 * 从 prompt_struct 构建聊天记录消息（司令员模式用）
 * 不使用 XML 包裹，直接以纯文本形式传递
 *
 * @param {prompt_struct_t} prompt_struct - 结构化提示
 * @param {boolean} ignoreFiles - 是否忽略文件
 * @returns {Array<{role: string, content: string|object[]}>}
 */
export function buildChatLogMessages(prompt_struct, ignoreFiles, attachmentHistory = "hide", attachmentTexts) {
  // [0717 regen断链根修] chat_log → 合并 log（含 additional_chat_log 工具结果条），见文件头 import 注释。
  //   ephemeral/_hidden 过滤保留在下方循环（:98/:100 语义不变）；marge 输出是新数组，不污染原 chat_log。
  //   skipStoredLogContext（0717 二修·凛倾链路确诊"输出完成后又发送一遍"）：盘上条目的工具轨迹
  //   logContext 不跨轮重灌——否则 <ppt_op> 等调用原文落尾部被当预填充，模型整轮重生成+工具重执行。
  const chatLog = margeStructPromptChatLog(prompt_struct, { skipStoredLogContext: true });
  const messages = [];
  wbT(prompt_struct?.chatid ?? null, "ai:transform", "buildChatLog_entry", { chatLogLen: chatLog.length, ignoreFiles, attachmentHistory });

  // ★ 图片诊断：统计 chatLog 中有文件的条目
  {
    const _entriesWithFiles = chatLog.map((e, i) => ({ i, role: e.role, filesLen: e.files?.length || 0, mimes: (e.files || []).map(f => f.mime_type || f.type || "?") })).filter(e => e.filesLen > 0);
    if (_entriesWithFiles.length > 0) {
      console.log(`[buildChatLogMessages] chatLog总条数=${chatLog.length}, 含文件的条目:`, JSON.stringify(_entriesWithFiles));
    }
    // 检查最后一条 user 消息是否有 files
    const _lastEntry = chatLog[chatLog.length - 1];
    if (_lastEntry) {
      const _hasFiles = _lastEntry.files?.length > 0;
      const _hasBuffer = _hasFiles && _lastEntry.files.some(f => f.buffer);
      const _bufferTypes = _hasFiles ? _lastEntry.files.map(f => typeof f.buffer === "object" ? (Buffer.isBuffer(f.buffer) ? "Buffer" : f.buffer?.constructor?.name) : typeof f.buffer) : [];
      console.log(`[buildChatLogMessages] 最后条目: role=${_lastEntry.role}, files=${_lastEntry.files?.length || 0}, hasBuffer=${_hasBuffer}, bufferTypes=[${_bufferTypes}], ignoreFiles=${ignoreFiles}`);
    }
  }

  // 只嵌入最后一条 user 消息的图片/音频，历史媒体全部 pass（不往回找）
  // [0716 音控修·凛倾定案] 原门控只认 image/*——最后一条 user 消息「只有音频没图片」时音频也被丢
  //   （shouldEmbed 恒 false 走占位路径）。扩为 image|audio 后纯音频消息可正常嵌入；图片历史省略策略维持不变。
  const _lastUserIdx = findLastUserIndex(chatLog);
  let lastImageEntryIndex = -1;
  if (_lastUserIdx >= 0 && chatLog[_lastUserIdx].files?.some((f) => /^(image|audio)\//.test(f.mime_type || f.type || ""))) {
    lastImageEntryIndex = _lastUserIdx;
  }
  // 文本附件"最后一次全文"锚点=最近一条带附件的 user 消息（与媒体门控语义刻意不同，见 textAttachment.mjs）
  const _lastUserFilesIdx = findLastUserFilesIndex(chatLog);
  if (lastImageEntryIndex >= 0) {
    const _imgEntry = chatLog[lastImageEntryIndex];
    const _imgFiles = (_imgEntry.files || []).filter(f => (f.mime_type || f.type || "").startsWith("image/"));
    console.log(`[buildChatLogMessages] ★ 当前轮图片: idx=${lastImageEntryIndex}/${chatLog.length - 1}, 图片数=${_imgFiles.length}, bufferOK=${_imgFiles.map(f => Buffer.isBuffer(f.buffer) ? "Y" : typeof f.buffer === "string" ? "str" : "?").join(",")}`);
  } else {
    console.log(`[buildChatLogMessages] 最后user消息无图片，跳过所有历史图片`);
  }

  for (let idx = 0; idx < chatLog.length; idx++) {
    const entry = chatLog[idx];
    // 跳过临时注入的条目（由预设在 TweakPrompt Round 3 注入的）
    if (entry.extension?.ephemeral) continue;
    // 智能清理标记：_hidden 的消息不注入上下文，但保留在 chatLog 中
    if (entry.extension?._hidden) continue;

    const role =
      entry.role === "user"
        ? "user"
        : entry.role === "system"
          ? "system"
          : "assistant";
    // 出站兜底剥离（0716 回归单源）：内置+自定义 thinking 标签在组装点（regex TweakPrompt）已剥，
    // 但 regex 插件禁用/旁路调用时组装点不跑——proxy 出站是喂 AI 前最后关口，此处按用户
    // 「思维链显示」设置兜底（stripReasoningTags 幂等，含 includes 预检，已剥文本零开销直过）。
    let content = entry.content || "";
    if (role === "assistant") content = stripReasoningTags(content, prompt_struct?.username);

    /** @type {{role: string, content: string|object[]}} */
    const message = { role, content };

    // 处理附带的文件
    if (entry.files?.length) {
      // [0716 附件传导链修·凛倾定案] 文本类附件（md/txt/json/代码等）→ buildEntryAttachmentText 单源：
      //   全文只给最后一条 user 消息；历史轮按 attachmentHistory 用户配置——hide(默认)=名字占位/
      //   block=屏蔽无痕/inline=历史也全文（30k/文件截断闸）。原实现文本附件一律 "can't show you"
      //   占位 → AI 永远读不到（凛倾实证 README_CN.md 0 字符进上下文）。
      //   ignoreFiles（用户显式忽略全部附件）优先级最高。非文本附件走原图片/音频/占位路径。
      const _mediaFiles = ignoreFiles ? [...entry.files] : entry.files.filter((f) => !isTextLikeFile(f));
      if (!ignoreFiles) {
        const _at = buildEntryAttachmentText(entry, { isLastUser: idx === _lastUserFilesIdx, username: prompt_struct?.username, historyMode: attachmentHistory, texts: attachmentTexts });
        if (_at) {
          content = content + _at;
          message.content = content;
          console.log(`[buildChatLogMessages] ★ 文本附件处理: idx=${idx}, isLastUser=${idx === _lastUserFilesIdx}, mode=${attachmentHistory}`);
        }
      }

      // 判断是否应该嵌入此条目的图片（只嵌入最后一条含图片的消息）
      const shouldEmbedImages = idx === lastImageEntryIndex && !ignoreFiles;

      if (_mediaFiles.length === 0) {
        /* 附件全部已作为文本内联，无媒体/占位需要处理 */
      } else if (ignoreFiles || !shouldEmbedImages) {
        // 不嵌入图片：用文字说明替代
        const notices = _mediaFiles.map((file) => {
          const mime_type = file.mime_type || file.type || "application/octet-stream";
          const name = file.name ?? "unknown";
          if (mime_type.startsWith("image/"))
            return `[附件: 图片 ${name}（历史图片已省略）]`;
          return `[System Notice: can't show you about file '${name}' because you cant take the file input of type '${mime_type}', but you may be able to access it by using code tools if you have.]`;
        });
        message.content = content + "\n" + notices.join("\n");
      } else {
        // 嵌入图片（仅最后一条含图片的消息）
        const contentParts = [{ type: "text", text: content }];

        for (const file of _mediaFiles) {
          // ★ 兼容 mime_type 和 type 两种字段名（YonBan用type，eye用mime_type）
          const _mt = file.mime_type || file.type;
          if (!_mt) continue;

          if (_mt.startsWith("image/")) {
            let _imgB64 = "";
            let _imgBytes = null;
            if (Buffer.isBuffer(file.buffer)) {
              _imgBytes = file.buffer;
              _imgB64 = file.buffer.toString("base64");
            } else if (typeof file.buffer === "string" && file.buffer.startsWith("file:")) {
              // ★ file:hash → 从磁盘读取
              const _resolved = _resolveFileHash(file.buffer, prompt_struct?.username);
              if (_resolved) {
                _imgBytes = _resolved;
                _imgB64 = _resolved.toString("base64");
                console.log(`[messageTransform] 图片file:hash解析成功: ${file.buffer.substring(0,20)}... → ${_imgB64.length}字符`);
              }
            } else if (typeof file.buffer === "string") {
              _imgB64 = file.buffer;
              try {
                const _bb = Buffer.from(_imgB64, "base64");
                if (_bb.length > 0) _imgBytes = _bb;
              } catch { /* 非法 base64 → 走降级 */ }
            }
            // ★ 支持集闸（imageInjection 单源）：magic bytes 权威判型——jpeg/png/gif/webp 全部
            //   可 magic 识别，检测不到 = 一定不是真支持图片，声明 mime 不作数（错标 png 的 SVG
            //   曾靠声明混进请求 → API 400 整轮报废，0727 空回复事故）。
            //   违规修复（凛倾 0727"直接转"）：历史会话里已存在这种附件也要能继续发——
            //   SVG=XML 文本 → 直接转成源码文本；其余不支持格式 → 文本说明降级。
            const _detected = _imgBytes ? detectImageMime(_imgBytes) : null;
            if (_imgB64 && _detected && isSupportedImageMime(_detected)) {
              contentParts.push({
                type: "image_url",
                image_url: { url: `data:${_detected};base64,${_imgB64}` },
              });
            } else if (_imgB64) {
              const _svgText = _imgBytes ? svgBufferToText(_imgBytes, _mt) : null;
              if (_svgText) {
                contentParts.push({ type: "text", text: `[SVG 源码 ${file.name || ""}]:\n${_svgText}` });
                console.warn(`[messageTransform] SVG 附件已转文本源码（${file.name || "unnamed"}）`);
              } else {
                const _mtLabel = _detected || _mt || "unknown";
                console.warn(`[messageTransform] 跳过不支持的图片附件 ${_mtLabel}（${file.name || "unnamed"}）：视觉通道仅收 jpeg/png/gif/webp`);
                contentParts.push({
                  type: "text",
                  text: `[附件: 图片 ${file.name || "unnamed"}（格式 ${_mtLabel} 不受视觉模型支持，未嵌入）]`,
                });
              }
            }
          }
          else if (_mt.startsWith("audio/")) {
            const formatMap = {
              "audio/wav": "wav",
              "audio/wave": "wav",
              "audio/x-wav": "wav",
              "audio/mpeg": "mp3",
              "audio/mp3": "mp3",
              "audio/mp4": "mp4",
              "audio/m4a": "m4a",
              "audio/webm": "webm",
              "audio/ogg": "webm",
            };
            const format = formatMap[_mt.toLowerCase()] || "wav";
            let _audioB64 = "";
            if (Buffer.isBuffer(file.buffer)) {
              _audioB64 = file.buffer.toString("base64");
            } else if (typeof file.buffer === "string" && file.buffer.startsWith("file:")) {
              const _resolved = _resolveFileHash(file.buffer, prompt_struct?.username);
              if (_resolved) _audioB64 = _resolved.toString("base64");
            } else if (typeof file.buffer === "string") {
              _audioB64 = file.buffer;
            }
            if (_audioB64) {
              contentParts.push({
                type: "input_audio",
                input_audio: { data: _audioB64, format },
              });
            }
          }
        }

        if (contentParts.length > 1) {
          const _imgCount = contentParts.filter(p => p.type === "image_url").length;
          console.log(`[buildChatLogMessages] ★ 图片嵌入: idx=${idx}, contentParts=${contentParts.length}, 图片数=${_imgCount}`);
          message.content = contentParts;
        }
      }
    }

    messages.push(message);
  }

  wbT(prompt_struct?.chatid ?? null, "ai:transform", "buildChatLog_done", { inLen: chatLog.length, outLen: messages.length });
  return messages;
}

// ============================================================
// 消息后处理
// ============================================================

/**
 * 提示词后处理：对消息序列应用不同级别的角色规范化
 *
 * 3 种模式 + none（与预填充 claude_prefill_mode 互不相干）：
 *   none   — 不处理（default）
 *   merge  — 合并连续同角色
 *   semi   — 旧半严格兼容值；等同 merge，保留 system 权限
 *   strict — 旧严格兼容值；等同 merge，保留 system 权限
 *
 * 权限契约（2026-07-29）：
 *   PP 只能整理消息边界，不能把 system 降成 user。渠道确有结构差异时，由 provider adapter
 *   映射成该协议的 systemInstruction / 顶层 system / developer 等等价高权限形状。
 * 存量兼容归一：旧 "claude"（预填充概念泄漏进 pp 的历史枚举，ST 分发表同义 merge）→ merge；
 * 旧 "single"（全并单条 user）→ strict。写入层（preset/main.mjs）同表迁移，此处消费端兜底。
 *
 * @param {Array<{role: string, content: string|object[]}>} messages
 * @param {'none'|'merge'|'semi'|'strict'} type 后处理类型
 * @returns {Array<{role: string, content: string|object[]}>}
 */
export function postProcessMessages(messages, type) {
  const _legacy = { claude: "merge", single: "strict" };
  const _type = _legacy[type] || type;
  wbT(null, "ai:transform", "postProcess", { type: _type, raw: type, count: messages?.length || 0 });
  switch (_type) {
    case "merge":
      return mergeConsecutiveRoles(_stripTools(messages, false));
    case "merge_tools":
      return mergeConsecutiveRoles(messages);
    case "semi":
      return semiStrictProcess(_stripTools(messages, false));
    case "semi_tools":
      return semiStrictProcess(messages);
    case "strict":
      return strictProcess(_stripTools(messages, false));
    case "strict_tools":
      return strictProcess(messages);
    default:
      return messages;
  }
}

// tool 角色处理（SillyTavern 同源）：tools=false 时 tool→user + 删 tool_calls/tool_call_id
function _stripTools(messages, keep) {
  if (keep) return messages;
  return messages.map((m) => {
    const out = { ...m };
    if (out.role === "tool") out.role = "user";
    delete out.tool_calls;
    delete out.tool_call_id;
    return out;
  });
}

/**
 * 合并相同角色连续的发言
 * 支持多模态 content（数组类型），将其中的文本部分扁平化后合并
 *
 * @param {Array<{role: string, content: string|object[]}>} messages
 * @returns {Array<{role: string, content: string|object[]}>}
 */
export function mergeConsecutiveRoles(messages) {
  const result = [];
  for (const msg of messages) {
    // 将数组类型 content 扁平化为字符串（图片/音频等非文本部分先用随机 token 占位）
    const flatMsg = { ...msg };
    /** @type {Map<string, object>} */
    const contentTokens = new Map();
    if (Array.isArray(flatMsg.content)) {
      const text = flatMsg.content
        .map((part) => {
          if (part.type === "text") return part.text || "";
          if (["image_url", "input_audio"].includes(part.type)) {
            const token = "@@" + Math.random().toString(36).slice(2, 18) + "@@";
            contentTokens.set(token, part);
            return token;
          }
          return "";
        })
        .join("\n\n");
      flatMsg.content = text;
      flatMsg._contentTokens = contentTokens;
    }

    const last = result[result.length - 1];
    if (last && last.role === flatMsg.role && flatMsg.content) {
      // 合并字符串内容
      if (
        typeof last.content === "string" &&
        typeof flatMsg.content === "string"
      ) {
        last.content += "\n\n" + flatMsg.content;
        // 合并 token 映射
        if (flatMsg._contentTokens) {
          last._contentTokens = last._contentTokens || new Map();
          for (const [k, v] of flatMsg._contentTokens)
            last._contentTokens.set(k, v);
        }
      } else {
        result.push(flatMsg);
      }
    } else {
      result.push(flatMsg);
    }
  }

  // 还原含 token 的消息为多模态数组格式
  for (const msg of result) {
    if (
      msg._contentTokens &&
      msg._contentTokens.size > 0 &&
      typeof msg.content === "string"
    ) {
      const hasToken = Array.from(msg._contentTokens.keys()).some((t) =>
        msg.content.includes(t),
      );
      if (hasToken) {
        const parts = msg.content.split("\n\n");
        const merged = [];
        for (const part of parts) {
          if (msg._contentTokens.has(part)) {
            merged.push(msg._contentTokens.get(part));
          } else if (
            merged.length > 0 &&
            merged[merged.length - 1].type === "text"
          ) {
            merged[merged.length - 1].text += "\n\n" + part;
          } else {
            merged.push({ type: "text", text: part });
          }
        }
        msg.content = merged;
      }
    }
    delete msg._contentTokens;
  }

  // 空消息不兜底（凛倾0712：代码禁产生进对话的文本，占位符已删除）——
  // 空数组发往渠道由渠道报错=可见诊断面，wbD 留定位点
  if (result.length === 0) {
    wbD(null, "ai:transform", "merge_empty", false, "合并后消息为空", { inLen: messages?.length || 0 });
  }

  return result;
}

/**
 * 半严格模式（SillyTavern semi 变体）：合并 + 历史对话中段的 system 改为 user。
 * 尾部 system（最后一条 user/assistant 之后的）保持原样——那是当前轮活跃指令，需要 system 权限。
 */
function semiStrictProcess(messages) {
  const merged = mergeConsecutiveRoles(messages);
  let lastChatIdx = 0;
  for (let i = merged.length - 1; i >= 0; i--) {
    if (merged[i].role === "user" || merged[i].role === "assistant") { lastChatIdx = i; break; }
  }
  for (let i = 1; i < lastChatIdx; i++) {
    if (merged[i].role === "system") merged[i].role = "user";
  }
  return mergeConsecutiveRoles(merged);
}

/**
 * 严格模式（SillyTavern strict 变体）：semi + 首条 system 后若无 user 则插占位消息。
 * 尾部 system 同样保持原样。
 */
function strictProcess(messages) {
  const merged = mergeConsecutiveRoles(messages);
  let lastChatIdx = 0;
  for (let i = merged.length - 1; i >= 0; i--) {
    if (merged[i].role === "user" || merged[i].role === "assistant") { lastChatIdx = i; break; }
  }
  for (let i = 1; i < lastChatIdx; i++) {
    if (merged[i].role === "system") merged[i].role = "user";
  }
  if (merged.length > 0 && merged[0].role === "system" && (merged.length === 1 || merged[1].role !== "user")) {
    merged.splice(1, 0, { role: "user", content: "." });
  }
  return mergeConsecutiveRoles(merged);
}

// convertTrailingAssistantToSystem 已删（2026-07-08）：off 时把尾部 assistant 静默转 system
// +assistant:\n 前缀=已废弃 wrap_system 同款坏形态。尾部形态统一由 providerPatch.applyTailPrefill
// 按用户显式四模式处理，off=纯不处理。

/**
 * 压缩系统消息：将连续的 system 消息合并为一条
 * 不包括被 assistant 消息分隔的部分（保留示例对话结构）
 *
 * @param {Array<{role: string, content: string|object[]}>} messages
 * @returns {Array<{role: string, content: string|object[]}>}
 */
export function squashSystemMessages(messages) {
  const result = [];
  let pendingSystem = [];

  function flushSystem() {
    if (pendingSystem.length === 0) return;
    if (pendingSystem.length === 1) {
      result.push(pendingSystem[0]);
    } else {
      // 合并多条 system 消息（兼容 string 和 array content）
      const merged = pendingSystem
        .map((m) => {
          if (typeof m.content === "string") return m.content;
          if (Array.isArray(m.content)) {
            return m.content
              .filter((p) => p.type === "text" && p.text)
              .map((p) => p.text)
              .join("\n\n");
          }
          return "";
        })
        .join("\n\n");
      result.push({ role: "system", content: merged });
    }
    pendingSystem = [];
  }

  for (const msg of messages) {
    if (msg.role === "system") {
      pendingSystem.push(msg);
    } else {
      flushSystem();
      result.push(msg);
    }
  }
  flushSystem();

  return result;
}

export function buildCompatMessages(mergedChatLog,ignoreFiles,username,attachmentHistory="hide",attachmentTexts){
  // [0716 音控修·凛倾定案] 媒体门控扩 image|audio（原只认 image/*，纯音频消息被丢）；图片历史省略维持
  const _luIdx=findLastUserIndex(mergedChatLog);
  let lastImageEntryIdx=-1;
  if(_luIdx>=0&&mergedChatLog[_luIdx].files?.some(f=>/^(image|audio)\//.test(f.mime_type||f.type||'')))lastImageEntryIdx=_luIdx;
  const _luFilesIdx=findLastUserFilesIndex(mergedChatLog); // 文本附件"最后一次全文"锚点
  // [0720 uid 稳定化·同病征清扫(与 requestBuilder.mjs:397 预览分支同批)] 原 Math.random 每轮重构
  //   历史消息包裹 uid 全变 → 发给 AI 的 messages 前缀每轮不同 = 击穿服务商 prompt cache(全价计费+高延迟)
  //   且破坏产物幂等。uid 无随机性需求(clearXmlFormat:491 按通用正则剥离不依赖 uid 值;作者写入时
  //   不可能预知自己 entry 的 id,伪造闭合标签风险不变)。改 entry.id 前 8 位,无 id 回退索引。
  return mergedChatLog.map((chatLogEntry,entryIdx)=>{const uid=String(chatLogEntry.id||entryIdx).slice(0,8);
  // [0720 compat出站剥离兜底] commander 分支同款在 buildChatLogMessages:123,compat 分支 0716 修时漏配（半修）——
  //   regex 插件禁用、或 marge 展开的 logContext/additional_chat_log 工具轨迹条目（TweakPrompt 只扫 chat_log 顶层）
  //   不经组装点剥离时,历史 thinking 全量原样出站（0720 实证：AI 反复读到自己旧思维链,回复劣化）。
  //   同受「思维链显示」设置（reasoning_builtin/reasoning_tags）控制,stripReasoningTags 幂等。
  const _entryRole=chatLogEntry.role==='user'?'user':chatLogEntry.role==='system'?'system':'assistant';
  const _entryContent=_entryRole==='assistant'?stripReasoningTags(chatLogEntry.content,username):chatLogEntry.content;
  let textContent='\t<message "'+uid+'">\n\t<sender>'+chatLogEntry.name+'<\/sender>\n\t<content>\n\t'+_entryContent+'\n\t<\/content>\n\t<\/message "'+uid+'">\n\t';
  // [0716 附件传导链修·凛倾定案] 文本附件单源 buildEntryAttachmentText：全文只给最后一条 user，历史按 attachmentHistory（hide/block/inline）
  let _bcFiles=chatLogEntry.files;
  if(_bcFiles?.length&&!ignoreFiles){
    const _at=buildEntryAttachmentText(chatLogEntry,{isLastUser:entryIdx===_luFilesIdx,username,historyMode:attachmentHistory,texts:attachmentTexts});
    if(_at)textContent+=_at;
    _bcFiles=_bcFiles.filter(f=>!isTextLikeFile(f));
  }
  const message={role:_entryRole,content:textContent};if(_bcFiles?.length){const shouldEmbedImages=entryIdx===lastImageEntryIdx&&!ignoreFiles;if(ignoreFiles||!shouldEmbedImages){const notices=_bcFiles.map(file=>{const mime_type=file.mime_type||'application/octet-stream';const name=file.name??'unknown';if(mime_type.startsWith('image/'))return '[附件: 图片 '+name+'（历史图片已省略）]';return '[System Notice: cannot show file "'+name+'" type='+mime_type+']';});textContent+='\n'+notices.join('\n');message.content=textContent;return message;}const contentParts=[{type:'text',text:textContent}];for(const file of _bcFiles){if(!file.mime_type)continue;if(file.mime_type.startsWith('image/')){
    // ★ 支持集闸（imageInjection 单源，与 buildChatLogMessages 嵌入点同款）：magic bytes 权威判型，
    //   检测不到=不是真支持图片，声明 mime 不作数（0727 SVG伪装png → API 400 空回复事故）。
    //   违规修复（凛倾 0727"直接转"）：SVG 字节→源码文本；其余不支持→文本说明。file:hash 经 _resolveFileHash 解析。
    let _cbBytes=null;
    if(Buffer.isBuffer(file.buffer))_cbBytes=file.buffer;
    else if(typeof file.buffer==='string'&&file.buffer.startsWith('file:'))_cbBytes=_resolveFileHash(file.buffer,username);
    else if(typeof file.buffer==='string'){try{const _bb=Buffer.from(file.buffer,'base64');if(_bb.length>0)_cbBytes=_bb;}catch{/* 非法 base64 → 降级 */}}
    const _cbDet=_cbBytes?detectImageMime(_cbBytes):null;
    if(_cbBytes&&_cbDet&&isSupportedImageMime(_cbDet)){
      contentParts.push({type:'image_url',image_url:{url:'data:'+_cbDet+';base64,'+_cbBytes.toString('base64')}});
    }else{
      const _cbSvg=_cbBytes?svgBufferToText(_cbBytes,file.mime_type):null;
      if(_cbSvg){contentParts.push({type:'text',text:'[SVG 源码 '+(file.name||'')+']:\n'+_cbSvg});console.warn('[messageTransform/compat] SVG 附件已转文本源码（'+(file.name||'unnamed')+'）');}
      else{const _cbLabel=_cbDet||file.mime_type||'unknown';contentParts.push({type:'text',text:'[附件: 图片 '+(file.name||'unnamed')+'（格式 '+_cbLabel+' 不受视觉模型支持，未嵌入）]'});console.warn('[messageTransform/compat] 跳过不支持的图片附件 '+_cbLabel+'（'+(file.name||'unnamed')+'）');}
    }
  }else if(file.mime_type.startsWith('audio/')){const fmt={'audio/wav':'wav','audio/wave':'wav','audio/x-wav':'wav','audio/mpeg':'mp3','audio/mp3':'mp3','audio/mp4':'mp4','audio/m4a':'m4a','audio/webm':'webm','audio/ogg':'webm'};const format=fmt[file.mime_type.toLowerCase()]||'wav';contentParts.push({type:'input_audio',input_audio:{data:file.buffer.toString('base64'),format}});}}if(contentParts.length>1)message.content=contentParts;}return message;});}

export function clearXmlFormat(text,alternativeCharnames){const m1=/<\/sender>\s*<content>/.test(text);if(m1){const altNames=(alternativeCharnames||[]).map(Object).map(s=>s instanceof String?escapeRegExp(s):s.source).join('|');const extracted=text.match(/<\/sender>\s*<content>([\S\s]*)/)?.[1]??text;text=altNames?extracted.split(new RegExp('('+altNames+')\\s*<\/sender>\\s*<content>')).pop():extracted;text=text.split(/<\/content>\s*<\/message/).shift();}if(/<\/content>\s*<\/message[^>]*>\s*$/.test(text))text=text.split(/<\/content>\s*<\/message[^>]*>\s*$/).shift();text=text.replace(/<\/content\s*$/,'').replace(/<\/message\s*$/,'').replace(/<\/\s*$/,'');return text;}
