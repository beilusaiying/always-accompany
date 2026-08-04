// resources2.mjs — 发散/打分/排序层资源加载(懒加载+缓存,承接 resources.mjs 的收集层资源)
//
// 设计来源: P1_新管线设计_算法标注版.md §发散 / §标注打分 / §code / §work
// 白盒: resourceReport2() 上报每份资源的词条数;缺失明确抛错或标 unavailable,不吞
// 重资源(SWOW/ConceptNet/词林)读 resources_derived/ 派生文件,由 bridge/preprocess_resources.py 一次性生成

import {
  readFileSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync,
  mkdirSync, writeFileSync, renameSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { getResDir } from './p1_resdir.mjs';

const LEXBASE = getResDir();
// 派生词库收口: env P1V2_DERIVED > P1 唯一资源根 resources/p1v2_derived。
const _dc = [
  process.env.P1V2_DERIVED,
  join(LEXBASE, 'p1v2_derived'),
].filter(Boolean);
export const DERIVED = _dc.find(p => existsSync(p)) ?? join(LEXBASE, 'p1v2_derived');

export const PATHS2 = {
  swowZh: join(DERIVED, 'swow_zh.tsv'),
  swowEn: join(DERIVED, 'swow_en.tsv'),
  conceptnetZh: join(DERIVED, 'conceptnet_zh.json'),
  conceptnetEn: join(DERIVED, 'conceptnet_en.json'),
  cilin: join(DERIVED, 'cilin.tsv'),
  nrcDir: join(LEXBASE, 'NRC-multilingual'),
  emobankDir: join(LEXBASE, 'EmoBank'),
  conc78kDir: join(LEXBASE, 'concreteness-78k'),
  ecdict: join(LEXBASE, 'ECDICT', 'ecdict.csv'),
  atomicDir: join(LEXBASE, 'atomic2020'),
  domainWordsDir: join(LEXBASE, 'DomainWordsDict'),
  codeSmellsDir: join(LEXBASE, 'code-smells'),
  businessDir: join(LEXBASE, 'business-wordlists'),
  // code/work 缩写/术语表(GitHub 抓取,落库后接线;缺失=unavailable 不断链)
  abbrCode: join(DERIVED, 'terms', 'abbreviations_in_code.tsv'),        // abbr \t full_en
  computerese: join(DERIVED, 'terms', 'computerese_zh_en.tsv'),         // en \t zh
  seAbbr: join(DERIVED, 'terms', 'software_engineering_abbr.tsv'),      // abbr \t full_en
  aiTerms: join(DERIVED, 'terms', 'ai_terminology_zh_en.tsv'),          // zh \t en
  glossaries: join(DERIVED, 'terms', 'glossaries_definitions.tsv'),     // term \t definition_en
  basicTech: join(DERIVED, 'terms', 'basic_tech_zh_en.tsv'),           // zh \t en (基础中英技术词)
  glossaryNouns: join(DERIVED, 'terms', 'glossaries_nouns.tsv'),       // term \t noun1,noun2,...
  // CFN 中文语义框架词表(work 模式发散; frame→words JSON)
  cfnLex: join(LEXBASE, 'CFN-Lex', 'CFN_LEX_CN.json'),
  // THUOCL 域词表(mode 消歧: IT vs animal)
  thuoclIt: join(LEXBASE, 'THUOCL', 'data', 'THUOCL_IT.txt'),
  thuoclAnimal: join(LEXBASE, 'THUOCL', 'data', 'THUOCL_animal.txt'),
  // DomainWordsDict 计算机业(code/work 域扩展)
  domainWordsIt: join(LEXBASE, 'DomainWordsDict', 'data', '计算机业.txt'),
  // moetype ACG 专名词典(20万+ 角色名/作品名/ACG术语)
  moetypeDict: join(LEXBASE, 'moetype', 'tone_moe.dict.yaml'),
};

const cache = new Map();
function memo(key, build) {
  if (!cache.has(key)) cache.set(key, build());
  return cache.get(key);
}

// ConceptNet 不得再 JSON.parse 整份 22MB/128MB 单行对象。派生层将顶层 key 按
// SHA-256 首字节分成 256 个 JSONL shard；运行时只加载当前锚词所在 shard，
// 每种语言有界 LRU。分片缺失/过期是资源契约错误，禁止回退整表解析。
const CONCEPTNET_SHARD_ROOT = join(DERIVED, 'conceptnet_shards');
const CONCEPTNET_SHARD_CACHE_MAX = Math.max(1, Math.min(32,
  parseInt(process.env.P1_CONCEPTNET_SHARD_CACHE, 10) || 8));

// DomainWordsDict 的 domain_confirm 只需要精确 membership，不需要把 455 万词常驻 Set。
// 离线构建将词按 SHA-256 首字节分成 256 片；运行时只读 manifest 和查询词所在片。
// 索引缺失/过期/损坏一律带结构化错误码失败，禁止退回召回热链遍历源目录。
const DOMAIN_WORDS_SHARD_ROOT = join(DERIVED, 'domain_words_shards');
const DOMAIN_WORDS_SHARD_CACHE_MAX = Math.max(1, Math.min(16,
  parseInt(process.env.P1_DOMAIN_WORDS_SHARD_CACHE, 10) || 2));
const DOMAIN_WORDS_INDEX_VERSION = 1;
const DOMAIN_WORDS_ALGORITHM = 'sha256-first-byte';
const DOMAIN_WORDS_FORMAT = 'utf8-lines-v1';
const DOMAIN_WORDS_MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const DOMAIN_WORDS_SHARD_KEYS = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function domainWordsIndexError(code, message, details = {}) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  error.details = details;
  return error;
}

