// cluster.mjs — P1 集群调用收口(底部功能层: 功能层一个,传导/缓存/处理多个)
//
// 三个常驻服务各自独立进程,懒加载,插拔语义:
//   tokenize_service :13151 — jieba+HanLP(GPU)+CoreNatureDictionary；Stanza 仅显式重后端
//   vector_service   :13152 — NB300 向量(mmap) + WordNet（含默认轻量英文词法 POS）
//   llmtok_service   :13153 — Gigatoken(Qwen3-8B tokenizer)
//
// 全部 async: 用原生 fetch 直调 HTTP,零 spawn 开销(1-5ms 网络 vs 200-500ms spawn)

import { readFileSync } from 'node:fs';

const RUNTIME_CONTRACT = JSON.parse(readFileSync(new URL('./runtime_contract.json', import.meta.url), 'utf8'));
const CLUSTER_CONTRACT = RUNTIME_CONTRACT.cluster.id;
const SERVICE_SPECS = new Map(RUNTIME_CONTRACT.cluster.services.map(s => [s.name, s]));
const PORTS = Object.fromEntries(RUNTIME_CONTRACT.cluster.services.map(s => [
  s.name,
  parseInt(process.env[s.envPort], 10) || s.port,
]));
const _verified = new Set();

async function probeService(service, timeoutMs = 3000) {
  const port = PORTS[service];
  const spec = SERVICE_SPECS.get(service);
  if (!port || !spec) return { ok: false, error: `unknown cluster service: ${service}` };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const health = await res.json();
    const compatible = res.ok
      && health?.ok === true
      && health?.service === service
      && health?.contract === CLUSTER_CONTRACT;
    return compatible
      ? { ...health, compatible: true }
      : {
          ...health,
          ok: false,
          compatible: false,
          error: `cluster contract mismatch: expected ${service}/${CLUSTER_CONTRACT}, got ${health?.service ?? '?'}/${health?.contract ?? '?'}`,
        };
  } catch (e) {
    return { ok: false, compatible: false, error: `cluster health failed: ${e.message}` };
  }
}

export async function httpCall(service, path, body, timeoutMs = 30000) {
  const port = PORTS[service];
  if (!port) throw new Error(`unknown cluster service: ${service}`);
  if (!_verified.has(service)) {
    const health = await probeService(service);
    if (!health.compatible) return { error: health.error, _cluster_err: true, health };
    _verified.add(service);
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text();
    let responseBody = null;
    if (raw) {
      try { responseBody = JSON.parse(raw); }
      catch {
        _verified.delete(service);
        return {
          error: `cluster service returned non-JSON response (${res.status})`,
          _cluster_err: true,
          status: res.status,
          statusText: res.statusText,
          body: raw.slice(0, 1000),
        };
      }
    }
    if (!res.ok) {
      _verified.delete(service);
      return {
        ...(responseBody && typeof responseBody === 'object' ? responseBody : {}),
        error: responseBody?.error ?? `cluster service HTTP ${res.status}`,
        _cluster_err: true,
        status: res.status,
        statusText: res.statusText,
        body: responseBody,
      };
    }
    return responseBody;
  } catch (e) {
    _verified.delete(service);
    return { error: e.message, _cluster_err: true };
  }
}

export async function healthCheck(service) {
  return probeService(service);
}

export async function clusterStatus() {
  const [t, v, l] = await Promise.all([healthCheck('tokenize'), healthCheck('vector'), healthCheck('llmtok')]);
  return { tokenize: t, vector: v, llmtok: l };
}
