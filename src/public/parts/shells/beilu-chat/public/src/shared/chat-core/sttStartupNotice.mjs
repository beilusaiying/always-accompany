// STT 服务冷启动进度提示（阶段单源=后端 /api/parts/plugins:beilu-stt/status 的 startup 字段）。
// 为什么存在:🎤首次点击时 record/start 代理会挂起等服务自动拉起+模型加载(可达 2 分钟),
// 期间零反馈会让用户以为坏了反复点击,服务就绪后多个 record/start 齐发,除第一个外全部
// 409 "already recording" 刷屏（20260724 截图实证）。
// 消费方:messageInput(主聊天🎤) / companionChat(桌宠🎤)。返回 stop 函数,调用方 finally 里必须调。
export function startSttStartupNotifier(port) {
  let lastNotice = 0, lastPhase = null;
  const timer = setInterval(async () => {
    try {
      const r = await fetch(`/api/parts/plugins:beilu-stt/status?port=${encodeURIComponent(port)}`);
      const j = await r.json();
      const su = j?.startup;
      if (!su || su.phase === "ready" || su.phase === "failed") return;
      const now = Date.now();
      // 阶段变化立即报;同阶段(加载模型可达分钟级)每 15s 刷新一次已用时长,证明还活着
      if (su.phase !== lastPhase || now - lastNotice > 15_000) {
        lastPhase = su.phase; lastNotice = now;
        window._beiluToast?.(`STT 服务启动中 · ${su.label}${su.pct != null ? ` ${su.pct}%` : ""} · 已用 ${su.elapsedS}s`, "info");
      }
    } catch { /* 后端瞬断:下轮再试 */ }
  }, 3000);
  return () => clearInterval(timer);
}
