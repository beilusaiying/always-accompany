/**
 * [ideTagParser] — IDE 工具标签解析与消息判定（纯函数，零副作用）。
 *
 * 从 ideClient.mjs 提取：parseIdeToolCallTags / parseQuestionTags / formatToolResultsForInjection
 * / isIdeToolResultMsg / isIdeToolCallMsg / CLONE_TAG_RE / collectNoiseToHide
 * / generateHumanReadableDescription / getSeverityEmoji + 内部辅助
 *
 * ideClient.mjs 通过 re-export 保持所有外部消费者 import 路径不变。
 */

/**
 * 解析 AI 回复中的 <ideToolCall> 标签
 * @param {string} content
 * @returns {{ toolCalls: Array<{ tool: string, params: object }>, cleanContent: string }}
 */
export function parseIdeToolCallTags(content) {
  const toolCalls = [];

  // 格式1: 自闭合 <ideToolCall tool="xxx" param1="val1" />
  // 属性区域允许包含引号内的>字符
  const selfClosingRegex = /<ideToolCall\s+((?:[^>"']|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')*?)\/>/gi;
  let match;
  while ((match = selfClosingRegex.exec(content)) !== null) {
    const attrs = parseAttributes(match[1]);
    const tool = attrs.tool;
    delete attrs.tool;
    if (tool) toolCalls.push({ tool, params: attrs, _idx: match.index });
  }

  // 格式2: 带内容 <ideToolCall tool="xxx" param1="val1">body</ideToolCall>
  // (?<!\/) 排除自闭合标签的 />，否则 body 正则会从自闭合标签的 > 起跨匹配到下一个
  // </ideToolCall>，导致自闭合工具被重复执行、中间的 body 工具被整个吞掉丢失
  const bodyRegex = /<ideToolCall\s+((?:[^>"']|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')*?)(?<!\/)>([\s\S]*?)<\/ideToolCall>/gi;
  while ((match = bodyRegex.exec(content)) !== null) {
    const attrs = parseAttributes(match[1]);
    // ★ 只去掉紧跟标签的首尾换行，保留内容本身的格式
    const body = match[2].replace(/^\n/, "").replace(/\n$/, "");
    const tool = attrs.tool;
    delete attrs.tool;
    if (tool) {
      if (tool === "write_file" && !attrs.content) {
        attrs.content = decodeHTMLEntities(body);
      } else if (tool === "replace_lines" && !attrs.new_content) {
        attrs.new_content = decodeHTMLEntities(body);
      } else if (tool === "insert_at_line" && !attrs.content) {
        attrs.content = decodeHTMLEntities(body);
      } else if (tool === "fuzzy_edit") {
        // fuzzy_edit 使用子标签 <old_string>...</old_string><new_string>...</new_string>
        const oldMatch = body.match(/<old_string>([\s\S]*?)<\/old_string>/i);
        const newMatch = body.match(/<new_string>([\s\S]*?)<\/new_string>/i);
        // ★ 去掉紧跟标签的首尾换行（AI格式化导致的多余\n），保留内容本身的缩进
        // ★ 对body内容也做HTML实体解码（属性值在parseAttributes里已解码，body内容之前漏了）
        if (oldMatch) attrs.old_string = decodeHTMLEntities(oldMatch[1].replace(/^\n/, "").replace(/\n$/, ""));
        if (newMatch) attrs.new_string = decodeHTMLEntities(newMatch[1].replace(/^\n/, "").replace(/\n$/, ""));
      } else if (tool === "todo_write" && !attrs.content) {
        attrs.content = decodeHTMLEntities(body);
      }
      toolCalls.push({ tool, params: attrs, _idx: match.index });
    }
  }

  // ★ 格式3: JSON格式兼容（Gemini等模型可能输出JSON而非XML属性）
  // <ideToolCall>{"tool_name":"run_command","tool_args":{"command":"..."}}</ideToolCall>
  // 或 <ideToolCall>{"tool":"read_file","params":{"path":"..."}}</ideToolCall>
  const jsonRegex = /<ideToolCall>\s*(\{[\s\S]*?\})\s*<\/ideToolCall>/gi;
  while ((match = jsonRegex.exec(content)) !== null) {
    try {
      const obj = JSON.parse(match[1]);
      // 兼容多种字段名
      const tool = obj.tool || obj.tool_name || obj.name || "";
      const params = obj.params || obj.tool_args || obj.arguments || {};
      // 工具名映射（模型可能用缩写/别名）
      const toolMap = { run_cmd: "run_command", read: "read_file", search: "search_files", list: "list_files", write: "write_file", edit: "fuzzy_edit" };
      const normalizedTool = toolMap[tool] || tool;
      if (normalizedTool) {
        // 检查是否已被前面的格式解析过（避免重复）
        const isDuplicate = toolCalls.some(tc => tc.tool === normalizedTool && JSON.stringify(tc.params) === JSON.stringify(params));
        if (!isDuplicate) {
          toolCalls.push({ tool: normalizedTool, params: typeof params === "object" ? params : {}, _idx: match.index });
        }
      }
    } catch (_e) { /* JSON解析失败跳过 */ }
  }

  // 属性区用与解析侧同款的「允许引号内 >」字符类，否则属性值含字面 >（如 command="node x > o.txt"）时标签清不掉、残留进 AI 可见回复。
  // 自闭合先剥（下一行），故 body 清理的闭合 > 无需 (?<!\/)。
  let cleanContent = content
    .replace(/<ideToolCall\s+(?:[^>"']|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')*?\/>/gi, "")
    .replace(/<ideToolCall\s+(?:[^>"']|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')*?>[\s\S]*?<\/ideToolCall>/gi, "")
    .replace(/<ideToolCall>\s*\{[\s\S]*?\}\s*<\/ideToolCall>/gi, "") // 清理JSON格式
    .trim();

  // ★ 符号根修复（兜底探针）：探测「属性位承载了 content-param」的 ideToolCall。
  //   这类标签的外层正则极可能已断裂、整条静默丢失；探针不读取引号内的值，故不受裸引号破坏，
  //   能稳定捞出来生成「明确可操作报错」，让静默丢从机制上不可能发生。
  const rejectedContentParams = [];
  {
    let pm;
    CONTENT_PARAM_IN_ATTR_PROBE.lastIndex = 0;
    while ((pm = CONTENT_PARAM_IN_ATTR_PROBE.exec(content)) !== null) {
      const p = pm[1].toLowerCase();
      if (!rejectedContentParams.includes(p)) rejectedContentParams.push(p);
    }
  }
  // 合并 parseAttributes 在「外层侥幸捕到」时打的标
  for (const tc of toolCalls) {
    const rp = tc.params && tc.params._rejectedContentParams;
    if (Array.isArray(rp)) {
      for (const p of rp) if (!rejectedContentParams.includes(p)) rejectedContentParams.push(p);
      delete tc.params._rejectedContentParams; // 不把内部标记透传给 IDE 端
    }
  }

  // 三种格式分批 push 会打乱顺序（自闭合 run_command 整批排到 body write_file 之前）→
  // 「先写文件再跑命令」被颠倒成先跑后写。按源文位置排回 AI 书写顺序；下游读/写分流仍可再排序。
  toolCalls.sort((a, b) => a._idx - b._idx);
  for (const tc of toolCalls) delete tc._idx;

  return { toolCalls, cleanContent, rejectedContentParams };
}

/**
 * 解析 AI 回复中的 <question> 标签
 * @param {string} content
 * @returns {{ questions: string[], cleanContent: string }}
 */
export function parseQuestionTags(content) {
  const questions = [];
  const regex = /<question>([\s\S]*?)<\/question>/gi;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const q = match[1].trim();
    if (q) questions.push(q);
  }
  const cleanContent = content.replace(/<question>[\s\S]*?<\/question>/gi, "").trim();
  return { questions, cleanContent };
}

/** 外层失败时透出执行端的结构化事实；仅回放真实结果，不在此层添加操作指令。 */
function _appendToolFailureReceipt(lines, outerResult) {
  const resultData = outerResult?.result;
  if (!resultData || typeof resultData !== "object" || Array.isArray(resultData)) return;

  const detail = {};
  for (const key of [
    "errorCode",
    "exitCode",
    "timedOut",
    "aborted",
    "stalled",
    "blocked",
    "session",
    "sessionKey",
  ]) {
    if (resultData[key] !== undefined) detail[key] = resultData[key];
  }
  for (const key of ["stall", "processTermination"]) {
    if (resultData[key] && typeof resultData[key] === "object") detail[key] = resultData[key];
  }
  if (Object.keys(detail).length > 0) {
    try {
      const encoded = JSON.stringify(detail);
      lines.push(`[tool_failure] ${encoded.length > 6000 ? `${encoded.slice(0, 6000)}…` : encoded}`);
    } catch {
      lines.push("[tool_failure] (结构化失败详情无法序列化)");
    }
  }

  for (const [label, value] of [["stdout", resultData.stdout], ["stderr", resultData.stderr]]) {
    if (typeof value !== "string" || !value) continue;
    lines.push(`[${label}] ${value.length > 8000 ? `${value.slice(0, 8000)}…` : value}`);
  }
}

/**
 * 格式化工具执行结果为注入文本
 *
 * !!!禁止放入提示词!!! 本函数属于唯一豁免域：AI 发指令后的系统回执（工具结果），只允许出现在
 * 对话尾部/用户消息之后（凛倾 0722 裁决），禁止被任何调用方拼进头部 system 区。除此豁免外，
 * 提示词文本只允许住 INJ 条目和预设——不要往这里加新的指令性引导句（教学/规则类文本进 INJ）。
 * @param {Array} results
 * @returns {string}
 */
export function formatToolResultsForInjection(results) {
  if (!results || results.length === 0) return "";

  const lines = ["[IDE工具执行结果]"];
  for (const r of results) {
    lines.push(`\n--- ${r.tool} (${r.timestamp}) ---`);
    // ★ 外层 warning（如 Gap A「目标文件曾被外部修改」）：附在 r.result（外层）而非 resultData（内层），
    //   必须在此独立透出，否则被白名单格式化器丢弃，AI 永远看不到。
    if (r.result?.warning) lines.push(`⚠️ ${r.result.warning}`);
    if (r.result?.pending) {
      // 0714 根因修：审批排队(pending:true)此前落入下方 success===false 分支被标「❌ 失败」——
      //   排队≠失败，AI 把等待当故障。error 文本本身已含 ⏳ 指引，原样透出不加失败前缀。
      lines.push(r.result?.error || `⏳ ${r.tool} 已提交审批队列，等待用户确认后执行。`);
    } else if (r.result?.success === false) {
      // 外层失败（工具抛异常/连接错误）
      lines.push(`❌ 失败: ${r.result?.error || "未知错误"}`);
      // [0726 分身失败吞报根修] success=false 但 result 里有内容（如 _clone_results 部分失败时的
      //   全量聚合文本：成功分身产出+失败分身错误都在里面）→ 原样透出。此前只打一行"未知错误"，
      //   任一分身失败=全部产出被吞（07-14/07-24 多会话实锤），主 AI 白等一整批。
      if (typeof r.result?.result === "string" && r.result.result.trim()) {
        lines.push(r.result.result);
      } else {
        _appendToolFailureReceipt(lines, r.result);
      }
    } else if (r.result?.success) {
      const resultData = r.result.result;
      if (!resultData) {
        lines.push("(无返回数据)");
      } else if (resultData.success === false) {
        // ★ 内层失败（fuzzy_edit匹配失败等 — handler正常返回但操作失败）
        lines.push(`⚠️ 操作失败: ${resultData.error || "未知原因"}`);
        if (resultData.suggestions && resultData.suggestions.length > 0) {
          lines.push("最接近的匹配位置:");
          for (const s of resultData.suggestions) {
            lines.push(`  第${s.line}行 (相似度${s.similarity}%): ${s.preview}`);
          }
          lines.push("提示: 请用 read_file 读取该文件确认当前内容，再重新构造 old_string");
        }
      } else if (typeof resultData === "string") {
        lines.push(resultData);
      } else {
        // ★ 成功结果: 只展示关键字段，不dump整个JSON
        const _lnBefore = lines.length; // 0714：白名单零命中检测基线（见下方兜底）
        const _msg = resultData.message || resultData.path || "";
        if (_msg) lines.push(_msg);
        // 读取/搜索来源与分页是真实工具回执数据，不是提示词指令。执行端负责产生，
        // 本层只做无损透传，避免 source/nextOffset/searchId 被白名单格式化器吞掉。
        if (resultData.source && typeof resultData.source === "object") {
          lines.push(`[source] ${JSON.stringify(resultData.source)}`);
        }
        if (resultData.limitApplied && typeof resultData.limitApplied === "object") {
          lines.push(`[read_limits] ${JSON.stringify(resultData.limitApplied)}`);
        }
        const _readPage = {};
        if (resultData.nextOffset !== undefined) _readPage.nextOffset = resultData.nextOffset;
        if (resultData.nextCharOffset !== undefined) _readPage.nextCharOffset = resultData.nextCharOffset;
        if (resultData.truncatedReason !== undefined) _readPage.truncatedReason = resultData.truncatedReason;
        if (Object.keys(_readPage).length > 0) {
          lines.push(`[read_page] ${JSON.stringify(_readPage)}`);
        }
        const _searchSnapshot = {};
        for (const _key of [
          "searchId",
          "queryKey",
          "snapshotAt",
          "complete",
          "snapshotCount",
          "pageCount",
          "nextCursor",
          "engine",
          "fallbackReason",
          "rangeLimitReason",
        ]) {
          if (resultData[_key] !== undefined) _searchSnapshot[_key] = resultData[_key];
        }
        if (Object.keys(_searchSnapshot).length > 0) {
          lines.push(`[search_snapshot] ${JSON.stringify(_searchSnapshot)}`);
        }
        // 写入类工具：展示验证状态
        if (resultData.verified === false) {
          lines.push("⚠️ 写入后验证失败，内容可能未正确写入");
        }
        // 展示关键信息但不dump完整JSON（减少token消耗）
        const _extras = [];
        if (resultData.totalLines !== undefined) _extras.push(`${resultData.totalLines}行`);
        if (resultData.size !== undefined) _extras.push(`${resultData.size}字节`);
        if (resultData.strategy) _extras.push(`策略:${resultData.strategy}`);
        if (resultData.anchorMatch) _extras.push(`锚点匹配:${resultData.anchorMatch}`);
        if (resultData.matchLine) _extras.push(`匹配位置:第${resultData.matchLine}行`);
        if (resultData.created) _extras.push("新建文件");
        if (resultData.truncated) _extras.push("结果已截断");
        if (_extras.length > 0) lines.push(`(${_extras.join(", ")})`);
        // ★ 定点返回（设计 §四焦点1）：改动点相对上下文锚——抗行号漂移的内容定位，AI 据 anchorText 可正则回找。
        //   白名单格式化器必须显式透出，否则字段被丢弃 AI 看不到（同上方 warning 字段独立透出的教训）。
        if (resultData.contextAnchor && typeof resultData.contextAnchor === "object") {
          const _ca = resultData.contextAnchor;
          const _b = Array.isArray(_ca.before) ? _ca.before.join(" ⏎ ") : "";
          const _a = Array.isArray(_ca.after) ? _ca.after.join(" ⏎ ") : "";
          lines.push(`📍上下文: …${_b} ⟪改动⟫ ${_a}…`);
          if (_ca.anchorText) lines.push(`   定位锚(可正则搜): ${_ca.anchorText}`);
        }
        // ★ 被删原文（replace_lines）：供 AI/前端看真实删除内容
        if (resultData.old_content && typeof resultData.old_content === "string") {
          const _oc = resultData.old_content.length > 600 ? resultData.old_content.slice(0, 600) + "…" : resultData.old_content;
          lines.push(`🗑 被替换原文:\n${_oc}`);
        }
        // ★ 截断续读指引（§7/§8 截断透明）：run_command 等截断时附 truncatedHint，告知 AI 如何取回完整内容。
        if (resultData.truncatedHint) lines.push(`ℹ️ ${resultData.truncatedHint}`);
        // ★ 结果提示（ToolExecutor._getResultHint 算出的 _hint）：此前从不透出，AI 看不到下一步指引，在此补上。
        if (resultData._hint) lines.push(`💡 ${resultData._hint}`);
        // read_file：优先尊重执行端回传的本次用户配置；老执行端没有 limitApplied 时
        // 保留旧 20000 字符防护，避免升级期间由单个遗留回包撑爆上下文。
        if (resultData.content !== undefined) {
          const _content = String(resultData.content);
          const _reportedMax = Number(resultData.limitApplied?.maxOutputChars);
          const _maxChars = Number.isFinite(_reportedMax) && _reportedMax > 0
            ? Math.round(_reportedMax)
            : 20000;
          if (_content.length > _maxChars) {
            lines.push(_content.slice(0, _maxChars));
            lines.push(`[content_truncated] ${JSON.stringify({
              originalChars: _content.length,
              displayedChars: _maxChars,
              reason: "injection_safety_limit",
            })}`);
          } else {
            lines.push(_content);
          }
        }
        // ★ search结果：紧凑格式（file:line content），不用JSON
        if (resultData.matches && Array.isArray(resultData.matches)) {
          const _reportedPageCount = Number(resultData.pageCount);
          const _displayCount = Number.isFinite(_reportedPageCount) && _reportedPageCount >= 0
            ? Math.min(resultData.matches.length, Math.round(_reportedPageCount))
            : Math.min(resultData.matches.length, 30);
          for (const _m of resultData.matches.slice(0, _displayCount)) {
            lines.push(`  ${_m.file || ""}:${_m.line || ""} ${(_m.content || _m.text || "").substring(0, 120)}`);
          }
          if (resultData.matches.length > _displayCount) {
            lines.push(`[matches_not_displayed] ${resultData.matches.length - _displayCount}`);
          }
        }
        // ★ list_files结果：紧凑一行一个
        if (resultData.files && Array.isArray(resultData.files)) {
          for (const _f of resultData.files.slice(0, 50)) {
            lines.push(`  ${_f.type === "directory" ? "📁" : "📄"} ${_f.path || _f.name}${_f.size ? " (" + _f.size + "B)" : ""}`);
          }
          // 0714：空目录显式标记——此前 files:[] 输出零行，AI 无法区分「空目录」与「工具坏了」（10:26 事故：AI 自查"是空目录还是注入问题"）
          if (resultData.files.length === 0) lines.push("  (空目录，0 项)");
          if (resultData.total > 50) lines.push(`  ... 共${resultData.total}项`);
        }
        // ★ diagnostics结果：紧凑格式
        if (resultData.diagnostics && Array.isArray(resultData.diagnostics)) {
          for (const _d of resultData.diagnostics.slice(0, 20)) {
            lines.push(`  ${_d.severity === 0 ? "❌" : "⚠️"} ${_d.file || ""}:${_d.line || ""} ${_d.message || ""}`);
          }
        }
        // run_command结果
        if (resultData.stdout !== undefined) {
          if (resultData.exitCode !== 0) lines.push(`退出码: ${resultData.exitCode}`);
          if (resultData.stdout) lines.push(resultData.stdout);
          if (resultData.stderr) lines.push(`[stderr] ${resultData.stderr}`);
          if (resultData.warning) lines.push(`⚠️ ${resultData.warning}`);
        }
        // ★ syntaxCheck结果
        if (resultData.syntaxCheck && !resultData.syntaxCheck.ok) {
          lines.push(`⚠️ 语法错误: ${resultData.syntaxCheck.error || ""}`);
        }
        // ★ callSites提醒
        if (resultData.callSites && resultData.callSites.length > 0) {
          lines.push(`📌 调用点: ${resultData.callSites.join("; ")}`);
        }
        // 0714 根因修（白名单格式化器吞成功结果）：以上全部字段提取零命中时，此前输出只剩耗时行——
        //   get_status/get_project_summary 等结构不在白名单的工具「成功但内容为空」，AI 误判工具坏/返回空。
        //   兜底：紧凑 JSON 透出（截断防膨胀），保证成功结果永远有内容可读。
        if (lines.length === _lnBefore) {
          try {
            const _j = JSON.stringify(resultData);
            lines.push(_j.length > 1500 ? _j.slice(0, 1500) + "…(已截断)" : _j);
          } catch { lines.push("(结果无法序列化展示)"); }
        }
      }
      if (r.result.duration) lines.push(`(耗时: ${r.result.duration}ms)`);
    } else {
      lines.push(`❌ 失败: ${r.result?.error || "未知错误"}`);
    }
  }
  lines.push("\n[/IDE工具执行结果]");
  return lines.join("\n");
}

/**
 * 单一真源：判定一条消息是否为"IDE工具/分身执行结果"操作消息。
 * 并行多信号（any-hit + 优先级回退）：
 *   信号1（结构字段，首选）: extension._opType === "ide_tool_result"
 *   信号2（系统身份）       : role==="system" || name==="IDE工具结果"
 *   信号3（内容哨兵，回退）  : content.includes("[IDE工具执行结果]")
 *   排除                    : extension._isSummary === true（摘要消息绝不算工具结果）
 * 新消息靠信号1权威（对话含字面串也不误判）；旧磁盘消息靠信号2+3回退，零回归。
 * @param {object} m chatLog 条目
 * @returns {boolean}
 */
export function isIdeToolResultMsg(m) {
  if (!m || typeof m !== "object") return false;
  if (m.extension && m.extension._isSummary === true) return false;
  // 已压缩/清理的占位符不算"活的"工具结果（压缩时 Object.assign 会保留 _opType，故须显式排除，保持旧语义）
  const _c = typeof m.content === "string" ? m.content : "";
  if (_c.startsWith("[已压缩") || _c === "[已清理的工具结果]" || _c.startsWith("[旧工具结果已清除")) return false;
  // _opType 接受域集合（0716 断点#2 修：MCP 结果原无标记，W66 压缩/urgent 裁剪按普通消息处理可能先被裁）——
  // 加域只扩集合零新分支；mcp_tool_result 由 MCP Template ReplyHandler 打标。
  if (m.extension && ["ide_tool_result", "mcp_tool_result"].includes(m.extension._opType)) return true;
  // 结构性回退：role:'tool' 是工具结果 data 层专用 role（全库生产者仅 MCP Template/beilu-ppt，均为工具结果语义）——
  // 兜住存量用户 MCP 插件件（Template 拷贝分发，旧件无 _opType 标记）。
  if (m.role === "tool") return true;
  const idOk = m.role === "system" || m.name === "IDE工具结果";
  return idOk && _c.includes("[IDE工具执行结果]");
}

/**
 * 单一真源：判定一条消息是否为"AI 操作"——即 AI 发出 IDE 工具调用（YonBan 命令）的消息。
 * 与 isIdeToolResultMsg 对称（那个判"工具结果"，这个判"AI 命令"）。
 *   信号1（结构字段，首选）: extension._opType === "ide_tool_call"（replyHandler 处理 ideToolCall 时打标）
 *   信号3（内容哨兵，回退）  : content.includes("<ideToolCall")（旧消息未剥离标签时）
 *   排除                    : 摘要 / 已压缩占位符
 * @param {object} m chatLog 条目
 * @returns {boolean}
 */
export function isIdeToolCallMsg(m) {
  if (!m || typeof m !== "object") return false;
  if (m.extension && m.extension._isSummary === true) return false;
  const _c = typeof m.content === "string" ? m.content : "";
  if (_c.startsWith("[已压缩") || _c === "[已清理的工具结果]" || _c.startsWith("[旧工具结果已清除")) return false;
  // _opType 接受域集合（0716 断点#2 对称扩：MCP 调用消息 mcp_tool_call 由 Template 打标）
  if (m.extension && ["ide_tool_call", "mcp_tool_call"].includes(m.extension._opType)) return true;
  return _c.includes("<ideToolCall") || _c.includes("<mcp-tool") || _c.includes("<mcp-prompt") || _c.includes("<mcp-resource"); // 内容哨兵回退（存量旧件消息）
}

// 分身/委派系统消息标签判定单一真源（原 setDataActions:hideContextNoise / getPromptHandler:urgent / hideCloneMessages 三处逐字复制 _cloneRe）。无 g/y flag，.test 不维护 lastIndex，单例安全。
export const CLONE_TAG_RE = /<(分身\d|delegate|parallelDelegate|report|approval)[\s>]/i;

/**
 * 单一真源：从 chatLog 收集"上下文噪声"待 hide 下标（三类：AI读取/工具结果 + AI操作/命令 + 分身输入，各保留最近 keepLast 条，其余返回）。
 * 纯计算无副作用，不调 hideMessages（可逆性由调用方持有）。原 setDataActions:hideContextNoise 与 getPromptHandler:urgent 两段逐字复制，此为消重收口。
 * @param {Array<{content?:string, extension?:object, id?:any}>} log 完整 chatLog（含已 hidden 条目）
 * @param {number} [keepLast=2] 各类保留最近条数
 * @returns {{indices:number[], breakdown:{read:number,op:number,clone:number}}}
 */
export function collectNoiseToHide(log, keepLast = 2) {
  const _keep = Number.isInteger(keepLast) ? keepLast : 2;
  const _readI = [], _opI = [], _cloneI = [];
  for (let i = 0; i < log.length; i++) {
    const e = log[i];
    if (e.extension?._hidden) continue;
    if (isIdeToolResultMsg(e)) _readI.push(i);
    else if (isIdeToolCallMsg(e)) _opI.push(i);
    else if (e.content && CLONE_TAG_RE.test(e.content)) _cloneI.push(i);
  }
  const _read = Math.max(0, _readI.length - _keep);
  const _op = Math.max(0, _opI.length - _keep);
  const _clone = Math.max(0, _cloneI.length - _keep);
  return {
    indices: [
      ..._readI.slice(0, _read),
      ..._opI.slice(0, _op),
      ..._cloneI.slice(0, _clone),
    ],
    breakdown: { read: _read, op: _op, clone: _clone },
  };
}

// ---- 辅助函数 ----

function decodeHTMLEntities(str) {
  if (typeof str !== "string") return str;
  return str
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&amp;/g, '&'); // &amp; 最后处理，避免二次解码
}

// ★ 必须保持字符串类型的参数名（不做数字转换）
const STRING_ONLY_PARAMS = new Set([
  "path", "command", "cwd", "pattern", "filePattern",
  "old_string", "new_string", "new_content", "content",
]);

// ★ 承载「代码/多行文本」的参数：禁止从 XML 属性承载（值含裸 " 或 <> 会让外层标签正则断裂、整条 ideToolCall 静默丢失）。
//    必须改用子标签 <old_string>/<new_string>/<content>/<new_content> 或带内容的 body 形式。
//    注意：这是 STRING_ONLY_PARAMS 的子集——path/command/pattern 等单行短值仍允许属性承载。
const CONTENT_PARAMS = new Set([
  "old_string", "new_string", "new_content", "content",
]);

// 兜底探针：不解析值，只探测「属性位出现 content-param 名 = 起始引号」。
//   因不读取引号内的值，故不受裸引号/代码标签破坏（这正是外层标签正则做不到的）。
//   命中即说明 AI 把代码塞进了属性，对应的 ideToolCall 很可能已被外层正则静默丢弃。
const CONTENT_PARAM_IN_ATTR_PROBE = /<ideToolCall\b[^>]*?\b(old_string|new_string|new_content|content)\s*=\s*["']/gi;

function parseAttributes(attrStr) {
  const attrs = {};
  // 双引号或单引号属性值都认（AI 常混用 tool='x'）。m[2]=双引号值，m[3]=单引号值。
  const regex = /(\w+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
  let m;
  while ((m = regex.exec(attrStr)) !== null) {
    const key = m[1];
    // ★ content-param 禁止从属性承载：值很可能已被裸引号截断/污染，取了反而把半截代码当真值写文件。
    //   剔除该 kv，并在 attrs._rejectedContentParams 标记，供上层生成精确可操作报错。
    if (CONTENT_PARAMS.has(key)) {
      (attrs._rejectedContentParams ||= []).push(key);
      continue;
    }
    // 单引号值还原 \'，双引号值还原 \"；两者都还原 \\ 与 HTML 实体。
    const raw = m[2] !== undefined ? m[2].replace(/\\"/g, '"') : m[3].replace(/\\'/g, "'");
    let val = decodeHTMLEntities(raw.replace(/\\\\/g, '\\'));
    if (!STRING_ONLY_PARAMS.has(key)) {
      if (val === "true") val = true;
      else if (val === "false") val = false;
      else if (/^\d+$/.test(val)) val = parseInt(val, 10);
    }
    attrs[key] = val;
  }
  return attrs;
}

// （命令安全域原 2286-2824 行已整块迁 src/yonban/core/functions/security/commandGate.mjs——T3a·3.6）

// W61: 大白话操作描述 + emoji严重程度（W13/W36设计）
// 映射键 = 本文件 IDE_TOOLS / YonBan ToolExecutor _handlers 的真实工具集（20 个 AI 工具）。
// 新增/删工具时同步此表；未命中走末尾 fallthrough（不再有 create_file/git_* 等幽灵键）。
export function generateHumanReadableDescription(toolName, args) {
  const descriptions = {
    read_file: (a) => `📖 读取文件: ${a.path || "?"}`,
    write_file: (a) => `📝 写入文件: ${a.path || "?"} (${(a.content || "").length}字符)`,
    list_files: (a) => `📂 列出文件: ${a.path || "."}`,
    run_command: (a) => `💻 执行命令: ${(a.command || "?").substring(0, 60)}`,
    get_diagnostics: (a) => `🔬 获取诊断信息${a.path ? `: ${a.path}` : ""}`,
    get_status: () => `📊 获取IDE状态`,
    search_files: (a) => `🔍 搜索内容: "${a.pattern || a.query || "?"}"`,
    search_by_name: (a) => `🔎 按名搜索文件: "${a.pattern || "?"}"`,
    replace_lines: (a) => `✏️ 替换行: ${a.path || "?"} (${a.start_line ?? "?"}-${a.end_line ?? "?"})`,
    insert_at_line: (a) => `➕ 插入: ${a.path || "?"} @行${a.line ?? "末尾"}`,
    fuzzy_edit: (a) => `🩹 模糊编辑: ${a.path || "?"}`,
    todo_read: () => `📋 读取任务清单`,
    todo_write: (a) => `📋 写入任务清单 (${(a.content || "").length}字符)`,
    goto_definition: (a) => `🎯 跳转定义: ${a.path || "?"}:${a.line ?? "?"}`,
    find_references: (a) => `🔗 查找引用: ${a.path || "?"}:${a.line ?? "?"}`,
    get_project_summary: () => `🗂️ 项目结构摘要`,
    ast_search: (a) => `🌳 AST搜索: "${a.pattern || "?"}"`,
    smart_search: (a) => `🧠 智能搜索: "${a.query || "?"}"`,
    validate_html: (a) => `✅ 校验HTML: ${a.path || "?"}`,
    lint_code: (a) => `🧹 Lint: ${a.path || "?"}`,
  };

  const fn = descriptions[toolName];
  if (fn) return fn(args || {});
  return `🔧 ${toolName}: ${JSON.stringify(args || {}).substring(0, 80)}`;
}

// 操作严重程度emoji — 键对齐真实工具集。🟢读/导航/搜索 · 🟡改文件 · 🔴执行命令（唯一可任意副作用）。
export function getSeverityEmoji(toolName) {
  const severity = {
    read_file: "🟢", list_files: "🟢", search_files: "🟢", search_by_name: "🟢",
    get_diagnostics: "🟢", get_status: "🟢", todo_read: "🟢",
    goto_definition: "🟢", find_references: "🟢", get_project_summary: "🟢",
    ast_search: "🟢", smart_search: "🟢", validate_html: "🟢", lint_code: "🟢",
    write_file: "🟡", replace_lines: "🟡", insert_at_line: "🟡", fuzzy_edit: "🟡", todo_write: "🟡",
    run_command: "🔴",
  };
  return severity[toolName] || "🟡";
}
