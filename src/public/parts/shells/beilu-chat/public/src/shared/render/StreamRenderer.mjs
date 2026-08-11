/**
 * [StreamRenderer.mjs] — 流式消息逐字 DOM 渲染器。只管把增量内容渲染进目标 DOM 节点，
 *   不管切片合并（那是 stream.mjs 的事），不管消息队列（那是 virtualQueue 的事），
 *   不管消息模板（那是 messageList 的事）。
 *
 * 职责：
 *   1. StreamRenderer 类（**每个窗口一个实例**，由 virtualQueue._W() 持有）：维护 streamingMessages
 *      Map + 自己的 RAF loop，管理**本窗口**所有流式消息
 *      【why 不是单例】（凛倾 0727「每个窗口都是并行的，哪里来的影响？」）多窗口并存时，
 *        单例意味着一份 streamingMessages + 一条 RAF loop 被所有窗口共用 → 任何一个窗口
 *        重建队列（开新窗口/补拉）时的 stopLoop()+clear() 会把**别的窗口正在生成的消息**
 *        一并掐断且永远卡住。窗口既然并行，渲染器就必须每窗口一份。
 *   2. register(id, el, initialContent)：注册一条新消息的流式渲染目标，绑定 DOM 节点
 *   3. updateTarget(id, content)：接收最新全量 content，计算 Δ 后走 morphdom diff 更新 DOM
 *      — 节流：MIN_RENDER_INTERVAL=80ms，避免每帧 markdown+正则
 *      — protectRichNode()：morphdom onBeforeElUpdated 白名单——保护 iframe/MathJax/hljs/details 不被重建
 *   4. stop(id)：流结束，flush 最终内容，注销注册，清理 rAF
 *   5. full-html 分支：检测到 full-html 内容时走 renderAsIframe，按间隔更新 iframe src
 *   6. 思维链折叠：流式中途也支持 extractThinkingContent + 折叠渲染（节流保护）
 *
 * 链路：virtualQueue.mjs handleStreamUpdate → applySlice → streamRenderer.updateTarget(el, content)
 *       → detectContentType → markdown/full-html/mixed 三分支 → morphdom diff → DOM 更新
 *       virtualQueue.mjs handleMessageReplaced → streamRenderer.stop(id) → flush 最终状态
 * 影响：高频写 DOM（每 80ms 最多一次 morphdom）；rAF 占用（animationFrameId）；
 *       不发网络请求；不写 localStorage
 * 相交：← virtualQueue.mjs（register/updateTarget/stop 唯一调用方）
 *       → displayRegex.mjs（detectContentType / extractThinkingContent / isRendererEnabled）
 *       → markdown.mjs（renderMarkdownAsString）
 *       → iframeRenderer.mjs（renderAsIframe：full-html 分支）
 *       → whitebox.mjs（wbTrace/wbDetect）
 *
 * 点击后发生什么（流式过程）：
 *   后端推 stream_update → virtualQueue → streamRenderer.updateTarget(id, newContent)
 *   → 80ms 节流 → morphdom diff 更新 .message-content 节点（保护 iframe/hljs 不重建）
 *   → 用户看到消息逐字出现
 *   流结束 → message_replaced → streamRenderer.stop(id) → 最终 flush → virtualQueue.replaceItem
 *   → messageList.renderMessage 全量重渲染（完整模板）
 */
import { renderMarkdownAsString } from "../../../../../../scripts/markdown.mjs";
import { createDiag } from "../state/diagLogger.mjs";
import {
  detectContentType,
  extractThinkingContent,
  applyThinkingVisibilityBadge,
  isRendererEnabled,
  // ★ T10 渲染双管线对齐：复用落稿同一套加工，禁复制第二份（病6自繁殖）。
  //   代码折叠/用户正则/占位符恢复本就在 displayRegex export，此处只追加 import 名。
  applyBuiltinProcessors,
  applyDisplayRules,
  restorePlaceholders,
} from "./displayRegex.mjs";
// ★ T10：宏替换/状态栏标签剥离原是 messageList 私有函数，已 export 供流式复用（禁复制）。
import { replaceMacros, extractStatusPlaceholder } from "./messageList.mjs";
import { renderAsIframe } from "./iframeRenderer.mjs";
import { wbTrace, wbDetect } from "../widgets/whitebox.mjs";
import { storage, KEYS } from "../state/storage.mjs"; // R2: localStorage 集中

const diag = createDiag("streamRenderer");

/**
 * 读取流式渲染是否启用
 * @returns {boolean}
 */
