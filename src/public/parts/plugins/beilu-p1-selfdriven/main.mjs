// ════════════════════════════════════════════════════════════════════
// beilu-p1-selfdriven — P1 自驱动召回插件
//
// 【功能链】
//   getPromptHandler Phase3 → p1Bridge.runP1() → 本插件 SetData({_action:"runP1"})
//     → 动态 import p1_pipeline.mjs → runPipeline → 返回 {p1_act, ...}
//   前端设置面板 → GET/POST /config/getdata|setdata → GetData/SetData
//
// 【why · 做成插件而非同进程直import】
//   p1_pipeline import 时把 conceptnet/swow/AT/NB300 等 119MB 词库 JSON 解析成
//   数百MB 模块级缓存进程永驻（0723 本体 2GB 内存案主因，0724 002拍板封存）。
//   插件化 = Load 零资源 + idle 超时显式清理各模块数据缓存；ESM 模块代码本身不会被卸载。
//   桥模块 p1Bridge.mjs 照 vectorBridge 范式：读盘 config 启用门 + 动态 import 本插件。
//
// 【影响范围】
//   本插件零静态 import 管线/词库模块——全部动态 import，首次 runP1 才触发加载。
//   config 写盘 data/plugins/beilu-p1-selfdriven/config.json（跨 isolate 铁律：盘为真相）。
//   Unload 等待运行中请求结束，再按依赖顺序清理 P1 的可重建数据缓存。
//   失败时返回 null/空结果，由调用方（p1Bridge）走 AI P1 降级=零回归。
//
// 【架构约束 · 盘为真相（与 vectordb 同口径）】
//   配置以 config.json 为权威并按 mtime 失效重读；召回运行保持单进程，不创建 worker/子进程。
// ════════════════════════════════════════════════════════════════════

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import info from './info.json' with { type: 'json' }

const __dirname = dirname(fileURLToPath(import.meta.url))
// 插件位于 <root>/src/public/parts/plugins/beilu-p1-selfdriven → 上 5 级 = 项目根
const PROJECT_ROOT = resolve(__dirname, '../../../../..')
const CONFIG_DIR = join(PROJECT_ROOT, 'data', 'plugins', 'beilu-p1-selfdriven')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
// 词库管理（2026-07-31 002后期任务前端3模块）：
//   AT 主词库（自更新，管线自学习写盘）在 src/yonban/.../memory/activation_terms_{mode}.json —— 本插件只读（统计/搜索）。
//   用户插拔词库在 data/plugins/beilu-p1-selfdriven/vocab/*.json —— 本插件 CRUD；
//   消费方 = p1_pool.mjs routeModeRes 第5子路由 mode:user（30s TTL 热更新），enabled 单源在文件 _meta 内（盘为真相）。
const VOCAB_DIR = join(CONFIG_DIR, 'vocab')
const AT_DIR = join(PROJECT_ROOT, 'src', 'yonban', 'core', 'functions', 'memory')
const AT_MODES = ['chat', 'code', 'work', 'airp']

// ============================================================
// 配置（内存镜像；权威在 CONFIG_FILE，mtime 失效重读）
// ============================================================

const _config = {
  enabled: false,            // 默认关闭——需用户在前端面板手动开启
  idleUnloadMinutes: 10,     // 空闲 N 分钟无 runP1 调用 → 自动清缓存释放内存
  dataRecall: true,          // 对应 P1_DATA_RECALL：记忆 data 三层擦边召回
  entryTopK: 20,             // 对应 P1_DATA_ENTRY_TOPK：多维排序取 top-K 子条目
  resonanceW: 0,             // 对应 P1_POOL_RESONANCE_W：多路共振加分权重（0=关闭）
  combinedMin: 4,            // 对应 P1_N0_COMBINED_MIN：上下文锚点最低 combined 门槛（002 Q4 定案）
  nbGlobalRoute: false,      // NB 仍供质心/语义打分；仅关闭未定质且热态约 500ms 的 64 万词全表 kNN 路
  deferNb300: true,          // 拆分/定位/稀疏搜索完成后，才加载 NB300
  nbRerank: true,            // NB300 只对稀疏候选做末段语义重排
  sparseTopK: 100,           // 进入 NB 末段前保留的稀疏候选上限
  bm25K1: 1.2,               // BM25 词频饱和；请求级传入，不写进召回模块全局状态
  bm25B: 0.75,               // BM25 条目长度归一；0=关闭，1=完全归一
  termTopK: 6,               // 每条候选最多贡献的语义+稀疏词数；OOV 不因 NB 缺词被删
  contextMessages: 5,        // 最近用户上下文消息数（assistant 不进入召回）
  inputMaxChars: 80,         // 历史 P1 软长度上限（UTF-16 String.length）
  shortSegmentChars: 10,     // 超长消息中连续短句合并阈值
  excludeExactAssistantCopies: true, // 排除用户整段精确复制 earlier assistant 的文本
  recentDataTopK: 0,         // 注入 Node1 的最近有效时间 data 数。[0731 002拍板 5→0] 回填消融实测:
                             //   关回填后英文严格口径50→61%/top1冻结解除, 中文仅-1pp; 要"最近记忆连续性"自行调回>0
  recordTopK: 5,             // 返回并注入主 AI 的记忆记录数
  candidateMinHits: 2,       // 倒排候选最低独立词命中数；绝不允许 1。[0731 002确认恒2为演进默认]
                             //   实测门槛2 vs 句长分级2/3/4: 英文严格口径+33pp、中文四模式零翻转;
                             //   139号句长分级逻辑(minHitsFor)保留为"未传配置"时的 fallback(直连管线调用)
  layerWeightHot: 1.0,       // 记忆层排序权重(当天热层)。[0731开配置通道] 原 node0 LAYER_W 硬编码单源,
  layerWeightWarm: 0.85,     //   近期温层。英文归因实测: 无时间戳记录场景层权差被归一化放大成50%权重,
  layerWeightCold: 0.7,      //   归档冷层。默认维持原硬编码值(零行为变化), 可调平衡层级vs词面相关度
  collapseSameFileKeywordSet: true, // 同文件同关键词集合的有时间版本只保留较高排名版本
  snippetMaxChars: 240,      // 单条召回记录最大注入字符数
  injectMaxChars: 0,         // 注入总字符上限（输出线）：按关联度从高到低保留，超线的低关联记录整条删除；0=不限（002 0731）
  recencyDecayBase: 0.995,   // 每小时 recency 衰减基数
  blqRerank: false,          // BLQ 始终计算；开启后参与候选后置重排
  includeMarkdown: true,     // 与 JSON/JSONL 共用同一倒排 reader
  indexCacheMax: 8,          // 多用户/多角色倒排索引 LRU 上限；防持续负载无界增长
  nbCacheMaxVectors: 50000,  // subset 向量 LRU 上限；原始向量约 60MB，不含 idx
}

