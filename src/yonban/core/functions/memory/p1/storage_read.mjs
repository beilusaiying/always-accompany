// storage_read.mjs — 记忆储存读取(共享物理源缓存, mtime 签名失效)
//
// 功能链: p1_service_stdio → loadThreeLayerMemory(username, charName, chatId, dataRoot, mode, opts)
//   → 递归扫描 memory/ 下 json/jsonl/md → 解析 entries[]/messages[]/tables[].rows[]/通用数组
//   → docs [{id, layer, text}] → pipeline 被检索库
// 数据源对齐: p1_node0_data_recall.py _collect + _split_entries + _read_data_store 的 JS 平移
// 请求/历史/novelty/写入仍由调用方按 username×charName×chatId×mode 四元隔离；
// 这里只缓存 username×charName×mode 对应物理记忆源的只读 docs，不按 chatId 复制。
// 缓存: mtime 签名(文件路径+mtime+size 拼接串)命中 → 直接返回缓存的 docs, 跳过读盘+解析
//   缓存上限 indexCacheMax(默认 8, LRU 淘汰); 记忆文件变更 → 签名不匹配 → 重建

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';

const DEFAULT_MAX_FILE = 8 * 1024 * 1024;
const MIN_MAX_FILE = 64 * 1024;
const MAX_MAX_FILE = 64 * 1024 * 1024;
const RUNTIME_CONTRACT = JSON.parse(readFileSync(new URL('./runtime_contract.json', import.meta.url), 'utf8'));
const SOURCE_POLICY = RUNTIME_CONTRACT.memorySourcePolicy;
const NON_RECALL_ROOT_DIRS = new Set(SOURCE_POLICY.nonRecallRootDirs);
const NON_RECALL_ROOT_FILES = new Set(SOURCE_POLICY.nonRecallRootFiles);
const FILE_EXT_RE = /\.(?:json|jsonl|md)$/i;
const CRLF_RE = /\r\n?/g;
const MD_HEADING_RE = /^\s{0,3}#{1,6}\s+(.+?)\s*$/;
const SOURCE_CACHE_HARD_CAP = Math.max(1, Math.min(64, Math.trunc(
  Number.isFinite(Number(process.env.P1_SOURCE_CACHE_HARD_CAP))
    ? Number(process.env.P1_SOURCE_CACHE_HARD_CAP)
    : 8,
)));

const PUBLIC_DIAGNOSTIC_MESSAGES = Object.freeze({
  P1_MEMORY_DIR_MISSING: 'memory directory is missing',
  P1_MEMORY_DIR_READ_FAILED: 'memory directory could not be read',
  P1_MEMORY_FILE_STAT_FAILED: 'memory file metadata could not be read',
  P1_MEMORY_FILE_READ_FAILED: 'memory file could not be read',
  P1_MEMORY_FILE_TOO_LARGE: 'memory file exceeds the configured size limit',
  P1_MEMORY_FILE_EMPTY: 'memory file is empty',
  P1_MEMORY_JSON_PARSE_FAILED: 'memory JSON could not be parsed',
  P1_MEMORY_JSONL_PARSE_FAILED: 'memory JSONL line could not be parsed',
});

