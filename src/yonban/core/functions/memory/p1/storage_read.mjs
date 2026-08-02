// storage_read.mjs — 记忆储存读取(按 username/charName 角色卡级隔离, mtime 签名缓存)
//
// 功能链: p1_service_stdio → loadThreeLayerMemory(username, charName, dataRoot, mode, opts)
//   → 递归扫描 memory/ 下 json/jsonl/md → 解析 entries[]/messages[]/tables[].rows[]/通用数组
//   → docs [{id, layer, text}] → pipeline 被检索库
// 数据源对齐: p1_node0_data_recall.py _collect + _split_entries + _read_data_store 的 JS 平移
// 缓存: mtime 签名(文件路径+mtime+size 拼接串)命中 → 直接返回缓存的 docs, 跳过读盘+解析
//   缓存上限 indexCacheMax(默认 8, LRU 淘汰); 记忆文件变更 → 签名不匹配 → 重建

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const MAX_FILE = 500 * 1024;
const SKIP_FILES = new Set(['tasks.json', 'promoted_experience.json']);
const FILE_EXT_RE = /\.(?:json|jsonl|md)$/i;
const CRLF_RE = /\r\n?/g;
const MD_HEADING_RE = /^\s{0,3}#{1,6}\s+(.+?)\s*$/;

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

function _collect(dirPath, relBase, out, skips) {
  let ents;
  try { ents = readdirSync(dirPath, { withFileTypes: true }); }
  catch { return; }
  for (const e of ents) {
    const name = e.name;
    if (name.startsWith('_') || name === 'vocab' || name === 'p1_experiment_log') continue;
    const isDir = e.isDirectory();
    if (isDir && !relBase && skips.skipDirs.has(name)) continue;
    const full = join(dirPath, name);
    const rel = relBase ? relBase + '/' + name : name;
    if (isDir) {
      _collect(full, rel, out, skips);
    } else if (FILE_EXT_RE.test(name) && !SKIP_FILES.has(name) && !skips.skipFiles.has(name)
               && !(skips.skipMd && name.toLowerCase().endsWith('.md'))) {
      out.push({ full, rel, format: extname(name).slice(1).toLowerCase() });
    }
  }
}

function _normalizeContent(value) {
  return String(value || '').replace(CRLF_RE, '\n').replace(/\0/g, '').trim();
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

function _timeFromObj(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const f of TIME_FIELDS) {
    const v = obj[f];
    if (v != null && v !== '') {
      const ms = new Date(v).getTime();
      if (Number.isFinite(ms)) return ms;
    }
  }
  return null;
}

function _splitEntries(text, fmt) {
  if (fmt === 'md') return _splitMarkdown(text).map(t => ({ text: t, ts: null }));
  const entries = [];
  let data;
  try { data = JSON.parse(text); } catch { data = null; }

  const pushObj = (obj) => {
    const t = typeof obj === 'string' ? obj : JSON.stringify(obj);
    if (!t || t.length < 5) return;
    let display = t;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const main = obj.content || obj.event || obj.thing || obj.summary || obj.task || obj.mes;
      if (main) display = String(main);
    }
    display = _normalizeContent(display);
    if (display.length >= 5) entries.push({ text: display, ts: _timeFromObj(obj) });
  };

  if (fmt === 'jsonl') {
    for (const line of String(text || '').split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length < 5) continue;
      try { pushObj(JSON.parse(trimmed)); } catch { entries.push({ text: trimmed, ts: null }); }
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
  } else if (text) {
    for (const line of String(text).split('\n')) {
      const s = line.trim();
      if (s.length >= 5) entries.push({ text: s, ts: null });
    }
  }
  return entries;
}

// ── mtime 签名 LRU 缓存(与 Python _read_data_store 对齐) ──
const _cache = new Map();
let _cacheMax = 8;
let _cacheEvictions = 0;

function _trimCache(limit) {
  while (_cache.size > limit) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
    _cacheEvictions++;
  }
}

function _buildSignature(files) {
  const parts = [];
  for (const f of files) {
    try {
      const st = statSync(f.full);
      parts.push(`${f.full}:${st.mtimeMs}:${st.size}|`);
    } catch {
      parts.push(`${f.full}:0:0|`);
    }
  }
  return parts.join('');
}