let _configMtime = -1 // -1=从未读过盘

function _numberInRange(value, fallback, min, max, integer) {
  const n = Number(value)
  const valid = Number.isFinite(n) ? n : fallback
  const bounded = Math.max(min, Math.min(max, valid))
  return integer ? Math.trunc(bounded) : bounded
}

function _loadConfigFromDisk() {
  let mt = 0
  try { mt = Deno.statSync(CONFIG_FILE).mtime?.getTime() || 0 } catch { /* 无配置文件 */ }
  if (mt === _configMtime) return
  _configMtime = mt
  if (mt === 0) return // 文件不存在=保持代码默认（disabled），合法路径
  try {
    const j = JSON.parse(Deno.readTextFileSync(CONFIG_FILE))
    if (j && typeof j === 'object') Object.assign(_config, j)
    // 召回顺序是结构契约，不是可降级的用户策略。兼容读取旧字段，但生产恒安全。
    _config.nbGlobalRoute = false
    _config.deferNb300 = true
  } catch (e) {
    console.warn('[beilu-p1-selfdriven] 配置文件读取失败（保持当前内存值）:', e.message)
  }
}

function _saveConfigToDisk() {
  const tempFile = `${CONFIG_FILE}.tmp.${Deno.pid}.${Date.now()}`
  try {
    Deno.mkdirSync(CONFIG_DIR, { recursive: true })
    Deno.writeTextFileSync(tempFile, JSON.stringify(_config, null, 2))
    Deno.renameSync(tempFile, CONFIG_FILE)
    try {
      _configMtime = Deno.statSync(CONFIG_FILE).mtime?.getTime() || 0
    } catch (e) {
      _configMtime = -1
      console.warn('[beilu-p1-selfdriven] 配置已落盘但 mtime 读取失败（下次强制重读）:', e.message)
    }
  } catch (e) {
    try { Deno.removeSync(tempFile) } catch { /* 临时文件可能尚未创建或已被 rename */ }
    console.warn('[beilu-p1-selfdriven] 配置落盘失败:', e.message)
    throw e
  }
}

// ============================================================
// 管线动态加载 + idle 卸载
// ============================================================

let _pipelineModule = null  // 缓存 import("p1_pipeline.mjs") 的模块引用
let _idleTimer = null       // idle 卸载定时器
let _lastRunTime = 0        // 最近一次 runP1 的时间戳
let _lastRunMs = 0          // 最近一次 runPipeline 耗时
let _activeRuns = 0         // 运行中请求数；清缓存必须等待归零
let _activeRunWaiters = []
let _clearPromise = null    // 串行化手动/idle/Unload 清理
let _lastCacheClear = null

const PIPELINE_PATH = '../../../../yonban/core/functions/memory/p1/p1_pipeline.mjs'

async function _ensurePipeline() {
  if (_pipelineModule) return _pipelineModule
  _pipelineModule = await import(PIPELINE_PATH)
  return _pipelineModule
}

function _resetIdleTimer() {
  if (_idleTimer) clearTimeout(_idleTimer)
  _idleTimer = null
  const minutes = Number(_config.idleUnloadMinutes)
  const ms = (Number.isFinite(minutes) ? minutes : 10) * 60 * 1000
  if (ms <= 0) return // 0 = 不自动卸载
  // [0731 词库多段缓存·002"不想每次一大段启动时间"] 两级 idle：
  //   第一档(idleUnloadMinutes)=light 清理——只卸大体量段(NB向量LRU/conceptnet/发散侧)，
  //     保留分词包+SWOW 等高频小段 → 回来再启动 <400ms 而非 3s 全冷；
  //   第二档(3×idleUnloadMinutes 后)=deep 全清——长时间不用才付全冷代价。
  _idleTimer = setTimeout(async () => {
    _idleTimer = null
    await _clearCaches({ tier: 'light' })
    if (_activeRuns === 0 && !_clearPromise) {
      _idleTimer = setTimeout(async () => {
        _idleTimer = null
        await _clearCaches({ tier: 'deep' })
      }, ms * 2) // light 后再等 2×分钟数 → 距最后一次调用共 3× 才全清
    }
  }, ms)
}

