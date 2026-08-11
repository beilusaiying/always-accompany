/**
 * windowRuntime.mjs — 窗口运行时门面：前台/后台刷新分级的唯一机制（0808 凛倾拍板：
 *   「切换窗口等于换前端；其他没有展示的前端刷新就减少，现在展示的就正常」）。
 *
 * 【功能链】
 *   layout.switchTab 切窗（单点 producer）→ 派发 beilu:window-shown{tab,prevTab}
 *   + 浏览器 document visibilitychange（整页最前/最小化）
 *   → 本模块 createVisibilityPoller 的每个实例重估自己的可见性
 *   → 展示中：interval 正常跑 + 恢复展示瞬间立即补拉一次（脏数据一次补齐）
 *   → 未展示：interval 整个暂停（不是空转 guard——timer 都不醒），只留低频安全重估
 *     （兜住面板内部分段显隐这类没有全局事件的可见性变化）。
 *
 * 【why】
 *   原状是散写：companionChat._visible() / companion._compTabVisible / bot tab 判空 各自手写
 *   guard，且 guard 只挡请求不停 timer（1s/5s/30s 空转常醒）、bot/companion 全文件无 clearInterval
 *   （治理清单 循环08 BUG 类三条的机制根源）。散传不算机制——调度策略收口到本模块单源，
 *   面板只提供自己的可见谓词（它最懂自己的 DOM），启停/补拉/降频统一归这里。
 *
 * 【关联链】
 *   producer：layout.mjs switchTab（beilu:window-shown）+ 浏览器 visibilitychange
 *   消费方：companion.mjs（状态 5s/倒计时 1s）/ companionChat.mjs（3s）/ bot.mjs（30s 角标）/
 *          smart.mjs（5s 审批兜底，启停仍由 _setupSmartPolling 业务开关控制，本模块管可见性维度）
 *
 * 【影响范围】
 *   纯前端调度层；不改任何请求语义与数据链，只改"何时醒来"。新面板轮询一律经本工厂，
 *   禁再手写 setInterval+可见性 guard 组合。
 */

/** 整页是否在前台（浏览器 tab 可见）。 */
export function isDocumentForeground() {
  try { return document.visibilityState !== "hidden"; } catch { return true; }
}

const _SAFETY_RECHECK_MS = 30_000; // 后台安全重估周期：只重估可见性不执行业务 tick（兜面板内部显隐无事件可听）

/**
 * 可见性轮询工厂。
 * @param {object} opts
 * @param {() => void|Promise<void>} opts.tick - 业务刷新函数（工厂不吞语义，异常自行处理或自然冒到 console）
 * @param {number} opts.intervalMs - 前台轮询间隔
 * @param {() => boolean} [opts.visible] - 面板自己的可见谓词（DOM 显隐等）；缺省=恒可见（只受整页前后台控制）
 * @param {boolean} [opts.immediateOnShow=true] - 由不可见转可见时立即补拉一次
 * @param {string} [opts.label] - 诊断标签
 * @returns {{ start: () => void, stop: () => void, kick: () => void }}
 *   start=进入生命周期（幂等）；stop=彻底退出（幂等，clearInterval+卸监听）；kick=无视节流立即 tick 一次
 */
export function createVisibilityPoller({ tick, intervalMs, visible, immediateOnShow = true, label = "" }) {
  let _timer = null;        // 前台业务 interval
  let _safetyTimer = null;  // 后台低频重估 interval
  let _started = false;
  let _wasShown = false;

  const _shown = () => isDocumentForeground() && (typeof visible === "function" ? !!visible() : true);

  const _runTick = () => { try { const r = tick(); if (r && typeof r.catch === "function") r.catch(() => { /* 业务自报，调度层不吞成功假象 */ }); } catch (e) { console.warn(`[windowRuntime] tick 异常(${label}):`, e?.message || e); } };

  const _evaluate = () => {
    if (!_started) return;
    const shown = _shown();
    if (shown && !_timer) {
      // 转前台：起正常节奏 + 补拉（后台期间的变化一次追平）
      if (_safetyTimer) { clearInterval(_safetyTimer); _safetyTimer = null; }
      _timer = setInterval(_runTick, intervalMs);
      if (immediateOnShow && !_wasShown) _runTick();
    } else if (!shown && _timer) {
      // 转后台：业务 timer 真暂停（不空转），留安全重估
      clearInterval(_timer); _timer = null;
      if (!_safetyTimer) { _safetyTimer = setInterval(_evaluate, _SAFETY_RECHECK_MS); _safetyTimer.unref?.(); }
    } else if (!shown && !_safetyTimer) {
      _safetyTimer = setInterval(_evaluate, _SAFETY_RECHECK_MS);
      _safetyTimer.unref?.();
    }
    _wasShown = shown;
  };

  const _onVisibilitySignal = () => _evaluate();

  return {
    start() {
      // start=进入生命周期；此刻若可见即视作一次"转可见"→ 立即补拉（immediateOnShow）。
      // 调用方不要再在 start 前手动先刷一次（会双拉）——初始刷新归工厂。
      if (_started) return;
      _started = true;
      _wasShown = false;
      window.addEventListener("beilu:window-shown", _onVisibilitySignal);
      window.addEventListener("beilu:mode-switched", _onVisibilitySignal); // 面板级显隐多随模式/视图联动；无专属事件的分段面板靠此+30s 安全重估兜住
      document.addEventListener("visibilitychange", _onVisibilitySignal);
      _evaluate();
    },
    stop() {
      if (!_started) return;
      _started = false;
      window.removeEventListener("beilu:window-shown", _onVisibilitySignal);
      window.removeEventListener("beilu:mode-switched", _onVisibilitySignal);
      document.removeEventListener("visibilitychange", _onVisibilitySignal);
      if (_timer) { clearInterval(_timer); _timer = null; }
      if (_safetyTimer) { clearInterval(_safetyTimer); _safetyTimer = null; }
      _wasShown = false;
    },
    kick() { _runTick(); },
  };
}