const PROMPT_MARKERS = [/<\w+_think>/i, /<thinking>/i, /^#\s*\*\w+回复前/, /^```\w*\n/, /^\[System/i, /^<\|/];
function _isPromptFragment(text) {
  return PROMPT_MARKERS.some(re => re.test(text));
}

function _getModePrivatePaths(mode) {
  if (mode === 'code') return { tableFile: 'code_tables.json', dirs: ['code'] };
  if (mode === 'work') return { tableFile: 'work_tables.json', dirs: ['work'] };
  return { tableFile: 'tables.json', dirs: [] };
}

const ALL_MODES = ['chat', 'code', 'work'];

function _modeSkips(mode) {
  const m = mode === 'ide' ? 'code' : (mode || 'chat');
  const skipDirs = new Set();
  const skipFiles = new Set();
  for (const om of ALL_MODES) {
    if (om === m) continue;
    const p = _getModePrivatePaths(om);
    for (const d of p.dirs) skipDirs.add(d);
    if (p.tableFile) skipFiles.add(p.tableFile);
  }
  return { skipDirs, skipFiles };
}

function _layerOf(rel) {
  const head = rel.split('/')[0];
  if (head === 'hot') return 'hot';
  if (head === 'cold') return 'cold';
  return 'warm';
}

function _sourceId(value) {
  return `memory-source:${_opaqueKey(String(value || '.'))}`;
}

export function createPublicStorageDiagnostic(code, source, kind, extra = {}) {
  const diagnostic = {
    code,
    sourceId: _sourceId(source),
    kind,
    message: PUBLIC_DIAGNOSTIC_MESSAGES[code] || 'memory storage operation failed',
  };
  for (const key of ['stage', 'line', 'size', 'limit']) {
    if (extra[key] != null) diagnostic[key] = extra[key];
  }
  // 旧白盒渲染器仍读取 d.path；保留不可枚举的兼容别名，但其值也只能是 opaque identity。
  Object.defineProperty(diagnostic, 'path', { value: diagnostic.sourceId, enumerable: false });
  return diagnostic;
}

function _recordDiagnostic(diagnostics, localDiagnostic, code, source, kind, extra = {}, error = null) {
  diagnostics.push(createPublicStorageDiagnostic(code, source, kind, extra));
  if (typeof localDiagnostic === 'function') {
    localDiagnostic({
      code,
      kind,
      path: String(source || '.'),
      error: error == null ? null : `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`,
      ...extra,
    });
  }
}

function _collect(dirPath, relBase, out, skips, diagnostics, localDiagnostic) {
  let ents;
  try { ents = readdirSync(dirPath, { withFileTypes: true }); }
  catch (error) {
    _recordDiagnostic(
      diagnostics, localDiagnostic, 'P1_MEMORY_DIR_READ_FAILED', dirPath, 'error', {}, error,
    );
    return;
  }
  for (const e of ents) {
    const name = e.name;
    const isDir = e.isDirectory();
    // 下划线命名为递归内部件；其余根层运行数据由 runtime_contract.json
    // 统一分类。观测/配置/新颖度账本绝不能成为被召回语料。
    if (name.startsWith('_')) continue;
    if (!relBase && ((isDir && NON_RECALL_ROOT_DIRS.has(name))
        || (!isDir && NON_RECALL_ROOT_FILES.has(name)))) continue;
    if (isDir && !relBase && skips.skipDirs.has(name)) continue;
    const full = join(dirPath, name);
    const rel = relBase ? relBase + '/' + name : name;
    if (isDir) {
      _collect(full, rel, out, skips, diagnostics, localDiagnostic);
    } else if (FILE_EXT_RE.test(name) && !skips.skipFiles.has(name)
               && !(skips.skipMd && name.toLowerCase().endsWith('.md'))) {
      out.push({
        full,
        rel,
        sourceId: _sourceId(full),
        format: extname(name).slice(1).toLowerCase(),
      });
    }
  }
}

function _normalizeContent(value) {
  return String(value || '').replace(CRLF_RE, '\n').replace(/\0/g, '').trim();
}

function _memoryFileLimit(value) {
  if (value == null || value === '') return DEFAULT_MAX_FILE;
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_MAX_FILE;
  return Math.max(MIN_MAX_FILE, Math.min(MAX_MAX_FILE, Math.trunc(n)));
}

function _splitMarkdown(text) {
  const entries = [];
  const lines = String(text || '').replace(CRLF_RE, '\n').split('\n');
  let heading = '';
  let paragraph = [];
  const flush = () => {
    const body = paragraph.join('\n').trim();
    paragraph = [];
    if (!body) return;
    const display = _normalizeContent(heading ? heading + '\n' + body : body);
    if (display.length >= 5) entries.push(display);
  };
  for (const line of lines) {
    const m = MD_HEADING_RE.exec(line);
    if (m) { flush(); heading = m[1].trim(); continue; }
    if (!line.trim()) { flush(); continue; }
    paragraph.push(line);
  }
  flush();
  return entries;
}

// 时间字段优先级(与 Python _TIME_FIELDS 对齐)
const TIME_FIELDS = ['timestamp', 'date', 'completed_at', 'archived_at', 'created_at'];

function _parseTime(value) {
  if (value == null || value === '') return null;
  const numeric = typeof value === 'number'
    ? value
    : (/^\d{10,13}$/.test(String(value).trim()) ? Number(value) : Number.NaN);
  const ms = Number.isFinite(numeric)
    ? (Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric)
    : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function _timeFromObj(obj) {
  if (!obj || typeof obj !== 'object') return { ts: null, timeSource: null };
  for (const f of TIME_FIELDS) {
    const v = obj[f];
    if (v != null && v !== '') {
      const ms = _parseTime(v);
      if (ms != null) return { ts: ms, timeSource: f };
    }
  }
  return { ts: null, timeSource: null };
}

function _metadataTerms(value) {
  if (!Array.isArray(value)) return [];
  return value.map(v => String(v ?? '').trim()).filter(Boolean);
}

function _finiteNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function _boolMeta(value) {
  if (value === true || (typeof value === 'number' && Number.isFinite(value) && value > 0)) return true;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^(?:true|yes|on|top|pinned)$/i.test(trimmed)) return true;
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0;
  }
  return false;
}