function _waitForActiveRuns() {
  if (_activeRuns === 0) return Promise.resolve()
  return new Promise((resolveWait) => _activeRunWaiters.push(resolveWait))
}

function _finishActiveRun() {
  _activeRuns = Math.max(0, _activeRuns - 1)
  if (_activeRuns !== 0) return
  const waiters = _activeRunWaiters
  _activeRunWaiters = []
  for (const resolveWait of waiters) resolveWait()
}

async function _clearCaches(opts = {}) {
  if (_clearPromise) return _clearPromise
  // light 档由 idle 链自己调度后续 deep 定时器，不在此清 _idleTimer（deep/手动/Unload 才终止链）
  if (_idleTimer && opts?.tier !== 'light') {
    clearTimeout(_idleTimer)
    _idleTimer = null
  }
  _clearPromise = (async () => {
    await _waitForActiveRuns()
    if (!_pipelineModule?.clearP1RuntimeCaches) {
      return { skipped: true, reason: 'pipeline-not-loaded' }
    }
    return _pipelineModule.clearP1RuntimeCaches({ tier: opts?.tier === 'light' ? 'light' : 'deep' })
  })()
  try {
    const report = await _clearPromise
    _lastCacheClear = { at: Date.now(), report }
    return report
  } catch (e) {
    console.warn('[beilu-p1-selfdriven] P1 运行时缓存清理失败:', e?.message || e)
    _lastCacheClear = { at: Date.now(), error: e?.message || String(e) }
    throw e
  } finally {
    _clearPromise = null
  }
}

// ============================================================
// runP1 核心：请求级 config → runPipeline → 返回结果
// ============================================================

// overrides：请求级参数（不落盘不动全局 _config），当前仅 dataRecallOverride（打字式联想传 false）
async function _runP1(inputText, chatHistory, mode, userCtx, overrides) {
  _loadConfigFromDisk()
  if (!_config.enabled) return null

  if (_idleTimer) {
    clearTimeout(_idleTimer)
    _idleTimer = null
  }
  if (_clearPromise) await _clearPromise
  _activeRuns++

  const recallConfig = Object.freeze({
    // dataRecallOverride：请求级轻量开关（打字式联想传 false=只要锚点/池词不扫三层记忆），
    // 不动全局 _config.dataRecall（生产对话召回共用该全局值，联想高频调用不得影响它）。
    dataRecall: overrides?.dataRecallOverride !== undefined ? overrides.dataRecallOverride === true : _config.dataRecall !== false,
    recallOnly: true,
    entryTopK: _numberInRange(_config.entryTopK, 20, 5, 50, true),
    resonanceW: _numberInRange(_config.resonanceW, 0, 0, 2, false),
    combinedMin: _numberInRange(_config.combinedMin, 4, 2, 10, false),
    nbGlobalRoute: false,
    deferNb300: true,
    nbRerank: _config.nbRerank !== false,
    sparseTopK: _numberInRange(_config.sparseTopK, 100, 20, 500, true),
    bm25K1: _numberInRange(_config.bm25K1, 1.2, 0.1, 3, false),
    bm25B: _numberInRange(_config.bm25B, 0.75, 0, 1, false),
    termTopK: _numberInRange(_config.termTopK, 6, 1, 20, true),
    contextMessages: _numberInRange(_config.contextMessages, 5, 0, 5, true), // 002 0731拍板：2-5轮，不超过5轮（长历史稀释 data 召回 qWords）
    inputMaxChars: _numberInRange(_config.inputMaxChars, 80, 20, 500, true),
    shortSegmentChars: _numberInRange(_config.shortSegmentChars, 10, 1, 80, true),
    excludeExactAssistantCopies: _config.excludeExactAssistantCopies !== false,
    recentDataTopK: _numberInRange(_config.recentDataTopK, 0, 0, 50, true),
    recordTopK: _numberInRange(_config.recordTopK, 5, 1, 50, true),
    candidateMinHits: _numberInRange(_config.candidateMinHits, 2, 2, 8, true),
    layerWeights: { // 记忆层排序权重 → node0 dImp 消费(缺省=node0 LAYER_W 同值, 零行为变化)
      hot: _numberInRange(_config.layerWeightHot, 1.0, 0, 2, false),
      warm: _numberInRange(_config.layerWeightWarm, 0.85, 0, 2, false),
      cold: _numberInRange(_config.layerWeightCold, 0.7, 0, 2, false),
    },
    collapseSameFileKeywordSet: _config.collapseSameFileKeywordSet !== false,
    snippetMaxChars: _numberInRange(_config.snippetMaxChars, 240, 40, 2000, true),
    injectMaxChars: _numberInRange(_config.injectMaxChars, 0, 0, 20000, true),
    recencyDecayBase: _numberInRange(_config.recencyDecayBase, 0.995, 0.9, 1, false),
    blqRerank: _config.blqRerank === true,
    includeMarkdown: _config.includeMarkdown !== false,
    indexCacheMax: _numberInRange(_config.indexCacheMax, 8, 1, 64, true),
    nbCacheMaxVectors: _numberInRange(_config.nbCacheMaxVectors, 50000, 0, 200000, true),
  })

  const t0 = Date.now()
  try {
    const mod = await _ensurePipeline()
    const result = await mod.runPipeline(inputText, chatHistory, mode, userCtx, { recall: recallConfig })
    _lastRunTime = Date.now()
    _lastRunMs = Date.now() - t0
    return result
  } catch (e) {
    console.warn('[beilu-p1-selfdriven] runPipeline 失败:', e?.message || e)
    _lastRunMs = Date.now() - t0
    return null
  } finally {
    _finishActiveRun()
    if (_activeRuns === 0 && !_clearPromise) _resetIdleTimer()
  }
}