function conceptnetShardError(code, message, details = {}) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  error.details = details;
  return error;
}

function domainWordsSourceInventory(dir) {
  if (!existsSync(dir)) {
    throw domainWordsIndexError('E_P1_DOMAIN_WORDS_SOURCE_MISSING', `source directory missing: ${dir}`);
  }
  const files = walkFiles(dir)
    .filter(path => /\.(txt|csv)$/i.test(path))
    .map(path => {
      const stat = statSync(path, { bigint: true });
      return {
        path,
        relativePath: relative(dir, path).replace(/\\/g, '/'),
        size: Number(stat.size),
        mtimeNs: stat.mtimeNs.toString(),
      };
    })
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'en'));
  const eligible = files.filter(file => file.size <= DOMAIN_WORDS_MAX_SOURCE_BYTES);
  // [0804 根因修·指纹 v2] 原指纹含 mtimeNs：内容未变但发布/复制安装必然改 mtime → manifest 恒 STALE
  //   → warmup fail-closed → runP1 503（E 现场 P1 死亡确诊根因）。v2 只取跨复制稳定的
  //   [relativePath, size]；内容级深校验由 shard 级 sha256（manifest.shards[*].sha256，loader 逐片验）
  //   与构建期写入的 per-file contentSha256（供发布验证器离线深验）承担，运行时校验零 hash 开销。
  const fingerprintPayload = eligible.map(({ relativePath, size }) => [relativePath, size]);
  const fingerprint = createHash('sha256').update(JSON.stringify(fingerprintPayload), 'utf8').digest('hex');
  return { files, eligible, fingerprint, fingerprintVersion: 2 };
}

function domainWordsShardFor(word) {
  return createHash('sha256').update(word, 'utf8').digest('hex').slice(0, 2);
}

function validateDomainWordsManifest(manifest, inventory, manifestPath) {
  if (manifest?.version !== DOMAIN_WORDS_INDEX_VERSION
      || manifest?.algorithm !== DOMAIN_WORDS_ALGORITHM
      || manifest?.format !== DOMAIN_WORDS_FORMAT
      || !/^data_[a-f0-9]{16}$/.test(String(manifest?.dataDir ?? ''))
      || !Number.isInteger(manifest?.entries) || manifest.entries < 0) {
    throw domainWordsIndexError('E_P1_DOMAIN_WORDS_INDEX_INVALID',
      `manifest contract invalid: ${manifestPath}`);
  }
  // [0804] fingerprintVersion !== 2 = 旧 mtime 版 manifest（复制安装即失配的历史格式）→ 判 STALE，
  //   由 ensureDomainWordsShardIndex 走原子重建路径自愈，不再永久 fail-closed。
  if (Number(manifest?.source?.fingerprintVersion) !== 2
      || manifest?.source?.fingerprint !== inventory.fingerprint
      || Number(manifest?.source?.eligibleFiles) !== inventory.eligible.length) {
    throw domainWordsIndexError('E_P1_DOMAIN_WORDS_INDEX_STALE',
      `manifest does not match DomainWordsDict source: ${manifestPath}`, {
        expectedFingerprint: inventory.fingerprint,
        actualFingerprint: manifest?.source?.fingerprint ?? null,
        manifestFingerprintVersion: manifest?.source?.fingerprintVersion ?? null,
      });
  }
  let totalEntries = 0;
  for (const shard of DOMAIN_WORDS_SHARD_KEYS) {
    const spec = manifest?.shards?.[shard];
    if (spec?.file !== `${shard}.txt`
        || !Number.isInteger(spec?.entries) || spec.entries < 0
        || !Number.isInteger(spec?.bytes) || spec.bytes < 0
        || !/^[a-f0-9]{64}$/.test(String(spec?.sha256 ?? ''))) {
      throw domainWordsIndexError('E_P1_DOMAIN_WORDS_INDEX_INVALID',
        `manifest shard contract invalid: ${shard}`, { manifestPath, shard });
    }
    totalEntries += spec.entries;
  }
  if (totalEntries !== manifest.entries) {
    throw domainWordsIndexError('E_P1_DOMAIN_WORDS_INDEX_INVALID',
      `manifest total entry count mismatch: ${manifestPath}`, {
        expectedEntries: manifest.entries, shardEntries: totalEntries,
      });
  }
}

