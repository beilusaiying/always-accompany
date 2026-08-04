import { wbT, wbD } from "../server/wbStub.mjs";
/**
 * 多组并行 v4 · P3-1 —— 组 worker 的「跑一轮回复」runner（在 Deno Worker isolate 内）
 *
 * 线路（亲读坐实 2026-06-06）：
 *   getChatRequest(chatid,charname)  [requestBuilder.mjs:31]
 *     → loadChat + loadPart + timeSlice.chars[charname]  ← 在「本 isolate」重新加载 char/插件
 *        ⇒ beilu-preset configData / beilu-memory _vectors / ideClient 这些 module 单例随 isolate 隔离
 *           （iso_test 6/0 证：两 isolate 单例不串）= 一组一套，真并行不互踩
 *     → request.char.interfaces.chat.GetReply(request)  [char-template main.mjs:209]
 *
 * 关键前提（亲读 server.mjs:127 init 坐实）：getChatRequest 经 requestBuilder→auth.mjs→server.mjs，
 *   需 beilu 的 data_path/config/auth 与 parts_loader 就绪。worker 是独立 isolate、没有主进程的 beilu 上下文，
 *   故 run 第一次先 **以 Base-only 引导 beilu**（init({starts:{Base,IPC:false,Web:false}})）——只起
 *   config+auth+parts，**不起 HTTP 监听**（Web:false → 不 .listen，第二个实例不抢 8931/端口）。
 *
 * ⚠ 诚实：本 runner 由线路+代码推导而成、node --check 过，但 **未在真 beilu runtime 跑过**
 *   （会真发 AI 调用 + 触碰 live beilu 数据，不能离线盲跑）。GetReply 的 result→最终 entry 的落盘/广播
 *   仍由主进程 executeGeneration 外壳做（见 groupWorkerManager 注释 §3.5），本 runner 只回传 serializable 子集。
 */

let _bootPromise = null;

async function ensureBeiluBoot(dataPath) {
  if (_bootPromise) return _bootPromise;
  wbT(null, "groupReplyRunner", "ensureBeiluBoot:enter", { dataPath });
  _bootPromise = (async () => {
    const { init } = await import("../server/server.mjs");
    // Base：config + initAuth + parts_loader 就绪；关 Jobs/Timers/Idle 后台调度；IPC/Web 全关（不起监听）
    await init({
      data_path: dataPath,
      starts: { Base: { Jobs: false, Timers: false, Idle: false }, IPC: false, Web: false },
    });
    wbT(null, "groupReplyRunner", "ensureBeiluBoot:done", {});
  })();
  return _bootPromise;
}

// GetReply 的完整持久化契约。只选择主进程 BuildChatLogEntryFromCharReply 的消费字段，
// 但对每个已存在字段保持原值（包括空串/undefined）和“字段缺失”的差异；files 不做重组，
// 因此图片/SVG/附件协议不会在 worker 边界被改写。
const SERIALIZABLE_REPLY_FIELDS = Object.freeze([
  "name",
  "avatar",
  "content",
  "content_for_show",
  "content_for_edit",
  "files",
  "extension",
  "logContextBefore",
  "logContextAfter",
]);

function _replySerializationError(field, cause) {
  const error = new Error(`worker reply field is not structured-cloneable: ${field}`);
  error.code = "E_GROUP_REPLY_FIELD_SERIALIZATION";
  error.phase = "result_serialize";
  error.executionStarted = true;
  error.sideEffectsPossible = true;
  error.indeterminate = true;
  error.details = {
    field,
    cause: cause?.message || String(cause || "structured clone failed"),
  };
  return error;
}

export function serializeReplyForWorker(r) {
  if (!r || typeof r !== "object") return { content: String(r ?? "") };
  if (typeof globalThis.structuredClone !== "function") {
    throw _replySerializationError("(serializer)", new Error("structuredClone is unavailable"));
  }
  const reply = {};
  for (const field of SERIALIZABLE_REPLY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(r, field)) continue;
    try {
      reply[field] = globalThis.structuredClone(r[field]);
    } catch (cause) {
      throw _replySerializationError(field, cause);
    }
  }
  return reply;
}