function _entryMeta(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return {
      ts: null, timeSource: null, lastTriggered: null,
      weight: null, importance: null, top: false, pinned: false,
      keywords: [], tags: [], metadataTerms: [], recordId: null,
    };
  }
  const time = _timeFromObj(obj);
  const keywords = [..._metadataTerms(obj.keywords), ..._metadataTerms(obj.keyword_nodes)];
  const tags = _metadataTerms(obj.tags);
  return {
    ...time,
    lastTriggered: _parseTime(obj.last_triggered ?? obj.lastTriggered),
    weight: _finiteNumber(obj.weight),
    importance: _finiteNumber(obj.importance),
    top: _boolMeta(obj.top),
    pinned: _boolMeta(obj.pinned),
    keywords: [...new Set(keywords)],
    tags: [...new Set(tags)],
    metadataTerms: [...new Set([...keywords, ...tags])],
    recordId: (obj.recordId || obj.record_id) ? String(obj.recordId || obj.record_id).slice(0, 120) : null,
  };
}

function _splitEntries(text, fmt, sourcePath, localDiagnostic) {
  if (fmt === 'md') return {
    entries: _splitMarkdown(text).map(t => ({ text: t, ..._entryMeta(null) })),
    diagnostics: [],
  };
  const entries = [];
  const diagnostics = [];
  let data;
  if (fmt !== 'jsonl') {
    try { data = JSON.parse(text); }
    catch (error) {
      _recordDiagnostic(
        diagnostics, localDiagnostic, 'P1_MEMORY_JSON_PARSE_FAILED', sourcePath, 'error', {}, error,
      );
      return { entries, diagnostics };
    }
  }

  const pushObj = (obj) => {
    const t = typeof obj === 'string' ? obj : JSON.stringify(obj);
    if (!t || t.length < 5) return;
    let display = t;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const main = obj.content || obj.event || obj.thing || obj.summary || obj.task || obj.mes;
      if (main) display = String(main);
    }
    display = _normalizeContent(display);
    if (display.length >= 5) entries.push({ text: display, ..._entryMeta(obj) });
  };

  if (fmt === 'jsonl') {
    const lines = String(text || '').split('\n');
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      const trimmed = line.trim();
      if (trimmed.length < 5) continue;
      try { pushObj(JSON.parse(trimmed)); }
      catch (error) {
        _recordDiagnostic(
          diagnostics, localDiagnostic, 'P1_MEMORY_JSONL_PARSE_FAILED', sourcePath, 'error',
          { line: lineIndex + 1 }, error,
        );
      }
    }
  } else if (data && typeof data === 'object') {
    if (Array.isArray(data)) {
      for (const e of data) pushObj(e);
    } else if (Array.isArray(data.entries)) {
      for (const e of data.entries) pushObj(e);
    } else if (Array.isArray(data.messages)) {
      for (const m of data.messages) pushObj(m);
    } else if (Array.isArray(data.tables)) {
      for (const t of data.tables) {
        const rows = (t && Array.isArray(t.rows)) ? t.rows : [];
        for (const row of rows) {
          pushObj(Array.isArray(row) ? row.join(' ') : row);
        }
      }
    } else if (typeof data.summary === 'string') {
      pushObj({ summary: data.summary });
    } else {
      let anyArr = false;
      for (const v of Object.values(data)) {
        if (Array.isArray(v)) { for (const e of v) pushObj(e); anyArr = true; }
      }
      if (!anyArr) pushObj(data);
    }
  } else if (data != null) {
    pushObj(data);
  }
  return { entries, diagnostics };
}