function buildDomainWordsLookup(dir) {
  const manifestPath = join(DOMAIN_WORDS_SHARD_ROOT, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw domainWordsIndexError('E_P1_DOMAIN_WORDS_INDEX_MISSING',
      `offline shard manifest missing: ${manifestPath}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw domainWordsIndexError('E_P1_DOMAIN_WORDS_INDEX_INVALID',
      `manifest parse failed: ${manifestPath}`, { cause: error.message });
  }
  const inventory = domainWordsSourceInventory(dir);
  validateDomainWordsManifest(manifest, inventory, manifestPath);
  const shardDir = join(DOMAIN_WORDS_SHARD_ROOT, manifest.dataDir);
  if (!manifest.dataDir || !existsSync(shardDir)) {
    throw domainWordsIndexError('E_P1_DOMAIN_WORDS_INDEX_MISSING',
      `shard directory missing: ${shardDir}`);
  }

  const shardCache = new Map();
  const counters = { hits: 0, misses: 0, evictions: 0 };
  const loadShard = shard => {
    if (shardCache.has(shard)) {
      const hit = shardCache.get(shard);
      shardCache.delete(shard);
      shardCache.set(shard, hit);
      counters.hits++;
      return hit;
    }
    counters.misses++;
    const spec = manifest.shards[shard];
    const path = join(shardDir, spec.file);
    if (!existsSync(path)) {
      throw domainWordsIndexError('E_P1_DOMAIN_WORDS_SHARD_MISSING',
        `required shard missing: ${path}`, { shard });
    }
    const buffer = readFileSync(path);
    const digest = createHash('sha256').update(buffer).digest('hex');
    if (buffer.length !== spec.bytes || digest !== spec.sha256) {
      throw domainWordsIndexError('E_P1_DOMAIN_WORDS_SHARD_CORRUPT',
        `shard checksum mismatch: ${path}`, {
          shard, expectedBytes: spec.bytes, actualBytes: buffer.length,
          expectedSha256: spec.sha256, actualSha256: digest,
        });
    }
    const words = new Set();
    for (const word of buffer.toString('utf8').split('\n')) {
      if (!word) continue;
      if (word.length < 2 || word.length > 12 || domainWordsShardFor(word) !== shard) {
        throw domainWordsIndexError('E_P1_DOMAIN_WORDS_SHARD_CORRUPT',
          `invalid word in shard ${shard}`, { shard, word });
      }
      words.add(word);
    }
    if (words.size !== spec.entries) {
      throw domainWordsIndexError('E_P1_DOMAIN_WORDS_SHARD_CORRUPT',
        `shard entry count mismatch: ${path}`, {
          shard, expectedEntries: spec.entries, actualEntries: words.size,
        });
    }
    shardCache.set(shard, words);
    while (shardCache.size > DOMAIN_WORDS_SHARD_CACHE_MAX) {
      shardCache.delete(shardCache.keys().next().value);
      counters.evictions++;
    }
    return words;
  };

  return {
    size: Number(manifest.entries) || 0,
    has(word) {
      const key = String(word ?? '');
      if (!key) return false;
      return loadShard(domainWordsShardFor(key)).has(key);
    },
    clear() { shardCache.clear(); },
    cacheStats() {
      let cachedEntries = 0;
      for (const words of shardCache.values()) cachedEntries += words.size;
      return {
        shards: shardCache.size,
        maxShards: DOMAIN_WORDS_SHARD_CACHE_MAX,
        cachedEntries,
        hits: counters.hits,
        misses: counters.misses,
        evictions: counters.evictions,
        sourceFiles: inventory.files.length,
        eligibleFiles: inventory.eligible.length,
        totalEntries: Number(manifest.entries) || 0,
      };
    },
  };
}

function buildConceptnetLookup(lang, sourcePath) {
  const manifestPath = join(CONCEPTNET_SHARD_ROOT, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`ConceptNet shard manifest missing: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const spec = manifest?.languages?.[lang];
  if (manifest?.version !== 1 || !spec) throw new Error(`ConceptNet shard manifest invalid for ${lang}`);
  // [0804 根因修·B8] freshness 改内容 hash（去 mtimeNs，与 DomainWords v2 同）：size 廉价预筛 +
  //   sourceSha256 权威。复制/发布安装改 mtime 不再误判 stale；旧 manifest（无 sourceFingerprintVersion）
  //   判 stale → builder（p1_server 每启动跑）自愈重建。hash 每 lang 仅 warmup 一次（optional 缓存），非查询热路径。
  const sourceStat = statSync(sourcePath, { bigint: true });
  if (Number(sourceStat.size) !== Number(spec.size)) {
    throw new Error(`ConceptNet ${lang} shards stale (size) for ${sourcePath}`);
  }
  if (Number(spec.sourceFingerprintVersion) !== 2) {
    throw new Error(`ConceptNet ${lang} shards stale (legacy mtime manifest) for ${sourcePath}`);
  }
  const sourceSha = createHash('sha256').update(readFileSync(sourcePath)).digest('hex');
  if (sourceSha !== String(spec.sourceSha256)) {
    throw new Error(`ConceptNet ${lang} shards stale (content) for ${sourcePath}`);
  }
  const shardDir = join(CONCEPTNET_SHARD_ROOT, spec.dir);
  if (!existsSync(shardDir)) throw new Error(`ConceptNet ${lang} shard dir missing: ${shardDir}`);

  const shardCache = new Map();
  const loadShard = shard => {
    if (shardCache.has(shard)) {
      const hit = shardCache.get(shard);
      shardCache.delete(shard);
      shardCache.set(shard, hit);
      return hit;
    }
    const path = join(shardDir, `${shard}.jsonl`);
    if (!existsSync(path)) {
      throw conceptnetShardError('E_P1_CONCEPTNET_SHARD_MISSING',
        `required ${lang} shard missing: ${path}`, { lang, shard, path });
    }
    let buffer;
    try {
      buffer = readFileSync(path);
    } catch (error) {
      const code = error?.code === 'ENOENT'
        ? 'E_P1_CONCEPTNET_SHARD_MISSING'
        : 'E_P1_CONCEPTNET_SHARD_CORRUPT';
      throw conceptnetShardError(code,
        `required ${lang} shard unreadable: ${path}`, {
          lang, shard, path, causeCode: error?.code ?? null, cause: error?.message ?? String(error),
        });
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch (error) {
      throw conceptnetShardError('E_P1_CONCEPTNET_SHARD_CORRUPT',
        `required ${lang} shard is not valid UTF-8: ${path}`, {
          lang, shard, path, cause: error?.message ?? String(error),
        });
    }
    const rows = new Map();
    let lineNumber = 0;
    for (const line of text.split(/\r?\n/)) {
      lineNumber++;
      if (!line) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch (error) {
        throw conceptnetShardError('E_P1_CONCEPTNET_SHARD_CORRUPT',
          `invalid JSON in ${lang} shard ${shard} at line ${lineNumber}`, {
            lang, shard, path, line: lineNumber, cause: error?.message ?? String(error),
          });
      }
      if (!Array.isArray(row) || row.length !== 2
          || typeof row[0] !== 'string' || !row[0]
          || !Array.isArray(row[1])
          || createHash('sha256').update(row[0], 'utf8').digest('hex').slice(0, 2) !== shard
          || rows.has(row[0])) {
        throw conceptnetShardError('E_P1_CONCEPTNET_SHARD_CORRUPT',
          `invalid row contract in ${lang} shard ${shard} at line ${lineNumber}`, {
            lang, shard, path, line: lineNumber,
          });
      }
      for (const edge of row[1]) {
        if (!Array.isArray(edge) || edge.length !== 3
            || typeof edge[0] !== 'string' || !edge[0]
            || typeof edge[1] !== 'string' || !edge[1]
            || !Number.isFinite(edge[2])) {
          throw conceptnetShardError('E_P1_CONCEPTNET_SHARD_CORRUPT',
            `invalid edge contract in ${lang} shard ${shard} at line ${lineNumber}`, {
              lang, shard, path, line: lineNumber, word: row[0],
            });
        }
      }
      rows.set(row[0], row[1]);
    }
    // 只在整片读取和格式验证成功后入 LRU；失败结果绝不能伪装为空片被缓存。
    shardCache.set(shard, rows);
    while (shardCache.size > CONCEPTNET_SHARD_CACHE_MAX) {
      shardCache.delete(shardCache.keys().next().value);
    }
    return rows;
  };

  return {
    size: Number(spec.entries) || 0,
    get(word) {
      const key = String(word ?? '');
      if (!key) return undefined;
      const shard = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 2);
      return loadShard(shard).get(key);
    },
    clear() { shardCache.clear(); },
    cacheStats() { return { keys: shardCache.size, max: CONCEPTNET_SHARD_CACHE_MAX }; },
  };
}

// 可缺资源的统一形态: 缺 → {available:false, why},白盒可见;在 → {available:true, data}
function optional(key, path, build) {
  return memo(key, () => {
    if (!existsSync(path)) return { available: false, why: `missing: ${path}` };
    try {
      return { available: true, data: build(path) };
    } catch (e) {
      return { available: false, why: `load error: ${e.message}` };
    }
  });
}

// 大词表逐行读取：内存上界=64KiB chunk + 单行上限，不生成整文件字符串/行数组。
function forEachUtf8LineSync(path, visit, maxLineBytes = 1024 * 1024) {
  const fd = openSync(path, 'r');
  const chunk = Buffer.allocUnsafe(64 * 1024);
  const decoder = new StringDecoder('utf8');
  let carry = '';
  try {
    while (true) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (!read) break;
      const text = carry + decoder.write(chunk.subarray(0, read));
      let start = 0;
      let nl;
      while ((nl = text.indexOf('\n', start)) >= 0) {
        const line = text.slice(start, nl).replace(/\r$/, '');
        if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
          throw new Error(`line exceeds ${maxLineBytes} bytes`);
        }
        visit(line);
        start = nl + 1;
      }
      carry = text.slice(start);
      if (Buffer.byteLength(carry, 'utf8') > maxLineBytes) {
        throw new Error(`line exceeds ${maxLineBytes} bytes`);
      }
    }
    carry += decoder.end();
    if (carry) visit(carry.replace(/\r$/, ''));
  } finally {
    closeSync(fd);
  }
}

