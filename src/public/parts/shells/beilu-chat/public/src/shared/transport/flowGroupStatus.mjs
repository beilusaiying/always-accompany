/**
 * T023 Q5：getFlowGroupStatus 共享取数（单飞 + TTL）。
 *
 * why：workPanel / groupRuntimePanel / pipelinePanel 三面板各自独立调同一 verb——三面板同开时
 *   同一状态被 3 倍拉取。治法=单飞（in-flight 合并同 key 并发请求）+ 短 TTL 缓存，非各自 debounce。
 * key：后端（setDataActions case getFlowGroupStatus）实际只消费 data.chatid（缺省 "_default" 槽）
 *   与 charName（memDir 槽）；payload.username 是无效参数（handler 用鉴权 username 非 payload）。
 *   故缓存键 = charName|chatid，同槽请求天然合并。
 * 失败语义：不缓存失败（下次重拉）；错误向调用方抛出，由各调用方保留自己的 catch 语义。
 */
import { sendAction } from "./sendAction.mjs";

const _TTL_MS = 2000;
const _cache = new Map(); // key → { at, data }
const _inflight = new Map(); // key → Promise

/** T029：变更类操作（approve/advance/stop/start/delete）后调用，清缓存使下一次取数立即回源（防 TTL 内显示旧状态） */
export function invalidateFlowGroupStatus() {
  _cache.clear();
}

export function getFlowGroupStatusShared(payload = {}) {
  // [键收口 2026-07-13] chatid 单点注入：调用方未显式给 chatid 时补当前聊天 cid（守卫单源 _beiluGetChatId，
  //   非法 hash 返 ""→undefined→后端 _default 槽）。原 workPanel 裸调不带 chatid 与启动链
  //   （startFlowGroup 现带 cid）键位分叉——显示/动作/启动三链同键。后端 D09 槽解析
  //   per-chatid 优先、_default 兜底，旧 _default 槽流水线仍可达。
  const _payload = ("chatid" in payload) ? payload : { ...payload, chatid: (window._beiluGetChatId?.() || "") || undefined };
  const key = `${_payload.charName || ""}|${_payload.chatid || "_default"}`;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < _TTL_MS) return Promise.resolve(hit.data);
  if (_inflight.has(key)) return _inflight.get(key);
  const p = sendAction({ verb: "getFlowGroupStatus", target: "plugins:beilu-memory", source: "web", payload: _payload })
    .then((data) => { _cache.set(key, { at: Date.now(), data }); return data; })
    .finally(() => { _inflight.delete(key); });
  _inflight.set(key, p);
  return p;
}
