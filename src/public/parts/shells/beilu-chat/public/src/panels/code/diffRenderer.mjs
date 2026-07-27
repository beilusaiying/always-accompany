/**
 * diffRenderer.mjs — IDE 操作 diff 可视化（W18 §四）
 *
 * 功能链：
 *   renderToolResultDiff(toolResult) → 识别 IDE 写操作类型（fuzzy_edit/replace_lines/write_file/insert_at_line）
 *     → 提取 oldText/newText → renderDiffHtml → computeLineDiff（逐行 LCS diff）
 *     → 生成 <div class="diff-container"> 红删绿增 HTML 字符串
 *   result.result.contextAnchor.before/after → 周边灰色上下文行（把改动放回文件视角）
 *   result.result.anchorText + revealPath → diff header 定位锚（阶段2可点击跳转 IDE）
 *
 * why（like Cursor 体验）：
 *   AI 文件写操作只有 oldText→newText，用户看不到具体改了哪行；
 *   diff 视图让改动即时可审，header 定位锚抗行号漂移（大文件行号漂移后锚仍有效）。
 *   周边上下文灰行弥补"孤立红绿"难以定位改动位置的问题。
 *
 * 关联链：
 *   → shared/state/utils.mjs escapeHtml（XSS 安全转义）
 *   → shared/transport/api-client.mjs apiFetch（未来阶段3 IDE 跳转 API 备用）
 *   ← idePanel.mjs pollIdeOpLog（工具日志轮询后调用本模块渲染 diff 卡片）
 *   ← taskItemPanel.mjs revertCheckpoint（回档 diff 预览复用本模块）
 *
 * 影响范围：
 *   纯渲染函数，不操作全局状态；输出 HTML 字符串由调用方插入 DOM。
 *   diff-anchor-clickable 元素上挂 data-reveal-path / data-reveal-anchor 属性，
 *   供 idePanel 的全局点击委托捕获后调用 IDE 跳转接口。
 *
 * 使用效果：
 *   每次 AI 写文件，聊天侧即出现带文件名/工具名/行计数的彩色 diff 卡片；
 *   点击定位锚（阶段3）→ IDE 跳到对应行；周边灰行提供改动上下文。
 */

import { escapeHtml } from "../../shared/state/utils.mjs";
import { sendAction } from "../../shared/transport/sendAction.mjs"; // T6b：出向统一门面（verb=真动作 revealInIde → memory 通配路由）

/**
 * 渲染diff HTML
 * @param {string} oldText - 原始内容（红色删除）
 * @param {string} newText - 新内容（绿色增加）
 * @param {{ fileName?: string, tool?: string }} [meta] - 文件名和工具类型
 * @returns {string} HTML字符串
 */
export function renderDiffHtml(oldText, newText, meta = {}) {
  const oldLines = (oldText || "").split("\n");
  const newLines = (newText || "").split("\n");

  // 简单逐行diff（LCS-based会更好，但对短代码够用）
  const diff = computeLineDiff(oldLines, newLines);

  // ★ 定点查看（阶段2）：header 优先显示内容锚 anchorText（抗行号漂移）；阶段3：有 revealPath 时锚可点击→IDE 跳转。
  const _anchorTxt = meta.anchorText ? escapeHtml(String(meta.anchorText).slice(0, 80)) : "";
  const _anchorLabel = !meta.anchorText
    ? ""
    : meta.revealPath
      ? `<span class="diff-anchor diff-anchor-clickable" data-reveal-path="${escapeHtml(String(meta.revealPath))}" data-reveal-anchor="${escapeHtml(String(meta.anchorText))}" title="点击在 IDE 跳转到此处"><i data-ic="anchor"></i> ${_anchorTxt}</span>`
      : `<span class="diff-anchor" title="定位锚（可正则搜）"><i data-ic="anchor"></i> ${_anchorTxt}</span>`;
  const headerHtml = (meta.fileName || _anchorLabel)
    ? `<div class="diff-header">${meta.fileName ? escapeHtml(meta.fileName) : ""}${meta.tool ? ` <span class="diff-tool">${meta.tool}</span>` : ""}${_anchorLabel ? ` ${_anchorLabel}` : ""}</div>`
    : "";

  // ★ 周边上下文灰行（来自工具返回的 contextAnchor.before/after）：把改动放回文件上下文里看，
  //   而不是孤立的红删绿增。computeLineDiff 只覆盖改动块本身，周边行靠 contextAnchor 补。
  const _ctxRow = (text, where) =>
    `<div class="diff-line-context diff-line-ambient"><span class="diff-prefix" title="${where}">·</span><span class="diff-content">${escapeHtml(text)}</span></div>`;
  const beforeHtml = Array.isArray(meta.contextBefore)
    ? meta.contextBefore.map((l) => _ctxRow(l, "上文")).join("")
    : "";
  const afterHtml = Array.isArray(meta.contextAfter)
    ? meta.contextAfter.map((l) => _ctxRow(l, "下文")).join("")
    : "";

  const linesHtml = diff
    .map((line) => {
      const cls =
        line.type === "remove" ? "diff-line-remove" :
        line.type === "add" ? "diff-line-add" :
        "diff-line-context";
      const prefix =
        line.type === "remove" ? "−" :
        line.type === "add" ? "+" :
        " ";
      return `<div class="${cls}"><span class="diff-prefix">${prefix}</span><span class="diff-content">${escapeHtml(line.text)}</span></div>`;
    })
    .join("");

  const stats = {
    added: diff.filter(l => l.type === "add").length,
    removed: diff.filter(l => l.type === "remove").length,
  };
  const statsHtml = `<div class="diff-stats"><span class="diff-stat-add">+${stats.added}</span> <span class="diff-stat-remove">−${stats.removed}</span></div>`;

  return `<div class="diff-container">${headerHtml}${statsHtml}<div class="diff-body">${beforeHtml}${linesHtml}${afterHtml}</div></div>`;
}