function parseCsvLine(line) {
  const cols = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
    } else if (ch === ',') {
      cols.push(field);
      field = '';
    } else if (ch === '"' && field.length === 0) {
      quoted = true;
    } else {
      field += ch;
    }
  }
  if (quoted) throw new Error('unterminated quoted CSV field');
  cols.push(field);
  return cols;
}

// ---- SWOW 联想网络: cue → [{word, strength}] 按 strength 降序 ----
function buildSwow(path) {
  const map = new Map();
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const [cue, resp, s] = lines[i].split('\t');
    if (!cue || !resp) continue;
    if (!map.has(cue)) map.set(cue, []);
    map.get(cue).push({ word: resp, strength: parseFloat(s) || 1 });
  }
  for (const arr of map.values()) arr.sort((a, b) => b.strength - a.strength);
  return map;
}
export const loadSwowZh = () => optional('swowZh', PATHS2.swowZh, buildSwow);
export const loadSwowEn = () => optional('swowEn', PATHS2.swowEn, buildSwow);

// ---- ConceptNet 倒排: word → [[rel, target, weight]] (rel 带~后缀=反向边) ----
export const loadConceptnetZh = () => optional('cnZh', PATHS2.conceptnetZh,
  p => buildConceptnetLookup('zh', p));
export const loadConceptnetEn = () => optional('cnEn', PATHS2.conceptnetEn,
  p => buildConceptnetLookup('en', p));