function isStreamRenderEnabled() {
  try {
    // 默认开：富内容(full-html/状态栏)也边出边渲染（实时渲染，为 Live2D 关联 + 省时）。
    // 仅当用户显式关掉 toggle-stream-render（存 "false"）才禁用。文本流式本就始终开。
    return storage.get(KEYS.BEILU_STREAM_RENDER_ENABLED) !== "false";
  } catch {
    return true;
  }
}

/**
 * FT4 §2.1：morphdom 富节点白名单守卫（onBeforeElUpdated 回调）。
 *
 * 返回 false 跳过该节点的 diff，保护流式过程中已渲染的昂贵/有状态富节点不被
 * 整段重建。
 * 4 类受保护节点：iframe（美化/状态栏）/ MathJax 公式 / hljs 代码块高亮 / details 折叠态。
 *
 * @param {HTMLElement} fromEl - 现有 DOM 节点
 * @param {HTMLElement} toEl - 新内容对应节点
 * @returns {boolean} false=跳过该节点更新（保护），true=允许 morphdom 正常 diff
 */
function protectRichNode(fromEl, toEl) {
  if (!fromEl || fromEl.nodeType !== 1) return true;
  const tag = fromEl.tagName;
  const cl = fromEl.classList;

  // 1) iframe（美化/状态栏）：重建丢失内部 state + 重跑角色卡脚本
  if (
    tag === "IFRAME" ||
    (cl &&
      (cl.contains("beilu-beauty-iframe") ||
        cl.contains("segment-iframe-container")))
  ) {
    return false;
  }

  // 2) MathJax 公式：重排昂贵且闪烁
  if (
    tag === "MJX-CONTAINER" ||
    (cl && (cl.contains("MathJax") || cl.contains("MathJax_Display")))
  ) {
    return false;
  }

  // 3) 代码块高亮：highlight.js 重算 + 用户选区丢失
  if (
    (cl && cl.contains("hljs")) ||
    (tag === "PRE" && fromEl.querySelector(".hljs"))
  ) {
    return false;
  }

  // 4) 折叠态 details：保留流式中途用户展开的折叠态，不被重置
  if (tag === "DETAILS") {
    if (toEl && toEl.nodeType === 1 && typeof toEl.open === "boolean") {
      // 同步新内容文本但保留用户当前展开/折叠状态
      toEl.open = fromEl.open;
    }
    return true;
  }

  return true;
}

/**
 * 用于实现流式渲染的类。
 *
 * 性能优化：
 * - 思维链折叠使用节流（MIN_RENDER_INTERVAL），避免每帧都执行正则+markdown
 * - 流式渲染模式：检测 full-html 内容时按间隔更新 iframe
 */
export class StreamRenderer {
  /** @type {number} 最小渲染间隔（毫秒），用于节流 */
  static MIN_RENDER_INTERVAL = 80;

  /**
   * 创建一个新的 StreamRenderer 实例。
   */
  constructor() {
    this.streamingMessages = new Map();
    this.animationFrameId = null;
  }

  /**
   * 注册一个正在进行流式传输的消息。
   * @param {string} id - 消息的唯一 ID。
   * @param {string} initialContent - 消息的初始内容。
   * @param {object} [options={}] - 额外选项
   * @param {string} [options.rawContent=''] - 原始消息内容（display regex 处理前），用于 iframe ST API 注入
   * @param {object} [options.mvuVariables=null] - MVU 累积变量，用于 iframe 中状态栏读取
   * @param {object} [options.message=null] - T10：消息对象，宏 replaceMacros 需要
   * @param {string} [options.role=''] - T10：消息角色，applyDisplayRules 作用域判定
   * @param {string} [options.charName=''] - T10：角色名（timeSlice.charname 优先），scoped 正则匹配
   * @param {number} [options.messageDepth=0] - T10：消息深度，正则 min/maxDepth 过滤
   */
  register(id, initialContent, options = {}) {
    diag.log(
      "register:",
      "id:",
      id,
      "initialContent.len:",
      initialContent?.length,
      "domElement found:",
      !!document.getElementById(id),
      "already registered:",
      this.streamingMessages.has(id),
      "hasRawContent:",
      !!options.rawContent,
      "hasMvuVars:",
      !!options.mvuVariables,
    );
    this.streamingMessages.set(id, {
      targetContent: initialContent || "",
      displayedContent: initialContent || "",
      lastRendered: null,
      lastRenderTime: 0,
      domElement: document.getElementById(id), // 缓存引用
      cache: {},
      streamIframe: null, // 流式渲染的 iframe 引用
      isFullHtml: false, // 是否被检测为 full-html
      // ★ Phase 1.2：存储 rawContent 和 mvuVariables，流式 iframe 渲染时传给 renderAsIframe
      rawContent: options.rawContent || "",
      mvuVariables: options.mvuVariables || null,
      // ★ T10：宏/正则加工所需上下文（由 virtualQueue 从 messageData 补传，零成本）。
      //   缺省时加工链退化为透传（无 message→宏跳过、role/charName 空→正则按规则自身作用域处理）。
      message: options.message || null,
      role: options.role || "",
      charName: options.charName || "",
      messageDepth: options.messageDepth || 0,
    });
    this.startLoop();
  }

