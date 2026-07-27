/**
 * proxy/lib/aiConcurrencyGate.mjs — 用户级 AI 并发闸（单点收口，两级优先）
 *
 * why：多窗口 + 分身 + 记忆AI 并发时（凛倾 0727：3窗×5分身=18路同飞实证），出站 AI 请求
 *   没有任何总量限制——上游网关/账号被打满；对单槽型网关（max-proxy 串台事故）并发越密
 *   请求体互换竞态越频。凛倾定的调度语义：①用户可设「同时最多几路 AI 在跑」；
 *   ②本体主对话 > 分身；③超出上限时分身退化成一个一个跑。
 *
 * 机制：per-user 两级信号量（hi=本体/默认，lo=分身/后台）。
 *   - 上限来自用户级 yonban_config.json 的 ai_max_concurrent（后端单源，0/缺省/怪值=不限=
 *     零状态直通，默认行为零变化）。每次 acquire 现读 → 面板改动即时生效，不需重启。
 *   - hi：running < limit 即放行；排队时永远排在 lo 前面被唤醒。
 *   - lo：除总上限外还受「让路规则」——只要有 hi 在跑或在等，lo 全体最多占 1 槽（串行）；
 *     hi 完全空闲时 lo 才可多路占满。上限调小后在场槽位随释放自然收敛。
 *   - 放行/唤醒全在同步块内完成计数（_pump），不存在「减一后新请求插队再加一=超限」竞态。
 *   - 排队等待可被 AbortSignal 打断（用户停止=立刻出队，抛 AbortError 与既有中止语义同族）。
 *
 * 消费方：httpFetch.fetchChatCompletionWithRetry（proxy 生成器全部出站流量的必经点：
 *   主对话 / 分身 / P系记忆AI / 联网AI 全走这里 —— 单点收口，不在各调用方散点接线）。
 *   lo 标记链：replyHandler 分身/delegate 调用点 aiPriority:"low" → runMemoryPresetAI options
 *   → StructCall options → httpFetch options → 本模块。未标记=hi（P1/P8/压缩等主回合前置
 *   不降级，降它=拖慢本体回合本身）。
 * 相交：← storage.getYonbanConfigPath / loadJsonFileIfExists（上限单源）
 *       ← 前端设置面板 API 区（endpoints.mjs ai-concurrency GET/POST → patchYonbanConfig）
 */
import { wbT } from "../../../../../../server/wbStub.mjs";
import { getYonbanConfigPath, loadJsonFileIfExists } from "../../../memory/storage_mod/storage.mjs";

/** @type {Map<string, { runningHi: number, runningLo: number, limit: number, hiQueue: Array<object>, loQueue: Array<object> }>} */
const _users = new Map();

function _readLimit(username) {
  try {
    const n = Number(loadJsonFileIfExists(getYonbanConfigPath(username), {}).ai_max_concurrent);
    return Number.isInteger(n) && n > 0 ? n : 0; // 0/缺省/怪值 = 不限
  } catch {
    return 0; // 配置读失败不阻断生成（容错先自愈）
  }
}

/** lo 级此刻允许的最大在跑数：有 hi 在跑/在等 → 1（分身一个一个）；hi 全空 → 满上限。 */
function _loAllowance(st) {
  return (st.runningHi > 0 || st.hiQueue.length > 0) ? 1 : st.limit;
}

/** 同步放行泵：每次状态变化（释放/入队）后按优先级尽量放行，计数与唤醒同块完成。 */
function _pump(st) {
  for (;;) {
    const total = st.runningHi + st.runningLo;
    if (st.hiQueue.length > 0 && total < st.limit) {
      const item = st.hiQueue.shift();
      st.runningHi++;
      _grant(item);
      continue;
    }
    if (st.loQueue.length > 0 && total < st.limit && st.runningLo < _loAllowance(st)) {
      const item = st.loQueue.shift();
      st.runningLo++;
      _grant(item);
      continue;
    }
    return;
  }
}

function _grant(item) {
  // 先摘 abort 监听再 grant，防「已授予又被 abort 回调出队」半态
  if (item.signal && item.onAbort) item.signal.removeEventListener("abort", item.onAbort);
  item.grant();
}

/**
 * 占一个 AI 运行槽位。上限未设置时零状态直通。
 * @param {string} username - 归属用户（config.username，proxy main.mjs:86 每调用必带）
 * @param {AbortSignal} [signal] - 排队等待期间用户停止 → 抛 AbortError 立刻出队
 * @param {string} [priority] - "low"=分身/后台级（让路+串行），其余=本体级
 * @returns {Promise<() => void>} 释放函数（幂等，finally 里调用）
 */
export async function acquireAiSlot(username, signal, priority) {
  const limit = _readLimit(username);
  if (limit <= 0) return () => {};
  const key = username || "_default";
  let st = _users.get(key);
  if (!st) {
    st = { runningHi: 0, runningLo: 0, limit, hiQueue: [], loQueue: [] };
    _users.set(key, st);
  }
  st.limit = limit; // 每次现读=改动即时生效；在场槽位超新上限时随释放自然收敛
  const isLo = priority === "low";
  const total = st.runningHi + st.runningLo;
  const canRun = isLo
    ? (total < limit && st.runningLo < _loAllowance(st))
    : (total < limit);

  if (canRun) {
    if (isLo) st.runningLo++;
    else st.runningHi++;
  } else {
    const queue = isLo ? st.loQueue : st.hiQueue;
    wbT(null, "ai:request", "concurrency_wait", { user: key, tier: isLo ? "lo" : "hi", runningHi: st.runningHi, runningLo: st.runningLo, limit, queuePos: queue.length + 1 });
    console.log(`[proxy] 并发闸: ${isLo ? "分身" : "本体"}排队第 ${queue.length + 1} 位（在跑 本体${st.runningHi}+分身${st.runningLo}/${limit}, user=${key}）`);
    await new Promise((resolve, reject) => {
      const item = { grant: resolve };
      if (signal) {
        if (signal.aborted) {
          const e = new Error("User Aborted");
          e.name = "AbortError";
          reject(e);
          return;
        }
        item.signal = signal;
        item.onAbort = () => {
          const i = queue.indexOf(item);
          if (i >= 0) queue.splice(i, 1);
          const e = new Error("User Aborted");
          e.name = "AbortError";
          reject(e); // grant 已先到时本 reject 是 no-op（promise 单次落定）
        };
        signal.addEventListener("abort", item.onAbort, { once: true });
      }
      queue.push(item);
      // hi 入队即泵一次：lo 让路规则含 hiQueue 判据，hi 到场不改变在跑数但可能收紧 lo 放行面
      // （无可放行时 _pump 是 O(1) 空转，安全）。
      _pump(st);
    });
    // 被唤醒 = _pump 已在同步块内把本请求计入 runningHi/runningLo，此处不再自增
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (isLo) st.runningLo = Math.max(0, st.runningLo - 1);
    else st.runningHi = Math.max(0, st.runningHi - 1);
    _pump(st); // 同步块内完成「减计数→按优先级放行→加计数」，无插队超限竞态
  };
}