function _sourceType(rel) {
  if (rel.includes('/archive/') || rel.includes('_archive')) return 'archive';
  if (rel.includes('/active/')) return 'active';
  if (rel.includes('/workflows/')) return 'workflow';
  if (rel.endsWith('_tables.json') || rel === 'tables.json') return 'tables';
  if (rel.endsWith('.md')) return 'md';
  return 'entry';
}

function _buildDocs(files, dataCount) {
  const docs = [];
  const dated = [];
  const layerCounts = { hot: 0, warm: 0, cold: 0 };
  for (const f of files) {
    let text;
    try {
      const st = statSync(f.full);
      if (st.size > MAX_FILE || st.size === 0) continue;
      text = readFileSync(f.full, 'utf8');
    } catch { continue; }
    const layer = _layerOf(f.rel);
    const sType = _sourceType(f.rel);
    const pieces = _splitEntries(text, f.format);
    for (const piece of pieces) {
      if (_isPromptFragment(piece.text)) continue;
      const doc = { id: `${layer}_${docs.length}`, layer, text: piece.text, sourceRel: f.rel, sourceType: sType, ts: piece.ts };
      docs.push(doc);
      layerCounts[layer] = (layerCounts[layer] || 0) + 1;
      if (piece.ts != null) dated.push({ doc, ts: piece.ts });
    }
  }
  dated.sort((a, b) => b.ts - a.ts);
  return { docs, layerCounts, dated };
}

export function loadThreeLayerMemory(username, charName, dataRoot, mode, opts = {}) {
  const out = { docs: [], layerCounts: { hot: 0, warm: 0, cold: 0 }, memDir: null, why: null, cacheHit: false };
  if (!username || !charName) { out.why = 'no userCtx(username/charName)'; return out; }
  if (!dataRoot) { out.why = 'no dataRoot(config.dataRoot)'; return out; }
  const memDir = join(dataRoot, username, 'chars', charName, 'memory');
  out.memDir = memDir;
  if (!existsSync(memDir)) { out.why = `memory dir missing: ${memDir}`; return out; }

  const skips = _modeSkips(mode);
  if (opts.includeMarkdown === false) skips.skipMd = true;
  const files = [];
  _collect(memDir, '', files, skips);
  if (charName !== '_global') {
    const globalMemDir = join(dataRoot, username, 'chars', '_global', 'memory');
    if (existsSync(globalMemDir)) _collect(globalMemDir, '', files, skips);
  }
  files.sort((a, b) => a.full.toLowerCase().localeCompare(b.full.toLowerCase()) || a.full.localeCompare(b.full));

  // 缓存: key=dirs+mode+md, sig=所有文件 mtime+size
  const maxIdx = Math.max(0, Math.min(64, Number(opts.indexCacheMax) || 8));
  _cacheMax = maxIdx;
  _trimCache(_cacheMax);
  const cacheKey = `${memDir}\0${mode || 'chat'}\0md:${opts.includeMarkdown !== false ? 'on' : 'off'}`;
  const sig = _buildSignature(files);
  const cached = _cache.get(cacheKey);
  const dataCount = Math.max(0, Math.min(20, Number(opts.dataCount) || 0));

  if (cached && cached.sig === sig) {
    _cache.delete(cacheKey);
    _cache.set(cacheKey, cached);
    out.docs = cached.docs;
    out.layerCounts = cached.layerCounts;
    out.recentDocs = dataCount > 0 ? cached.dated.slice(0, dataCount).map(d => d.doc) : [];
    out.cacheHit = true;
    return out;
  }

  const built = _buildDocs(files, dataCount);
  out.docs = built.docs;
  out.layerCounts = built.layerCounts;
  out.recentDocs = dataCount > 0 ? built.dated.slice(0, dataCount).map(d => d.doc) : [];
  if (_cacheMax > 0) {
    _cache.delete(cacheKey);
    _cache.set(cacheKey, { sig, docs: built.docs, layerCounts: built.layerCounts, dated: built.dated });
    _trimCache(_cacheMax);
  }
  return out;
}

export function clearMemoryCache() {
  const before = { keys: _cache.size, evictions: _cacheEvictions };
  _cache.clear();
  _cacheEvictions = 0;
  return before;
}

export function getMemoryCacheStats() {
  return { keys: _cache.size, max: _cacheMax, evictions: _cacheEvictions };
}
