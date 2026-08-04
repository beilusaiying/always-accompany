// index_trace.mjs — node4 内部缓存状态 → 前端可展示的安全诊断契约。
// 明确白名单，避免内部 scopeKey/dataRoot/文件签名在未来扩字段时被 ...spread 带到前端。

const nonNegativeInt = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
};

export function buildIndexTrace(indexCache, req = {}, cfg = {}) {
  if (!indexCache) return null;
  return {
    hit: Boolean(indexCache.hit),
    requested: nonNegativeInt(indexCache.requested),
    effective: nonNegativeInt(indexCache.effective),
    hardCap: nonNegativeInt(indexCache.hardCap),
    entries: nonNegativeInt(indexCache.entries),
    evictions: nonNegativeInt(indexCache.evictions),
    rebuilt: Boolean(indexCache.rebuilt),
    enabled: Boolean(indexCache.enabled),
    docCount: Math.max(0, Number(indexCache.docCount) || 0),
    version: String(indexCache.version || '').slice(0, 16),
    versionSource: indexCache.versionSource === 'storage' ? 'storage' : 'content',
    scope: {
      username: String(req.username ?? ''),
      charName: String(req.charName ?? ''),
      chatId: String(req.chatId ?? ''),
      mode: String(req.mode ?? req.activeMode ?? ''),
      includeMarkdown: cfg.includeMarkdown !== false,
    },
    chatContextBound: Boolean(req.chatId),
  };
}