/**
 * 从IDE工具调用参数生成diff视图
 * @param {{ tool: string, params: object, result: object }} toolResult
 * @returns {string|null} diff HTML或null（不是写操作）
 */
export function renderToolResultDiff(toolResult) {
  const { tool, params, result } = toolResult;
  if (!result?.success) return null;

  // ★ 定点查看（设计阶段2）：工具返回的相对上下文锚（before3/after3+anchorText）+ 被删原文，
  //   threaded 进 renderDiffHtml，让 diff 带周边上下文、header 用内容锚而非行号。result.result = handler 返回层。
  const _rd = result?.result || {};
  const _ca = _rd.contextAnchor || {};
  const _ctxMeta = {
    contextBefore: Array.isArray(_ca.before) ? _ca.before : undefined,
    contextAfter: Array.isArray(_ca.after) ? _ca.after : undefined,
    anchorText: _ca.anchorText,
    revealPath: _ca.anchorText ? params.path : undefined, // 有锚才挂跳转路径（阶段3）
  };

  switch (tool) {
    case "fuzzy_edit":
      // 最完美的diff场景：有old_string和new_string
      if (params.old_string && params.new_string) {
        return renderDiffHtml(params.old_string, params.new_string, {
          fileName: params.path,
          tool: "fuzzy_edit",
          ..._ctxMeta,
        });
      }
      break;

    case "replace_lines":
      // ★ old_content 现由工具真实返回（阶段1）：拿到则渲染真 diff，拿不到才退回占位符
      if (params.new_content) {
        const oldContent = _rd.old_content || `(第${params.start_line}-${params.end_line}行)`;
        return renderDiffHtml(oldContent, params.new_content, {
          fileName: params.path,
          tool: "replace_lines",
          ..._ctxMeta,
        });
      }
      break;

    case "write_file":
      // 新建/覆盖文件 — 全部显示为新增
      if (params.content) {
        const preview = params.content.length > 2000
          ? params.content.substring(0, 2000) + "\n...(truncated)"
          : params.content;
        return renderDiffHtml("", preview, {
          fileName: params.path,
          tool: "write_file",
        });
      }
      break;

    case "insert_at_line":
      if (params.content) {
        return renderDiffHtml("", params.content, {
          fileName: params.path,
          tool: "insert_at_line",
          ..._ctxMeta,
        });
      }
      break;
  }

  return null;
}

/**
 * 简单逐行diff算法（基于最长公共子序列思想的简化版）
 * @param {string[]} oldLines
 * @param {string[]} newLines
 * @returns {Array<{ type: "context"|"add"|"remove", text: string }>}
 */
function computeLineDiff(oldLines, newLines) {
  const result = [];
  let oi = 0, ni = 0;

  while (oi < oldLines.length || ni < newLines.length) {
    if (oi < oldLines.length && ni < newLines.length) {
      if (oldLines[oi] === newLines[ni]) {
        // 相同行
        result.push({ type: "context", text: oldLines[oi] });
        oi++;
        ni++;
      } else {
        // 尝试向前查找匹配
        const lookAhead = 5;
        let foundOld = -1, foundNew = -1;

        // 在新行中找当前旧行
        for (let j = ni + 1; j < Math.min(ni + lookAhead, newLines.length); j++) {
          if (newLines[j] === oldLines[oi]) { foundNew = j; break; }
        }
        // 在旧行中找当前新行
        for (let j = oi + 1; j < Math.min(oi + lookAhead, oldLines.length); j++) {
          if (oldLines[j] === newLines[ni]) { foundOld = j; break; }
        }

        if (foundNew >= 0 && (foundOld < 0 || foundNew - ni <= foundOld - oi)) {
          // 新行中有插入
          while (ni < foundNew) {
            result.push({ type: "add", text: newLines[ni] });
            ni++;
          }
        } else if (foundOld >= 0) {
          // 旧行中有删除
          while (oi < foundOld) {
            result.push({ type: "remove", text: oldLines[oi] });
            oi++;
          }
        } else {
          // 直接替换
          result.push({ type: "remove", text: oldLines[oi] });
          result.push({ type: "add", text: newLines[ni] });
          oi++;
          ni++;
        }
      }
    } else if (oi < oldLines.length) {
      result.push({ type: "remove", text: oldLines[oi] });
      oi++;
    } else {
      result.push({ type: "add", text: newLines[ni] });
      ni++;
    }
  }

  return result;
}

// ★ 定点跳转（阶段3）：委派监听 diff 锚点击 → POST revealInIde → 后端 ideClient.callTool("_reveal") → IDE 跳转。
//   模块级一次性绑定（diffRenderer 被 idePanel/messageList 多处 import 但只加载一次），覆盖面板与聊天流两处卡。
if (typeof document !== "undefined" && !document.__beiluDiffRevealBound) {
  document.__beiluDiffRevealBound = true;
  document.addEventListener("click", (e) => {
    const el = e.target?.closest?.(".diff-anchor-clickable");
    if (!el) return;
    const path = el.getAttribute("data-reveal-path");
    const anchorText = el.getAttribute("data-reveal-anchor");
    if (!path) return;
    // verb=revealInIde → memory 通配路由组装 {_action:"revealInIde", path, anchorText}。失败静默（fire-and-forget）。
    sendAction({ verb: "revealInIde", target: "plugins:beilu-memory", source: "web", payload: { path, anchorText } })
      .then((d) => { if (d && d.success === false) console.warn("[diff reveal] 跳转失败:", d.error || "未知"); })
      .catch(() => {});
  });
}
