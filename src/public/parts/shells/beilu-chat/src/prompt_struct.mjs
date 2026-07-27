/** @typedef {import('../../../../../decl/prompt_struct.ts').prompt_struct_t} prompt_struct_t */
/** @typedef {import('../../../../../decl/charAPI.ts').CharAPI_t} CharAPI_t */
/** @typedef {import('../../../../../decl/userAPI.ts').UserAPI_t} UserAPI_t */
/** @typedef {import('../../../../../decl/worldAPI.ts').WorldAPI_t} WorldAPI_t */
/** @typedef {import('../../chat/decl/chatLog.ts').chatLogEntry_t} chatLogEntry_t */
/** @typedef {import('../../chat/decl/chatLog.ts').chatReplyRequest_t} chatReplyRequest_t */

// T8 清理（07-03 凛倾"剩下的全部做"批）：buildPromptStructLegacy(旧线原实现,唯一消费=_t5shadow 影子端点已同批删)与其孤立 helper getSinglePartPrompt 已删——正线=buildPromptStruct→ViaModes(shadowBuild.mjs,影子孪生转正)。原件备份 p1_archive/backup/yonban迁移_T8_Legacy与探针清理_*。


/**
 * 构建提示结构（T5 切流量入口，2026-07-02）。
 * 影子三模式逐字节零 diff 后切到 ModeDef+dispatch 线（yonban pipelines runner，凛倾裁决1 内置也数据化）；
 * 单点收口：所有卡（已部署实例/模板/ST）的调用自动走新线，卡文件零改动。
 * （T8 07-03：Legacy 旧线已删——回退路径=从备份 yonban迁移_T8_Legacy与探针清理_* 取回。）
 * 动态 import 防止把 yonban 线静态耦合进壳加载时序（同 exits 跨 part 范式）。
 * @param {chatReplyRequest_t} args - 参数。
 * @param {number} [detail_level=3] - 细节级别，即 TweakPrompt 的迭代轮数（每轮 detail_level 递减）。
 * @returns {Promise<prompt_struct_t>} - 提示结构。
 */
export async function buildPromptStruct(args, detail_level = 3) {
  const { buildPromptStructViaModes } = await import("../../../../../yonban/pipelines/_runtime/shadowBuild.mjs");
  return buildPromptStructViaModes(args, detail_level);
}


// ============================================================
// 拼接骨架段标题单源（2026-07-08 链路3·代码零提示词方向，对齐 ST story_string 形态）
// 凛倾裁决:「提示词一旦出现那么就是有问题的.因为提示词只有用户可以选择+做」——
// 段标题此前逐字写死在下方六处 push 里，用户不可见不可改。现收敛为此表:
//   - 覆盖通道: prompt_struct.section_headers（组装线单点填充，来源=用户预设/配置），
//     7 个消费点（requestBuilder + 6 个 yonban generator）只传 prompt_struct，零改动
//   - 空字符串 = 用户显式选择不要该段标题（不 push 标题行，内容照常输出）
//   - 未提供 = 回退本表默认（文本原样迁移，未改一字——文本内容归用户/凛倾域）
// ============================================================
export const DEFAULT_SECTION_HEADERS = {
  char: "你需要扮演的角色设定如下：",
  user: "用户的设定如下：",
  world: "当前环境的设定如下：",
  other_chars: "其他角色的设定如下：",
  plugins: "你可以使用以下插件，方法如下：",
  chat_log: "聊天记录如下：",
};

/**
 * 将结构化提示转换为单个无聊天记录的字符串。
 * @param {prompt_struct_t} prompt - 提示结构。prompt.section_headers 可携带用户自定义段标题
 *   （键同 DEFAULT_SECTION_HEADERS，空字符串=该段不输出标题行）。
 * @returns {string} - 单个字符串。
 */