// ---- 词林: 词 → [编码...] + 编码 → 词集(只用 = 同义行,# 相关行降权,@ 独立行忽略) ----
export const loadCilin = () => optional('cilin', PATHS2.cilin, (p) => {
  const wordToCodes = new Map();
  const codeToWords = new Map();
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const [code, wordsStr] = line.split('\t');
    if (!code || !wordsStr) continue;
    const words = wordsStr.trim().split(/\s+/);
    codeToWords.set(code, words);
    for (const w of words) {
      if (!wordToCodes.has(w)) wordToCodes.set(w, []);
      wordToCodes.get(w).push(code);
    }
  }
  // 层级前缀索引(设计§发散·词林: 同大类L3+同中类L2): L3=小类前4位, L2=中类前2位
  const smallToWords = new Map(), midToWords = new Map();
  for (const [code, words] of codeToWords) {
    if (!code.endsWith('=')) continue; // 层级扩展同样只用同义行
    for (const [key, m] of [[code.slice(0, 4), smallToWords], [code.slice(0, 2), midToWords]]) {
      if (!m.has(key)) m.set(key, new Set());
      for (const w of words) m.get(key).add(w);
    }
  }
  return { wordToCodes, codeToWords, smallToWords, midToWords };
});

// ---- NRC 情绪词表: word → {emotion: 0|1} (标准 Wordlevel 三列 word\temotion\tflag) ----
export const loadNrc = () => optional('nrc', PATHS2.nrcDir, (dir) => {
  const file = findFile(dir, n => /wordlevel|emotion-lexicon/i.test(n) && n.endsWith('.txt'));
  if (!file) throw new Error('NRC wordlevel txt not found');
  const map = new Map();
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const [w, emo, flag] = line.split('\t');
    if (!w || !emo || flag !== '1') continue;
    if (!map.has(w)) map.set(w, []);
    map.get(w).push(emo);
  }
  return map;
});

// ---- EmoBank: 句子级 VAD 原始语料 ----
// 消费现状: 仅 resourceReport2 清点;打分层词级 VAD 查询走 loadEmobankVad(派生表 emobank_word_vad.tsv),
// 本函数保留=原始语料可达性证明 + 未来句子级用途,不在打分链上
export const loadEmobank = () => optional('emobank', PATHS2.emobankDir, (dir) => {
  const file = findFile(dir, n => n.toLowerCase() === 'emobank.csv') || findFile(dir, n => n.endsWith('.csv'));
  if (!file) throw new Error('emobank csv not found');
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const header = lines[0].split(',');
  const vi = header.indexOf('V'), ai = header.indexOf('A'), di = header.indexOf('D');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c.length <= Math.max(vi, ai, di)) continue;
    rows.push({ v: +c[vi], a: +c[ai], d: +c[di], text: c.slice(di + 1).join(',') });
  }
  return rows;
});

// ---- concreteness-78k(英文补充卷): 列名探测 word+conc ----
export const loadConc78k = () => optional('conc78k', PATHS2.conc78kDir, (dir) => {
  const file = findFile(dir, n => /\.(csv|tsv|txt)$/i.test(n), f => statSync(f).size > 100000);
  if (!file) throw new Error('conc78k data file not found');
  const raw = readFileSync(file, 'utf8').split(/\r?\n/);
  const delim = raw[0].includes('\t') ? '\t' : ',';
  const header = raw[0].split(delim).map(s => s.trim().toLowerCase());
  const wi = header.findIndex(h => h === 'word' || h === 'words');
  const ci = header.findIndex(h => h.includes('conc'));
  if (wi < 0 || ci < 0) throw new Error(`conc78k 列探测失败: ${header.join(',')}`);
  const map = new Map();
  for (let i = 1; i < raw.length; i++) {
    const c = raw[i].split(delim);
    if (c[wi] && c[ci]) map.set(c[wi].toLowerCase(), parseFloat(c[ci]));
  }
  return map;
});

// ---- ECDICT: 英文词频 frq(0=未收录) ----
export const loadEcdictFrq = () => optional('ecdict', PATHS2.ecdict, (p) => {
  const map = new Map();
  // ecdict.csv 约 66MB：按 64KiB chunk + 有界单行解析，禁止 readFileSync().split() 双份峰值。
  let wi = -1, fi = -1, row = 0;
  forEachUtf8LineSync(p, line => {
    row++;
    if (!line) return;
    const cols = parseCsvLine(line);
    if (wi < 0) {
      wi = cols.indexOf('word');
      fi = cols.indexOf('frq');
      if (wi < 0 || fi < 0) throw new Error(`ecdict 表头异常: ${cols.slice(0, 12).join(',')}`);
      return;
    }
    if (cols.length <= Math.max(wi, fi)) throw new Error(`ecdict 第${row}行列数不足`);
    const word = cols[wi].trim().toLowerCase();
    const rawFrq = cols[fi].trim();
    if (!word || !rawFrq) return;
    const frq = Number(rawFrq);
    if (!Number.isInteger(frq) || frq < 0) throw new Error(`ecdict 第${row}行 frq 非法: ${rawFrq}`);
    if (frq > 0) map.set(word, frq);
  });
  if (wi < 0 || fi < 0) throw new Error('ecdict 文件为空');
  return map;
});