// ============================================================
// 插件导出
// ============================================================

const pluginExport = {
  info,

  Load: async ({ router } = {}) => {
    // config REST 端点（与 vectordb 同范式：主进程 REST，前端面板消费）
    if (router) {
      const { authenticate } = await import('../../../../yonban/core/functions/security/auth.mjs')
      router.get(/\/config\/getdata$/, authenticate, async (_req, res) => {
        try { res.json(await pluginExport.interfaces.config.GetData()) }
        catch (e) { res.status(500).json({ error: e.message }) }
      })
      router.post(/\/config\/setdata$/, authenticate, async (req, res) => {
        // _username 服务端注入（authenticate 后 req.user 为真相；放在 spread 之后=前端不可伪造）。
        // 消费方：runP1 action 用 _username+charName 组 userCtx（角色卡级隔离，见底部功能层.txt 隔离级别）。
        try { res.json(await pluginExport.interfaces.config.SetData({ ...req.body, _username: req.user?.username || null }) ?? { success: true }) }
        catch (e) { res.status(500).json({ error: e.message }) }
      })
    }
    _loadConfigFromDisk()
    // 注意：Load 不 import 管线/词库——懒加载，Load 零资源占用
  },

  Unload: async () => {
    if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null }
    await _clearCaches()
  },

  interfaces: {
    config: {
      // deno-lint-ignore require-await -- 插件 config 接口统一返回 Promise，保持宿主调用契约。
      GetData: async () => {
        _loadConfigFromDisk()
        return {
          enabled: _config.enabled,
          idleUnloadMinutes: _config.idleUnloadMinutes,
          dataRecall: _config.dataRecall,
          entryTopK: _config.entryTopK,
          resonanceW: _config.resonanceW,
          combinedMin: _config.combinedMin,
          nbGlobalRoute: _config.nbGlobalRoute,
          deferNb300: _config.deferNb300,
          nbRerank: _config.nbRerank,
          sparseTopK: _config.sparseTopK,
          bm25K1: _config.bm25K1,
          bm25B: _config.bm25B,
          termTopK: _config.termTopK,
          indexCacheMax: _config.indexCacheMax,
          nbCacheMaxVectors: _config.nbCacheMaxVectors,
          pipelineLoaded: !!_pipelineModule,
          lastRunTime: _lastRunTime || null,
          lastRunMs: _lastRunMs || null,
          // 控件元数据单源下发（0722 禁前端硬编码）：前端设置面纯渲染
          meta: [
            { key: 'enabled', group: '基础设置', type: 'toggle', label: '启用 P1 自驱动召回', desc: '开启后每次对话自动运行本地召回管线,召回相关记忆记录注入上下文；首次向量加载会明显较慢' },
            { key: 'idleUnloadMinutes', group: '内存管理', type: 'number', label: '空闲清缓存（分钟）', desc: '两级卸载：到时先轻清（只卸大体量段，再启动<400ms）；3倍时间后才全清（再启动约3秒）。0=不自动清理', min: 0, max: 60 },
            { key: 'dataRecall', group: '召回参数', type: 'toggle', label: '记忆 Data 召回', desc: '启用记忆三层（热/温/冷）擦边召回' },
            { key: 'entryTopK', group: '召回参数', type: 'number', label: '条目 Top-K', desc: '多维排序后取前 K 个子条目提词', min: 5, max: 50 },
            { key: 'resonanceW', group: '召回参数', type: 'number', label: '共振权重', desc: '多路共振加分权重（0=关闭共振）', min: 0, max: 2, step: 0.1 },
            { key: 'combinedMin', group: '召回参数', type: 'number', label: '锚点最低门槛', desc: '上下文锚点 combined 最低分（002 定档=4）', min: 2, max: 10 },
            { key: 'nbRerank', group: '召回参数', type: 'toggle', label: 'NB300 候选重排', desc: '只对稀疏候选做语义复核，不扫描零字面命中的全库条目' },
            { key: 'sparseTopK', group: '召回参数', type: 'number', label: '稀疏候选 Top-K', desc: '进入 NB300 末段前最多保留的条目数', min: 20, max: 500 },
            { key: 'bm25K1', group: '召回参数', type: 'number', label: 'BM25 K1', desc: '词频饱和强度；标准默认 1.2', min: 0.1, max: 3, step: 0.1 },
            { key: 'bm25B', group: '召回参数', type: 'number', label: 'BM25 B', desc: '条目长度归一强度；标准默认 0.75', min: 0, max: 1, step: 0.05 },
            { key: 'termTopK', group: '召回参数', type: 'number', label: '条目提词 Top-K', desc: '每条候选最多贡献的语义词和稀疏 OOV 词总数；不会用 NB 缺词做硬删除', min: 1, max: 20 },
            { key: 'contextMessages', group: '召回输入', type: 'number', label: '用户上下文条数', desc: '仅取最近用户消息；assistant 不进入召回；上限5轮（002定档：长历史会稀释 data 召回）', min: 0, max: 5 },
            { key: 'inputMaxChars', group: '召回输入', type: 'number', label: '输入软上限', desc: '超长输入优先保留完整尾句，默认沿用历史 80 字契约', min: 20, max: 500 },
            { key: 'shortSegmentChars', group: '召回输入', type: 'number', label: '短句合并阈值', desc: '超长消息中连续短句先合并再执行软上限', min: 1, max: 80 },
            { key: 'excludeExactAssistantCopies', group: '召回输入', type: 'toggle', label: '排除整段 AI 复制', desc: '用户文本与更早 assistant 完整规范化文本相同时不进入召回上下文' },
            { key: 'recentDataTopK', group: '召回参数', type: 'number', label: '最近 Data 数', desc: '把最近 N 条记忆的名词并入召回上下文（记忆连续性）。0=关闭：检索只看当前输入，弱输入时不再召回"最近记忆"（英文/短句场景更准）', min: 0, max: 50 },
            { key: 'recordTopK', group: '召回参数', type: 'number', label: '记录召回 Top-K', desc: '最终返回并注入主 AI 的记忆记录数', min: 1, max: 50 },
            { key: 'candidateMinHits', group: '召回参数', type: 'number', label: '候选最低命中数', desc: '倒排候选至少命中的独立词数；最低为 2，避免单词暴力匹配', min: 2, max: 8 },
            { key: 'layerWeightHot', group: '召回参数', type: 'number', label: '热层排序权重', desc: '当天记忆(hot)在排序中的层级加权；调低可减少"最近的记忆压过更相关的记忆"', min: 0, max: 2, step: 0.05 },
            { key: 'layerWeightWarm', group: '召回参数', type: 'number', label: '温层排序权重', desc: '近期记忆(warm)的层级加权', min: 0, max: 2, step: 0.05 },
            { key: 'layerWeightCold', group: '召回参数', type: 'number', label: '冷层排序权重', desc: '归档记忆(cold)的层级加权', min: 0, max: 2, step: 0.05 },
            { key: 'collapseSameFileKeywordSet', group: '召回参数', type: 'toggle', label: '合并同文件同关键词版本', desc: '同一文件、同一关键词集合且都有事件时间时，只保留排序更高的版本' },
            { key: 'snippetMaxChars', group: '召回参数', type: 'number', label: '记录摘要上限', desc: '单条召回记录最多进入注入数据的字符数', min: 40, max: 2000 },
            { key: 'injectMaxChars', group: '召回参数', type: 'number', label: '注入总字数上限', desc: '输出线：按关联度从高到低保留，到达字数后低关联记录整条删除；0=不限制', min: 0, max: 20000 },
            { key: 'recencyDecayBase', group: '召回参数', type: 'number', label: '时近衰减基数', desc: '按小时计算的 recency 衰减；无时间记录不伪造为当前时间', min: 0.9, max: 1, step: 0.001 },
            { key: 'blqRerank', group: '召回参数', type: 'toggle', label: 'BLQ 候选重排', desc: 'BLQ 始终输出分项；开启后只对已有候选做后置重排' },
            { key: 'includeMarkdown', group: '召回参数', type: 'toggle', label: '读取 Markdown 归档', desc: 'Markdown 与 JSON/JSONL 使用同一条倒排/BM25/NB 候选链' },
            { key: 'indexCacheMax', group: '内存管理', type: 'number', label: '倒排索引缓存上限', desc: '最多保留多少个用户/角色/mode 的记忆索引；使用 LRU 淘汰', min: 1, max: 64 },
            { key: 'nbCacheMaxVectors', group: '内存管理', type: 'number', label: 'NB 子集向量缓存上限', desc: '跨请求最多缓存多少个 300d 向量；0=每次只读、不跨请求缓存', min: 0, max: 200000 },
          ],
          setdataWrap: 'updateConfig',
          stats: {
            pipelineLoaded: !!_pipelineModule,
            activeRuns: _activeRuns,
            clearing: !!_clearPromise,
            lastRunMs: _lastRunMs,
            idleUnloadMinutes: _config.idleUnloadMinutes,
            lastCacheClear: _lastCacheClear,
          },
          description: 'P1 自驱动召回 — 本地召回管线（分词过滤→多机制发散→打分→混合排序），召回记忆记录注入主 AI 上下文',
        }
      },

      SetData: async (data) => {
        if (!data) return

        // 更新配置（写盘=跨 isolate 生效的唯一路径）
        if (data._action === 'updateConfig') {
          _loadConfigFromDisk() // 先合最新盘值
          if (data.enabled !== undefined) _config.enabled = !!data.enabled
          if (data.idleUnloadMinutes !== undefined) _config.idleUnloadMinutes = _numberInRange(data.idleUnloadMinutes, 10, 0, 60, false)
          if (data.dataRecall !== undefined) _config.dataRecall = !!data.dataRecall
          if (data.entryTopK !== undefined) _config.entryTopK = _numberInRange(data.entryTopK, 20, 5, 50, true)
          if (data.resonanceW !== undefined) _config.resonanceW = _numberInRange(data.resonanceW, 0, 0, 2, false)
          if (data.combinedMin !== undefined) _config.combinedMin = _numberInRange(data.combinedMin, 4, 2, 10, false)
          _config.nbGlobalRoute = false
          _config.deferNb300 = true
          if (data.nbRerank !== undefined) _config.nbRerank = !!data.nbRerank
          if (data.sparseTopK !== undefined) _config.sparseTopK = _numberInRange(data.sparseTopK, 100, 20, 500, true)
          if (data.bm25K1 !== undefined) _config.bm25K1 = _numberInRange(data.bm25K1, 1.2, 0.1, 3, false)
          if (data.bm25B !== undefined) _config.bm25B = _numberInRange(data.bm25B, 0.75, 0, 1, false)
          if (data.termTopK !== undefined) _config.termTopK = _numberInRange(data.termTopK, 6, 1, 20, true)
          if (data.contextMessages !== undefined) _config.contextMessages = _numberInRange(data.contextMessages, 5, 0, 5, true) // 002 0731拍板：≤5轮
          if (data.inputMaxChars !== undefined) _config.inputMaxChars = _numberInRange(data.inputMaxChars, 80, 20, 500, true)
          if (data.shortSegmentChars !== undefined) _config.shortSegmentChars = _numberInRange(data.shortSegmentChars, 10, 1, 80, true)
          if (data.excludeExactAssistantCopies !== undefined) _config.excludeExactAssistantCopies = !!data.excludeExactAssistantCopies
          if (data.recentDataTopK !== undefined) _config.recentDataTopK = _numberInRange(data.recentDataTopK, 0, 0, 50, true)
          if (data.layerWeightHot !== undefined) _config.layerWeightHot = _numberInRange(data.layerWeightHot, 1.0, 0, 2, false)
          if (data.layerWeightWarm !== undefined) _config.layerWeightWarm = _numberInRange(data.layerWeightWarm, 0.85, 0, 2, false)
          if (data.layerWeightCold !== undefined) _config.layerWeightCold = _numberInRange(data.layerWeightCold, 0.7, 0, 2, false)
          if (data.recordTopK !== undefined) _config.recordTopK = _numberInRange(data.recordTopK, 5, 1, 50, true)
          if (data.candidateMinHits !== undefined) _config.candidateMinHits = _numberInRange(data.candidateMinHits, 2, 2, 8, true)
          if (data.collapseSameFileKeywordSet !== undefined) _config.collapseSameFileKeywordSet = !!data.collapseSameFileKeywordSet
          if (data.snippetMaxChars !== undefined) _config.snippetMaxChars = _numberInRange(data.snippetMaxChars, 240, 40, 2000, true)
          if (data.injectMaxChars !== undefined) _config.injectMaxChars = _numberInRange(data.injectMaxChars, 0, 0, 20000, true)
          if (data.recencyDecayBase !== undefined) _config.recencyDecayBase = _numberInRange(data.recencyDecayBase, 0.995, 0.9, 1, false)
          if (data.blqRerank !== undefined) _config.blqRerank = !!data.blqRerank
          if (data.includeMarkdown !== undefined) _config.includeMarkdown = !!data.includeMarkdown
          if (data.indexCacheMax !== undefined) _config.indexCacheMax = _numberInRange(data.indexCacheMax, 8, 1, 64, true)
          if (data.nbCacheMaxVectors !== undefined) _config.nbCacheMaxVectors = _numberInRange(data.nbCacheMaxVectors, 50000, 0, 200000, true)
          _saveConfigToDisk()
          return { success: true, config: { ..._config } }
        }

        // 运行 P1 管线（p1Bridge 进程内调用带 data.userCtx；前端快速测试带 charName+服务端注入的 _username）
        if (data._action === 'runP1') {
          const _userCtx = data.userCtx
            || (data.charName && data._username ? { username: data._username, charName: String(data.charName) } : null)
          const result = await _runP1(
            data.inputText || '',
            data.chatHistory || [],
            data.mode || 'chat',
            _userCtx,
            { dataRecallOverride: data.dataRecallOverride }, // 请求级：打字联想传 false=不扫三层记忆
          )
          if (!result) return { success: false, p1_act: [], error: 'runPipeline returned null（插件未启用或管线失败）' }
          return {
            success: true,
            p1_act: result.p1_act || [],
            recalledRecords: result.recalledRecords || [],
            v5: result.v5 || null,
            pyramid: result.pyramid || null,
            trace: result.trace || null,
            whitebox: result.whitebox || null,
          }
        }

        // ── 词库管理（前端「词库管理」面板消费；AT 只读，用户词库 CRUD） ──
        if (data._action === 'listVocabs') {
          const at = []
          for (const m of AT_MODES) {
            const fp = join(AT_DIR, `activation_terms_${m}.json`)
            try {
              const st = Deno.statSync(fp)
              at.push({ mode: m, file: `activation_terms_${m}.json`, size: st.size, mtime: st.mtime?.getTime() || null })
            } catch { at.push({ mode: m, file: `activation_terms_${m}.json`, size: 0, mtime: null, missing: true }) }
          }
          const user = []
          try {
            for (const e of Deno.readDirSync(VOCAB_DIR)) {
              if (!e.isFile || !e.name.endsWith('.json')) continue
              try {
                const j = JSON.parse(Deno.readTextFileSync(join(VOCAB_DIR, e.name)))
                const meta = j?._meta || {}
                user.push({
                  file: e.name, name: meta.name || e.name,
                  modes: Array.isArray(meta.modes) && meta.modes.length ? meta.modes : ['all'],
                  enabled: meta.enabled !== false,
                  entryCount: j?.entries && typeof j.entries === 'object' ? Object.keys(j.entries).length : 0,
                  mtime: Deno.statSync(join(VOCAB_DIR, e.name)).mtime?.getTime() || null,
                })
              } catch { user.push({ file: e.name, name: e.name, broken: true }) }
            }
          } catch { /* vocab 目录不存在=尚无用户词库，合法 */ }
          return { success: true, at, user }
        }

        if (data._action === 'atSearch') {
          // AT 主词库搜索（只读）。9MB 级文件按 mtime 缓存单 mode 解析结果。
          const m = AT_MODES.includes(data.mode) ? data.mode : 'chat'
          const q = String(data.q || '').trim()
          if (!q) return { success: false, error: '搜索词为空' }
          const fp = join(AT_DIR, `activation_terms_${m}.json`)
          try {
            const mt = Deno.statSync(fp).mtime?.getTime() || 0
            if (!globalThis.__p1AtSearchCache || globalThis.__p1AtSearchCache.key !== `${m}:${mt}`) {
              globalThis.__p1AtSearchCache = { key: `${m}:${mt}`, data: JSON.parse(Deno.readTextFileSync(fp)) }
            }
            const atData = globalThis.__p1AtSearchCache.data
            const hits = []
            outer: for (const [dimKey, terms] of Object.entries(atData)) {
              if (!terms || typeof terms !== 'object') continue
              for (const termName of Object.keys(terms)) {
                if (termName.includes(q)) {
                  hits.push({ dim: dimKey, term: termName })
                  if (hits.length >= 50) break outer
                }
              }
            }
            return { success: true, mode: m, q, hits, truncated: hits.length >= 50 }
          } catch (e) { return { success: false, error: e.message } }
        }

        // AT 词库浏览（0731 002骂点"点击不了,查了不了"）：只读分页浏览，复用 atSearch 同款 mtime 缓存。
        //   data.dim 未给 → 回该 mode 维度列表（550个左右，一次性给全，前端本地筛/翻）；
        //   data.dim 给了 → 回该维度下词条分页（每页 limit，默认50）。词条值裁掉 axes_47 等重量级
        //   打分向量字段（仅供管线用，浏览用不上），只回 concepts 摘要，避免把整份权重表传前端。
        if (data._action === 'atBrowse') {
          const m = AT_MODES.includes(data.mode) ? data.mode : 'chat'
          const fp = join(AT_DIR, `activation_terms_${m}.json`)
          try {
            const mt = Deno.statSync(fp).mtime?.getTime() || 0
            if (!globalThis.__p1AtSearchCache || globalThis.__p1AtSearchCache.key !== `${m}:${mt}`) {
              globalThis.__p1AtSearchCache = { key: `${m}:${mt}`, data: JSON.parse(Deno.readTextFileSync(fp)) }
            }
            const atData = globalThis.__p1AtSearchCache.data
            const dim = data.dim ? String(data.dim) : ''
            if (!dim) {
              const dims = Object.entries(atData)
                .filter(([, terms]) => terms && typeof terms === 'object')
                .map(([dimKey, terms]) => ({ dim: dimKey, count: Object.keys(terms).length }))
              return { success: true, mode: m, dims }
            }
            const terms = atData[dim]
            if (!terms || typeof terms !== 'object') return { success: false, error: `维度不存在: ${dim}` }
            const names = Object.keys(terms)
            const offset = Math.max(0, Number(data.offset) || 0)
            const limit = Math.min(200, Math.max(1, Number(data.limit) || 50))
            const page = names.slice(offset, offset + limit).map((term) => {
              const v = terms[term] || {}
              return { term, concepts: Array.isArray(v.concepts) ? v.concepts : [] }
            })
            return { success: true, mode: m, dim, total: names.length, offset, limit, entries: page }
          } catch (e) { return { success: false, error: e.message } }
        }

        if (data._action === 'getUserVocab') {
          try {
            const fn = String(data.file || '').replace(/[\\/]/g, '')
            return { success: true, file: fn, content: JSON.parse(Deno.readTextFileSync(join(VOCAB_DIR, fn))) }
          } catch (e) { return { success: false, error: e.message } }
        }

        if (data._action === 'saveUserVocab') {
          // 新建/覆盖用户词库。content={_meta:{name,modes,enabled},entries:{词:[关联词]}}
          const fn = String(data.file || '').replace(/[\\/]/g, '')
          if (!fn.endsWith('.json')) return { success: false, error: '文件名必须 .json 结尾' }
          const c = data.content
          if (!c || typeof c !== 'object' || !c.entries || typeof c.entries !== 'object')
            return { success: false, error: '格式错误：需要 {_meta, entries:{词:[关联词,...]}}' }
          for (const [k, v] of Object.entries(c.entries)) {
            if (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))
              return { success: false, error: `entries["${k}"] 必须是字符串数组` }
          }
          c._meta = { name: String(c._meta?.name || fn), modes: Array.isArray(c._meta?.modes) && c._meta.modes.length ? c._meta.modes : ['all'], enabled: c._meta?.enabled !== false }
          try {
            Deno.mkdirSync(VOCAB_DIR, { recursive: true })
            const tmp = join(VOCAB_DIR, `${fn}.tmp.${Deno.pid}`)
            Deno.writeTextFileSync(tmp, JSON.stringify(c, null, 2))
            Deno.renameSync(tmp, join(VOCAB_DIR, fn))
            return { success: true, file: fn, entryCount: Object.keys(c.entries).length }
          } catch (e) { return { success: false, error: e.message } }
        }

        if (data._action === 'toggleUserVocab') {
          try {
            const fn = String(data.file || '').replace(/[\\/]/g, '')
            const fp = join(VOCAB_DIR, fn)
            const j = JSON.parse(Deno.readTextFileSync(fp))
            j._meta = { ...(j._meta || {}), enabled: !!data.enabled }
            Deno.writeTextFileSync(fp, JSON.stringify(j, null, 2))
            return { success: true, file: fn, enabled: !!data.enabled }
          } catch (e) { return { success: false, error: e.message } }
        }

        if (data._action === 'deleteUserVocab') {
          try {
            const fn = String(data.file || '').replace(/[\\/]/g, '')
            Deno.removeSync(join(VOCAB_DIR, fn))
            return { success: true, file: fn }
          } catch (e) { return { success: false, error: e.message } }
        }

        // ── P9 词库维护 AI 提示词数据件（默认件在插件目录，用户副本在 data 目录；可微调可插拔） ──
        // 注意：P9 执行器（AI runner 接入）待 002 拍板（P系列名单 P1-P8 闭案 vs 新增 P9 冲突，
        //   见 setDataActions.mjs:1371 importMemoryPreset "P系列为固定名单"守卫）。本插件先交付数据件机制。
        if (data._action === 'getP9Prompts') {
          try {
            const def = JSON.parse(Deno.readTextFileSync(join(__dirname, 'p9_prompts_default.json')))
            let user = null
            try { user = JSON.parse(Deno.readTextFileSync(join(CONFIG_DIR, 'p9_prompts.json'))) } catch { /* 无用户副本=用默认 */ }
            return { success: true, prompts: user?.prompts || def.prompts, isUserCopy: !!user, executorPending: true }
          } catch (e) { return { success: false, error: e.message } }
        }
        if (data._action === 'saveP9Prompts') {
          if (!Array.isArray(data.prompts)) return { success: false, error: 'prompts 必须是数组' }
          try {
            Deno.mkdirSync(CONFIG_DIR, { recursive: true })
            const tmp = join(CONFIG_DIR, `p9_prompts.json.tmp.${Deno.pid}`)
            Deno.writeTextFileSync(tmp, JSON.stringify({ _meta: { savedAt: Date.now() }, prompts: data.prompts }, null, 2))
            Deno.renameSync(tmp, join(CONFIG_DIR, 'p9_prompts.json'))
            return { success: true, count: data.prompts.length }
          } catch (e) { return { success: false, error: e.message } }
        }
        if (data._action === 'resetP9Prompts') {
          // 误删保护：confirm=true 才执行恢复（前端弹确认框后传 confirm:true）
          // 不传 confirm 或 confirm=false → 只返回检查结果，不做恢复
          const userFile = join(CONFIG_DIR, 'p9_prompts.json')
          let hasUserCopy = false
          try { Deno.statSync(userFile); hasUserCopy = true } catch { /* 无用户副本 */ }
          if (!data.confirm) {
            // 检查阶段：返回状态让前端决定是否弹框
            return {
              success: true,
              action: 'confirm_required',
              hasUserCopy,
              message: hasUserCopy
                ? '检测到自定义 P9 预设。恢复默认将丢失你的修改，是否恢复？'
                : '当前已是默认预设，无需恢复。',
            }
          }
          // 用户确认恢复：删除用户副本 → 自动回退到核心默认件（getP9Prompts 的读取逻辑已处理）
          if (!hasUserCopy) return { success: true, message: '已是默认预设' }
          try {
            Deno.removeSync(userFile)
            // 从核心默认件读取返回，让前端立即看到恢复后的内容
            const def = JSON.parse(Deno.readTextFileSync(join(__dirname, 'p9_prompts_default.json')))
            return { success: true, restored: true, prompts: def.prompts, message: '已从核心默认件恢复' }
          } catch (e) { return { success: false, error: e.message } }
        }

        // 手动清缓存
        if (data._action === 'unloadCaches') {
          const report = await _clearCaches()
          return { success: true, message: 'P1 可重建数据缓存已清除', report }
        }

        // 统计
        if (data._action === 'getStats') {
          _loadConfigFromDisk()
          return {
            enabled: _config.enabled,
            pipelineLoaded: !!_pipelineModule,
            activeRuns: _activeRuns,
            clearing: !!_clearPromise,
            lastRunTime: _lastRunTime || null,
            lastRunMs: _lastRunMs || null,
            idleUnloadMinutes: _config.idleUnloadMinutes,
            lastCacheClear: _lastCacheClear,
          }
        }
      },
    },
  },
}

export default pluginExport
