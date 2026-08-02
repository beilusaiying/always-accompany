/**
 * 把共享 OpenAI 形状消息映射为 Gemini 原生 generateContent 形状。
 *
 * Gemini 原生 contents 只有 user/model；应用指令必须进入 config.systemInstruction，
 * 不能伪装成带 "system:" 前缀的 user 消息。
 *
 * @param {Array<{role:string,content:string|Array<object>}>} messages
 * @param {{imageSkippedText?:string}} options
 * @returns {{contents:Array<{role:string,parts:Array<object>}>,systemInstruction:string}}
 */
export function convertOpenAIToGeminiMessages(
  messages,
  { imageSkippedText = "[image skipped]" } = {},
) {
  const systemParts = [];
  const contents = [];

  for (const msg of messages || []) {
    if (msg?.role === "system") {
      const text = contentToText(msg.content, imageSkippedText);
      if (text) systemParts.push(text);
      continue;
    }

    const role = msg?.role === "assistant" ? "model" : "user";
    const parts = contentToParts(msg?.content, imageSkippedText);
    contents.push({
      role,
      parts: parts.length ? parts : [{ text: "" }],
    });
  }

  return {
    contents,
    systemInstruction: systemParts.join("\n\n"),
  };
}

/**
 * 构造 Gemini SDK 最终请求形状，确保 systemInstruction 位于 config 而非 contents。
 *
 * @param {{model:string,contents:Array<object>,config?:object,systemInstruction?:string}} input
 * @returns {{model:string,contents:Array<object>,config:object}}
 */
export function buildGeminiModelParams({
  model,
  contents,
  config = {},
  systemInstruction = "",
}) {
  return {
    model,
    contents,
    config: {
      ...config,
      ...(systemInstruction ? { systemInstruction } : {}),
    },
  };
}

function contentToText(content, imageSkippedText) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (part?.type === "text") return part.text || "";
      if (part?.type === "image_url" || part?.type === "image") {
        return imageSkippedText;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function contentToParts(content, imageSkippedText) {
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return [];

  return content
    .map((part) => {
      if (part?.type === "text") return { text: part.text || "" };
      if (part?.type === "image_url" || part?.type === "image") {
        return { text: imageSkippedText };
      }
      return { text: "" };
    })
    .filter((part) => part.text);
}