// ---- ATOMIC2020: P1 专用过滤版 csv (head,relation,tail,knowledge_type,split; 94万行) ----
const ATOMIC_RELS_CHAT = new Set(['xWant', 'xEffect', 'xReact', 'oReact']); // 设计: 不选 xNeed/xAttr
export const loadAtomic = () => optional('atomic', PATHS2.atomicDir, (dir) => {
  const f = findFile(dir, x => x === 'atomic2020_p1_filtered.csv');
  if (!f) throw new Error('atomic2020_p1_filtered.csv not found');
  const index = new Map();   // word → [{r,t,h}] h=head序号(事件模板交集定位用)
  const heads = [];
  let edges = 0, skippedCols = 0;
  const lines = readFileSync(f, 'utf8').split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length !== 5) { skippedCols++; continue; } // head/tail 含逗号的行放弃,白盒计数
    const [head, rel, tail] = cols;
    if (!head || !ATOMIC_RELS_CHAT.has(rel) || !tail || tail === 'none') continue;
    const h = heads.length;
    heads.push(head);
    edges++;
    for (const w of head.toLowerCase().replace(/person[xy]|___/g, ' ').split(/\W+/)) {
      if (w.length < 3) continue;
      if (!index.has(w)) index.set(w, []);
      const arr = index.get(w);
      if (arr.length < 30) arr.push({ rel, tail, h });
    }
  }
  return { index, heads, edges, skippedCols };
});

// ---- code/work 术语与缩写表(抓取后落 derived/terms,缺=unavailable) ----
const buildTwoCol = p => {
  const map = new Map();
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const [a, b] = line.split('\t');
    if (a && b) map.set(a.trim().toLowerCase(), b.trim());
  }
  return map;
};
export const loadAbbrCode = () => optional('abbrCode', PATHS2.abbrCode, buildTwoCol);
export const loadSeAbbr = () => optional('seAbbr', PATHS2.seAbbr, buildTwoCol);
export const loadComputerese = () => optional('computerese', PATHS2.computerese, buildTwoCol); // en→zh
export const loadAiTerms = () => optional('aiTerms', PATHS2.aiTerms, buildTwoCol);             // zh→en
export const loadGlossaries = () => optional('glossaries', PATHS2.glossaries, buildTwoCol);    // term→def
const buildTwoColKeepCase = p => {
  const map = new Map();
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const [a, b] = line.split('\t');
    if (a && b) map.set(a.trim(), b.trim());
  }
  return map;
};
export const loadBasicTech = () => optional('basicTech', PATHS2.basicTech, buildTwoColKeepCase); // zh→en
export const loadGlossaryNouns = () => optional('glossaryNouns', PATHS2.glossaryNouns, p => {
  const map = new Map();
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const [term, nouns] = line.split('\t');
    if (term && nouns) map.set(term.trim().toLowerCase(), nouns.trim().split(',').filter(n => n.length > 2));
  }
  return map;
}); // term → [noun1, noun2, ...]
// DomainWordsDict: work/domain_confirm 的精确 membership。
// 运行时只装 manifest + 查询词所在 shard；离线生成必须显式调用 buildDomainWordsShardIndex()。
export const loadDomainWords = () => optional('domainWords', PATHS2.domainWordsDir, buildDomainWordsLookup);

