// monitorSlot.mjs — 设置面板·后台监控增强 slot（自 settingsSlots.mjs 拆出，2026-08-03，内容逐字搬迁）
// 注：timeSince 为死函数（原文件即无调用点，utils.mjs:207 注释点名各留原地），原样保留。
import { escapeHtml, copyWithFeedback } from "../../../shared/state/utils.mjs";
import { sendAction } from "../../../shared/transport/sendAction.mjs";
import { storage, KEYS } from "../../../shared/state/storage.mjs";
import { beiluConfirm } from "../../../shared/widgets/beiluDialog.mjs";
import { getWhiteboxRing, setWhiteboxEnabled } from "../../../shared/widgets/whitebox.mjs";
import { classifyPartLoadStatus } from "../../../shared/state/partLoadStatus.mjs";
import diagControl from "../../../shared/state/diagLogger.mjs";

// ============================================================
// 后台监控增强 (W63新增: beilu-logger + 前端诊断)
// ============================================================

export async function initMonitorSlot() {
  const logOutput = document.getElementById("settings-monitor-log");
  const errOutput = document.getElementById("settings-monitor-errors");
  const statusOutput = document.getElementById("settings-monitor-status");
  const clearBtn = document.getElementById("settings-monitor-clear-log");
  if (!logOutput) return;
  // 幂等：initSettingsSlots 只调一次，但防御性挡重入（避免重复注册监听/MutationObserver）
  if (logOutput.dataset.monInit === "1") return;
  logOutput.dataset.monInit = "1";

  let autoRefreshTimer = null;
  let currentLevel = 'all';
  let currentErrSource = 'all'; // 错误追踪块来源过滤：all/frontend/server
  // 异步竞态防护：每次 fetchLogs 自增 token，旧响应回来时若 token 已过期则丢弃，
  // 防止「慢的旧请求」覆盖「快的新请求」结果（凛倾点名注意异步）。
  let _fetchSeq = 0;

  // Replace log area with enhanced UI
  const logParent = logOutput.parentElement;
  // Add controls before the log output
  const controls = document.createElement('div');
  controls.className = 'flex items-center gap-1 mb-1 flex-wrap';
  controls.innerHTML = `
    <button class="btn btn-xs mon-filter active" data-level="all" style="background:oklch(var(--b2))">全部</button>
    <button class="btn btn-xs btn-ghost mon-filter" data-level="error"><i data-ic="cross"></i> 错误</button>
    <button class="btn btn-xs btn-ghost mon-filter" data-level="warn"><i data-ic="warning"></i> 警告</button>
    <label class="flex items-center gap-1 ml-auto cursor-pointer">
      <input type="checkbox" id="mon-auto-refresh" class="checkbox checkbox-xs" />
      <span class="text-[10px]">自动刷新</span>
    </label>
    <button id="mon-copy-log" class="btn btn-xs btn-ghost" title="复制日志">📋</button>
  `;
  logParent.insertBefore(controls, logOutput);

  // ── 错误追踪块控制条（来源过滤 / console.error 桥接开关 / 导出）──
  // errOutput 容器结构：div.bg-base-300/50 > [<p>⚠️ 错误追踪</p>, #settings-monitor-errors]
  // 控制条插在标题 <p> 之后、错误列表 errOutput 之前。
  if (errOutput) {
    const errParent = errOutput.parentElement;
    const errControls = document.createElement('div');
    errControls.className = 'flex items-center gap-1 mb-1 flex-wrap';
    const bridgeOn = (() => { try { return storage.get(KEYS.BEILU_CONSOLE_ERROR_BRIDGE) === '1'; } catch { return false; } })();
    errControls.innerHTML = `
      <button class="btn btn-xs err-src active" data-src="all" style="background:oklch(var(--b2))">全部</button>
      <button class="btn btn-xs btn-ghost err-src" data-src="frontend">前端</button>
      <button class="btn btn-xs btn-ghost err-src" data-src="server">后端</button>
      <label class="flex items-center gap-1 ml-auto cursor-pointer" title="开启后 console.error 也会镜像上报到错误缓冲（默认关，避免噪音）">
        <input type="checkbox" id="err-console-bridge" class="checkbox checkbox-xs" ${bridgeOn ? 'checked' : ''} />
        <span class="text-[10px]">桥接 console.error</span>
      </label>
      <button id="err-export" class="btn btn-xs btn-ghost" title="导出错误报告 (JSON)"><i data-ic="upload"></i></button>
    `;
    errParent.insertBefore(errControls, errOutput);

    // 来源过滤
    errControls.querySelectorAll('.err-src').forEach(btn => {
      btn.addEventListener('click', () => {
        errControls.querySelectorAll('.err-src').forEach(b => { b.classList.add('btn-ghost'); b.style.background = ''; });
        btn.classList.remove('btn-ghost');
        btn.style.background = 'oklch(var(--b2))';
        currentErrSource = btn.dataset.src;
        fetchLogs();
      });
    });

    // console.error 桥接开关（持久化 + 调用 base.mjs 安装的 window._setConsoleErrorBridge）
    errControls.querySelector('#err-console-bridge')?.addEventListener('change', (e) => {
      const on = !!e.target.checked;
      try { storage.set(KEYS.BEILU_CONSOLE_ERROR_BRIDGE, on ? '1' : '0'); } catch {}
      if (typeof window._setConsoleErrorBridge === 'function') window._setConsoleErrorBridge(on);
    });

    // 导出错误报告：独立 fetch，不共享自动刷新的 _fetchSeq（凛倾点名注意并发）。
    // 纯本地 Blob 下载，零联网。拉全量（limit=1000，后端上限）+ 当前诊断元信息。
    errControls.querySelector('#err-export')?.addEventListener('click', async () => {
      const btn = errControls.querySelector('#err-export');
      const orig = btn.textContent;
      btn.disabled = true; btn.textContent = '⏳';
      try {
        // T2批23：读路走 sendAction（getErrors，notify:"report"）。sendAction 非 2xx 自动 throw，
        //   故用 try 给 errors 失败占位（导出仍产出，与原 res.ok?...:{error,entries:[]} 降级同义）。
        // 导出去重：dedupe=1 → 后端同指纹（message+stack首行）折叠为一条，附 count/firstSeen/lastSeen；
        //   rawTotal 保留折叠前原始条数。面板列表路径（fetchLogs）不带 dedupe，行为不变。
        let data;
        try { data = await sendAction({ verb: "getErrors", target: "server:monitor", source: "web", payload: { limit: 1000, dedupe: true } }); }
        catch (e) { data = { error: e?.message || String(e), entries: [] }; }
        let health = null;
        try { health = await sendAction({ verb: "getHealth", target: "server:monitor", source: "web" }); } catch {}
        const report = {
          _type: 'beilu-error-report', _version: 2,
          meta: {
            timestamp: new Date().toISOString(),
            userAgent: navigator.userAgent,
            url: location.href,
            viewport: `${innerWidth}x${innerHeight}`,
            deduped: true,
            consoleErrorBridge: (() => { try { return storage.get(KEYS.BEILU_CONSOLE_ERROR_BRIDGE) === '1'; } catch { return false; } })(),
          },
          health,
          total: data.total ?? (data.entries ? data.entries.length : 0),
          rawTotal: data.rawTotal ?? null,
          entries: data.entries || [],
        };
        const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `beilu-errors-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        btn.textContent = '✅'; setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
      } catch (err) {
        btn.textContent = '❌'; setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
      }
    });
  }

  // W63: 前端诊断模块开关
  const DIAG_MODULES = ['template','displayRegex','messageList','streamRenderer','virtualQueue','websocket','iframeRenderer','stCompat','sidebar','fileExplorer','layout','config','api','dom','perf'];
  const diagSection = document.createElement('div');
  diagSection.className = 'bg-base-300/50 rounded-lg p-2 space-y-1 mt-2';
  diagSection.innerHTML = `
    <div class="flex items-center justify-between mb-1">
      <p class="text-xs font-medium" style="color:var(--beilu-amber)"><i data-ic="wrench"></i> 前端诊断模块</p>
      <div class="flex gap-1">
        <button id="diag-enable-all" class="btn btn-xs btn-ghost">全开</button>
        <button id="diag-disable-all" class="btn btn-xs btn-ghost">全关</button>
        <button id="diag-export" class="btn btn-xs btn-ghost" title="导出全量诊断报告（运行时日志+错误追踪+系统状态+白盒线路追踪）"><i data-ic="upload"></i></button>
      </div>
    </div>
    <div class="flex flex-wrap gap-1" id="diag-module-btns">
      ${DIAG_MODULES.map(m => {
        const active = (storage.get(KEYS.BEILU_DIAG_MODULES) || '').includes(m);
        return `<button class="btn btn-xs ${active ? 'btn-warning' : 'btn-ghost'} diag-mod" data-mod="${m}">${m}</button>`;
      }).join('')}
    </div>
    <div class="flex items-center gap-2 mt-1">
      <span class="text-[10px] opacity-60">日志级别</span>
      <select id="diag-level-sel" class="select select-xs select-bordered w-24">
        <option value="info" ${(storage.get(KEYS.BEILU_DIAG_LEVEL)||'info')==='info'?'selected':''}>info</option>
        <option value="debug" ${storage.get(KEYS.BEILU_DIAG_LEVEL)==='debug'?'selected':''}>debug</option>
        <option value="warn" ${storage.get(KEYS.BEILU_DIAG_LEVEL)==='warn'?'selected':''}>warn</option>
        <option value="error" ${storage.get(KEYS.BEILU_DIAG_LEVEL)==='error'?'selected':''}>error</option>
      </select>
      <label class="flex items-center gap-1 ml-auto cursor-pointer" title="白盒线路追踪总开关（前后端，默认开）。与上面的诊断模块是两套：诊断模块控 console 日志，白盒控 wbTrace 线路环。">
        <input type="checkbox" id="diag-whitebox-toggle" class="checkbox checkbox-xs" ${(()=>{try{return storage.get(KEYS.BEILU_WHITEBOX_ENABLED)!=='0';}catch{return true;}})()?'checked':''} />
        <span class="text-[10px]">白盒线路追踪</span>
      </label>
    </div>
  `;
  logParent.parentElement.appendChild(diagSection);

  // Module toggle
  diagSection.querySelectorAll('.diag-mod').forEach(btn => {
    btn.addEventListener('click', () => {
      const mod = btn.dataset.mod;
      let mods = (storage.get(KEYS.BEILU_DIAG_MODULES) || '').split(',').filter(Boolean);
      if (mods.includes(mod)) { mods = mods.filter(m => m !== mod); btn.classList.replace('btn-warning','btn-ghost'); }
      else { mods.push(mod); btn.classList.replace('btn-ghost','btn-warning'); }
      storage.set(KEYS.BEILU_DIAG_MODULES, mods.join(','));
    });
  });
  // Enable/disable all
  diagSection.querySelector('#diag-enable-all')?.addEventListener('click', () => {
    storage.set(KEYS.BEILU_DIAG_MODULES, '*');
    diagSection.querySelectorAll('.diag-mod').forEach(b => { b.classList.remove('btn-ghost'); b.classList.add('btn-warning'); });
  });
  diagSection.querySelector('#diag-disable-all')?.addEventListener('click', () => {
    storage.remove(KEYS.BEILU_DIAG_MODULES);
    diagSection.querySelectorAll('.diag-mod').forEach(b => { b.classList.remove('btn-warning'); b.classList.add('btn-ghost'); });
  });
  // Level
  diagSection.querySelector('#diag-level-sel')?.addEventListener('change', (e) => {
    storage.set(KEYS.BEILU_DIAG_LEVEL, e.target.value);
  });
  // 白盒线路追踪总开关（断点②修复）：前端 setWhiteboxEnabled + 后端 POST toggle，持久化。
  // 启动时按持久化恢复（默认开；仅显式存 '0' 才关）。
  const wbToggle = diagSection.querySelector('#diag-whitebox-toggle');
  const applyWhitebox = (on, persist) => {
    try { setWhiteboxEnabled(on); } catch {}
    if (persist) { try { storage.set(KEYS.BEILU_WHITEBOX_ENABLED, on ? '1' : '0'); } catch {} }
    // T2批23：交互写按钮 → toggleWhitebox（缺省 toast，失败让用户可见没生效）。.catch 吞 rethrow（本地态已由
    //   setWhiteboxEnabled/持久化落地，后端同步失败不回滚前端）；toast 由 sendAction _report 缺省档负责弹出。
    sendAction({ verb: "toggleWhitebox", target: "server:monitor", source: "web", payload: { enabled: on } }).catch(() => {});
  };
  wbToggle?.addEventListener('change', (e) => applyWhitebox(!!e.target.checked, true));
  // 启动恢复：仅当持久化为 '0' 时主动关（避免每次进设置面板都向后端发无谓请求，默认开不发）
  try { if (storage.get(KEYS.BEILU_WHITEBOX_ENABLED) === '0') applyWhitebox(false, false); } catch {}
  // 全量诊断导出：单按钮汇总本面板全部可观测 —— 运行时日志 + 错误追踪 + 系统状态(health)
  // + 前端诊断配置 + 白盒线路追踪环(getWhiteboxRing，此前无任何导出口，含前端执行点 + 后端广播 wb_trace)
  // + 前端 console 缓冲/状态快照(diagControl.getLogBuffer/getSnapshotBuffer，此前仅控制台 beiluDiag.pack() 可达，面板导出漏接)。
  // 纯本地 Blob 下载，四个 fetch 并发独立(不共享 fetchLogs 的 _fetchSeq)，任一失败降级不阻断其余。
  // 导出去重（三处重复源，各在权威侧折叠）：
  //   ① errors → 后端 dedupe=1 同指纹折叠（monitor.mjs，附 count/firstSeen/lastSeen）
  //   ② loggerLogs ↔ errors 跨源重复（beilu-logger 与 monitor 双拦 console.error/warn）→
  //      errors 为权威（含 module/stack/source 结构化），loggerLogs 剔除与 errors console 域同 level+message 的条目
  //   ③ 白盒双环：前端环含后端广播(side:"be")，后端 RING 为权威全量 → 后端环拉取成功时前端环只导 side:"fe"，
  //      拉取失败时保留整环兜底；前端 console 缓冲中 "[wb:" 行已结构化在环里，导出时剔除
  const _foldLogs = (entries, msgOf, tsOf) => {
    // 同 level+message 折叠为一条（保留首见实体 + count/firstSeen/lastSeen），导出专用，不动缓冲本体
    const map = new Map();
    for (const e of entries) {
      const key = `${e.level}|${msgOf(e)}`;
      const cur = map.get(key);
      const ts = tsOf(e);
      if (cur) { cur.count++; cur.lastSeen = ts; }
      else map.set(key, { ...e, count: 1, firstSeen: ts, lastSeen: ts });
    }
    return Array.from(map.values());
  };
  diagSection.querySelector('#diag-export')?.addEventListener('click', async () => {
    const btn = diagSection.querySelector('#diag-export');
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = '⏳';
    try {
      // T2批23：四路读全走 sendAction（notify:"report"，失败进后端报错系统不弹 toast）。
      //   Promise.allSettled 结构保留——sendAction 非 2xx reject，pick(r) 取 null 降级（与原 r.ok?json:null 同义）。
      const [logsR, errsR, healthR, wbBeR] = await Promise.allSettled([
        sendAction({ verb: "getLogs", target: "plugins:beilu-logger", source: "web", payload: { level: "all", limit: 500 } }),
        sendAction({ verb: "getErrors", target: "server:monitor", source: "web", payload: { limit: 1000, dedupe: true } }),
        sendAction({ verb: "getHealth", target: "server:monitor", source: "web" }),
        sendAction({ verb: "getWhitebox", target: "server:monitor", source: "web" }),
      ]);
      const pick = (r) => (r.status === 'fulfilled' ? r.value : null);
      let wbRing = [];
      try { wbRing = getWhiteboxRing(); } catch {}
      const wbBe = pick(wbBeR);
      const errData = pick(errsR);
      // ③ 白盒去重：后端权威环在手 → 前端环只留本端执行点（side:"fe"）
      const wbFeRing = (wbBe && Array.isArray(wbBe.ring)) ? wbRing.filter(e => e.side === 'fe') : wbRing;
      // ② 跨源去重：errors console 域（后端 installConsoleHook 产物）的 level+message 集合
      const errConsoleKeys = new Set((errData?.entries || []).filter(e => e.module === 'console').map(e => `${e.level}|${e.message}`));
      const loggerData = pick(logsR);
      const loggerLogsDeduped = loggerData ? {
        ...loggerData,
        logs: _foldLogs((loggerData.logs || []).filter(l => !errConsoleKeys.has(`${l.level}|${l.message}`)), l => l.message, l => l.time),
      } : null;
      // 前端 console 缓冲：剔除 "[wb:" 行（已结构化在 whiteboxRing）后同信息折叠；快照原样（结构化数据无重复语义）
      let feConsoleLogs = [];
      let feSnapshots = [];
      try {
        feConsoleLogs = _foldLogs(
          diagControl.getLogBuffer(500).filter(e => !String(e.msg || '').startsWith('[wb:')),
          e => e.msg, e => new Date(e.t).toISOString());
        feSnapshots = diagControl.getSnapshotBuffer(200);
      } catch {}
      const report = {
        _type: 'beilu-diag-report', _version: 4,
        meta: {
          timestamp: new Date().toISOString(),
          userAgent: navigator.userAgent,
          url: location.href,
          viewport: `${innerWidth}x${innerHeight}`,
          deduped: true,
          consoleErrorBridge: (() => { try { return storage.get(KEYS.BEILU_CONSOLE_ERROR_BRIDGE) === '1'; } catch { return false; } })(),
        },
        frontend: {
          diagModules: storage.get(KEYS.BEILU_DIAG_MODULES),
          diagLevel: storage.get(KEYS.BEILU_DIAG_LEVEL),
          theme: storage.get(KEYS.THEME),
          consoleLogs: feConsoleLogs,     // ← 前端 console 拦截缓冲（diagLogger，去 wb 行 + 同信息折叠）
          snapshots: feSnapshots,         // ← 前端状态快照（diag.snapshot 产物）
          whiteboxRing: wbFeRing,         // ← 白盒线路追踪环（后端环拉取成功时仅 side:"fe"，失败时整环兜底）
          whiteboxRingCount: wbFeRing.length,
        },
        backend: {
          loggerLogs: loggerLogsDeduped,  // ← 已剔除与 errors console 域重复 + 同信息折叠
          errors: errData ? { total: errData.total ?? (errData.entries?.length || 0), rawTotal: errData.rawTotal ?? null, entries: errData.entries || [] } : null,
          health: pick(healthR),
          whiteboxRing: wbBe ? wbBe.ring : null,        // ← 后端 RING 权威全量（含回合外 chatid=null 线路）
          whiteboxRingCount: wbBe ? wbBe.total : null,
        },
      };
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `beilu-diag-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      btn.textContent = '✅'; setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
    } catch (err) {
      btn.textContent = '❌'; setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
    }
  });

  // 单源复用既有检测代码（不另造采集器）：
  //   · 运行时日志 ← beilu-logger 插件环形缓冲（plugins:beilu-logger/logs，main.mjs 拦截后端 console.error/warn）
  //   · 错误追踪   ← server/monitor.mjs 权威错误缓冲（/api/v1/monitor/errors）。该缓冲已聚合：
  //                 后端 console（installConsoleHook, monitor.mjs:72）+ 前端运行时错误（base.mjs:8 _reportError
  //                 → /api/v1/monitor/errors/report，source:"frontend"）+ 路由异常（asyncHandler）。
  //                 含 module/source/stack 结构化信息，故此处渲染真实条目，不再只显示计数。
  //   · 系统状态   ← /api/v1/monitor/health 真实 uptime/memory/最近5分钟错误数（取代写死的「● 运行中」）。
  // 三个 fetch 并发；用 _fetchSeq token 丢弃过期响应。authenticate 经同源 cookie 通过
  // （与 backendMonitor.mjs:283 同源调用 /api/v1/monitor/plugins 一致）。
  const fetchLogs = async () => {
    const seq = ++_fetchSeq;
    const stale = () => seq !== _fetchSeq; // 有更新请求发出后，本次结果作废
    // ── 运行时日志（beilu-logger）──
    try {
      // T2批23：走 getLogs（notify:"report"，轮询读路失败不弹 toast 进报错系统）。sendAction 直返 body（非 2xx 自动 throw 进本 catch）。
      const data = await sendAction({ verb: "getLogs", target: "plugins:beilu-logger", source: "web", payload: { level: currentLevel, limit: 200 } });
      if (stale()) return;
      const logs = data.logs || [];
      if (logs.length === 0) {
        logOutput.innerHTML = '<p class="text-base-content/50 text-center py-2">暂无日志</p>';
      } else {
        logOutput.innerHTML = logs.map(l => {
          const icon = l.level === 'error' ? '<i data-ic="cross"></i>' : l.level === 'warn' ? '<i data-ic="warning"></i>' : '<i data-ic="edit"></i>';
          const time = l.time ? new Date(l.time).toLocaleTimeString('zh-CN') : '';
          const color = l.level === 'error' ? 'text-error' : l.level === 'warn' ? 'text-warning' : '';
          return `<div class="${color}">${icon} <span class="opacity-40">${time}</span> ${escapeHtml(l.message || '')}</div>`;
        }).join('');
        logOutput.scrollTop = logOutput.scrollHeight;
      }
    } catch (e) {
      if (!stale()) logOutput.innerHTML = `<p class="text-error text-center py-2">日志加载失败: ${e.message}</p>`;
    }

    // ── 错误追踪（server/monitor.mjs 权威缓冲，含前端上报错误）──
    if (errOutput) {
      try {
        // 来源过滤经后端 source 参数（monitor.mjs /errors 支持 source）。limit=200 给详情列表更全的历史。
        // T2批23：走 getErrors（notify:"report"），source 缺省不带（'all' 不设 query）。
        const _src = (currentErrSource && currentErrSource !== 'all') ? currentErrSource : undefined;
        const data = await sendAction({ verb: "getErrors", target: "server:monitor", source: "web", payload: { limit: 200, ...(_src ? { source: _src } : {}) } });
        if (stale()) return;
        const entries = data.entries || []; // 已 reverse（最新在前），每条附 count/firstSeen（monitor.mjs 查询边界聚合）
        if (entries.length === 0) {
          // 空态引导文案（凛倾：优化用户前端体验）
          errOutput.innerHTML = '<p class="text-base-content/50 text-center py-2 leading-relaxed">无错误记录。<br/>前端未捕获异常会自动上报；console.error 桥接可在上方开启。</p>';
        } else {
          const errN = entries.filter(e => e.level === 'error').length;
          const warnN = entries.filter(e => e.level === 'warn').length;
          const head = `<div class="text-xs opacity-60 mb-1"><i data-ic="cross"></i> ${errN} · <i data-ic="warning"></i> ${warnN} · 共 ${data.total ?? entries.length} 条 · 点击展开详情</div>`;
          const rows = entries.map(en => renderErrorRow(en)).join('');
          errOutput.innerHTML = head + rows;
        }
      } catch (e) {
        if (!stale()) errOutput.innerHTML = `<p class="text-warning text-center py-2">错误数据不可用: ${escapeHtml(e.message)}</p>`;
      }
    }

    // ── 系统状态（/api/v1/monitor/health 真实数据）──
    if (statusOutput) {
      try {
        // T2批23：走 getHealth（notify:"report"）。sendAction 直返 body（非 2xx 自动 throw 进本 catch 降级）。
        const h = await sendAction({ verb: "getHealth", target: "server:monitor", source: "web" });
        if (stale()) return;
        const ok = h.status === 'ok';
        const statusColor = ok ? 'text-success' : 'text-warning';
        const statusText = ok ? '● 运行中' : '▲ ' + (h.status || '降级');
        const uptimeStr = Number.isFinite(h.uptime) ? fmtUptime(h.uptime) : 'N/A';
        const mem = h.memory || {};
        const last5 = h.errors ? (h.errors.last5min || 0) : 0;
        statusOutput.innerHTML = `
          <div class="flex items-center justify-between">
            <span class="text-base-content/60">服务状态</span>
            <span class="${statusColor} text-[10px]">${statusText}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-base-content/60">运行时间</span>
            <span class="text-[10px]">${uptimeStr}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-base-content/60">内存 (heap/rss)</span>
            <span class="text-[10px]">${mem.heapUsedMB || '?'} / ${mem.rssMB || '?'} MB</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-base-content/60">近5分钟错误</span>
            <span class="text-[10px] ${last5 > 0 ? 'text-error' : ''}">${last5}</span>
          </div>
        `;
      } catch (e) {
        // health 拉取失败（未登录/端点异常）：状态块降级显示，不影响日志/错误块
        if (!stale()) statusOutput.innerHTML = `<div class="text-warning text-[10px]">状态不可用: ${escapeHtml(e.message)}</div>`;
      }
    }
  };

  // Level filter
  controls.querySelectorAll('.mon-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      controls.querySelectorAll('.mon-filter').forEach(b => { b.classList.add('btn-ghost'); b.style.background = ''; });
      btn.classList.remove('btn-ghost');
      btn.style.background = 'oklch(var(--b2))';
      currentLevel = btn.dataset.level;
      fetchLogs();
    });
  });

  // Auto refresh —— 异步生命周期收口（凛倾点名注意异步）
  //   · 单一 timer，startAuto/stopAuto 配对，绝不并行多个 interval；
  //   · timer 仅在「勾选 且 section 可见」时存在；
  //   · MutationObserver 监听 monitor section 的 .hidden（切走 section / 关设置弹窗都会加 .hidden），
  //     隐藏即 stopAuto（立即停，不等下个 tick），重新可见且仍勾选则 startAuto。
  const autoCb = controls.querySelector('#mon-auto-refresh');
  // monitor section 容器（index.html: div.settings-section[data-section="monitor"]）
  const monSection = logOutput.closest('.settings-section') || document.querySelector('.settings-section[data-section="monitor"]');
  const isVisible = () => !!(logOutput.offsetParent); // 隐藏(.hidden/display:none)时为 null
  const refreshAll = () => { fetchLogs(); fetchPluginStatus(); };
  const startAuto = () => {
    if (autoRefreshTimer) return;            // 防重入：已存在不再起第二个
    autoRefreshTimer = setInterval(refreshAll, 5000);
  };
  const stopAuto = () => {
    if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
  };
  autoCb?.addEventListener('change', (e) => {
    if (e.target.checked && isVisible()) startAuto();
    else stopAuto();
  });
  if (monSection) {
    const monObs = new MutationObserver(() => {
      const visible = isVisible();
      if (visible) {
        fetchLogs(); fetchPluginStatus();     // 重新进入面板：立即刷新一次拿最新
        if (autoCb?.checked) startAuto();     // 仍勾选则恢复自动刷新
      } else {
        stopAuto();                           // 隐藏/关弹窗：立即停 timer（异步泄漏收口）
      }
    });
    monObs.observe(monSection, { attributes: true, attributeFilter: ['class', 'style'] });
  }

  // Copy
  controls.querySelector('#mon-copy-log')?.addEventListener('click', () => {
    copyWithFeedback(logOutput.innerText, controls.querySelector('#mon-copy-log'), '✅');
  });

  // Clear
  clearBtn?.addEventListener('click', async () => {
    if (!await beiluConfirm('清空所有日志？')) return;
    try {
      // T2批23：交互写按钮 → clearLogs（缺省 toast，失败让用户可见）。
      await sendAction({ verb: "clearLogs", target: "plugins:beilu-logger", source: "web" });
      fetchLogs();
    } catch {}
  });

  // ── 插件加载状态（拉线自 /api/v1/monitor/plugins，此前仅 IDE 面板有） ──
  const pluginsOutput = document.getElementById("settings-monitor-plugins");
  const pluginRefreshBtn = document.getElementById("settings-monitor-refresh-plugins");

  const fetchPluginStatus = async () => {
    if (!pluginsOutput) return;
    try {
      // P1-2（一致性审计②双通道）：apiFetch 直连 → 既有 verb server:monitor#getPlugins（sendAction.mjs:460）；
      //   !ok 由门面抛错落下方 catch（原 !ok 分支的状态码文案并入 e.message，诊断面不丢）
      const data = await sendAction({ verb: "getPlugins", target: "server:monitor", source: "web" });
      const plugins = data?.plugins || {};
      const entries = Object.entries(plugins);
      if (entries.length === 0) {
        pluginsOutput.innerHTML = '<p class="text-base-content/50 text-center py-1">无已注册插件</p>';
        return;
      }
      // 按状态排序：错误在上
      entries.sort(([, a], [, b]) => {
        const ae = classifyPartLoadStatus(a?.status) === "failure" ? 0 : 1;
        const be = classifyPartLoadStatus(b?.status) === "failure" ? 0 : 1;
        return ae - be;
      });
      pluginsOutput.innerHTML = entries.map(([name, info]) => {
        const kind = classifyPartLoadStatus(info?.status);
        const color = kind === "failure" ? "text-error" : kind === "success" ? "text-success" : "";
        const icon = kind === "failure" ? '<i data-ic="cross"></i>' : kind === "success" ? '<i data-ic="check"></i>' : kind === "pending" ? '<i data-ic="hourglass"></i>' : "◻️";
        const detail = info.detail
          ? (typeof info.detail === "string" ? info.detail : JSON.stringify(info.detail))
          : "";
        const time = info.lastUpdate ? new Date(info.lastUpdate).toLocaleTimeString("zh-CN") : "";
        return `<div class="${color} flex items-start gap-1"><span>${icon}</span><span class="flex-1 break-all">${escapeHtml(name)} <span class="opacity-50">[${escapeHtml(info.status)}]</span>${detail ? " " + escapeHtml(detail.slice(0, 120)) : ""}</span><span class="opacity-40 shrink-0">${time}</span></div>`;
      }).join("");
    } catch (e) {
      pluginsOutput.innerHTML = `<p class="text-warning text-center py-1">拉取失败: ${escapeHtml(e.message)}</p>`;
    }
  };

  pluginRefreshBtn?.addEventListener("click", fetchPluginStatus);

  // ── 前端监控设置 ──
  const pollToggle = document.getElementById("mon-poll-toggle");
  const POLL_KEY = KEYS.BEILU_MONITOR_POLL_ENABLED; // T041b: 收编 KEYS 单源（原字面 "beilu-monitor-poll-enabled"，与 backendMonitor 同 key）
  // 恢复持久化状态
  try { if (storage.get(POLL_KEY) === "0") { if (pollToggle) pollToggle.checked = false; } } catch {}

  pollToggle?.addEventListener("change", (e) => {
    try { storage.set(POLL_KEY, e.target.checked ? "1" : "0"); } catch {}
    // 通知 backendMonitor 停/启轮询
    window.dispatchEvent(new CustomEvent("beilu:monitor-poll-toggle", { detail: { enabled: e.target.checked } }));
  });

  // Initial load
  fetchLogs();
  fetchPluginStatus();
}