/**
 * groupWorker.mjs 的 _runner(payload, ctx)。
 * @param {{data_path:string, chatid:string, charname?:string}} payload
 * @param {{groupId:string, workerId:string, signal:AbortSignal, emit:(chunk:any)=>void, emitEvent:(event:any)=>boolean,setExecutionPhase?:(phase:string)=>void}} ctx
 */
export async function run(payload, ctx) {
  ctx?.setExecutionPhase?.("runner_boot");
  wbT(payload?.chatid ?? null, "groupReplyRunner", "run:enter", { chatid: payload?.chatid, charname: payload?.charname, groupId: ctx?.groupId });
  await ensureBeiluBoot(payload.data_path);
  // 跨 isolate 桥（isolateBridge 收口）：绑定上行 emitter——本轮插件链内的审批入队/广播
  // 经 ctx.emit 骑 stream 通道到主进程（GetReply 的 finally 解绑）；并把主进程权威态快照
  // （写审批开关/主工作区根）灌入本 isolate 的 ideClient（主写 worker 读不到的内存单例收口）。
  ctx?.setExecutionPhase?.("bridge_bind");
  const _bridge = await import("../yonban/core/transport/isolateBridge.mjs");
  const _streamBindingToken = _bridge.bindWorkerEmitter(payload.chatid, ctx.emit);
  // 工具 lifecycle 使用 worker 常驻控制通道，不随本次 GetReply 的 stream emitter 解绑。
  _bridge.bindWorkerLifecycleEmitter(ctx.emitEvent);
  try {
    const { ideClient: _ic } = await import("../yonban/core/transport/ideClient.mjs");
    const _ownerRegistered = _ic.registerChatOwner?.(payload.chatid, payload.username);
    if (_ownerRegistered === false) {
      wbD(payload?.chatid ?? null, "group", "run:ownerRegisterFail", false,
        "worker 会话 owner 注册冲突，工具结果将 fail-closed", { username: payload.username });
    }
    if (payload.bridgeState) {
      _ic.applyBridgeState(payload.bridgeState, payload.username);
    }
  } catch (_bsErr) { wbD(payload?.chatid ?? null, "group", "run:bridgeStateApplyFail", false, _bsErr?.message || String(_bsErr), {}); }
  // per-group 工作区根：在本 isolate 的 ideClient 设内存覆盖（不持久化、不写共享磁盘），
  // 使本组 worker 的 workspaceRoot/file_op 沙箱/路径解析都用本组根，两组互不串（isolate 隔离 + 内存覆盖）。
  if (payload.workspaceRoot) {
    try {
      const { ideClient: _ic } = await import(
        "../yonban/core/transport/ideClient.mjs"
      );
      _ic.setWorkspaceRootOverride(payload.workspaceRoot);
    } catch (_wsErr) { wbD(payload?.chatid ?? null, "group", "run:wsRootOverrideFail", false, _wsErr?.message || String(_wsErr), { workspaceRoot: payload.workspaceRoot }); /* 取不到 ideClient 不阻断生成，退回默认根解析 */ }
  }
  // 跨 isolate 模式同步（债-C 完整化）：把主进程本会话的 activeMode 设回本 worker isolate，
  //   否则 worker 的 beilu-files activeModes 默认 "chat" → file/work/code 模式失效、file_op 续轮判定恒 false。
  if (payload.activeMode) {
    try {
      const _files = await import(
        "../public/parts/plugins/beilu-files/main.mjs"
      );
      // Y2 确诊修（07-03）三点之一：pluginData Proxy per-user 桶——原无 ALS 写进 _default 桶，而 worker 内
      // ReplyHandler 的 file_op 结果落 username 桶（main.mjs:3152 run(args.username)），模式与数据永不同桶
      // →下方 pendingFileOps 读门恒 false（债-C 逃生阀本身失效，分身Y2 STEP B/D 双桶实测实锤）。模式写同落 username 桶。
      _files._filesAls.run({ username: payload.username }, () => _files.setActiveModeForSession?.(payload.chatid, payload.activeMode));
    } catch (_amErr) { wbD(payload?.chatid ?? null, "group", "run:setActiveModeFail", false, _amErr?.message || String(_amErr), { activeMode: payload.activeMode }); /* 设不了模式→worker 退回默认 chat */ }
  }

  ctx?.setExecutionPhase?.("request_build");
  wbT(payload?.chatid ?? null, "groupReplyRunner", "getChatRequest:before", { chatid: payload?.chatid, charname: payload?.charname });
  const { getChatRequest } = await import(
    "../public/parts/shells/beilu-chat/src/lib/requestBuilder.mjs"
  );
  const request = await getChatRequest(payload.chatid, payload.charname);
  wbT(payload?.chatid ?? null, "groupReplyRunner", "getChatRequest:done", { chatid: payload?.chatid });
  // D3：worker isolate 的 ideClient 连接竞态修复（runtime 实测坐实:仅靠 beilu-memory Load 的非阻塞 connect
  //   不可靠——首轮带 <ideToolCall> 的 GetReply 跑到时 isConnected=false → IDE 工具"未连接"失败）。
  //   GetReply 前【显式】发起 connect(幂等:已连/连接中即返回)并等就绪(超时降级,不阻断生成)。
  try {
    const { ideClient: _ic } = await import(
      "../yonban/core/transport/ideClient.mjs"
    );
    // 多开：主进程随 payload 下发本会话所绑 YonBan 实例端口（idePort）→ worker 定向连接该窗口，
    //   不再连注册表赢家端口（否则本组工具打到别的窗口工作区）。无绑定 → 旧行为（整池/赢家端口）。
    try { _ic.connect?.(payload.idePort ? { autoReconnect: true, port: payload.idePort } : { autoReconnect: true }); } catch { /* 已连/连接中→幂等返回 */ }
    await _ic.waitConnected?.(2000); // 2s 上限:连上即返回;连不上只赔 2s 不阻断生成
    // worker isolate 内也登记绑定：isolate 的 ideClient 是独立实例，绑定表不共享，
    //   不登记则 callTool 路由 _connFor(chatid) 走主连接——单连接场景等价，多连接场景必须对齐。
    if (payload.idePort && payload.chatid) { try { _ic.bindChat?.(payload.chatid, payload.idePort); } catch { /* 登记失败→主连接兜底 */ } }
  } catch (_ideErr) { wbD(payload?.chatid ?? null, "group", "run:ideWaitConnectedFail", false, _ideErr?.message || "IDE 未连接, 首轮工具可能失败", { chatid: payload?.chatid }); /* 等待失败→照常生成，工具首轮可能失败 */ }
  // 根因已定位+修复(2026-06-17 U2/D3):此前 worker IDE 工具返回"未连接"——非 Deno worker WS 限制、
  //   非 connect 生命周期,而是 resolveIdeWsToken 盲信全局 ide_ws_token 单文件嵌的端口(多窗口/重启下
  //   残留已退出实例端口=死端口),致 worker 连死端口。已改:端口以 ide_active_ports.json(pid 存活过滤)
  //   为权威 + per-port token 文件取 token(ideClient.mjs resolveIdeWsToken)。producer 侧 YonBan
  //   IdeWsServer 改为 listening 确认绑定端口后才写 token/注册表,杜绝写未绑定端口踩坏 per-port token。
  //   隔离 HOME 端到端验过(worker connect+token 匹配+callTool 成功);真环境需装新 vsix+reload Cursor
  //   让运行中的 YonBan 重写正确 token 文件后生效。waitConnected 保留作 connect-vs-首轮GetReply 竞态防护。
  // 流式：把 isolate 内的 replyPreviewUpdater 增量 emit 回主进程（再由主进程 broadcastChatEvent 转前端）
  request.generation_options = {
    replyPreviewUpdater: (reply) => { try { ctx.emit({ preview: reply?.content ?? "" }); } catch { /* 流回调不阻塞生成 */ } },
    signal: ctx.signal,
  };
  if (!request.char?.interfaces?.chat?.GetReply) {
    wbD(payload?.chatid ?? null, "groupReplyRunner", "GetReply:missing", false, "char 无 GetReply 接口", { charname: payload?.charname });
    throw new Error(`char 无 GetReply 接口 (char=${payload.charname})`);
  }
  ctx?.setExecutionPhase?.("get_reply");
  wbT(payload?.chatid ?? null, "groupReplyRunner", "GetReply:before", { chatid: payload?.chatid, charname: payload?.charname });
  let result;
  try {
    result = await request.char.interfaces.chat.GetReply(request);
  } finally {
    // 上行 emitter 按 token 精确解绑；同 chat 并发 parent 不互相撤销。
    try { _bridge.unbindWorkerEmitter(payload.chatid, _streamBindingToken); } catch { /* request binding finally 仍会兜底关闭 */ }
  }
  ctx?.setExecutionPhase?.("result_serialize");
  wbT(payload?.chatid ?? null, "groupReplyRunner", "GetReply:done", { chatid: payload?.chatid });
  const reply = serializeReplyForWorker(result);
  wbT(payload?.chatid ?? null, "groupReplyRunner", "run:serialized", { chatid: payload?.chatid, hasContent: !!reply?.content });
  // pendingResults 跨界（v4 §3.3/§3.5）：本 isolate 的 ideClient 累积了 worker 内 ReplyHandler 的工具调用结果，
  // 但 auto-continue 续轮注入在主进程读主 ideClient → 把本 worker 的结果回传，主进程灌入主 ideClient。
  try {
    const { ideClient } = await import(
      "../yonban/core/transport/ideClient.mjs"
    );
    reply.pendingResults = ideClient.consumePendingResults(payload.chatid, payload.username) || [];
    wbT(payload?.chatid ?? null, "group", "run:pendingResultsBack", { count: reply.pendingResults.length });
  } catch (_prErr) { wbD(payload?.chatid ?? null, "group", "run:pendingResultsFail", false, _prErr?.message || String(_prErr), { chatid: payload?.chatid }); reply.pendingResults = []; }
  // 债-C：file_op 结果在本 worker isolate 的 beilu-files 私有池（主进程续轮门查不到它）。
  //   上报本 isolate 是否有待处理 file_op，由主进程续轮门采信；数据不回传——续轮仍重派到本 worker，
  //   由本 worker 的 GetPrompt drainPendingOpResultsForSession 就地注入（池随 isolate 常驻）。
  try {
    const _files = await import(
      "../public/parts/plugins/beilu-files/main.mjs"
    );
    // Y2 确诊修三点之二：读门与写端（ReplyHandler run(args.username)）同 username 桶——原无 ALS 读 _default 桶，
    // 数据+file 模式门双双错桶恒 false（分身Y2 STEP C/D 实测）。
    reply.pendingFileOps = !!_files._filesAls.run({ username: payload.username }, () => _files.hasPendingOpResultsForSession?.(payload.chatid));
  } catch (_foErr) { wbD(payload?.chatid ?? null, "group", "run:pendingFileOpsFail", false, _foErr?.message || String(_foErr), { chatid: payload?.chatid }); reply.pendingFileOps = false; }
  // [0717 交叉债修] web_search 续轮池上报（债-C 同款病，与上方 pendingFileOps 同范式）：
  //   <needWebSearch> 结果写在本 worker isolate 的 aiRunner.pendingChatSearchResults，主进程
  //   generation 第三级池 peek 的是主进程模块实例=恒空 → worker 路由下搜索结果永不自动续轮
  //   （隔轮兜底不丢数据但要等下次用户消息）。上报本 isolate 真值；数据不回传——续轮重派到
  //   本 worker，由本 worker 的 GetPrompt 既有注入器（CHAT_SEARCH_RESULT）就地消费。
  try {
    const _ar = await import("../yonban/core/functions/memory/ai/aiRunner.mjs");
    reply.pendingWebSearch = !!_ar.hasPendingChatSearchForChat?.(payload.chatid);
  } catch (_wsErr) { wbD(payload?.chatid ?? null, "group", "run:pendingWebSearchFail", false, _wsErr?.message || String(_wsErr), { chatid: payload?.chatid }); reply.pendingWebSearch = false; }
  return reply;
}

export default run;