  /**
   * 更新指定消息的目标内容，用于平滑渲染。
   * @param {string} id - 消息的唯一 ID。
   * @param {string} newContent - 消息的新内容。
   */
  updateTarget(id, newContent) {
    const state = this.streamingMessages.get(id);
    if (state) {
      const prevLen = state.targetContent?.length || 0;
      state.targetContent = newContent;
      // 每50次更新打印一次，避免日志爆炸
      if (prevLen === 0 || (newContent?.length || 0) - prevLen > 200) {
        diag.log(
          "updateTarget:",
          "id:",
          id,
          "prevLen:",
          prevLen,
          "newLen:",
          newContent?.length,
          "displayedLen:",
          state.displayedContent?.length,
        );
      }
    } else {
      diag.warn("updateTarget: id not registered:", id);
    }
    this.startLoop();
  }

  /**
   * 停止对指定消息的流式渲染。
   * @param {string} id - 消息的唯一 ID。
   */
  stop(id) {
    const had = this.streamingMessages.has(id);
    const state = this.streamingMessages.get(id);
    if (state?.streamIframe) {
      state.streamIframe = null; // 清除引用，iframe 保留在 DOM 中
    }
    this.streamingMessages.delete(id);
    // ★ DIAG: 确认 StreamRenderer 停止
    diag.log("stop called:", "id:", id, "was_registered:", had);
  }

  /**
   * 启动渲染循环
   */
  startLoop() {
    if (this.animationFrameId || !this.streamingMessages.size) return;
    // 代计数：cancelAnimationFrame 只能取消【pending】的 RAF，关不掉正挂起在
    // await renderFrame() 里的本轮 loop——恢复后会无条件 requestAnimationFrame 重启循环
    //（M-10 注释的意图因此落空）。loop 捕获创建时的代号，await 归来对不上就自灭。
    this._loopGen ??= 0;
    const gen = this._loopGen;
    /**
     * 一个帧的渲染逻辑
     */
    const loop = async () => {
      if (!this.streamingMessages.size) {
        this.animationFrameId = null;
        return;
      }
      await this.renderFrame();
      if (gen !== this._loopGen) return; // await 间隙被 stopLoop：不再重臂 RAF
      this.animationFrameId = requestAnimationFrame(loop);
    };
    this.animationFrameId = requestAnimationFrame(loop);
  }