// ── mtime 签名 LRU 缓存(与 Python _read_data_store 对齐) ──
const _cache = new Map();
let _cacheMax = Math.min(8, SOURCE_CACHE_HARD_CAP);
let _cacheEvictions = 0;

function _trimCache(limit) {
  let evictions = 0;
  while (_cache.size > limit) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
    _cacheEvictions++;
    evictions++;
  }
  return evictions;
}

function _sourceCacheLimits(value) {
  const number = Number(value);
  const requested = Number.isFinite(number)
    ? Math.max(0, Math.min(64, Math.trunc(number)))
    : 8;
  return { requested, effective: Math.min(requested, SOURCE_CACHE_HARD_CAP), hardCap: SOURCE_CACHE_HARD_CAP };
}

function _buildSignature(files, diagnostics, localDiagnostic) {
  const parts = [];
  for (const f of files) {
    try {
      const st = statSync(f.full);
      parts.push(`${f.full}:${st.mtimeMs}:${st.birthtimeMs}:${st.size}|`);
    } catch (error) {
      parts.push(`${f.full}:0:0|`);
      _recordDiagnostic(
        diagnostics, localDiagnostic, 'P1_MEMORY_FILE_STAT_FAILED', f.full, 'error',
        { stage: 'signature' }, error,
      );
    }
  }
  return parts.join('');
}