// 渲染单条错误为可展开详情行（<details>）。
// entry 字段来自 monitor.mjs makeErrorEntry + 查询边界聚合：
//   level/module/route/userId/message/stack/context{url,line,col,userAgent}/source/timestamp/count/firstSeen
function renderErrorRow(en) {
  const icon = en.level === 'error' ? '<i data-ic="cross"></i>' : en.level === 'warn' ? '<i data-ic="warning"></i>' : '<i data-ic="info"></i>';
  const color = en.level === 'error' ? 'text-error' : en.level === 'warn' ? 'text-warning' : '';
  const time = en.timestamp ? new Date(en.timestamp).toLocaleTimeString('zh-CN') : '';
  // source: frontend/server；module: console/route/frontend...（monitor.mjs makeErrorEntry）
  const tag = en.source === 'frontend' ? '前端' : (en.module || 'server');
  const count = (en.count && en.count > 1) ? `<span class="badge badge-xs badge-warning ml-1" title="同错累计出现次数">×${en.count}</span>` : '';
  const ctx = en.context || {};
  // 详情字段（仅渲染存在的，避免一堆「null」噪音）
  const detailRows = [];
  if (en.source) detailRows.push(['来源', en.source]);
  if (en.module) detailRows.push(['模块', en.module]);
  if (en.route) detailRows.push(['路由', en.route]);
  if (en.userId) detailRows.push(['用户', en.userId]);
  if (en.timestamp) detailRows.push(['时间', new Date(en.timestamp).toLocaleString('zh-CN')]);
  if (en.firstSeen && en.firstSeen !== en.timestamp) detailRows.push(['首次', new Date(en.firstSeen).toLocaleString('zh-CN')]);
  if (en.count && en.count > 1) detailRows.push(['累计', `${en.count} 次`]);
  if (ctx.url) detailRows.push(['URL', ctx.url]);
  if (ctx.line != null) detailRows.push(['行:列', `${ctx.line}:${ctx.col ?? '?'}`]);
  if (ctx.userAgent) detailRows.push(['UA', ctx.userAgent]);
  const meta = detailRows.map(([k, v]) =>
    `<div class="flex gap-2"><span class="opacity-40 shrink-0 w-12">${k}</span><span class="break-all">${escapeHtml(String(v))}</span></div>`
  ).join('');
  const stackBlock = en.stack
    ? `<div class="mt-1"><span class="opacity-40">stack</span><pre class="whitespace-pre-wrap break-all mt-0.5 opacity-80 text-[9px] leading-snug">${escapeHtml(en.stack)}</pre></div>`
    : '';
  return `<details class="${color} border-b border-base-content/5">
    <summary class="py-0.5 cursor-pointer list-none flex items-center gap-1">
      <span>${icon}</span><span class="opacity-40">${time}</span><span class="opacity-50">[${escapeHtml(tag)}]</span>
      <span class="truncate flex-1">${escapeHtml(en.message || '')}</span>${count}
    </summary>
    <div class="pl-4 pb-1 pt-0.5 space-y-0.5 text-[9px] text-base-content/70">${meta}${stackBlock}</div>
  </details>`;
}

function timeSince(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}分钟`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}小时${mins % 60}分`;
  return `${Math.floor(hrs / 24)}天${hrs % 24}小时`;
}

// health.uptime 为秒（monitor.mjs /api/v1/monitor/health：Math.floor((now-startTime)/1000)）
function fmtUptime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return `${h}小时${m}分`;
  return `${m}分${sec % 60}秒`;
}