  /**
   * 停止渲染循环（M-10：切卡 teardown 时调用，取消 pending RAF + 代号失效，
   * 防 async loop 在 await 间隙后于【已销毁 DOM】上继续 renderFrame）。
   */
  stopLoop() {
    this._loopGen = (this._loopGen ?? 0) + 1;
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  /**
   * 渲染一帧
   *
   * 性能优化策略：
   * 1. 平滑算法照旧（字符追赶，无需节流）
   * 2. markdown 渲染 + 思维链折叠使用最小间隔节流
   * 3. full-html 流式渲染使用更长间隔（500ms）更新 iframe
   */
  async renderFrame() {
    const now = performance.now();

    for (const [id, state] of this.streamingMessages) {
      try {
        // 重新获取 DOM，防止虚拟列表滚动导致元素重建
        if (!state.domElement || !state.domElement.isConnected) {
          state.domElement = document.getElementById(id);
          if (!state.domElement) continue;
        }

        // 平滑算法逻辑
        const { targetContent, displayedContent } = state;
        if (targetContent.length > displayedContent.length) {
          const lag = targetContent.length - displayedContent.length;
          const step = Math.max(1, Math.ceil(lag / 5));
          state.displayedContent = targetContent.substring(
            0,
            displayedContent.length + step,
          );
          wbTrace("streamRender", "smoothCatchup", { id, lag, step, displayedLen: state.displayedContent.length });
        } else {
          state.displayedContent = targetContent;
        }

        // 只有内容变化才操作 DOM
        if (state.displayedContent !== state.lastRendered) {
          // ★ 节流：距离上次渲染未达最小间隔则跳过（平滑算法下一帧会重试）
          if (now - state.lastRenderTime < StreamRenderer.MIN_RENDER_INTERVAL) {
            continue;
          }

          // ★ 流式渲染：检测 full-html 内容
          if (isStreamRenderEnabled() && isRendererEnabled()) {
            const contentType = detectContentType(state.displayedContent);
            if (contentType === "full-html" && !state.isFullHtml) {
              state.isFullHtml = true;
            }

            // full-html 流式更新：用更长间隔（500ms）刷新 iframe
            if (state.isFullHtml) {
              if (now - state.lastRenderTime < 500) continue;

              state.lastRenderTime = now;
              state.lastRendered = state.displayedContent;

              if (!state.streamIframe?.isConnected) {
                // ★ 首次：完整创建 iframe
                state.streamIframe = await renderAsIframe(
                  state.displayedContent,
                  state.domElement,
                  state.rawContent || "",
                  { mvuVariables: state.mvuVariables || {} },
                );
                if (!state.domElement?.isConnected) continue;
              } else {
                // ★ 后续：通过 postMessage 增量更新内容（不重建iframe）
                try {
                  state.streamIframe.contentWindow.postMessage({
                    type: 'beilu-stream-update',
                    content: state.displayedContent
                  }, '*');
                } catch {
                  // iframe可能已失效，回退到重建
                  state.streamIframe.remove();
                  state.streamIframe = await renderAsIframe(
                    state.displayedContent,
                    state.domElement,
                    state.rawContent || "",
                    { mvuVariables: state.mvuVariables || {} },
                  );
                  if (!state.domElement?.isConnected) continue;
                }
              }

              // 显示内容区域
              if (state.displayedContent.trim()) {
                const skeletonEl =
                  state.domElement.querySelector(".skeleton-loader");
                if (skeletonEl) skeletonEl.classList.add("hidden");
                const contentEl =
                  state.domElement.querySelector(".message-content");
                if (contentEl) contentEl.classList.remove("hidden");
              }
              continue;
            }
          }

          // ★ T10 渲染双管线对齐：宏替换前置（对齐落稿 messageList.mjs:988 replaceMacros 在 extractThinkingContent:991 之前）。
          //   幂等（无 `{{` O(1) 跳过）+ 极低成本；否则流式期 {{char}}/{{user}} 裸露，流结束跳变。
          const macroApplied = state.message
            ? replaceMacros(state.displayedContent, state.message)
            : state.displayedContent;

          // ★ 提取思维链内容到独立 UI 组件
          const { cleanText, thinkingText, isComplete, hasBeiluThinking, hasOtherReasoning } = extractThinkingContent(
            macroApplied,
          );

          // 1. 更新思维链区域（纯文本，不走 markdown，零开销）
          const thinkingEl = state.domElement.querySelector(".thinking-toggle");
          if (thinkingEl) {
            if (thinkingText) {
              thinkingEl.classList.remove("hidden");
              const labelEl = thinkingEl.querySelector(".thinking-toggle-label");
              if (labelEl) {
                // 图标由模板 .thinking-toggle-label 前的 data-ic 或此处 innerHTML 提供
                labelEl.innerHTML = isComplete
                  ? '<i data-ic="thought"></i> 思考了一会'
                  : '<i data-ic="thought"></i> 正在思考中...';
              }
              const thinkContentEl = thinkingEl.querySelector(
                ".thinking-toggle-content",
              );
              if (thinkContentEl) thinkContentEl.textContent = thinkingText;
              // [2026-08-10] badge 与真实 AI 可见性一致（流式与落稿 messageList 同口径）
              applyThinkingVisibilityBadge(thinkingEl, { hasBeiluThinking, hasOtherReasoning });

              // 流式阶段绑定折叠事件（仅绑定一次）
              if (!thinkingEl.dataset.bound) {
                thinkingEl.dataset.bound = "1";
                const toggleBtn = thinkingEl.querySelector(
                  ".thinking-toggle-btn",
                );
                if (toggleBtn) {
                  toggleBtn.addEventListener("click", () => {
                    const cd = thinkingEl.querySelector(
                      ".thinking-toggle-content",
                    );
                    const iconEl = thinkingEl.querySelector(
                      ".thinking-toggle-icon",
                    );
                    const isHidden = cd.classList.toggle("hidden");
                    if (iconEl) iconEl.textContent = isHidden ? "▶" : "▼";
                  });
                }
              }
            } else {
              thinkingEl.classList.add("hidden");
            }
          }

          // 2. 更新消息正文（只渲染剥离思维链后的内容）
          const contentEl = state.domElement.querySelector(".message-content");
          if (contentEl) {
            wbTrace("streamRender", "renderFrame.markdown", { id, cleanLen: cleanText?.length, hasThinking: !!thinkingText });

            // ★ T10 渲染双管线对齐：流式 markdown 正文补齐落稿同序加工，消除「流式裸露→落稿跳变」。
            //   顺序严格对齐落稿 messageList.mjs：状态栏剥标签(:1078) → 代码折叠(:1114) → 用户正则(:1121) → markdown → restorePlaceholders(:1224)。
            //   全部复用 displayRegex/messageList 的同一 export 实现（禁复制第二份）；每帧对全量文本重跑，加工幂等，
            //   已过 80ms 节流（每 80ms 最多一次），成本受控。留落稿的项（IDE卡/K4世界书注入/mixed分段/状态栏iframe注入）不在此接入。
            const statusStripped = extractStatusPlaceholder(cleanText).cleanText;
            const builtinProcessed = applyBuiltinProcessors(statusStripped);
            const { text: displayProcessed, placeholders } = applyDisplayRules(
              builtinProcessed,
              { role: state.role, charName: state.charName, messageDepth: state.messageDepth },
            );
            // [0805 流式性能] 流式期纯文本渲染（零开销），落稿时完整 markdown 渲染。
            //   流式每帧 markdown+正则+morphdom 全文加工是前端卡顿主源（长回复 CPU ~5-50ms/帧）；
            //   改为流式期 textContent 直赋（<1ms），最终排版由 message_replaced →
            //   replaceItem → messageList.renderMessage 落稿管线完成（权威渲染，本处 else 分支为
            //   register 时已 is_generating=false 的补渲染兜底）。
            //   is_generating 从 register 时传入的 message 对象获取（virtualQueue.mjs 两条注册路径均传 message）。
            const isGenerating = state.message?.is_generating !== false;
            if (isGenerating) {
              // 流式期：纯文本 textContent 赋值，跳过 markdown/正则/morphdom
              contentEl.textContent = displayProcessed;
            } else {
              // 落稿：完整 markdown 渲染 + morphdom diff
              let newHtml = await renderMarkdownAsString(
                displayProcessed,
                state.cache,
              );
              if (placeholders.size > 0) {
                newHtml = restorePlaceholders(newHtml, placeholders);
              }
              // ★ FT4 §2.1：morphdom 增量 diff（childrenOnly + 富节点白名单），
              //   替代每帧整段 innerHTML 重绘（销毁重建代码块/MathJax/选区/折叠态）。
              //   morphdom 未加载（首帧无子节点 / vendor 加载失败）或抛错时，回退整段
              //   innerHTML——保证流式不白屏（凛倾红线：回退分支必须保留）。
              if (window.morphdom && contentEl.childNodes.length) {
                try {
                  const tmp = document.createElement("div");
                  tmp.innerHTML = newHtml;
                  window.morphdom(contentEl, tmp, {
                    childrenOnly: true,
                    onBeforeElUpdated: protectRichNode,
                  });
                  wbDetect("streamRender", "morphdom", true, undefined, { id });
                } catch (morphErr) {
                  // morphdom 失败 → 降级整段重绘，绝不白屏
                  contentEl.innerHTML = newHtml;
                  wbDetect("streamRender", "morphdom", false, morphErr?.message, { id });
                }
              } else {
                // 首帧 / morphdom 未加载 → 整段渲染（与原行为一致）
                contentEl.innerHTML = newHtml;
              }
            }

            if (cleanText.trim()) {
              const skeletonEl =
                state.domElement.querySelector(".skeleton-loader");
              if (skeletonEl) skeletonEl.classList.add("hidden");
              contentEl.classList.remove("hidden");
            }
          }

          state.lastRendered = state.displayedContent;
          state.lastRenderTime = now;
        }
      } catch (err) {
        console.error('[StreamRenderer] renderFrame error for message', id, err);
        wbDetect("streamRender", "renderFrame", false, err?.message, { id, stack: err?.stack });
        window._reportError?.(`[StreamRenderer] renderFrame: ${err.message}`, err.stack);
      }
    }
  }
}

// [0727 多窗口] 这里原本 `export const streamRenderer = new StreamRenderer()` 单例 +
//   `window._beiluHasActiveStream` 桥。实例改由 virtualQueue._W() 每窗口持有一份（见类头 why），
//   桥也随之搬到 virtualQueue——「当前窗口有没有在生成」只有持有窗口表的那一层知道，
//   本模块看不到窗口维度。单 producer：全项目只有 virtualQueue.mjs 写这个 window 键。
