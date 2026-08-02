// cluster.mjs — P1 集群调用收口(底部功能层: 功能层一个,传导/缓存/处理多个)
//
// 三个常驻服务各自独立进程,懒加载,插拔语义:
//   tokenize_service :13151 — jieba+HanLP(GPU)+Stanza+CoreNatureDictionary
//   vector_service   :13152 — NB300 向量(mmap) + WordNet
//   llmtok_service   :13153 — Gigatoken(Qwen3-8B tokenizer)
//
// 全部 async: 用原生 fetch 直调 HTTP,零 spawn 开销(1-5ms 网络 vs 200-500ms spawn)

const PORTS = {
  tokenize: parseInt(process.env.P1_TOK_PORT, 10) || 13151,
  vector: parseInt(process.env.P1_VEC_PORT, 10) || 13152,
  llmtok: parseInt(process.env.P1_LLMTOK_PORT, 10) || 13153,
};

export async function httpCall(service, path, body, timeoutMs = 30000) {
  const port = PORTS[service];
  if (!port) throw new Error(`unknown cluster service: ${service}`);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return await res.json();
  } catch (e) {
    return { error: e.message, _cluster_err: true };
  }
}

export async function healthCheck(service) {
  const port = PORTS[service];
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
    return await res.json();
  } catch { return { ok: false }; }
}

export async function clusterStatus() {
  const [t, v, l] = await Promise.all([healthCheck('tokenize'), healthCheck('vector'), healthCheck('llmtok')]);
  return { tokenize: t, vector: v, llmtok: l };
}