export function structPromptToSingleNoChatLog(
  /** @type {prompt_struct_t} */ prompt,
) {
  const headers = { ...DEFAULT_SECTION_HEADERS, ...(prompt.section_headers || {}) };
  const result = [];

  {
    const sorted = prompt.char_prompt.text
      .sort((a, b) => a.important - b.important)
      .map((text) => text.content)
      .filter(Boolean);
    if (sorted.length) {
      if (headers.char) result.push(headers.char);
      result.push(...sorted);
    }
  }

  {
    const sorted = prompt.user_prompt.text
      .sort((a, b) => a.important - b.important)
      .map((text) => text.content)
      .filter(Boolean);
    if (sorted.length) {
      if (headers.user) result.push(headers.user);
      result.push(...sorted);
    }
  }

  {
    const sorted = prompt.world_prompt.text
      .sort((a, b) => a.important - b.important)
      .map((text) => text.content)
      .filter(Boolean);
    if (sorted.length) {
      if (headers.world) result.push(headers.world);
      result.push(...sorted);
    }
  }

  {
    const sorted = Object.values(prompt.other_chars_prompt)
      .map((char) => char?.text)
      .filter(Boolean)
      .map((char) =>
        char
          .sort((a, b) => a.important - b.important)
          .map((text) => text.content)
          .filter(Boolean),
      )
      .flat()
      .filter(Boolean);
    if (sorted.length) {
      if (headers.other_chars) result.push(headers.other_chars);
      result.push(...sorted);
    }
  }

  {
    const sorted = Object.values(prompt.plugin_prompts)
      .map((plugin) => plugin?.text)
      .filter(Boolean)
      .map((plugin) =>
        plugin
          .sort((a, b) => a.important - b.important)
          .map((text) => text.content)
          .filter(Boolean),
      )
      .flat()
      .filter(Boolean);
    if (sorted.length) {
      if (headers.plugins) result.push(headers.plugins);
      result.push(...sorted);
    }
  }

  return result.join("\n");
}

/**
 * 合并结构化提示聊天记录。
 * @param {prompt_struct_t} prompt - 提示结构。
 * @returns {chatLogEntry_t[]} - 聊天记录条目数组。
 */
export function margeStructPromptChatLog(
  /** @type {prompt_struct_t} */ prompt,
  // [0717 工具轨迹跨轮重灌断链修·凛倾链路确诊] skipStoredLogContext=true 时,chat_log(盘上)条目的
  //   logContextBefore/After 不展平——那是上一轮工具轨迹(AddLongTimeLog 寄生在 char 消息上落盘),
  //   跨轮重灌会把 <ppt_op> 等完整调用原文再次入上下文,且落到尾部被 applyTailPrefill 当预填充
  //   → 模型把上一轮输出整个重新生成+工具重执行(0717 实证"输出完成后又发送一遍/循环两遍")。
  //   当轮 additional_chat_log 条目的 logContext 照常展平(当轮轨迹本就该见)。
  //   缺省 false=原行为,compat 既有链路零变化;commander 消费点显式传 true。
  { skipStoredLogContext = false } = {},
) {
  // [0717 契约硬化] chat_log/other_chars_prompt/plugin_prompts 容缺（缺=空，语义不变）——
  //   本函数自 0717 起是全部 AI 源 commander/compat 两分支的单一聊天段来源（regen断链根修），
  //   消费方从"直读 chat_log || []"迁来，宽容度不得低于原实现（手搓 struct 如 aiRunner 字段可能不全）。
  const result = [
    ...(prompt.chat_log || []),
    ...(prompt.user_prompt?.additional_chat_log || []),
    ...(prompt.world_prompt?.additional_chat_log || []),
    ...Object.values(prompt.other_chars_prompt || {})
      .map((char) => char?.additional_chat_log || [])
      .flat(),
    ...Object.values(prompt.plugin_prompts || {})
      .map((plugin) => plugin?.additional_chat_log || [])
      .flat(),
    ...(prompt.char_prompt?.additional_chat_log || []),
  ];
  /** @type {chatLogEntry_t[]} */
  const flat_result = [];
  // 盘上条目集合:skipStoredLogContext 时这些条目的 logContext 不展平(见函数头注释)
  const _stored = skipStoredLogContext ? new Set(prompt.chat_log || []) : null;
  for (const entry of result) {
    const _skipLC = _stored ? _stored.has(entry) : false;
    if (entry.logContextBefore && !_skipLC) flat_result.push(...entry.logContextBefore);
    flat_result.push(entry);
    if (entry.logContextAfter && !_skipLC) flat_result.push(...entry.logContextAfter);
  }
  return flat_result.filter(
    (entry) =>
      !entry.charVisibility || entry.charVisibility.includes(prompt.char_id),
  );
}

/**
 * 将结构化提示转换为单个字符串。
 * @param {prompt_struct_t} prompt - 提示结构。
 * @returns {string} - 单个字符串。
 */
export function structPromptToSingle(/** @type {prompt_struct_t} */ prompt) {
  const result = [structPromptToSingleNoChatLog(prompt)];

  const _clHeader = { ...DEFAULT_SECTION_HEADERS, ...(prompt.section_headers || {}) }.chat_log;
  if (_clHeader) result.push(_clHeader);
  margeStructPromptChatLog(prompt).forEach((chatLogEntry) => {
    result.push(chatLogEntry.name + ": " + chatLogEntry.content);
  });

  return result.join("\n");
}