function _opaqueKey(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function _sourceType(rel) {
  if (rel.includes('/archive/') || rel.includes('_archive')) return 'archive';
  if (rel.includes('/active/')) return 'active';
  if (rel.includes('/workflows/')) return 'workflow';
  if (rel.endsWith('_tables.json') || rel === 'tables.json') return 'tables';
  if (rel.endsWith('.md')) return 'md';
  return 'entry';
}

function _fileDateFromRel(rel) {
  const match = String(rel || '').match(/(?:^|\/)(19\d{2}|20\d{2})[-_/](0?[1-9]|1[0-2])[-_/](0?[1-9]|[12]\d|3[01])(?:\/|\.|$)/);
  if (!match) return null;
  const ms = new Date(`${match[1]}-${String(+match[2]).padStart(2, '0')}-${String(+match[3]).padStart(2, '0')}T00:00:00`).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function _buildDocs(files, diagnostics, maxFileBytes, localDiagnostic) {
  const docs = [];
  const dated = [];
  const layerCounts = { hot: 0, warm: 0, cold: 0 };
  for (const f of files) {
    let text;
    let fileCreatedTime = null;
    try {
      const st = statSync(f.full);
      fileCreatedTime = Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0 ? st.birthtimeMs : null;
      if (st.size > maxFileBytes) {
        _recordDiagnostic(
          diagnostics, localDiagnostic, 'P1_MEMORY_FILE_TOO_LARGE', f.full, 'skipped',
          { size: st.size, limit: maxFileBytes },
        );
        continue;
      }
      if (st.size === 0) {
        _recordDiagnostic(
          diagnostics, localDiagnostic, 'P1_MEMORY_FILE_EMPTY', f.full, 'skipped',
        );
        continue;
      }
      text = readFileSync(f.full, 'utf8');
    } catch (error) {
      _recordDiagnostic(
        diagnostics, localDiagnostic, 'P1_MEMORY_FILE_READ_FAILED', f.full, 'error', {}, error,
      );
      continue;
    }
    const layer = _layerOf(f.rel);
    const sType = _sourceType(f.rel);
    const split = _splitEntries(text, f.format, f.full, localDiagnostic);
    diagnostics.push(...split.diagnostics);
    const pieces = split.entries;
    const fileTs = _fileDateFromRel(f.rel);
    for (const piece of pieces) {
      if (_isPromptFragment(piece.text)) continue;
      const doc = {
        id: `${layer}_${docs.length}`,
        recordId: piece.recordId,
        layer,
        text: piece.text,
        // 生产记录只携带不可逆物理源身份；真实文件路径仅可通过 localDiagnostic 在本机观测。
        sourceRel: f.sourceId,
        sourceId: f.sourceId,
        sourceType: sType,
        ts: piece.ts,
        timeSource: piece.timeSource,
        fileTs,
        fileCreatedTime,
        lastTriggered: piece.lastTriggered,
        weight: piece.weight,
        importance: piece.importance,
        top: piece.top,
        pinned: piece.pinned,
        keywords: piece.keywords,
        tags: piece.tags,
        metadataTerms: piece.metadataTerms,
      };
      docs.push(doc);
      layerCounts[layer] = (layerCounts[layer] || 0) + 1;
      const sortableTs = piece.ts ?? fileTs;
      if (sortableTs != null) dated.push({ doc, ts: sortableTs });
    }
  }
  dated.sort((a, b) => b.ts - a.ts);
  return { docs, layerCounts, dated };
}

export function loadThreeLayerMemory(username, charName, chatId, dataRoot, mode, opts = {}) {
  const scope = {
    username: String(username ?? ''),
    charName: String(charName ?? ''),
    chatId: String(chatId ?? ''),
    mode: String(mode ?? ''),
  };
  const localDiagnostic = opts.localDiagnostic;
  const cacheLimits = _sourceCacheLimits(opts.indexCacheMax);
  _cacheMax = cacheLimits.effective;
  _trimCache(_cacheMax);
  const out = {
    docs: [], layerCounts: { hot: 0, warm: 0, cold: 0 }, why: null, cacheHit: false,
    diagnostics: [],
    requestScope: scope,
    sourceScope: null,
    indexScope: null,
    chatContextBound: Boolean(scope.chatId.trim()),
    // 仅供后端索引缓存使用：哈希后不泄露 dataRoot/用户名/角色目录。
    indexScopeKey: null, indexVersion: null,
    cache: {
      enabled: cacheLimits.effective > 0,
      hit: false,
      rebuilt: false,
      requested: cacheLimits.requested,
      effective: cacheLimits.effective,
      hardCap: cacheLimits.hardCap,
      entries: _cache.size,
      evictions: _cacheEvictions,
    },
  };
  if (Object.values(scope).some(value => !value.trim())) {
    out.why = 'P1_RECALL_SCOPE_MISSING';
    return out;
  }
  const memoryUserRoot = opts.memoryUserRoot || (dataRoot ? join(dataRoot, scope.username) : '');
  if (!memoryUserRoot) { out.why = 'P1_MEMORY_USER_ROOT_MISSING'; return out; }
  const memDir = join(memoryUserRoot, 'chars', scope.charName, 'memory');
  const modeKey = scope.mode;
  const includeMarkdown = opts.includeMarkdown !== false;
  const maxFileBytes = _memoryFileLimit(opts.memoryFileMaxBytes);
  // 物理三层角色语料与其纯只读索引按真实来源共享；chatId 只属于请求/历史/写入状态，
  // 不能进入 docs 解析缓存或 Node4 索引键，否则同角色的多个窗口会复制相同大对象。
  const sourceIdentity = JSON.stringify({
    username: scope.username,
    charName: scope.charName,
    mode: modeKey,
    memDir,
    includeMarkdown,
    memoryFileMaxBytes: maxFileBytes,
  });
  const sourceScopeKey = `memory:${_opaqueKey(sourceIdentity)}`;
  const cacheKey = sourceIdentity;
  out.indexScopeKey = sourceScopeKey;
  out.sourceScope = {
    username: scope.username,
    charName: scope.charName,
    mode: modeKey,
    includeMarkdown,
    memoryFileMaxBytes: maxFileBytes,
    memDirIdentity: `memory-dir:${_opaqueKey(memDir)}`,
    sharedAcrossChatIds: true,
  };
  if (!existsSync(memDir)) {
    out.why = 'P1_MEMORY_DIR_MISSING';
    _recordDiagnostic(
      out.diagnostics, localDiagnostic, 'P1_MEMORY_DIR_MISSING', memDir, 'error',
    );
    return out;
  }

  const skips = _modeSkips(modeKey);
  if (opts.includeMarkdown === false) skips.skipMd = true;
  const files = [];
  _collect(memDir, '', files, skips, out.diagnostics, localDiagnostic);
  if (scope.charName !== '_global') {
    const globalMemDir = join(memoryUserRoot, 'chars', '_global', 'memory');
    if (existsSync(globalMemDir)) _collect(globalMemDir, '', files, skips, out.diagnostics, localDiagnostic);
  }
  files.sort((a, b) => a.full.toLowerCase().localeCompare(b.full.toLowerCase()) || a.full.localeCompare(b.full));

  // 缓存: key=dirs+mode+md, sig=所有文件 mtime+size
  const sig = _buildSignature(files, out.diagnostics, localDiagnostic);
  out.indexVersion = _opaqueKey(`${maxFileBytes}\0${sig}`);
  out.sourceScope.version = out.indexVersion;
  out.indexScope = {
    key: out.indexScopeKey,
    version: out.indexVersion,
    sharedAcrossChatIds: true,
  };
  const cached = _cacheMax > 0 ? _cache.get(cacheKey) : undefined;
  const dataCount = Math.max(0, Math.min(20, Number(opts.dataCount) || 0));

  if (cached && cached.sig === sig) {
    _cache.delete(cacheKey);
    _cache.set(cacheKey, cached);
    out.docs = cached.docs;
    out.layerCounts = cached.layerCounts;
    out.recentDocs = dataCount > 0 ? cached.dated.slice(0, dataCount).map(d => d.doc) : [];
    out.diagnostics.push(...cached.diagnostics);
    out.cacheHit = true;
    _trimCache(_cacheMax);
    out.cache = {
      ...out.cache,
      hit: true,
      entries: _cache.size,
      evictions: _cacheEvictions,
    };
    return out;
  }

  // effective=0 仍为本请求真实读取/解析，但不读取旧项、不插入进程级 owner Map。
  _trimCache(_cacheMax);
  const built = _buildDocs(files, out.diagnostics, maxFileBytes, localDiagnostic);
  out.docs = built.docs;
  out.layerCounts = built.layerCounts;
  out.recentDocs = dataCount > 0 ? built.dated.slice(0, dataCount).map(d => d.doc) : [];
  if (_cacheMax > 0) {
    _cache.delete(cacheKey);
    _cache.set(cacheKey, {
      sig, docs: built.docs, layerCounts: built.layerCounts, dated: built.dated,
      diagnostics: [...out.diagnostics],
    });
    _trimCache(_cacheMax);
  }
  out.cache = {
    ...out.cache,
    rebuilt: true,
    entries: _cache.size,
    evictions: _cacheEvictions,
  };
  return out;
}

export function clearMemoryCache() {
  const before = { keys: _cache.size, evictions: _cacheEvictions };
  _cache.clear();
  _cacheEvictions = 0;
  return before;
}

export function getMemoryCacheStats() {
  return {
    keys: _cache.size,
    max: _cacheMax,
    effective: _cacheMax,
    hardCap: SOURCE_CACHE_HARD_CAP,
    enabled: _cacheMax > 0,
    evictions: _cacheEvictions,
  };
}
