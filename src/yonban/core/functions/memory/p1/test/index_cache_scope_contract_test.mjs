import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 定向契约测试不依赖常驻集群。Node4 的 llmtok 已是严格失败契约，
// 因此用同一 HTTP schema 的进程内假服务提供确定性分词，不能再把连接失败当“降级成功”。
globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  const parsed = new URL(target);
  const service = ({ '13151': 'tokenize', '13152': 'vector', '13153': 'llmtok' })[parsed.port];
  if (target.endsWith('/health')) {
    return new Response(JSON.stringify({
      ok: true, service, contract: 'beilu-p1-cluster-v2',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (target.endsWith('/tokenize')) {
    const body = JSON.parse(String(init.body ?? '{}'));
    const words = (body.texts ?? []).map(text => String(text)
      .split(/[^\p{L}\p{N}]+/u).filter(Boolean));
    const payload = service === 'tokenize'
      ? {
        success: true,
        provider: { posStatus: { available: true, backend: 'onnx_ctb9', label: 'onnx_ctb9_cpu' } },
        results: words.map(tokens => tokens.map(w => ({ w, p: 'n', modelPos: 'n' }))),
      }
      : { provider: 'gigatoken:test', results: words };
    return new Response(JSON.stringify(payload), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (target.endsWith('/wn_pos')) {
    const body = JSON.parse(String(init.body ?? '{}'));
    const results = Object.fromEntries((body.words ?? []).map(word => [word, 'NOUN']));
    return new Response(JSON.stringify({
      available: true, results, provider: 'wordnet:contract-test', oovCount: 0,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error(`unexpected fake cluster URL: ${target}`);
};

delete process.env.P1_INDEX_CACHE_HARD_CAP;
delete process.env.P1_SOURCE_CACHE_HARD_CAP;
const { rank, clearRankCaches } = await import('../node4_rank.mjs');
const { loadThreeLayerMemory, clearMemoryCache, getMemoryCacheStats } = await import('../storage_read.mjs');
const { buildIndexTrace } = await import('../index_trace.mjs');

const node0 = (word) => ({ units: [{ type: 'user_current', raw: `${word} contract request` }] });
const runRank = (word, docs, opts = {}) => rank({
  scored: [{
    word, score: 1, sources: ['contract-test'], strength: 1, resonance: 1, via: [word], factors: {},
  }],
}, node0(word), docs, {
  mode: opts.mode || 'cache-contract',
  inputKeptWords: [word],
  exactAnchorWords: new Set([word]),
  indexScopeKey: opts.indexScopeKey,
  indexVersion: opts.indexVersion,
  indexCacheMax: opts.indexCacheMax ?? 8,
});

// 1) 无 storage 版本的直调方必须按全文失效；旧实现只看首尾 20 字，会把 beta 查成空。
const samePrefix = 'same-prefix-1234567890-';
const directA = await runRank('alpha', [{ id: 'direct-a', text: `${samePrefix}alpha` }], { mode: 'direct-fallback' });
const directB = await runRank('beta', [{ id: 'direct-b', text: `${samePrefix}beta` }], { mode: 'direct-fallback' });
const directB2 = await runRank('beta', [{ id: 'direct-b', text: `${samePrefix}beta` }], { mode: 'direct-fallback' });
assert.deepEqual(directA.ranked.map(x => x.id), ['direct-a']);
assert.deepEqual(directB.ranked.map(x => x.id), ['direct-b']);
assert.equal(directB.indexCache.hit, false);
assert.equal(directB.indexCache.versionSource, 'content');
assert.equal(directB2.indexCache.hit, true);

// 2) 相同 mode/版本字符串但不同物理用户角色源，不能互相覆盖。
const scopeA = await runRank('alpha', [{ id: 'scope-a', text: `${samePrefix}alpha` }], {
  indexScopeKey: 'memory:user-a/char-a/chat-mode', indexVersion: 'same-version',
});
const scopeB = await runRank('beta', [{ id: 'scope-b', text: `${samePrefix}beta` }], {
  indexScopeKey: 'memory:user-b/char-b/chat-mode', indexVersion: 'same-version',
});
assert.deepEqual(scopeA.ranked.map(x => x.id), ['scope-a']);
assert.deepEqual(scopeB.ranked.map(x => x.id), ['scope-b']);
assert.equal(scopeA.indexCache.hit, false);
assert.equal(scopeB.indexCache.hit, false);

// 3) 同一 scope 的 storage 版本变化必须重建。
const versionA = await runRank('alpha', [{ id: 'version-a', text: `${samePrefix}alpha` }], {
  indexScopeKey: 'memory:user/char/chat-mode', indexVersion: 'mtime-v1',
});
const versionB = await runRank('beta', [{ id: 'version-b', text: `${samePrefix}beta` }], {
  indexScopeKey: 'memory:user/char/chat-mode', indexVersion: 'mtime-v2',
});
assert.equal(versionA.indexCache.hit, false);
assert.equal(versionB.indexCache.hit, false);
assert.deepEqual(versionB.ranked.map(x => x.id), ['version-b']);

// 4) Node4 进程级索引 owner 必须在 hit/miss 都应用当前上限，并维持真实 LRU 顺序。
const cacheDoc = word => [{ id: `cache-${word}`, text: `${word} cache contract` }];

clearRankCaches();
for (const word of ['alpha', 'beta', 'gamma']) {
  await runRank(word, cacheDoc(word), {
    indexScopeKey: `node4-shrink:${word}`, indexVersion: 'v1', indexCacheMax: 3,
  });
}
const shrinkHit = await runRank('alpha', cacheDoc('alpha'), {
  indexScopeKey: 'node4-shrink:alpha', indexVersion: 'v1', indexCacheMax: 1,
});
const retainedAfterShrink = await runRank('alpha', cacheDoc('alpha'), {
  indexScopeKey: 'node4-shrink:alpha', indexVersion: 'v1', indexCacheMax: 1,
});
assert.equal(shrinkHit.indexCache.hit, true);
assert.equal(shrinkHit.indexCache.requested, 1);
assert.equal(shrinkHit.indexCache.effective, 1);
assert.equal(shrinkHit.indexCache.hardCap, 8);
assert.equal(shrinkHit.indexCache.entries, 1);
assert.equal(shrinkHit.indexCache.evictions, 2);
assert.equal(retainedAfterShrink.indexCache.hit, true);
assert.equal(clearRankCaches().indexEntries, 1);

await runRank('alpha', cacheDoc('alpha'), {
  indexScopeKey: 'node4-zero:alpha', indexVersion: 'v1', indexCacheMax: 3,
});
const zeroLimit = await runRank('alpha', cacheDoc('alpha'), {
  indexScopeKey: 'node4-zero:alpha', indexVersion: 'v1', indexCacheMax: 0,
});
assert.equal(zeroLimit.indexCache.enabled, false);
assert.equal(zeroLimit.indexCache.hit, false);
assert.equal(zeroLimit.indexCache.rebuilt, true);
assert.equal(zeroLimit.indexCache.requested, 0);
assert.equal(zeroLimit.indexCache.effective, 0);
assert.equal(zeroLimit.indexCache.entries, 0);
assert.equal(zeroLimit.indexCache.evictions, 1);
assert.deepEqual(zeroLimit.ranked.map(x => x.id), ['cache-alpha']);
const zeroLimitAgain = await runRank('alpha', cacheDoc('alpha'), {
  indexScopeKey: 'node4-zero:alpha', indexVersion: 'v1', indexCacheMax: 0,
});
assert.equal(zeroLimitAgain.indexCache.enabled, false);
assert.equal(zeroLimitAgain.indexCache.hit, false);
assert.equal(zeroLimitAgain.indexCache.rebuilt, true);
assert.equal(zeroLimitAgain.indexCache.entries, 0);
assert.equal(zeroLimitAgain.indexCache.evictions, 0);
assert.deepEqual(zeroLimitAgain.ranked.map(x => x.id), ['cache-alpha']);
assert.equal(clearRankCaches().indexEntries, 0);

const recoveredAfterZero = await runRank('alpha', cacheDoc('alpha'), {
  indexScopeKey: 'node4-zero:alpha', indexVersion: 'v1', indexCacheMax: 3,
});
const recoveredAfterZeroHit = await runRank('alpha', cacheDoc('alpha'), {
  indexScopeKey: 'node4-zero:alpha', indexVersion: 'v1', indexCacheMax: 3,
});
assert.equal(recoveredAfterZero.indexCache.enabled, true);
assert.equal(recoveredAfterZero.indexCache.hit, false);
assert.equal(recoveredAfterZero.indexCache.rebuilt, true);
assert.equal(recoveredAfterZero.indexCache.entries, 1);
assert.equal(recoveredAfterZeroHit.indexCache.hit, true);
assert.equal(recoveredAfterZeroHit.indexCache.rebuilt, false);
assert.equal(clearRankCaches().indexEntries, 1);

for (const word of ['alpha', 'beta']) {
  await runRank(word, cacheDoc(word), {
    indexScopeKey: `node4-zero-miss:${word}`, indexVersion: 'v1', indexCacheMax: 3,
  });
}
const zeroLimitMiss = await runRank('gamma', cacheDoc('gamma'), {
  indexScopeKey: 'node4-zero-miss:gamma', indexVersion: 'v1', indexCacheMax: 0,
});
assert.equal(zeroLimitMiss.indexCache.enabled, false);
assert.equal(zeroLimitMiss.indexCache.hit, false);
assert.equal(zeroLimitMiss.indexCache.rebuilt, true);
assert.equal(zeroLimitMiss.indexCache.entries, 0);
assert.equal(zeroLimitMiss.indexCache.evictions, 2);
assert.deepEqual(zeroLimitMiss.ranked.map(x => x.id), ['cache-gamma']);
const zeroLimitMissAgain = await runRank('gamma', cacheDoc('gamma'), {
  indexScopeKey: 'node4-zero-miss:gamma', indexVersion: 'v1', indexCacheMax: 0,
});
assert.equal(zeroLimitMissAgain.indexCache.hit, false);
assert.equal(zeroLimitMissAgain.indexCache.rebuilt, true);
assert.equal(zeroLimitMissAgain.indexCache.entries, 0);
assert.equal(zeroLimitMissAgain.indexCache.evictions, 0);
assert.deepEqual(zeroLimitMissAgain.ranked.map(x => x.id), ['cache-gamma']);
assert.equal(clearRankCaches().indexEntries, 0);

const recoveredAfterZeroMiss = await runRank('gamma', cacheDoc('gamma'), {
  indexScopeKey: 'node4-zero-miss:gamma', indexVersion: 'v1', indexCacheMax: 3,
});
const recoveredAfterZeroMissHit = await runRank('gamma', cacheDoc('gamma'), {
  indexScopeKey: 'node4-zero-miss:gamma', indexVersion: 'v1', indexCacheMax: 3,
});
assert.equal(recoveredAfterZeroMiss.indexCache.hit, false);
assert.equal(recoveredAfterZeroMiss.indexCache.rebuilt, true);
assert.equal(recoveredAfterZeroMiss.indexCache.entries, 1);
assert.equal(recoveredAfterZeroMissHit.indexCache.hit, true);
assert.equal(recoveredAfterZeroMissHit.indexCache.rebuilt, false);
assert.equal(clearRankCaches().indexEntries, 1);

for (const word of ['alpha', 'beta', 'gamma']) {
  await runRank(word, cacheDoc(word), {
    indexScopeKey: `node4-lru:${word}`, indexVersion: 'v1', indexCacheMax: 3,
  });
}
const touchedA = await runRank('alpha', cacheDoc('alpha'), {
  indexScopeKey: 'node4-lru:alpha', indexVersion: 'v1', indexCacheMax: 3,
});
const insertedD = await runRank('delta', cacheDoc('delta'), {
  indexScopeKey: 'node4-lru:delta', indexVersion: 'v1', indexCacheMax: 3,
});
const retainedA = await runRank('alpha', cacheDoc('alpha'), {
  indexScopeKey: 'node4-lru:alpha', indexVersion: 'v1', indexCacheMax: 3,
});
const evictedB = await runRank('beta', cacheDoc('beta'), {
  indexScopeKey: 'node4-lru:beta', indexVersion: 'v1', indexCacheMax: 3,
});
assert.equal(touchedA.indexCache.hit, true);
assert.equal(insertedD.indexCache.evictions, 1);
assert.equal(retainedA.indexCache.hit, true);
assert.equal(evictedB.indexCache.hit, false);
clearRankCaches();

let hardCapProbe = null;
for (let i = 0; i < 9; i++) {
  const word = `cap${i}`;
  hardCapProbe = await runRank(word, cacheDoc(word), {
    indexScopeKey: `node4-hard-cap:${word}`, indexVersion: 'v1', indexCacheMax: 64,
  });
}
assert.equal(hardCapProbe.indexCache.requested, 64);
assert.equal(hardCapProbe.indexCache.effective, 8);
assert.equal(hardCapProbe.indexCache.hardCap, 8);
assert.equal(hardCapProbe.indexCache.entries, 8);
assert.equal(hardCapProbe.indexCache.evictions, 1);
assert.equal(clearRankCaches().indexEntries, 8);

// 5) storage 的只读 docs/source/index 按真实物理源跨 chatId 共享；四维请求作用域仍显式分离。
const root = mkdtempSync(join(tmpdir(), 'p1-index-contract-'));
let storageContractEvidence = null;
try {
  const memDir = join(root, 'alice', 'chars', 'beilu', 'memory');
  mkdirSync(memDir, { recursive: true });
  const dataFile = join(memDir, 'entries.json');
  writeFileSync(dataFile, JSON.stringify([{ content: 'alpha memory record' }]), 'utf8');
  clearMemoryCache();
  const memA = loadThreeLayerMemory('alice', 'beilu', 'window-a', root, 'chat', { includeMarkdown: true, indexCacheMax: 8 });
  const memA2 = loadThreeLayerMemory('alice', 'beilu', 'window-a', root, 'chat', { includeMarkdown: true, indexCacheMax: 8 });
  const memOtherChat = loadThreeLayerMemory('alice', 'beilu', 'window-b', root, 'chat', { includeMarkdown: true, indexCacheMax: 8 });
  const memOtherMode = loadThreeLayerMemory('alice', 'beilu', 'window-a', root, 'code', { includeMarkdown: true, indexCacheMax: 8 });
  const memNoMarkdown = loadThreeLayerMemory('alice', 'beilu', 'window-a', root, 'chat', { includeMarkdown: false, indexCacheMax: 8 });
  const memSmallerFileLimit = loadThreeLayerMemory('alice', 'beilu', 'window-a', root, 'chat', { memoryFileMaxBytes: 64 * 1024, indexCacheMax: 8 });
  writeFileSync(dataFile, JSON.stringify([{ content: 'beta memory record with changed size' }]), 'utf8');
  const memB = loadThreeLayerMemory('alice', 'beilu', 'window-a', root, 'chat', { includeMarkdown: true, indexCacheMax: 8 });
  assert.match(memA.indexScopeKey, /^memory:[a-f0-9]{64}$/);
  assert.equal(memA.indexScopeKey.includes(root), false);
  assert.equal(memA.indexScopeKey, memA2.indexScopeKey);
  assert.equal(memA.indexScopeKey, memOtherChat.indexScopeKey);
  assert.notEqual(memA.indexScopeKey, memOtherMode.indexScopeKey);
  assert.notEqual(memA.indexScopeKey, memNoMarkdown.indexScopeKey);
  assert.notEqual(memA.indexScopeKey, memSmallerFileLimit.indexScopeKey);
  assert.equal(memA.indexVersion, memA2.indexVersion);
  assert.equal(memA2.cacheHit, true);
  assert.equal(memOtherChat.cacheHit, true);
  assert.deepEqual(memA.requestScope, {
    username: 'alice', charName: 'beilu', chatId: 'window-a', mode: 'chat',
  });
  assert.deepEqual(memOtherChat.requestScope, {
    username: 'alice', charName: 'beilu', chatId: 'window-b', mode: 'chat',
  });
  assert.deepEqual(memA.sourceScope, memOtherChat.sourceScope);
  assert.deepEqual(memA.indexScope, memOtherChat.indexScope);
  assert.equal(Object.hasOwn(memA.sourceScope, 'chatId'), false);
  assert.equal(memA.sourceScope.sharedAcrossChatIds, true);
  assert.equal(memA.indexScope.sharedAcrossChatIds, true);
  assert.equal(memA.chatContextBound, true);
  assert.equal(memOtherChat.chatContextBound, true);
  assert.equal(JSON.stringify(memA.sourceScope).includes(root), false);
  assert.notEqual(memA.indexVersion, memB.indexVersion);
  assert.deepEqual(memB.docs.map(x => x.text), ['beta memory record with changed size']);

  // 两个窗口交给 Node4 的 scope/version 相同，因此第二次直接复用同一物理索引。
  const sharedA = await runRank('alpha', memA.docs, {
    mode: 'chat', indexScopeKey: memA.indexScopeKey, indexVersion: memA.indexVersion,
  });
  const sharedOtherChat = await runRank('alpha', memOtherChat.docs, {
    mode: 'chat', indexScopeKey: memOtherChat.indexScopeKey, indexVersion: memOtherChat.indexVersion,
  });
  assert.equal(sharedA.indexCache.hit, false);
  assert.equal(sharedOtherChat.indexCache.hit, true);

  // LRU 上限/淘汰语义不因 scope 拆分退化。
  const otherMemDir = join(root, 'alice', 'chars', 'other', 'memory');
  mkdirSync(otherMemDir, { recursive: true });
  writeFileSync(join(otherMemDir, 'entries.json'), JSON.stringify([{ content: 'other physical source' }]), 'utf8');
  clearMemoryCache();
  const lruA = loadThreeLayerMemory('alice', 'beilu', 'window-a', root, 'chat', { indexCacheMax: 1 });
  loadThreeLayerMemory('alice', 'other', 'window-z', root, 'chat', { indexCacheMax: 1 });
  const lruAAfterEviction = loadThreeLayerMemory('alice', 'beilu', 'window-b', root, 'chat', { indexCacheMax: 1 });
  assert.equal(lruA.cacheHit, false);
  assert.equal(lruAAfterEviction.cacheHit, false);

  // source/docs Map 是服务级 owner：请求只能调小，不能用64把默认 hard cap 8抬高。
  clearMemoryCache();
  let sourceHardCapProbe = null;
  for (let i = 0; i < 9; i++) {
    const charName = `source-cap-${i}`;
    const sourceDir = join(root, 'alice', 'chars', charName, 'memory');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'entries.json'), JSON.stringify([{ content: `source cache ${i}` }]), 'utf8');
    sourceHardCapProbe = loadThreeLayerMemory('alice', charName, `window-${i}`, root, 'chat', { indexCacheMax: 64 });
  }
  assert.deepEqual({
    requested: sourceHardCapProbe.cache.requested,
    effective: sourceHardCapProbe.cache.effective,
    hardCap: sourceHardCapProbe.cache.hardCap,
    enabled: sourceHardCapProbe.cache.enabled,
    hit: sourceHardCapProbe.cache.hit,
    entries: sourceHardCapProbe.cache.entries,
    evictions: sourceHardCapProbe.cache.evictions,
  }, {
    requested: 64, effective: 8, hardCap: 8, enabled: true, hit: false, entries: 8, evictions: 1,
  });
  assert.equal(getMemoryCacheStats().keys, 8);

  // requested=0 是禁用：清旧项、仍为本请求读出 docs，但连续请求不命中/不插入；恢复后先 miss 再 hit。
  clearMemoryCache();
  const sourceSeed = loadThreeLayerMemory('alice', 'beilu', 'window-a', root, 'chat', { indexCacheMax: 3 });
  const sourceSeedHit = loadThreeLayerMemory('alice', 'beilu', 'window-b', root, 'chat', { indexCacheMax: 3 });
  const sourceDisabledA = loadThreeLayerMemory('alice', 'beilu', 'window-c', root, 'chat', { indexCacheMax: 0 });
  const sourceDisabledB = loadThreeLayerMemory('alice', 'beilu', 'window-d', root, 'chat', { indexCacheMax: 0 });
  assert.equal(sourceSeed.cache.hit, false);
  assert.equal(sourceSeedHit.cache.hit, true);
  for (const disabled of [sourceDisabledA, sourceDisabledB]) {
    assert.deepEqual({
      enabled: disabled.cache.enabled,
      hit: disabled.cache.hit,
      rebuilt: disabled.cache.rebuilt,
      requested: disabled.cache.requested,
      effective: disabled.cache.effective,
      entries: disabled.cache.entries,
      docs: disabled.docs.map(doc => doc.text),
    }, {
      enabled: false, hit: false, rebuilt: true, requested: 0, effective: 0, entries: 0,
      docs: ['beta memory record with changed size'],
    });
  }
  assert.equal(getMemoryCacheStats().keys, 0);
  const sourceRestored = loadThreeLayerMemory('alice', 'beilu', 'window-e', root, 'chat', { indexCacheMax: 3 });
  const sourceRestoredHit = loadThreeLayerMemory('alice', 'beilu', 'window-f', root, 'chat', { indexCacheMax: 3 });
  assert.equal(sourceRestored.cache.hit, false);
  assert.equal(sourceRestoredHit.cache.hit, true);
  assert.equal(sourceRestored.cache.entries, 1);
  assert.equal(sourceRestoredHit.cache.entries, 1);

  storageContractEvidence = {
    crossChatDocsCacheHit: memOtherChat.cacheHit,
    crossChatIndexCacheHit: sharedOtherChat.indexCache.hit,
    requestChatIds: [memA.requestScope.chatId, memOtherChat.requestScope.chatId],
    sharedSourceKey: memA.indexScopeKey === memOtherChat.indexScopeKey,
    sourceHasChatId: Object.hasOwn(memA.sourceScope, 'chatId'),
    versionChangedAfterFileWrite: memA.indexVersion !== memB.indexVersion,
    lruEvictedOldest: lruAAfterEviction.cacheHit === false,
    sourceHardCap: {
      requested: sourceHardCapProbe.cache.requested,
      effective: sourceHardCapProbe.cache.effective,
      hardCap: sourceHardCapProbe.cache.hardCap,
      entries: sourceHardCapProbe.cache.entries,
    },
    sourceDisabled: {
      firstHit: sourceDisabledA.cache.hit,
      secondHit: sourceDisabledB.cache.hit,
      entries: sourceDisabledB.cache.entries,
      restoredHit: sourceRestoredHit.cache.hit,
    },
  };
} finally {
  rmSync(root, { recursive: true, force: true });
}

// 6) 前端诊断只拿稳定缓存字段和业务 scope；内部路径仍不能穿透白名单。
const frontTrace = buildIndexTrace({
  hit: true, requested: 64, effective: 8, hardCap: 8, entries: 7, evictions: 1,
  rebuilt: false, enabled: true, docCount: 2,
  version: 'abcdef1234567890-too-long', versionSource: 'storage',
  scopeKey: 'D:\\private\\users\\alice', rawSignature: 'secret-file-signature',
}, { username: 'alice', charName: 'beilu', mode: 'chat', chatId: 'window-123' }, { includeMarkdown: true });
assert.deepEqual(frontTrace.scope, {
  username: 'alice', charName: 'beilu', chatId: 'window-123', mode: 'chat', includeMarkdown: true,
});
assert.deepEqual({
  requested: frontTrace.requested, effective: frontTrace.effective, hardCap: frontTrace.hardCap,
  entries: frontTrace.entries, evictions: frontTrace.evictions, hit: frontTrace.hit,
}, { requested: 64, effective: 8, hardCap: 8, entries: 7, evictions: 1, hit: true });
assert.equal(frontTrace.chatContextBound, true);
assert.equal(frontTrace.version, 'abcdef1234567890');
assert.equal(JSON.stringify(frontTrace).includes('private'), false);
assert.equal(JSON.stringify(frontTrace).includes('secret'), false);

console.log(JSON.stringify({
  ok: true,
  directFallback: { rebuilt: !directB.indexCache.hit, nextHit: directB2.indexCache.hit },
  scopedIsolation: [scopeA.ranked[0]?.id, scopeB.ranked[0]?.id],
  versionInvalidation: versionB.ranked[0]?.id,
  node4Cache: {
    shrinkEntries: shrinkHit.indexCache.entries,
    retainedAfterShrink: retainedAfterShrink.indexCache.hit,
    zeroHitPath: {
      hit: zeroLimit.indexCache.hit, rebuilt: zeroLimit.indexCache.rebuilt,
      entries: zeroLimit.indexCache.entries, repeatedRebuilt: zeroLimitAgain.indexCache.rebuilt,
      recoveredHit: recoveredAfterZeroHit.indexCache.hit,
    },
    zeroMissPath: {
      hit: zeroLimitMiss.indexCache.hit, rebuilt: zeroLimitMiss.indexCache.rebuilt,
      entries: zeroLimitMiss.indexCache.entries, repeatedRebuilt: zeroLimitMissAgain.indexCache.rebuilt,
      recoveredHit: recoveredAfterZeroMissHit.indexCache.hit,
    },
    lruRetainedA: retainedA.indexCache.hit,
    lruEvictedB: !evictedB.indexCache.hit,
    hardCap: hardCapProbe.indexCache.hardCap,
  },
  storageScope: 'opaque-shared-source-sha256',
  storageContract: storageContractEvidence,
  frontTrace: { cache: frontTrace.hit ? 'hit' : 'rebuilt', chatContextBound: frontTrace.chatContextBound },
}));