// 显式离线构建入口。它可能使用与旧全量 Set 相当的构建内存，因此严禁由 loadDomainWords()/diverge()
// 自动调用。manifest 采用 wx 写入：已有索引不会被无备份覆盖，更新时应由部署流程切换新派生根。
export function buildDomainWordsShardIndex({
  sourceDir = PATHS2.domainWordsDir,
  outputRoot = DOMAIN_WORDS_SHARD_ROOT,
} = {}) {
  const started = process.hrtime.bigint();
  const manifestPath = join(outputRoot, 'manifest.json');
  if (existsSync(manifestPath)) {
    throw domainWordsIndexError('E_P1_DOMAIN_WORDS_INDEX_EXISTS',
      `refusing to overwrite existing manifest: ${manifestPath}`);
  }
  const inventory = domainWordsSourceInventory(sourceDir);
  mkdirSync(outputRoot, { recursive: true });
  const dataDir = `data_${inventory.fingerprint.slice(0, 16)}`;
  const finalDir = join(outputRoot, dataDir);
  if (existsSync(finalDir)) {
    throw domainWordsIndexError('E_P1_DOMAIN_WORDS_INDEX_EXISTS',
      `refusing to overwrite existing shard directory: ${finalDir}`);
  }
  const stagingDir = join(outputRoot, `.building_${process.pid}_${Date.now()}`);
  mkdirSync(stagingDir, { recursive: false });

  const shardSets = new Map(DOMAIN_WORDS_SHARD_KEYS.map(shard => [shard, new Set()]));
  for (const file of inventory.eligible) {
    forEachUtf8LineSync(file.path, line => {
      const word = line.split(/[\t,]/)[0].trim();
      if (word && word.length >= 2 && word.length <= 12) {
        shardSets.get(domainWordsShardFor(word)).add(word);
      }
    });
  }

  const shards = {};
  let entries = 0;
  for (const shard of DOMAIN_WORDS_SHARD_KEYS) {
    const words = [...shardSets.get(shard)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const buffer = Buffer.from(words.length ? `${words.join('\n')}\n` : '', 'utf8');
    writeFileSync(join(stagingDir, `${shard}.txt`), buffer, { flag: 'wx' });
    entries += words.length;
    shards[shard] = {
      file: `${shard}.txt`,
      entries: words.length,
      bytes: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
    };
  }
  renameSync(stagingDir, finalDir);
  const manifest = {
    version: DOMAIN_WORDS_INDEX_VERSION,
    algorithm: DOMAIN_WORDS_ALGORITHM,
    format: DOMAIN_WORDS_FORMAT,
    dataDir,
    entries,
    source: {
      fingerprint: inventory.fingerprint,
      fingerprintVersion: 2, // [0804] v2=内容契约（path+size），跨复制/发布安装稳定；v1（含 mtimeNs）判 STALE 重建
      files: inventory.files.length,
      eligibleFiles: inventory.eligible.length,
      maxSourceBytes: DOMAIN_WORDS_MAX_SOURCE_BYTES,
      // [0804] 构建期逐文件内容 sha256：运行时校验不消费（零热路径开销），供发布验证器离线深验源完整性
      eligibleFileHashes: inventory.eligible.map(({ relativePath, size, path: absPath }) => ({
        path: relativePath, size,
        sha256: createHash('sha256').update(readFileSync(absPath)).digest('hex'),
      })),
      skippedFiles: inventory.files
        .filter(file => file.size > DOMAIN_WORDS_MAX_SOURCE_BYTES)
        .map(({ relativePath, size }) => ({ path: relativePath, size })),
    },
    shards,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return {
    manifestPath,
    dataDir: finalDir,
    entries,
    sourceFiles: inventory.files.length,
    eligibleFiles: inventory.eligible.length,
    skippedFiles: manifest.source.skippedFiles,
    totalMs: Number(process.hrtime.bigint() - started) / 1e6,
  };
}

// [0804 根因修·stale 自愈] 幂等确保入口：manifest 缺失→构建；有效→快速返回（零 hash 开销：
//   校验只 stat + 读 manifest）；STALE（含旧 mtime 版 fingerprintVersion）/INVALID→原子重建——
//   旧 manifest 先旁移为时间戳备份（旧 dataDir 保留不删），重建失败回滚 manifest，保持
//   「有旧索引+可见错误」而非无索引。消费方：build_domainwords_shards.mjs（p1_server 启动期恒调）。
//   原「只在缺失时构建、stale 永久 fail-closed」是 E 现场 P1 死亡根因：发布复制改 mtime →
//   v1 指纹恒失配 → warmup 失败 → runP1 503，且无任何自愈路径。
export function ensureDomainWordsShardIndex({
  sourceDir = PATHS2.domainWordsDir,
  outputRoot = DOMAIN_WORDS_SHARD_ROOT,
} = {}) {
  const manifestPath = join(outputRoot, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { status: 'built', ...buildDomainWordsShardIndex({ sourceDir, outputRoot }) };
  }
  const inventory = domainWordsSourceInventory(sourceDir);
  let staleError;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    validateDomainWordsManifest(manifest, inventory, manifestPath);
    return { status: 'ok', manifestPath, entries: manifest.entries };
  } catch (error) {
    if (error?.code !== 'E_P1_DOMAIN_WORDS_INDEX_STALE'
        && error?.code !== 'E_P1_DOMAIN_WORDS_INDEX_INVALID'
        && !(error instanceof SyntaxError)) throw error; // 源缺失等非索引问题原样上抛
    staleError = error;
  }
  const backupPath = join(outputRoot, `manifest.stale.${Date.now()}.json`);
  renameSync(manifestPath, backupPath);
  // 目标 dataDir（新指纹命名）若已存在＝上次「目录已就位、manifest 未写成」的残留，内容未经验证
  //   不可采信 → 旁移孤儿，让重建走完整 staging→rename 验证链。
  const expectedFinalDir = join(outputRoot, `data_${inventory.fingerprint.slice(0, 16)}`);
  if (existsSync(expectedFinalDir)) {
    renameSync(expectedFinalDir, `${expectedFinalDir}.orphan_${Date.now()}`);
  }
  try {
    const rebuilt = buildDomainWordsShardIndex({ sourceDir, outputRoot });
    return { status: 'rebuilt', reason: staleError?.code ?? 'E_P1_DOMAIN_WORDS_INDEX_INVALID', staleManifestBackup: backupPath, ...rebuilt };
  } catch (rebuildError) {
    try { if (!existsSync(manifestPath)) renameSync(backupPath, manifestPath); } catch { /* 回滚失败时备份仍在 outputRoot 可手工恢复 */ }
    throw rebuildError;
  }
}

// ---- CFN 中文语义框架(设计§work: CFN=✓; frame→words JSON → 反向索引 word→frames + frame→words) ----
export const loadCfnLex = () => optional('cfnLex', PATHS2.cfnLex, (p) => {
  const raw = JSON.parse(readFileSync(p, 'utf8')); // { frameName: [word...] }
  const wordToFrames = new Map(); // word → [frameName...]
  const frameToWords = new Map(); // frameName → [word...]
  for (const [frame, words] of Object.entries(raw)) {
    frameToWords.set(frame, words);
    for (const w of words) {
      if (!wordToFrames.has(w)) wordToFrames.set(w, []);
      wordToFrames.get(w).push(frame);
    }
  }
  return { wordToFrames, frameToWords };
});

// ---- EmoBank 词级 VAD(设计§标注打分 审查机制2: emobank[word]→{V,A,D};句子级语料词级聚合派生) ----
export const loadEmobankVad = () => optional('emobankVad', join(DERIVED, 'emobank_word_vad.tsv'), (p) => {
  const map = new Map();
  const lines = readFileSync(p, 'utf8').split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const [w, v, a, d] = lines[i].split('\t');
    if (w && v) map.set(w, { v: +v, a: +a, d: +d });
  }
  return map;
});

