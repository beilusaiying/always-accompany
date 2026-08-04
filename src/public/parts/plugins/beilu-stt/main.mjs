import info from './info.json' with { type: 'json' };
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { authenticate } from "../../../../yonban/core/functions/security/auth.mjs";
import { createDownloadJobState, finalizeDownloadJobState } from "./download_job_model.mjs"; // D5 §2.3 Job DTO/终态合同(纯函数叶子,可单测)

let _sttProcess = null;
let _sttStderr = "";

// 禁机器路径默认值（凛倾 0722"看到任何系统硬编码就重做"）：python 默认走 PATH 命令名。
// 模型默认目录=仓库根 moxin/（凛倾 0722 拍板）——仓库相对路径非机器盘符;权重 1.8GB 不进
// git（.gitignore /moxin），面板内联网下载（直链/镜像）。
const DEFAULT_PYTHON_EXE = process.platform === "win32" ? "python" : "python3";
const SCRIPT_PATH = path.join(import.meta.dirname, "stt_service.py");
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../..");
const MOXIN_DIR = path.join(REPO_ROOT, "moxin");
const DEFAULT_MODEL_PATH = path.join(MOXIN_DIR, "MOSS-Transcribe-Diarize");
const HF_REPO = "OpenMOSS-Team/MOSS-Transcribe-Diarize";
// ModelScope 上的同权重仓库(20260724 核对:safetensors 尺寸 1817113576 与 HF 一致)
const MS_REPO = "OpenMOSS/MOSS-Transcribe-Diarize";
// 模型下载源（适配各地区网络）:auto=并行测速选最快;下载中单源反复失败自动切下一源断点续传
const MODEL_SOURCES = [
  { id: "auto", label: "自动选源（测速）", auto: true },
  { id: "hf", label: "HuggingFace 直链", kind: "hf", base: "https://huggingface.co", repo: HF_REPO },
  { id: "mirror", label: "hf-mirror 镜像", kind: "hf", base: "https://hf-mirror.com", repo: HF_REPO },
  { id: "modelscope", label: "ModelScope 魔搭", kind: "ms", base: "https://modelscope.cn", repo: MS_REPO },
];
const REAL_SOURCES = MODEL_SOURCES.filter((s) => !s.auto);
// ModelScope CDN 对无 UA 请求返 403(20260724 实测,带 UA 后大文件 Range 正常 206),下载请求统一带 UA
const DL_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; beilu-stt/1.0)" };
// 安装完成判据：关键文件齐且 safetensors 尺寸非零
const MODEL_KEY_FILES = ["config.json", "model-00000-of-00001.safetensors", "tokenizer.json"];

function modelInstalled(dir) {
  try {
    return MODEL_KEY_FILES.every((f) => {
      const p = path.join(dir, f);
      return fs.existsSync(p) && fs.statSync(p).size > 0;
    });
  } catch { return false; }
}

// 下载任务单槽状态（本地单用户）
let _dl = null; // { running, source, filesTotal, filesDone, currentFile, doneBytes, totalBytes, error, finished, abort }

