import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

delete process.env.P1_SOURCE_CACHE_HARD_CAP;
const {
  createPublicStorageDiagnostic,
  loadThreeLayerMemory,
  clearMemoryCache,
} = await import('../storage_read.mjs');

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, ...Array(7).fill('..'));
const sensitivePaths = [
  'D:\\private\\users\\alice\\chars\\beilu\\memory',
  '\\\\private-host\\memory-share\\alice\\chars\\beilu\\memory',
  join(repoRoot, 'src', 'data', 'users', '_path_contract_private'),
];

function stdioTraceShape(mem) {
  const memoryReason = mem.why ?? (mem.cacheHit ? 'loaded_from_cache' : 'loaded');
  return {
    trace: {
      recall: {
        dataRecall: {
          enabled: true,
          memoryScan: true,
          reason: memoryReason,
          sourceScope: mem.sourceScope,
          indexScope: mem.indexScope,
        },
        memoryReason,
        storageDiagnostics: mem.diagnostics,
      },
    },
    memory: {
      reason: memoryReason,
      sourceScope: mem.sourceScope,
      indexScope: mem.indexScope,
      why: mem.why,
      cacheHit: mem.cacheHit,
      storageDiagnostics: mem.diagnostics,
    },
    // p1/pipeline.mjs 的现有 whitebox 消费 d.path；兼容别名也必须只得到 opaque key。
    whitebox: mem.diagnostics
      .map(diagnostic => `${diagnostic.kind} ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`)
      .join('\n'),
  };
}

function assertNoSensitivePath(value, paths, label) {
  const serialized = JSON.stringify(value);
  for (const sensitive of paths) {
    assert.equal(serialized.includes(sensitive), false, `${label} leaked ${sensitive}`);
    assert.equal(String(value?.whitebox ?? '').includes(sensitive), false, `${label} whitebox leaked ${sensitive}`);
  }
  assert.doesNotMatch(serialized, /[A-Za-z]:[\\/][^"\n]+/);
  assert.doesNotMatch(serialized, /\\\\[^\\"\n]+\\[^"\n]+/);
}

// 所有公开 storage diagnostic 都由同一构造器生成；原始 source/error/message 注入不能穿透。
const diagnosticCodes = [
  'P1_MEMORY_DIR_MISSING',
  'P1_MEMORY_DIR_READ_FAILED',
  'P1_MEMORY_FILE_STAT_FAILED',
  'P1_MEMORY_FILE_READ_FAILED',
  'P1_MEMORY_FILE_TOO_LARGE',
  'P1_MEMORY_FILE_EMPTY',
  'P1_MEMORY_JSON_PARSE_FAILED',
  'P1_MEMORY_JSONL_PARSE_FAILED',
];
for (const [index, code] of diagnosticCodes.entries()) {
  const sensitive = sensitivePaths[index % sensitivePaths.length];
  const diagnostic = createPublicStorageDiagnostic(code, sensitive, 'error', {
    path: sensitive,
    error: sensitive,
    message: sensitive,
    stage: 'contract-test',
    line: 7,
  });
  assert.match(diagnostic.sourceId, /^memory-source:[a-f0-9]{64}$/);
  assert.equal(diagnostic.path, diagnostic.sourceId);
  assert.equal(Object.keys(diagnostic).includes('path'), false);
  assert.equal(Object.hasOwn(diagnostic, 'error'), false);
  assert.equal(diagnostic.message.includes(sensitive), false);
  assertNoSensitivePath({ diagnostic, whitebox: `${diagnostic.path}: ${diagnostic.message}` }, sensitivePaths, code);
}

// Windows 盘符和真实 repo 绝对路径经过 storage→stdio trace 形状后只剩稳定 code + opaque identity。
const missingTraceEvidence = [];
for (const memoryUserRoot of [sensitivePaths[0], sensitivePaths[2]]) {
  const localDiagnostics = [];
  const mem = loadThreeLayerMemory('alice', 'beilu', 'window-a', '', 'chat', {
    memoryUserRoot,
    indexCacheMax: 0,
    localDiagnostic: diagnostic => localDiagnostics.push(diagnostic),
  });
  const trace = stdioTraceShape(mem);
  assert.equal(mem.why, 'P1_MEMORY_DIR_MISSING');
  assert.equal(Object.hasOwn(mem, 'memDir'), false);
  assert.equal(mem.diagnostics[0]?.code, 'P1_MEMORY_DIR_MISSING');
  assert.match(mem.diagnostics[0]?.sourceId, /^memory-source:[a-f0-9]{64}$/);
  assert.equal(localDiagnostics.length, 1);
  assert.equal(localDiagnostics[0].path.includes(memoryUserRoot), true);
  assertNoSensitivePath(trace, sensitivePaths, 'missing-memory trace');
  missingTraceEvidence.push({ reason: mem.why, sourceId: mem.diagnostics[0].sourceId });
}

// 解析失败、被跳过文件和正常 docs 共用同一公开身份契约；本机 callback 仍保留物理路径供诊断。
const fixtureRoot = mkdtempSync(join(tmpdir(), 'p1-storage-path-contract-'));
let fixtureEvidence;
try {
  const memDir = join(fixtureRoot, 'alice', 'chars', 'beilu', 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(memDir, 'valid.json'), JSON.stringify([{ content: 'safe memory record' }]), 'utf8');
  writeFileSync(join(memDir, 'invalid.json'), '{"broken":', 'utf8');
  writeFileSync(join(memDir, 'invalid.jsonl'), '{"broken":\n', 'utf8');
  writeFileSync(join(memDir, 'empty.md'), '', 'utf8');
  writeFileSync(join(memDir, 'oversize.md'), 'x'.repeat(64 * 1024 + 1), 'utf8');

  clearMemoryCache();
  const localDiagnostics = [];
  const mem = loadThreeLayerMemory('alice', 'beilu', 'window-a', fixtureRoot, 'chat', {
    indexCacheMax: 0,
    memoryFileMaxBytes: 64 * 1024,
    localDiagnostic: diagnostic => localDiagnostics.push(diagnostic),
  });
  const trace = stdioTraceShape(mem);
  const codes = new Set(mem.diagnostics.map(diagnostic => diagnostic.code));
  for (const code of [
    'P1_MEMORY_JSON_PARSE_FAILED',
    'P1_MEMORY_JSONL_PARSE_FAILED',
    'P1_MEMORY_FILE_EMPTY',
    'P1_MEMORY_FILE_TOO_LARGE',
  ]) assert.equal(codes.has(code), true, `missing diagnostic ${code}`);
  assert.deepEqual(mem.docs.map(doc => doc.text), ['safe memory record']);
  assert.match(mem.docs[0].sourceRel, /^memory-source:[a-f0-9]{64}$/);
  assert.equal(mem.docs[0].sourceId, mem.docs[0].sourceRel);
  assert.equal(mem.cache.enabled, false);
  assert.equal(mem.cache.hit, false);
  assert.equal(mem.cache.entries, 0);
  assert.equal(localDiagnostics.some(diagnostic => diagnostic.path.includes(fixtureRoot)), true);
  assertNoSensitivePath(trace, [...sensitivePaths, fixtureRoot], 'fixture trace');
  fixtureEvidence = {
    codes: [...codes].sort(),
    sourceId: mem.docs[0].sourceId,
    cache: mem.cache,
  };
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  missingTraceEvidence,
  fixtureEvidence,
  pathKinds: ['windows-drive', 'unc', 'repo-absolute'],
}));