// ---- THUOCL 域词表(mode 消歧: code/work 看 IT 词表, chat/airp 看 animal 词表排除错域) ----
function buildWordFreqSet(path) {
  const set = new Set();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const w = line.split('\t')[0].trim();
    if (w && w.length >= 2) set.add(w);
  }
  return set;
}
export const loadThuoclIt = () => optional('thuoclIt', PATHS2.thuoclIt, buildWordFreqSet);
export const loadThuoclAnimal = () => optional('thuoclAnimal', PATHS2.thuoclAnimal, buildWordFreqSet);
export const loadDomainWordsIt = () => optional('domainWordsIt', PATHS2.domainWordsIt, buildWordFreqSet);

// ---- moetype ACG 专名词典(Rime YAML 格式: YAML header → ... → word\tpinyin 行) ----
export const loadMoetypeAcg = () => optional('moetypeAcg', PATHS2.moetypeDict, (path) => {
  const set = new Set();
  let afterHeader = false;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!afterHeader) {
      if (line.trim() === '...') afterHeader = true;
      continue;
    }
    const w = line.split('\t')[0].trim();
    if (w && w.length >= 2) set.add(w);
  }
  return set;
});

// ---- 工具 ----
function walkFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.git') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, acc);
    else acc.push(p);
  }
  return acc;
}
function findFile(dir, nameTest, fileTest = () => true) {
  if (!existsSync(dir)) return null;
  for (const p of walkFiles(dir)) {
    const base = p.split('\\').pop();
    if (nameTest(base) && fileTest(p)) return p;
  }
  return null;
}

export function clearResourceCaches() {
  for (const result of cache.values()) result?.data?.clear?.();
  cache.clear();
}

function loadedResourceSize(data) {
  if (data == null) return 0;
  if (Number.isFinite(data.size)) return Number(data.size);
  if (Number.isFinite(data.index?.size)) return Number(data.index.size);
  if (Number.isFinite(data.wordToCodes?.size)) return Number(data.wordToCodes.size);
  if (Number.isFinite(data.wordToFrames?.size)) return Number(data.wordToFrames.size);
  if (Array.isArray(data)) return data.length;
  return null;
}

// stdio warmup 的本地静态资源入口：只调用 loader，不制造输入、候选或请求语义。
// ConceptNet 此处只构造按片查询 wrapper；全域 DomainWords 数据 shard 明确不在列表内。
export function warmLocalResources2() {
  const started = process.hrtime.bigint();
  const loaders = [
    ['swowZh', loadSwowZh], ['swowEn', loadSwowEn],
    ['conceptnetZh', loadConceptnetZh], ['conceptnetEn', loadConceptnetEn],
    ['cilin', loadCilin],
    ['abbrCode', loadAbbrCode], ['seAbbr', loadSeAbbr],
    ['computerese', loadComputerese], ['aiTerms', loadAiTerms],
    ['glossaries', loadGlossaries], ['basicTech', loadBasicTech],
    ['glossaryNouns', loadGlossaryNouns],
    ['cfnLex', loadCfnLex], ['emobankVad', loadEmobankVad],
    ['thuoclIt', loadThuoclIt], ['thuoclAnimal', loadThuoclAnimal],
    ['domainWordsIt', loadDomainWordsIt],
    // 只校验 manifest + 当前源文件指纹；loadDomainWords() 本身不读任何 data shard。
    ['domainWordsIndex', loadDomainWords],
  ];
  const items = {};
  for (const [name, loader] of loaders) {
    const itemStarted = process.hrtime.bigint();
    const result = loader();
    const cacheStats = name === 'domainWordsIndex' && result.available
      ? result.data.cacheStats()
      : null;
    if (cacheStats && cacheStats.shards !== 0) {
      throw domainWordsIndexError('E_P1_DOMAIN_WORDS_WARMUP_CONTRACT',
        'index-only warmup loaded DomainWords data shards', { cacheStats });
    }
    items[name] = {
      available: result.available === true,
      size: result.available ? loadedResourceSize(result.data) : null,
      why: result.available ? null : result.why,
      ...(cacheStats ? { cacheStats } : {}),
      ms: +(Number(process.hrtime.bigint() - itemStarted) / 1e6).toFixed(3),
    };
  }
  return {
    available: Object.values(items).every(item => item.available),
    items,
    excluded: ['domainWords:data-shards'],
    totalMs: +(Number(process.hrtime.bigint() - started) / 1e6).toFixed(3),
  };
}

export function resourceReport2() {
  const size = r => (r.available
    ? loadedResourceSize(r.data)
    : `✗(${r.why?.slice(0, 60)})`);
  const domainWords = loadDomainWords();
  return {
    swowZh: size(loadSwowZh()), swowEn: size(loadSwowEn()),
    conceptnetZh: size(loadConceptnetZh()), conceptnetEn: size(loadConceptnetEn()),
    cilin: size(loadCilin()), nrc: size(loadNrc()), emobank: size(loadEmobank()),
    conc78k: size(loadConc78k()), ecdictFrq: 'node1-controlled(default disabled)', atomic: size(loadAtomic()),
    abbrCode: size(loadAbbrCode()), seAbbr: size(loadSeAbbr()), computerese: size(loadComputerese()),
    aiTerms: size(loadAiTerms()), glossaries: size(loadGlossaries()),
    basicTech: size(loadBasicTech()), glossaryNouns: size(loadGlossaryNouns()),
    domainWords: size(domainWords),
    domainWordsCache: domainWords.available ? domainWords.data.cacheStats() : { available: false, why: domainWords.why },
    cfnLex: size(loadCfnLex()),
    thuoclIt: size(loadThuoclIt()), thuoclAnimal: size(loadThuoclAnimal()),
    domainWordsIt: size(loadDomainWordsIt()), moetypeAcg: size(loadMoetypeAcg()),
  };
}