// 源适配器:HF 系(直链/镜像)与 ModelScope 的文件列表 API、直链格式不同,差异收口在这两个函数,
// 下载引擎本体源无关(跨源故障转移/测速都走这里)。
async function _listModelFiles(source, signal) {
  if (source.kind === "ms") {
    const r = await fetch(`${source.base}/api/v1/models/${source.repo}/repo/files?Recursive=true`, { headers: DL_HEADERS, signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (!Array.isArray(j?.Data?.Files)) throw new Error(`API 响应异常 Code=${j?.Code}`);
    return j.Data.Files.filter((f) => f.Type === "blob").map((f) => ({ path: f.Path, size: f.Size || 0 }));
  }
  const r = await fetch(`${source.base}/api/models/${source.repo}/tree/main`, { headers: DL_HEADERS, signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return j.filter((f) => f.type === "file").map((f) => ({ path: f.path, size: f.size || 0 }));
}

function _modelFileUrl(source, fpath) {
  const enc = fpath.split("/").map(encodeURIComponent).join("/");
  return source.kind === "ms"
    ? `${source.base}/models/${source.repo}/resolve/master/${enc}`
    : `${source.base}/${source.repo}/resolve/main/${enc}`;
}

// 测速:文件列表可达性 + 最大文件首 256KB 实测吞吐(延迟低≠带宽大,按实际吞吐排序)
async function _probeSource(source, jobSignal) {
  const files = await _listModelFiles(source, AbortSignal.any([jobSignal, AbortSignal.timeout(12_000)]));
  const big = files.reduce((a, b) => (b.size > (a?.size || 0) ? b : a), null);
  let bps = 0;
  if (big) {
    const t0 = Date.now();
    const r = await fetch(_modelFileUrl(source, big.path), {
      headers: { ...DL_HEADERS, Range: "bytes=0-262143" },
      redirect: "follow",
      signal: AbortSignal.any([jobSignal, AbortSignal.timeout(10_000)]),
    });
    if (!(r.ok || r.status === 206) || !r.body) throw new Error(`测速 HTTP ${r.status}`);
    const reader = r.body.getReader();
    let n = 0;
    while (n < 262144) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
    }
    try { await reader.cancel(); } catch { /* 已读够,取消余量 */ }
    if (!n) throw new Error("测速无数据");
    bps = n / Math.max((Date.now() - t0) / 1000, 0.001);
  }
  return { files, bps };
}

// ── 启动进度单源(面板进度条/主聊天🎤/桌宠🎤共同消费):spawn 时建,stderr 标记推进,exit 收尾 ──
// 阶段标记来自 stt_service.py 自己的日志行与 uvicorn 固定输出;checkpoint 百分比来自
// transformers 加载分片的 tqdm(可能缺失,缺失时消费端退化为流动动画+已用时长)。
let _startup = null;
const STT_PHASE_LABELS = {
  spawning: "启动 Python 进程",
  deps: "安装缺失的 Python 依赖(首次较慢)",
  init: "服务初始化",
  loading_model: "加载模型权重",
  binding: "模型已加载,绑定端口",
  ready: "就绪",
  failed: "启动失败",
};
function _startupSnapshot() {
  if (!_startup) return null;
  return {
    phase: _startup.phase,
    label: STT_PHASE_LABELS[_startup.phase] || _startup.phase,
    pct: _startup.pct ?? null,
    error: _startup.error || null,
    elapsedS: Math.round(((_startup.endedAt || Date.now()) - _startup.startedAt) / 1000),
  };
}
function _advanceStartup(msg) {
  if (!_startup || _startup.phase === "ready" || _startup.phase === "failed") return;
  if (msg.includes("自动安装缺少的依赖")) _startup.phase = "deps";
  if (msg.includes("Starting beilu-stt on")) _startup.phase = "init";
  if (msg.includes("Loading model from")) _startup.phase = "loading_model";
  const shards = [...msg.matchAll(/Loading checkpoint shards:\s*(\d+)%/g)];
  if (shards.length) { _startup.phase = "loading_model"; _startup.pct = Number(shards[shards.length - 1][1]); }
  if (/Model loaded in [\d.]+s/.test(msg)) { _startup.phase = "binding"; _startup.pct = null; }
  if (msg.includes("Failed to load model")) {
    _startup.phase = "failed"; _startup.error = msg.slice(0, 500); _startup.endedAt = Date.now();
    return;
  }
  if (msg.includes("Uvicorn running on") || msg.includes("Application startup complete")) {
    _startup.phase = "ready"; _startup.endedAt = Date.now();
  }
}

// spawn 收口:start 路由与 ensureServiceStarted(自动连接)共用,进程句柄/守卫单源。
function _spawnSttService({ modelPath, port, pythonExe } = {}) {
  modelPath = modelPath || DEFAULT_MODEL_PATH;
  port = port || 7861;
  pythonExe = pythonExe || DEFAULT_PYTHON_EXE;
  if (!modelInstalled(modelPath)) {
    return { error: `模型未安装（${modelPath}）——请在语音转录设置的「模型」区点击下载，或指定已有模型文件夹`, httpStatus: 400 };
  }
  if (!fs.existsSync(SCRIPT_PATH)) return { error: `脚本不存在: ${SCRIPT_PATH}` };
  // 含路径分隔符=完整路径可预检；裸命令名（python）交 spawn 按 PATH 解析，ENOENT 由 error 事件报
  if (/[\\/]/.test(pythonExe) && !fs.existsSync(pythonExe)) return { error: `Python 不存在: ${pythonExe}` };

  _sttStderr = "";
  _startup = { phase: "spawning", pct: null, error: null, startedAt: Date.now(), endedAt: null };
  _sttProcess = spawn(pythonExe, [SCRIPT_PATH, "--model", modelPath, "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  // 身份守卫（20260722 实测翻车）：旧进程延迟退出时其 exit 处理器无条件置 null，
  // 会清掉此后 start 的新进程引用 → 新服务健康运行但状态误报"未运行"。只清自己。
  const child = _sttProcess;
  // 无 error 监听时 spawn ENOENT（如 PATH 上无 python）会成为进程级未捕获异常
  child.on("error", (err) => {
    const isNotFound = err.code === "ENOENT";
    const userMsg = isNotFound
      ? `未找到 Python（命令: ${pythonExe}）——请安装 Python 后重试。下载: https://www.python.org/downloads/`
      : err.message;
    console.error(`[stt] 进程启动失败: ${userMsg}`);
    _sttStderr += `\nspawn error: ${userMsg}`;
    if (_sttProcess === child) {
      _sttProcess = null;
      if (_startup && _startup.phase !== "ready" && _startup.phase !== "failed") {
        _startup.phase = "failed"; _startup.error = userMsg; _startup.endedAt = Date.now();
      }
    }
  });
  child.on("exit", (code) => {
    console.log(`[stt] 服务进程退出 code=${code} pid=${child.pid}`);
    if (code !== 0 && _sttStderr) console.error(`[stt] stderr:\n${_sttStderr.slice(-2000)}`);
    if (_sttProcess === child) {
      _sttProcess = null;
      if (_startup && _startup.phase !== "ready" && _startup.phase !== "failed") {
        _startup.phase = "failed";
        _startup.error = (_sttStderr.trim() || `进程退出 code=${code}`).slice(-500);
        _startup.endedAt = Date.now();
      }
    }
  });
  child.stderr?.on("data", (d) => {
    const msg = d.toString();
    _sttStderr += msg;
    if (_sttStderr.length > 8000) _sttStderr = _sttStderr.slice(-4000);
    if (_sttProcess === child) _advanceStartup(msg);
    const trimmed = msg.trim();
    if (trimmed) console.log(`[stt] ${trimmed}`);
  });
  child.stdout?.on("data", (d) => {
    const msg = d.toString().trim();
    if (msg) console.log(`[stt:out] ${msg}`);
  });
  return { pid: child.pid, port };
}

// 语音自动连接(凛倾 0722"点击语言,包括本体,那些都需要自动连接.而不是手动连接"):
// 服务未起时自动 spawn 并等 health(uvicorn 先载模型后绑端口,健康=可用);并发去重单飞。
// 入口:record/transcribe 代理 ECONNREFUSED 重试 + /api/eye/stt-ensure(桌宠,endpoints.mjs 直接 import)。
let _ensurePromise = null;
async function _probeSttHealth(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    let payload = null;
    try { payload = await response.json(); } catch { /* 非 JSON 健康响应 */ }
    return {
      reachable: true,
      ready: response.ok,
      error: payload?.error || payload?.detail || (response.ok ? null : `health HTTP ${response.status}`),
    };
  } catch (error) {
    return { reachable: false, ready: false, error: error?.message || String(error) };
  }
}

export async function ensureServiceStarted(port = 7861) {
  const existing = await _probeSttHealth(port);
  if (existing.ready) return { ok: true, already: true };
  // 端口已有 STT 服务响应但模型不可用，不能再 spawn 第二个进程撞端口。
  if (existing.reachable) return { ok: false, error: existing.error || "模型未就绪" };
  if (_ensurePromise) return _ensurePromise;
  _ensurePromise = (async () => {
    try {
      if (!(_sttProcess && !_sttProcess.killed)) {
        const r = _spawnSttService({ port });
        if (r.error) return { ok: false, error: r.error };
      }
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (_startup?.phase === "failed")
          return { ok: false, error: _startup.error || "模型加载失败" };
        const health = await _probeSttHealth(port);
        if (health.ready) return { ok: true };
        if (health.reachable)
          return { ok: false, error: health.error || "模型未就绪" };
        if (!(_sttProcess && !_sttProcess.killed))
          return { ok: false, error: "服务进程退出: " + _sttStderr.slice(-300) };
      }
      return { ok: false, error: "启动超时(120s)" };
    } finally {
      _ensurePromise = null;
    }
  })();
  return _ensurePromise;
}

export default {
  info,

  Load: async ({ router }) => {

    router.post('/api/parts/plugins\\:beilu-stt/start', authenticate, async (req, res) => {
      try {
        if (_sttProcess && !_sttProcess.killed) {
          // 带启动态:仍在加载模型时前端接上进度轮询,而不是只弹"已在运行中"(用户狂点刷屏根因)
          return res.json({ status: "already_running", pid: _sttProcess.pid, startup: _startupSnapshot() });
        }
        // stop→start 竞态修（20260722 实测端口 10048 复现）：kill 是异步的，旧进程退出前
        // 端口仍被占；uvicorn 先加载模型(~4s)后绑端口，新实例会在绑定时撞 10048 静默死亡。
        // 已发 SIGTERM 但尚未退出的旧进程：等它真正 exit（上限 8s）再 spawn。
        if (_sttProcess && _sttProcess.killed && _sttProcess.exitCode === null) {
          const prev = _sttProcess;
          await new Promise((resolve) => {
            const t = setTimeout(resolve, 8000);
            prev.once("exit", () => { clearTimeout(t); resolve(); });
          });
        }

        const body = req.body || {};
        const r = _spawnSttService({ modelPath: body.modelPath, port: body.port, pythonExe: body.pythonExe });
        if (r.error) return res.status(r.httpStatus || 500).json({ error: r.error });
        res.json({ status: "starting", pid: r.pid, port: r.port });
      } catch (err) {
        console.error("[stt] 启动失败:", err.message);
        res.status(500).json({ error: err.message });
      }
    });

    router.post('/api/parts/plugins\\:beilu-stt/stop', authenticate, (_req, res) => {
      if (_sttProcess && !_sttProcess.killed) {
        // 不立即置 null：保留句柄让 start 能等待退出、让 exit 处理器（身份守卫）收尾。
        // status 的 !killed 判定在 kill() 后立即变 false，对外语义仍是"已停止"。
        _startup = null; // 主动停止≠启动失败,清掉启动态防 exit 处理器误标 failed
        _sttProcess.kill("SIGTERM");
        return res.json({ status: "stopped" });
      }
      res.json({ status: "not_running" });
    });

    router.get('/api/parts/plugins\\:beilu-stt/status', authenticate, async (req, res) => {
      const running = !!(_sttProcess && !_sttProcess.killed);
      const result = { running, pid: _sttProcess?.pid || null, model_loaded: false, health_error: null };
      if (running) {
        try {
          const port = req.query?.port || 7861;
          const h = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
          if (h.ok) {
            const hd = await h.json();
            result.model_loaded = !!hd.model_loaded;
            // 健康即就绪:stderr 标记万一漏解析,以 health 实测收敛启动态(单源不留悬空"启动中")
            if (result.model_loaded && _startup && _startup.phase !== "ready") {
              _startup.phase = "ready"; _startup.endedAt ??= Date.now();
            }
          } else {
            // 503=模型加载失败(服务活着但 load_error 非空),把真实错误透出去
            try {
              const hd = await h.json();
              if (hd?.error) result.load_error = hd.error;
            } catch { /* 非 JSON 响应,忽略 */ }
          }
        } catch {
          result.health_error = "服务初始化中...";
        }
      }
      if (!running && _sttStderr) result.last_error = _sttStderr.slice(-500);
      result.startup = _startupSnapshot();
      res.json(result);
    });

    // ── 环境检测（面板引导卡数据源）──
    router.get('/api/parts/plugins\\:beilu-stt/env/check', authenticate, async (req, res) => {
      const pythonExe = req.query?.pythonExe || DEFAULT_PYTHON_EXE;
      const modelPath = req.query?.modelPath || DEFAULT_MODEL_PATH;
      // python 检测：spawn --version（裸命令名走 PATH，完整路径直接跑）
      const python = await new Promise((resolve) => {
        try {
          const p = spawn(pythonExe, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
          let out = "";
          p.stdout?.on("data", (d) => out += d.toString());
          p.stderr?.on("data", (d) => out += d.toString());
          const t = setTimeout(() => { try { p.kill(); } catch {} resolve({ ok: false, detail: "检测超时" }); }, 5000);
          p.on("error", (e) => { clearTimeout(t); resolve({ ok: false, detail: e.message }); });
          p.on("exit", (code) => { clearTimeout(t); resolve({ ok: code === 0, detail: out.trim() || `exit ${code}` }); });
        } catch (e) { resolve({ ok: false, detail: e.message }); }
      });
      let modelBytes = 0;
      try {
        if (fs.existsSync(modelPath))
          for (const f of fs.readdirSync(modelPath)) {
            try { modelBytes += fs.statSync(path.join(modelPath, f)).size; } catch {}
          }
      } catch {}
      res.json({
        python: { exe: pythonExe, ...python },
        model: { path: modelPath, defaultPath: DEFAULT_MODEL_PATH, installed: modelInstalled(modelPath), bytes: modelBytes },
        vendor: { ok: fs.existsSync(path.join(import.meta.dirname, "vendor", "moss_transcribe_diarize", "__init__.py")) },
        service: { running: !!(_sttProcess && !_sttProcess.killed), pid: _sttProcess?.pid || null, startup: _startupSnapshot() },
      });
    });

    // ── 模型下载（权重 1.8GB 不进 git；HF 直链/镜像流式下载到 moxin/）──
    router.get('/api/parts/plugins\\:beilu-stt/model/sources', authenticate, (_req, res) => {
      res.json({ sources: MODEL_SOURCES, repo: HF_REPO, targetDir: DEFAULT_MODEL_PATH });
    });

    router.get('/api/parts/plugins\\:beilu-stt/model/progress', authenticate, (_req, res) => {
      if (!_dl) return res.json({ running: false, installed: modelInstalled(DEFAULT_MODEL_PATH) });
      const { abort, ...state } = _dl;
      res.json({ ...state, installed: modelInstalled(DEFAULT_MODEL_PATH) });
    });

    router.post('/api/parts/plugins\\:beilu-stt/model/cancel', authenticate, (_req, res) => {
      if (_dl?.running) {
        // [D5 §2.3] cancel 收束语义:先标 cancelling 并 abort;terminal `cancelled` 只由后台任务的
        // finally 在所有在途 list/probe/transfer settle 后写入(finalizeDownloadJobState)。
        // .part 保留、已验证目标文件不删——取消不是 error。
        _dl.phase = "cancelling";
        _dl.note = "正在取消（等待在途连接收束，已下载部分保留）…";
        _dl.abort?.abort();
        return res.json({ status: "cancelling", jobId: _dl.jobId });
      }
      res.json({ status: "not_running" });
    });

    router.post('/api/parts/plugins\\:beilu-stt/model/download', authenticate, async (req, res) => {
      if (_dl?.running) return res.status(409).json({ error: "已有下载任务在进行" });
      const wanted = MODEL_SOURCES.find((s) => s.id === (req.body?.source || "auto")) || MODEL_SOURCES[0];
      const abort = new AbortController();
      // [D5 §2.3] Job DTO 全字段(jobId/phase/sourceOrder/probe/resumeBytes/terminalReason)单源=download_job_model.mjs
      _dl = { ...createDownloadJobState(wanted.id), abort };
      res.json({ status: "started", jobId: _dl.jobId, source: wanted.id, targetDir: DEFAULT_MODEL_PATH });

      // 后台执行（单槽,进度经 /model/progress 轮询）。抗网络波动设计（凛倾 0722 + 20260724 多源化）:
      //   ①字节级断点续传:.part 保留,重试/重启任务用 Range: bytes=N- 续传（三源实测 206;
      //     各源为同一 LFS 内容,跨源续传同一 .part 偏移有效,尺寸核对兜底）
      //   ②瞬断重试:指数退避 1s→2s→…→30s,每源上限 4 次/文件;额度用尽自动切下一源续传
      //   ③停滞看门狗:30s 无新字节判定假连接,主动断开当前尝试触发重试
      //   ④完整性:下载完按文件列表报的尺寸核对,不符删 .part 重来
      //   ⑤auto 选源:各源并行测速(列表可达+首 256KB 吞吐),按吞吐排序;手选源仍保留其余源作后备
      (async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const RETRY_MAX = 4; // 每源重试额度
        const STALL_MS = 30_000;

        const downloadFile = async (f, fileBase, ordered) => {
          const dest = path.join(DEFAULT_MODEL_PATH, f.path);
          const part = dest + ".part";
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          const { Readable, Transform } = await import("node:stream");
          const { pipeline } = await import("node:stream/promises");

          let onlyMissing = true; // 全部失败均为 404/403 时才可判"各源都没有此文件"
          let lastErr = null;
          for (const src of ordered) {
            const url = _modelFileUrl(src, f.path);
            for (let attempt = 0; attempt < RETRY_MAX; attempt++) {
              let offset = 0;
              try { if (fs.existsSync(part)) offset = fs.statSync(part).size; } catch {}
              if (f.size > 0 && offset > f.size) { try { fs.unlinkSync(part); } catch {} offset = 0; }
              _dl.resumeBytes = offset; // Job DTO:当前文件 .part 续传起点(取消/失败后即下次续传位置)

              const attemptCtrl = new AbortController();
              const onJobAbort = () => attemptCtrl.abort();
              abort.signal.addEventListener("abort", onJobAbort, { once: true });
              let lastData = Date.now();
              const watchdog = setInterval(() => {
                if (Date.now() - lastData > STALL_MS) attemptCtrl.abort(new Error("连接停滞(30s无数据)"));
              }, 5000);
              try {
                const headers = offset > 0 ? { ...DL_HEADERS, Range: `bytes=${offset}-` } : { ...DL_HEADERS };
                const r = await fetch(url, { signal: attemptCtrl.signal, redirect: "follow", headers });
                let append = offset > 0;
                if (append && r.status === 200) {
                  // 源不认 Range → 从零重下（ModelScope 小文件实测走此分支）
                  try { fs.unlinkSync(part); } catch {}
                  offset = 0; append = false;
                } else if (append && r.status !== 206) {
                  const e = new Error(`续传失败 HTTP ${r.status}`); e.httpStatus = r.status; throw e;
                }
                if (!(r.ok || r.status === 206) || !r.body) {
                  const e = new Error(`HTTP ${r.status}`); e.httpStatus = r.status; throw e;
                }

                _dl.doneBytes = fileBase + offset;
                const counter = new Transform({
                  transform(chunk, _enc, cb) {
                    lastData = Date.now();
                    this._n = (this._n || 0) + chunk.length;
                    _dl.doneBytes = fileBase + offset + this._n;
                    cb(null, chunk);
                  },
                });
                await pipeline(Readable.fromWeb(r.body), counter, fs.createWriteStream(part, append ? { flags: "a" } : {}));

                const got = fs.statSync(part).size;
                if (f.size > 0 && got !== f.size) {
                  try { fs.unlinkSync(part); } catch {}
                  throw new Error(`尺寸不符 ${got}≠${f.size}`);
                }
                fs.renameSync(part, dest);
                _dl.note = "";
                return "ok";
              } catch (e) {
                if (abort.signal.aborted) throw new Error("已取消");
                lastErr = e;
                if (e.httpStatus !== 404 && e.httpStatus !== 403) onlyMissing = false;
                // 404/403=该源没有此文件或直接拒绝,重试无意义,换下一源
                if (e.httpStatus === 404 || e.httpStatus === 403) break;
                if (attempt >= RETRY_MAX - 1) break; // 本源额度用尽,换下一源
                _dl.retries = (_dl.retries || 0) + 1;
                _dl.note = `网络波动,${Math.min(2 ** attempt, 30)}s 后重试 ${attempt + 1}/${RETRY_MAX}（${src.id}·${f.path}: ${e.message}）`;
                await sleep(Math.min(2 ** attempt, 30) * 1000);
              } finally {
                clearInterval(watchdog);
                abort.signal.removeEventListener("abort", onJobAbort);
              }
            }
            if (src !== ordered[ordered.length - 1]) {
              _dl.retries = (_dl.retries || 0) + 1;
              _dl.note = `${src.label}多次失败,切换下一下载源续传（${f.path}）`;
            }
          }
          // 各源均 404/403 的非关键文件跳过不阻断（源间文件清单有差异,如 ModelScope 多出的架构图）
          if (onlyMissing && lastErr && !MODEL_KEY_FILES.includes(path.basename(f.path))) return "skipped";
          throw new Error(`下载 ${f.path} 失败(已试 ${ordered.length} 个源): ${lastErr?.message}`);
        };

        // 速度/ETA 采样（2s 窗口）
        let lastSample = { t: Date.now(), b: 0 };
        const speedTimer = setInterval(() => {
          const now = Date.now();
          const db = _dl.doneBytes - lastSample.b, dt = (now - lastSample.t) / 1000;
          if (dt > 0) {
            _dl.speedBps = Math.max(0, Math.round(db / dt));
            _dl.etaS = _dl.speedBps > 0 ? Math.round((_dl.totalBytes - _dl.doneBytes) / _dl.speedBps) : null;
          }
          lastSample = { t: now, b: _dl.doneBytes };
        }, 2000);

        try {
          // ── 选源:auto=并行测速按吞吐排序;手选=该源优先,其余源作故障转移后备 ──
          let ordered, files = null;
          if (wanted.auto) {
            // [0804 根因修·auto 检测失败但直连能下] 原实现把测速探针（12s list + 10s/256KB Range）
            //   当下载准入门：probe 失败即整源剔除、三源全失败直接终止——而真实下载链有 30s 无字节
            //   watchdog、每源 4 次指数退避重试、跨源 .part 续传，慢网/探针被拒时照样能传输
            //   （E 现场"直连可以下载,自动检测直接失败"实证）。
            //   改为 probe 只排序不作准入：可测速的按吞吐降序在前，probe 失败的保留在尾部作故障转移；
            //   全 probe 失败时回落到与手选完全相同的 list 合同（20s/源、逐源换、任一成功即准入）。
            //   只有所有源连文件列表都取不到，才报"所有下载源不可达"。
            _dl.note = "正在选择下载源（慢网也会直接尝试下载）…";
            const probes = await Promise.all(REAL_SOURCES.map(async (s) => {
              try { return { s, ...(await _probeSource(s, abort.signal)) }; }
              catch (e) { return { s, error: e.message }; }
            }));
            if (abort.signal.aborted) throw new Error("已取消");
            const usable = probes.filter((p) => !p.error).sort((a, b) => b.bps - a.bps);
            _dl.probe = probes.map((p) => ({ id: p.s.id, label: p.s.label,
              mbps: p.error ? null : +(p.bps / 1048576).toFixed(2), error: p.error || null }));
            ordered = [...usable.map((p) => p.s), ...probes.filter((p) => p.error).map((p) => p.s)];
            files = usable[0]?.files || null; // 测速时已取到最快源的文件列表,直接复用
            if (files) {
              _dl.source = ordered[0].id;
              _dl.note = `测速完成,选用${ordered[0].label}（${(usable[0].bps / 1048576).toFixed(2)} MB/s）`;
            } else {
              // 全 probe 失败 → 与手选同一 list 合同逐源取清单（探针失败≠源不可用）
              let probeListErr = null;
              for (const src of ordered) {
                try {
                  files = await _listModelFiles(src, AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]));
                  _dl.source = src.id;
                  _dl.note = `测速均超时,已直连${src.label}获取文件列表,开始下载（慢网自适应重试/续传）`;
                  ordered = [src, ...ordered.filter((s) => s.id !== src.id)];
                  break;
                } catch (e) {
                  if (abort.signal.aborted) throw new Error("已取消");
                  probeListErr = e;
                  _dl.note = `文件列表获取失败(${src.id}: ${e.message}),换源重试`;
                }
              }
              if (!files)
                throw new Error("所有下载源不可达(文件列表均失败): " + probes.map((p) => `${p.s.id}: ${p.error}`).join("; ") + `; 最后错误: ${probeListErr?.message}`);
            }
          } else {
            ordered = [wanted, ...REAL_SOURCES.filter((s) => s.id !== wanted.id)];
            let listErr = null;
            for (const src of ordered) {
              try {
                files = await _listModelFiles(src, AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]));
                break;
              } catch (e) {
                if (abort.signal.aborted) throw new Error("已取消");
                listErr = e;
                _dl.note = `文件列表获取失败(${src.id}: ${e.message}),换源重试`;
              }
            }
            if (!files) throw new Error(`获取文件列表失败: ${listErr?.message}`);
          }

          _dl.sourceOrder = ordered.map((s) => s.id); // Job DTO:最终故障转移顺序
          if (_dl.phase === "selecting") _dl.phase = "transferring"; // cancelling 已标则不回退
          _dl.filesTotal = files.length;
          _dl.totalBytes = files.reduce((s, f) => s + (f.size || 0), 0);
          fs.mkdirSync(DEFAULT_MODEL_PATH, { recursive: true });

          let fileBase = 0;
          for (const f of files) {
            const dest = path.join(DEFAULT_MODEL_PATH, f.path);
            if (fs.existsSync(dest) && fs.statSync(dest).size === f.size) {
              _dl.filesDone++; fileBase += f.size || 0; _dl.doneBytes = fileBase; continue;
            }
            _dl.currentFile = f.path;
            const got = await downloadFile(f, fileBase, ordered);
            if (got === "skipped") {
              _dl.skipped = (_dl.skipped || 0) + 1;
              _dl.note = `跳过 ${f.path}（各源均无此文件,非关键文件不阻断）`;
            }
            fileBase += f.size || 0;
            _dl.doneBytes = fileBase;
            _dl.filesDone++;
          }
          _dl.finished = true;
        } catch (e) {
          if (!abort.signal.aborted) _dl.error = e.message; // 取消不是 error(终态由 finalize 单点裁决)
          console.error("[stt] 模型下载" + (abort.signal.aborted ? "已取消:" : "失败:"), e.message);
        } finally {
          clearInterval(speedTimer);
          // [D5 §2.3] 终态收束单点:此刻所有在途 list/probe/transfer 已 settle(同一 async 任务内),
          // cancelling→cancelled / 完成→completed / 其余→failed;字段合同见 download_job_model.mjs。
          Object.assign(_dl, finalizeDownloadJobState({
            aborted: abort.signal.aborted, finished: _dl.finished, errorMessage: _dl.error,
          }));
          _dl.currentFile = "";
        }
      })();
    });

    // 后端录音代理:record/* 全部透传 Python 服务(devices/probe/start/status/stop/audio/transcribe)。
    // audio 是二进制 WAV(试听回放),其余 JSON。
    const proxyRecord = async (req, res) => {
      const port = req.query?.port || req.body?.port || 7861;
      const action = req.params.action;
      const doFetch = () => fetch(`http://127.0.0.1:${port}/record/${action}`, req.method === "POST"
        ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req.body || {}) }
        : {});
      try {
        let resp;
        try {
          resp = await doFetch();
        } catch (e) {
          // 自动连接(凛倾 0722):服务没起=自动拉起再重试一次,不把 ECONNREFUSED 甩给用户
          const ens = await ensureServiceStarted(port);
          if (!ens.ok) return res.status(503).json({ error: "STT 服务自动启动失败: " + ens.error });
          resp = await doFetch();
        }
        if (action === "audio" && resp.ok) {
          res.set("Content-Type", "audio/wav");
          return res.send(Buffer.from(await resp.arrayBuffer()));
        }
        return res.status(resp.status).json(await resp.json());
      } catch (err) {
        console.error("[stt] 录音代理失败:", err.message);
        res.status(502).json({ error: "STT 服务不可达: " + err.message });
      }
    };
    router.post('/api/parts/plugins\\:beilu-stt/record/:action', authenticate, proxyRecord);
    router.get('/api/parts/plugins\\:beilu-stt/record/:action', authenticate, proxyRecord);

    router.post('/api/parts/plugins\\:beilu-stt/transcribe', authenticate, async (req, res) => {
      try {
        const port = req.body?.port || 7861;
        // 自动连接(凛倾 0722):转录前确保服务在(没起自动拉起并等模型加载)
        const ens = await ensureServiceStarted(port);
        if (!ens.ok) return res.status(503).json({ error: "STT 服务自动启动失败: " + ens.error });
        const resp = await fetch(`http://127.0.0.1:${port}/transcribe_json`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            audioBase64: req.body?.audioBuffer || "",
            fileName: req.body?.fileName || "audio.webm",
            language: req.body?.language || "auto",
            max_new_tokens: req.body?.max_new_tokens || 8192,
            hotwords: req.body?.hotwords || "",
            denoise: !!req.body?.denoise,
          }),
        });
        if (!resp.ok) {
          const errText = await resp.text();
          return res.status(resp.status).json({ error: errText });
        }
        const result = await resp.json();
        res.json(result);
      } catch (err) {
        console.error("[stt] 转录请求失败:", err.message);
        res.status(502).json({ error: "STT 服务不可达: " + err.message });
      }
    });
  },

  interfaces: {
    config: {
      GetData: async () => ({
        running: !!(_sttProcess && !_sttProcess.killed),
        pid: _sttProcess?.pid || null,
      }),
      SetData: async () => {},
    },
  },
};
