"""p1_server.py — P1 召回独立服务（单独/可插拔/可独立运行，002 2026-07-31 拍板）。

功能链：
    启动: python p1_server.py [--port N]   ← 完全脱离本体，独立启动即全功能（拉线测试入口）
    本体侧: shells/p1/main.mjs 薄壳把 /api/parts/shells:p1/service/<action> 代理到这里
    路由: GET /health | POST /runP1 /clearCaches /unloadCaches /getConfig /setConfig /updateConfig
          /getStats /getData
          POST /listVocabs /atSearch /atBrowse /getUserVocab /saveUserVocab /toggleUserVocab /deleteUserVocab
          POST /getP9Prompts /saveP9Prompts /resetP9Prompts
          POST /getRunLogInfo /getRunLog（运行记录：每次真实召回输出落盘 JSONL，前端展示位置+点击打开）
    管线: pipeline/ 包（p1_pipeline_py.run_pipeline 入口）——零本体依赖，词库/记忆路径全走 p1_config

why FastAPI：环境已装（0.135），JSON 契约自动校验；只绑 127.0.0.1，鉴权由本体薄壳做，
    直连场景（拉线测试）本机信任。username 取 X-P1-Username header（薄壳注入）或 body.username（直连测试）。
影响范围：新服务，不改任何本体文件。返回字段形状与旧插件 SetData 各 action 逐字段一致（前端零改动）。
"""
from __future__ import annotations

import argparse
import json
import re
import time
import urllib.parse
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from p1_config import get_config, get_user_config, update_config, update_user_config, DEFAULTS, DATA_DIR

app = FastAPI(title="P1 Recall Service", docs_url=None, redoc_url=None)

_SERVICE_DIR = Path(__file__).resolve().parent


def _ensure_resources():
    """大文件自解压: git 仓库放 zip 压缩包(每个<100MB), 首次启动自动解压原始文件(用户零配置)。
    nb_vec_int8.npy 拆成 part0+part1 两个 zip, 解压后合并。"""
    cfg = get_config()
    res_root = Path(cfg.get("resourceDir") or "")
    derived = res_root / "p1_res" / "p1v2_derived"
    if not derived.is_dir():
        return
    import zipfile
    _UNPACK = [
        {"target": "nb_vec_int8.npy", "zips": ["nb_vec_int8.part0.zip", "nb_vec_int8.part1.zip"], "merge": True},
        {"target": "userdict_domain_full.txt", "zips": ["userdict_domain_full.zip"], "merge": False},
        {"target": "conceptnet_en.json", "zips": ["conceptnet_en.zip"], "merge": False},
    ]
    for item in _UNPACK:
        target = derived / item["target"]
        if target.exists() and target.stat().st_size > 0:
            continue
        zips = [derived / z for z in item["zips"]]
        if not all(z.exists() for z in zips):
            continue
        total_mb = sum(z.stat().st_size for z in zips) // 1048576
        print(f"[p1_server] 首次启动解压: {item['target']}（{len(zips)} 个 zip, {total_mb}MB 压缩）...")
        try:
            if item["merge"]:
                with open(target, "wb") as out:
                    for zp in zips:
                        with zipfile.ZipFile(zp, "r") as zf:
                            name = zf.namelist()[0]
                            out.write(zf.read(name))
            else:
                with zipfile.ZipFile(zips[0], "r") as zf:
                    zf.extractall(derived)
            print(f"[p1_server] ✓ {item['target']} ({target.stat().st_size // 1048576}MB)")
        except Exception as e:
            print(f"[p1_server] ✗ {item['target']} 解压失败: {e}")
            if target.exists():
                target.unlink()
_started_at = time.time()
_pipeline_mod = None
_pipeline_err: str | None = None

# runP1 运行态统计（旧插件 main.mjs _lastRunTime/_lastRunMs/_lastDirWordCount 平移；
# 独立服务无 idle 卸载/activeRuns 并发计数概念，getStats/getData 里那几个字段诚实给 null，不编造）
_last_run_time: int | None = None
_last_run_ms: float | None = None
_last_dir_word_count: int | None = None

AT_MODES = ("chat", "code", "work", "airp")
_VOCAB_NAME_RE = re.compile(r"^[\w\-. 一-鿿]+\.json$")
_at_cache: dict[str, tuple[float, dict]] = {}  # mode -> (mtime, parsed)；atSearch/atBrowse 共用，对照旧插件 globalThis.__p1AtSearchCache

_P9_DEFAULT_FILE = _SERVICE_DIR / "p9_prompts_default.json"
_P9_USER_FILE = DATA_DIR / "p9_prompts.json"

# 运行记录（0731 002"每次输出都需要进行文件记录"）：每次真实召回（打字联想轻量路除外——
# 400ms 防抖高频会刷盘）按天追加 JSONL 到 data/runs/；前端 p1run「运行记录」卡片经
# /getRunLogInfo /getRunLog 只读消费（记录文件位置+点击打开）。保留天数可配，跨天首写自动清过期。
_RUNS_FALLBACK = DATA_DIR / "runs"
_RUN_LOG_NAME_RE = re.compile(r"^p1_runs_\d{4}-\d{2}-\d{2}\.jsonl$")


def _runs_dir_for(username: str = "", char_name: str = "") -> Path:
    """角色卡级运行记录目录: 有 user+char → memory/p1_runs/; 无 → 全局兜底 service/data/runs/"""
    if username and char_name:
        cfg = get_config()
        d = Path(cfg["dataRoot"]) / username / "chars" / char_name / "memory" / "p1_runs"
    else:
        d = _RUNS_FALLBACK
    d.mkdir(parents=True, exist_ok=True)
    return d


def _append_run_log(entry: dict[str, Any]) -> None:
    """追加一条运行记录。失败只打印不抛——记录是旁路观测，绝不反噬召回主链返回值。"""
    if get_config().get("runLogEnabled") is False:
        return
    try:
        runs = _runs_dir_for(entry.get("user") or "", entry.get("char") or "")
        fp = runs / f"p1_runs_{time.strftime('%Y-%m-%d')}.jsonl"
        is_new_file = not fp.exists()
        with fp.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        if is_new_file:
            _prune_run_logs(runs)
    except OSError as e:
        print(f"[p1_server] 运行记录写入失败（不影响召回）: {e}")


def _prune_run_logs(runs_dir: Path | None = None) -> None:
    keep_days = int(get_config().get("runLogKeepDays") or 0)
    if keep_days <= 0:
        return
    cutoff = time.time() - keep_days * 86400
    target = runs_dir or _RUNS_FALLBACK
    try:
        for p in target.glob("p1_runs_*.jsonl"):
            if not _RUN_LOG_NAME_RE.match(p.name):
                continue
            try:
                day_ts = time.mktime(time.strptime(p.name[8:18], "%Y-%m-%d")) + 86399
                if day_ts < cutoff:
                    p.unlink()
            except (ValueError, OSError):
                continue  # 单文件解析/删除失败不阻塞其余清理
    except OSError:
        pass  # runs 目录不存在=无可清理


def _pipeline():
    """延迟加载管线（首次 runP1 才付词库初始化成本；加载失败记录原因，响亮报错不吞）。"""
    global _pipeline_mod, _pipeline_err
    if _pipeline_mod is None and _pipeline_err is None:
        try:
            from pipeline import p1_pipeline_py  # noqa: PLC0415
            _pipeline_mod = p1_pipeline_py
        except Exception as e:  # noqa: BLE001 — 启动期缺件要完整报因
            _pipeline_err = f"{type(e).__name__}: {e}"
    return _pipeline_mod


def _username(req: Request, body: dict) -> str:
    raw = req.headers.get("x-p1-username") or ""
    # main.mjs 用 encodeURIComponent 编码 username（非 ASCII 安全过 HTTP header），这里对称解码
    return urllib.parse.unquote(raw) if raw else str(body.get("username") or "")


@app.get("/health")
async def health() -> dict[str, Any]:
    cfg = get_config()
    pl = _pipeline()
    return {
        "ok": True,
        "service": "p1-recall",
        "uptimeSec": round(time.time() - _started_at, 1),
        "pipelineLoaded": pl is not None,
        "pipelineError": _pipeline_err,
        "enabled": cfg.get("enabled", True),
    }


# ── P1v2 node 常驻子进程(0801: runP1 引擎切到 node 白盒新管线;config.engine="python" 可切回旧管线) ──
# why 常驻: node 侧词库+HanLP 加载秒级,每请求 spawn 不可用
# 多路复用: requestId 标识并发请求, Node 侧 async 处理, 响应行带 _rid 对应回调
import json as _njson
import os as _nos
import subprocess as _nsp
import threading as _nth
import uuid as _uuid

_NODE_STDIO = _nos.path.normpath(_nos.path.join(
    _nos.path.dirname(_nos.path.abspath(__file__)),
    "..", "..", "..", "..", "..", "yonban", "core", "functions", "memory", "p1", "p1_service_stdio.mjs"))
_node_state: dict[str, Any] = {"proc": None, "err": None}
_node_write_lock = _nth.Lock()
_node_pending: dict[str, _nth.Event] = {}
_node_results: dict[str, dict] = {}
_node_reader_started = False


def _node_ensure():
    global _node_reader_started
    p = _node_state["proc"]
    if p is not None and p.poll() is None:
        return p
    try:
        p = _nsp.Popen(["node", _NODE_STDIO], stdin=_nsp.PIPE, stdout=_nsp.PIPE, stderr=_nsp.DEVNULL,
                       text=True, encoding="utf-8", bufsize=1,
                       cwd=_nos.path.dirname(_NODE_STDIO))
        p.stdout.readline()  # 启动握手行 {"ready":true}
        _node_state["proc"] = p
        _node_state["err"] = None
        if not _node_reader_started:
            _node_reader_started = True
            _nth.Thread(target=_node_reader_loop, daemon=True).start()
        return p
    except Exception as e:  # noqa: BLE001
        _node_state["err"] = f"{type(e).__name__}: {e}"
        return None


def _node_reader_loop():
    """后台线程: 持续读 Node stdout, 按 _rid 分发响应到对应的等待者"""
    while True:
        p = _node_state.get("proc")
        if p is None or p.poll() is not None:
            import time; time.sleep(0.5)
            continue
        try:
            line = p.stdout.readline()
        except Exception:
            continue
        if not line:
            _node_state["proc"] = None
            for rid, ev in list(_node_pending.items()):
                _node_results[rid] = {"error": "node 子进程无响应(已标记重启)"}
                ev.set()
            _node_pending.clear()
            continue
        try:
            data = _njson.loads(line)
        except Exception:
            continue
        rid = data.pop("_rid", None)
        if rid and rid in _node_pending:
            _node_results[rid] = data
            _node_pending[rid].set()


def _node_call(payload: dict[str, Any]) -> dict[str, Any]:
    with _node_write_lock:
        p = _node_ensure()
    if p is None:
        raise RuntimeError(f"node 子进程不可用: {_node_state['err']}")
    rid = _uuid.uuid4().hex[:12]
    payload["_rid"] = rid
    ev = _nth.Event()
    _node_pending[rid] = ev
    try:
        with _node_write_lock:
            p.stdin.write(_njson.dumps(payload, ensure_ascii=False) + "\n")
            p.stdin.flush()
        if not ev.wait(timeout=60):
            raise RuntimeError("node 子进程响应超时(60s)")
        return _node_results.pop(rid, {"error": "response lost"})
    finally:
        _node_pending.pop(rid, None)
        _node_results.pop(rid, None)


@app.post("/runP1")
async def run_p1(req: Request) -> JSONResponse:
    body = await req.json()
    username = _username(req, body)
    cfg = get_user_config(username)
    if not cfg.get("enabled", True):
        return JSONResponse({"success": False, "p1_act": [], "error": "P1 服务已禁用 (config.enabled=false)"})
    _engine = str(cfg.get("engine") or "node")  # 0801: 默认 node 白盒新管线
    pl = None
    if _engine != "node":
        pl = _pipeline()
        if pl is None:
            return JSONResponse({"success": False, "p1_act": [], "error": f"管线未就绪: {_pipeline_err}"}, status_code=500)
    char_name = str(body.get("charName") or "")
    # recallConfig 组装（旧插件 _runP1 L221-251 职责平移）：config 平铺键 → runtime_config.recall；
    # dataRecallOverride=请求级轻量开关（打字联想传 false），不动全局 config
    dro = body.get("dataRecallOverride")
    # 运行记录来源标注：前端快测 payload 自带 source:"panel-test"；生产线 p1Bridge 不带=按 bridge 记
    _src_tag = str(body.get("source") or "bridge")
    _log_this = dro is not False  # 打字联想轻量路（dataRecallOverride=false 高频）不记录
    recall_cfg = {
        "recallOnly": True,
        "dataRecall": (dro is True) if dro is not None else (cfg.get("dataRecall") is not False),
        **{k: cfg[k] for k in (
            "entryTopK", "resonanceW", "combinedMin", "nbGlobalRoute", "deferNb300", "nbRerank",
            "sparseTopK", "bm25K1", "bm25B", "termTopK", "contextMessages", "inputMaxChars",
            "shortSegmentChars", "excludeExactAssistantCopies", "recentDataTopK", "recordTopK",
            "candidateMinHits", "collapseSameFileKeywordSet", "snippetMaxChars", "injectMaxChars",
            "recencyDecayBase", "blqRerank", "includeMarkdown", "indexCacheMax", "nbCacheMaxVectors",
        ) if k in cfg},
        "layerWeights": {  # [0731 配置通道] 三平铺键组装为对象 → node0 dImp 消费
            "hot": cfg.get("layerWeightHot", 1.0),
            "warm": cfg.get("layerWeightWarm", 0.85),
            "cold": cfg.get("layerWeightCold", 0.7),
        },
    }
    user_ctx = {"username": username, "charName": char_name} if (username or char_name) else None
    global _last_run_time, _last_run_ms, _last_dir_word_count
    t0 = time.time()
    try:
        if _engine == "node":
            result = _node_call({
                "action": "runP1",
                "inputText": str(body.get("inputText") or ""),
                "chatHistory": body.get("chatHistory") or [],
                "mode": str(body.get("mode") or "chat"),
                "username": username,
                "charName": char_name,
                "chatId": str(body.get("chatId") or ""),
                "config": cfg,
            })
        else:
            result = pl.run_pipeline(
                str(body.get("inputText") or ""),
                body.get("chatHistory") or [],
                str(body.get("mode") or "chat"),
                user_ctx=user_ctx,
                runtime_config={"recall": recall_cfg},
            )
    except Exception as e:  # noqa: BLE001 — 管线异常按契约回 error，调用方走降级链
        _last_run_ms = round((time.time() - t0) * 1000, 1)
        if _log_this:  # 失败也如实记录（调用发生了但无输出）
            _append_run_log({
                "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "source": _src_tag,
                "mode": str(body.get("mode") or "chat"), "ms": _last_run_ms, "success": False,
                "user": username or None, "char": char_name or None,
                "input": str(body.get("inputText") or "")[:500],
                "error": f"{type(e).__name__}: {e}",
            })
        return JSONResponse({"success": False, "p1_act": [], "error": f"{type(e).__name__}: {e}"}, status_code=500)
    if not result:
        _last_run_ms = round((time.time() - t0) * 1000, 1)
        if _log_this:
            _append_run_log({
                "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "source": _src_tag,
                "mode": str(body.get("mode") or "chat"), "ms": _last_run_ms, "success": False,
                "user": username or None, "char": char_name or None,
                "input": str(body.get("inputText") or "")[:500],
                "error": "runPipeline returned null",
            })
        return JSONResponse({"success": False, "p1_act": [], "error": "runPipeline returned null"})
    # runP1 成功路径记录统计（旧插件 main.mjs _runP1 L269-271 平移）：getStats/getData 消费
    _last_run_time = int(time.time() * 1000)
    _last_run_ms = round((time.time() - t0) * 1000, 1)
    _last_dir_word_count = len(result.get("p1_act") or [])
    # 每次输出落盘记录（0731 002）：方向词+召回记忆全量（记忆 content 已经管线 snippet 截断）
    if _log_this:
        _append_run_log({
            "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "source": _src_tag,
            "mode": str(body.get("mode") or "chat"), "ms": _last_run_ms, "success": True,
            "user": username or None, "char": char_name or None,
            "input": str(body.get("inputText") or "")[:500],
            "p1_act": result.get("p1_act") or [],
            "directionWords": result.get("directionWords") or [],
            "recalledRecords": [
                {"layer": (r or {}).get("layer"), "matchedTerms": (r or {}).get("matchedTerms") or [], "content": (r or {}).get("content") or ""}
                for r in (result.get("recalledRecords") or [])
            ],
        })
    # 返回块与旧插件 main.mjs runP1 返回逐字段一致（前端/p1Bridge 消费方零改动）
    return JSONResponse({
        "success": True,
        "p1_act": result.get("p1_act", []),
        "recalledRecords": result.get("recalledRecords", []),
        "v5": result.get("v5"),
        "directionWords": result.get("directionWords", []),
        "pyramid": result.get("pyramid"),
        "trace": result.get("trace"),
        "whitebox": result.get("whitebox"),
    })


@app.post("/clearCaches")
async def clear_caches(req: Request) -> dict[str, Any]:
    body = await req.json()
    pl = _pipeline()
    if pl is None:
        return {"success": False, "error": f"管线未就绪: {_pipeline_err}"}
    tier = str(body.get("tier") or "light")
    report = pl.clear_p1_runtime_caches({"tier": tier})  # 签名对照 pipeline/p1_pipeline_py.py:104（JS clearP1RuntimeCaches(opts) 平移）
    return {"success": True, "tier": tier, "report": report}


@app.post("/getConfig")
async def get_config_action(_req: Request) -> dict[str, Any]:
    return {"success": True, "config": get_config(), "defaults": DEFAULTS}


@app.post("/setConfig")
async def set_config_action(req: Request) -> dict[str, Any]:
    body = await req.json()
    cfg = update_config({k: v for k, v in body.items() if k != "username"})
    return {"success": True, "config": cfg}


@app.post("/updateConfig")
async def update_config_action(req: Request) -> dict[str, Any]:
    """verb 名对齐前端（p1panel.mjs 发 updateConfig）；逻辑与 /setConfig 等价，返回形状对照旧插件
    main.mjs SetData _action==='updateConfig'：{success, config:{...}}。/setConfig 路由保留不删。"""
    body = await req.json()
    cfg = update_config({k: v for k, v in body.items() if k != "username"})
    return {"success": True, "config": cfg}


@app.post("/getStats")
async def get_stats(_req: Request) -> dict[str, Any]:
    """对照旧插件 main.mjs SetData _action==='getStats' 返回形状；独立服务无 idle 卸载调度/
    activeRuns 并发计数/清理串行化概念（旧插件那套是宿主插件生命周期机制）——这些字段诚实给 null，
    不编造假数据顶替（凛倾"半接线/离线兜底≠通行证"守则）。"""
    cfg = get_config()
    pl = _pipeline()
    return {
        "enabled": cfg.get("enabled", True),
        "pipelineLoaded": pl is not None,
        "activeRuns": None,
        "clearing": None,
        "lastRunTime": _last_run_time,
        "lastRunMs": _last_run_ms,
        "lastDirWordCount": _last_dir_word_count,
        "idleUnloadMinutes": None,
        "lastCacheClear": None,
    }


@app.post("/unloadCaches")
async def unload_caches(req: Request) -> dict[str, Any]:
    """clearCaches 别名（旧插件 main.mjs unloadCaches action 同名不同返回形状：message 字段），tier 透传。"""
    body = await req.json()
    pl = _pipeline()
    if pl is None:
        return {"success": False, "error": f"管线未就绪: {_pipeline_err}"}
    tier = str(body.get("tier") or "deep")  # 旧插件手动清缓存默认走 deep（_clearCaches() 无 opts）
    report = pl.clear_p1_runtime_caches({"tier": tier})
    return {"success": True, "message": "P1 可重建数据缓存已清除", "report": report}


# 控件元数据单源下发（0722 禁前端硬编码：min/max/desc 权威在后端）。旧插件 main.mjs GetData
# L340-369 全量平移（29 条），仅删 idleUnloadMinutes 一条——宿主插件空闲卸载调度键，独立服务
# 无该生命周期概念，不适用。desc 文案里原有"插件"字样按本次任务口径改"服务"（此列表全文无该措辞，
# 核对后确认无需改字）。
_CONTROL_META: list[dict[str, Any]] = [
    {"key": "enabled", "group": "基础设置", "type": "toggle", "label": "启用 P1 自驱动召回", "desc": "开启后每次对话自动运行本地联想召回管线产出方向词；首次向量加载会明显较慢"},
    {"key": "dataRecall", "group": "召回参数", "type": "toggle", "label": "记忆 Data 召回", "desc": "启用记忆三层（热/温/冷）擦边召回"},
    {"key": "entryTopK", "group": "召回参数", "type": "number", "label": "条目 Top-K", "desc": "多维排序后取前 K 个子条目提词", "min": 5, "max": 50},
    {"key": "resonanceW", "group": "召回参数", "type": "number", "label": "共振权重", "desc": "多路共振加分权重（0=关闭共振）", "min": 0, "max": 2, "step": 0.1},
    {"key": "combinedMin", "group": "召回参数", "type": "number", "label": "锚点最低门槛", "desc": "上下文锚点 combined 最低分（002 定档=4）", "min": 2, "max": 10},
    {"key": "nbRerank", "group": "召回参数", "type": "toggle", "label": "NB300 候选重排", "desc": "只对稀疏候选做语义复核，不扫描零字面命中的全库条目"},
    {"key": "sparseTopK", "group": "召回参数", "type": "number", "label": "稀疏候选 Top-K", "desc": "进入 NB300 末段前最多保留的条目数", "min": 20, "max": 500},
    {"key": "bm25K1", "group": "召回参数", "type": "number", "label": "BM25 K1", "desc": "词频饱和强度；标准默认 1.2", "min": 0.1, "max": 3, "step": 0.1},
    {"key": "bm25B", "group": "召回参数", "type": "number", "label": "BM25 B", "desc": "条目长度归一强度；标准默认 0.75", "min": 0, "max": 1, "step": 0.05},
    {"key": "termTopK", "group": "召回参数", "type": "number", "label": "条目提词 Top-K", "desc": "每条候选最多贡献的语义词和稀疏 OOV 词总数；不会用 NB 缺词做硬删除", "min": 1, "max": 20},
    {"key": "contextMessages", "group": "召回输入", "type": "number", "label": "用户上下文条数", "desc": "仅取最近用户消息；assistant 不进入召回；上限5轮（002定档：长历史会稀释 data 召回）", "min": 0, "max": 5},
    {"key": "inputMaxChars", "group": "召回输入", "type": "number", "label": "输入软上限", "desc": "超长输入优先保留完整尾句，默认沿用历史 80 字契约", "min": 20, "max": 500},
    {"key": "shortSegmentChars", "group": "召回输入", "type": "number", "label": "短句合并阈值", "desc": "超长消息中连续短句先合并再执行软上限", "min": 1, "max": 80},
    {"key": "excludeExactAssistantCopies", "group": "召回输入", "type": "toggle", "label": "排除整段 AI 复制", "desc": "用户文本与更早 assistant 完整规范化文本相同时不进入召回上下文"},
    {"key": "recentDataTopK", "group": "召回参数", "type": "number", "label": "最近 Data 数", "desc": '把最近 N 条记忆的名词并入召回上下文（记忆连续性）。0=关闭：检索只看当前输入，弱输入时不再召回"最近记忆"（英文/短句场景更准）', "min": 0, "max": 50},
    {"key": "recordTopK", "group": "召回参数", "type": "number", "label": "记录召回 Top-K", "desc": "最终返回并注入主 AI 的记忆记录数", "min": 1, "max": 50},
    {"key": "candidateMinHits", "group": "召回参数", "type": "number", "label": "候选最低命中数", "desc": "倒排候选至少命中的独立词数；最低为 2，避免单词暴力匹配", "min": 2, "max": 8},
    {"key": "layerWeightHot", "group": "召回参数", "type": "number", "label": "热层排序权重", "desc": '当天记忆(hot)在排序中的层级加权；调低可减少"最近的记忆压过更相关的记忆"', "min": 0, "max": 2, "step": 0.05},
    {"key": "layerWeightWarm", "group": "召回参数", "type": "number", "label": "温层排序权重", "desc": "近期记忆(warm)的层级加权", "min": 0, "max": 2, "step": 0.05},
    {"key": "layerWeightCold", "group": "召回参数", "type": "number", "label": "冷层排序权重", "desc": "归档记忆(cold)的层级加权", "min": 0, "max": 2, "step": 0.05},
    {"key": "collapseSameFileKeywordSet", "group": "召回参数", "type": "toggle", "label": "合并同文件同关键词版本", "desc": "同一文件、同一关键词集合且都有事件时间时，只保留排序更高的版本"},
    {"key": "snippetMaxChars", "group": "召回参数", "type": "number", "label": "记录摘要上限", "desc": "单条召回记录最多进入注入数据的字符数", "min": 40, "max": 2000},
    {"key": "injectMaxChars", "group": "召回参数", "type": "number", "label": "注入总字数上限", "desc": "输出线：按关联度从高到低保留，到达字数后低关联记录整条删除；0=不限制", "min": 0, "max": 20000},
    {"key": "recencyDecayBase", "group": "召回参数", "type": "number", "label": "时近衰减基数", "desc": "按小时计算的 recency 衰减；无时间记录不伪造为当前时间", "min": 0.9, "max": 1, "step": 0.001},
    {"key": "blqRerank", "group": "召回参数", "type": "toggle", "label": "BLQ 候选重排", "desc": "BLQ 始终输出分项；开启后只对已有候选做后置重排"},
    {"key": "includeMarkdown", "group": "召回参数", "type": "toggle", "label": "读取 Markdown 归档", "desc": "Markdown 与 JSON/JSONL 使用同一条倒排/BM25/NB 候选链"},
    {"key": "indexCacheMax", "group": "内存管理", "type": "number", "label": "倒排索引缓存上限", "desc": "最多保留多少个用户/角色/mode 的记忆索引；使用 LRU 淘汰", "min": 1, "max": 64},
    {"key": "nbCacheMaxVectors", "group": "内存管理", "type": "number", "label": "NB 子集向量缓存上限", "desc": "跨请求最多缓存多少个 300d 向量；0=每次只读、不跨请求缓存", "min": 0, "max": 200000},
    {"key": "vocabEditMaxChanges", "group": "词库管理", "type": "number", "label": "P9 单次改动上限", "desc": "AI 一次 <vocab_edit> 最多改动的词条数，超限拒绝（防失控大改）", "min": 1, "max": 200},
    {"key": "atSearchMaxHits", "group": "高级", "type": "number", "label": "AT 搜索命中上限", "desc": "AT 主词库搜索（atSearch）单次最多返回的命中条数，超出截断", "min": 1, "max": 500},
    {"key": "atBrowseLimitDefault", "group": "高级", "type": "number", "label": "AT 浏览分页默认条数", "desc": "atBrowse 未指定 limit 时每页默认返回的词条数", "min": 1, "max": 200},
    {"key": "atBrowseLimitMax", "group": "高级", "type": "number", "label": "AT 浏览分页上限", "desc": "atBrowse limit 参数的钳制上限，防止单页请求过大", "min": 50, "max": 1000},
    {"key": "typingDebounceMs", "group": "召回输入", "type": "number", "label": "打字联想防抖(ms)", "desc": "输入框停顿多久后触发一次打字式联想请求", "min": 100, "max": 3000},
    {"key": "typingMinChars", "group": "召回输入", "type": "number", "label": "打字联想触发门槛(字)", "desc": "输入不足该字数时不触发打字式联想", "min": 1, "max": 20},
    {"key": "runLogEnabled", "group": "运行记录", "type": "toggle", "label": "召回输出落盘记录", "desc": "每次真实召回把输出按天写入 JSONL 记录文件（打字联想轻量调用不记录）；文件位置见「运行记录」卡片"},
    {"key": "runLogKeepDays", "group": "运行记录", "type": "number", "label": "记录保留天数", "desc": "跨天写入时自动删除过期记录文件；0=永久保留", "min": 0, "max": 3650},
    # ── P1v2 白盒新管线(0801) ──
    {"key": "engine", "group": "引擎", "type": "select", "label": "召回引擎", "desc": "node=白盒新管线 / python=旧管线(回退通道)", "options": ["node", "python"]},
    {"key": "dataCount", "group": "召回输入", "type": "number", "label": "Data 召回条数", "desc": "data 记忆最近 N 条进召回语境", "min": 0, "max": 20},
    {"key": "inputMaxWords", "group": "召回输入", "type": "number", "label": "分词截断上限(词)", "desc": "分词后按词数截断,头尾保留", "min": 20, "max": 500},
    {"key": "truncHeadRatio", "group": "召回输入", "type": "number", "label": "截断头段占比", "desc": "0.5=头尾各半; 0.3=头30%尾70%", "min": 0.1, "max": 0.9, "step": 0.1},
    {"key": "aiOutputCount", "group": "召回输入", "type": "number", "label": "AI输出召回条数", "desc": "code/work 模式检测 AI 最近 N 条输出做召回触发源(0=关闭)", "min": 0, "max": 5},
    {"key": "ctxWordsPerUnit", "group": "召回输入", "type": "number", "label": "上下文每条取词数", "desc": "非当前输入的上下文/data 每条取 N 个低频词做锚", "min": 1, "max": 10},
    {"key": "concFloor", "group": "分词过滤", "type": "number", "label": "中文具体性下限", "desc": "具体性评分低于此值的虚化词过滤(1-5量表,5=最具体)", "min": 1.0, "max": 5.0, "step": 0.1},
    {"key": "enConcFloor", "group": "分词过滤", "type": "number", "label": "英文具体性下限", "desc": "同上(英文 brysbaert 量表)", "min": 1.0, "max": 5.0, "step": 0.1},
    {"key": "enFreqHigh", "group": "分词过滤", "type": "number", "label": "英文高频排除线", "desc": "ECDICT 词频超此值排除(0=只标注不过滤)", "min": 0, "max": 99999999},
    {"key": "swowTopK", "group": "发散机制", "type": "number", "label": "SWOW 每词联想数", "desc": "每个输入词取前 K 个自由联想词", "min": 1, "max": 30},
    {"key": "swowMinSupZh", "group": "发散机制", "type": "number", "label": "SWOW 中文支持度", "desc": "多词输入时需 N 个词共同联想到才进池(1=宽松)", "min": 1, "max": 5},
    {"key": "cnTopK", "group": "发散机制", "type": "number", "label": "ConceptNet 每词取数", "desc": "ConceptNet 每词每关系取前 K 个", "min": 1, "max": 50},
    {"key": "cilinMaxL3", "group": "发散机制", "type": "number", "label": "词林同小类上限", "desc": "L3 层级扩展每词上限(0=关闭)", "min": 0, "max": 10},
    {"key": "cilinMaxL2", "group": "发散机制", "type": "number", "label": "词林同中类上限", "desc": "L2 层级扩展每词上限(0=关闭,默认关:噪声源)", "min": 0, "max": 10},
    {"key": "atomicTopK", "group": "发散机制", "type": "number", "label": "ATOMIC 事件推理数", "desc": "每个英文词的事件推理取前 K 条", "min": 1, "max": 20},
    {"key": "shortInputChars", "group": "召回参数", "type": "number", "label": "短输入字数门槛", "desc": "输入文本短于此字数时,1 个词命中即可召回(不按文档长度计算门槛)", "min": 1, "max": 100},
    {"key": "hitsDivisor", "group": "召回参数", "type": "number", "label": "命中除数", "desc": "标准门槛: 每 N 字需 1 个词命中;调大=更宽松(默认 10)", "min": 2, "max": 100},
    {"key": "mechDisable", "group": "发散机制", "type": "text", "label": "关停机制", "desc": "逗号分隔: swow_zh,conceptnet_zh,cilin,swow_en,atomic,conceptnet_en"},
    {"key": "ibAlpha", "group": "打分", "type": "number", "label": "IB 倒U α", "desc": "信息瓶颈意外性参数(峰值在 d*=1/√α)", "min": 0.5, "max": 8.0, "step": 0.1},
    {"key": "hitWeight", "group": "排序", "type": "number", "label": "关联词命中加分", "desc": "被检索文档每命中一个发散词的加分", "min": 0, "max": 5.0, "step": 0.1},
    {"key": "phraseWeight", "group": "排序", "type": "number", "label": "短语匹配加分", "desc": "LLM token 连续命中≥3 时每 token 加分", "min": 0, "max": 5.0, "step": 0.1},
    {"key": "phraseMinRun", "group": "排序", "type": "number", "label": "短语最小连续数", "desc": "连续 LLM token 命中≥N 才算短语级匹配", "min": 2, "max": 10},
    {"key": "topInputBonus", "group": "排序", "type": "number", "label": "Top词额外加成", "desc": "发散池 Top 词命中时的额外加分", "min": 0, "max": 2.0, "step": 0.1},
    {"key": "fusion", "group": "排序", "type": "select", "label": "融合方式", "desc": "weighted=加权求和 / rrf=倒数排名融合", "options": ["weighted", "rrf"]},
    {"key": "experimentLog", "group": "实验", "type": "toggle", "label": "实验储存", "desc": "每次召回结果独立落盘 JSONL（按角色卡隔离，用于展示和问题收集，不存入对话）"},
]


@app.post("/getData")
async def get_data(_req: Request) -> dict[str, Any]:
    """GetData 聚合：对照旧插件 main.mjs interfaces.config.GetData（L317-383）完整形状。
    config 平铺键：旧插件源码此处实际只平铺了 enabled/dataRecall/entryTopK/.../indexCacheMax/
    nbCacheMaxVectors 这 15 键（漏了 contextMessages/recordTopK/layerWeight*等 13 个 meta 引用到
    的键——前端渲染 d[m.key] 拿不到值，是旧插件真实存在的取值缺口，非本次臆造）；这里改为把
    DEFAULTS 中所有面向前端的键（排除 port/resourceDir/dataRoot/vocabDir 四个服务内部路径类配置）
    全量平铺，让 meta 数组里每一条控件都能在顶层拿到初值，修掉该缺口，不是破坏契约。
    """
    cfg = get_config()
    pl = _pipeline()
    flat = {k: cfg[k] for k in DEFAULTS if k not in ("port", "resourceDir", "dataRoot", "vocabDir")}
    return {
        **flat,
        "pipelineLoaded": pl is not None,
        "lastRunTime": _last_run_time,
        "lastRunMs": _last_run_ms,
        "lastDirWordCount": _last_dir_word_count,
        "meta": _CONTROL_META,
        "setdataWrap": "updateConfig",
        "stats": {
            "pipelineLoaded": pl is not None,
            "activeRuns": None,
            "clearing": None,
            "lastRunMs": _last_run_ms,
            "lastDirWordCount": _last_dir_word_count,
            "idleUnloadMinutes": None,
            "lastCacheClear": None,
        },
        "description": "P1 自驱动召回 — 本地联想管线（SWOW+NB300+多路池），产出方向词注入主 AI 上下文",
    }


# ── 词库管理（P1 自持数据域；形状对照旧插件同名 action）──

def _vocab_dir(username: str = "") -> Path:
    """用户级词库: 有 username → dataRoot/<u>/p1_vocab/; 无 → 全局兜底 service/data/vocab/"""
    cfg = get_config()
    if username:
        d = Path(cfg["dataRoot"]) / username / "p1_vocab"
    else:
        d = Path(cfg["vocabDir"])
    d.mkdir(parents=True, exist_ok=True)
    return d


@app.post("/listVocabs")
async def list_vocabs(_req: Request) -> dict[str, Any]:
    """对照旧插件 main.mjs main._action==='listVocabs'（L451-478）：AT 主词库只读统计（4 固定模式，
    缺失文件标 missing）+ 用户插拔词库 CRUD 列表。vocab 文件结构 = {_meta:{name,modes,enabled}, entries:{...}}，
    entryCount=entries 键数（此前误把顶层非 _meta 键当 entries，词库真实结构是嵌套 entries 对象，已修正）。"""
    resource_dir = Path(get_config()["resourceDir"])
    at: list[dict[str, Any]] = []
    for m in AT_MODES:
        fp = resource_dir / f"activation_terms_{m}.json"
        try:
            st = fp.stat()
            at.append({"mode": m, "file": fp.name, "size": st.st_size, "mtime": int(st.st_mtime * 1000)})
        except OSError:
            at.append({"mode": m, "file": f"activation_terms_{m}.json", "size": 0, "mtime": None, "missing": True})

    user: list[dict[str, Any]] = []
    _u = _username(_req, {})
    for p in sorted(_vocab_dir(_u).glob("*.json")):
        try:
            j = json.loads(p.read_text(encoding="utf-8"))
            meta = j.get("_meta", {}) if isinstance(j, dict) else {}
            entries = j.get("entries") if isinstance(j, dict) else None
            entries = entries if isinstance(entries, dict) else {}
            modes = meta.get("modes")
            user.append({
                "file": p.name,
                "name": meta.get("name") or p.name,
                "modes": modes if isinstance(modes, list) and modes else ["all"],
                "enabled": meta.get("enabled") is not False,
                "entryCount": len(entries),
                "mtime": int(p.stat().st_mtime * 1000),
            })
        except (OSError, json.JSONDecodeError):
            user.append({"file": p.name, "name": p.name, "broken": True})
    return {"success": True, "at": at, "user": user}


def _load_at_data(mode: str) -> dict:
    """AT 主词库按 mtime 缓存单 mode 解析结果，atSearch/atBrowse 共用（对照旧插件
    globalThis.__p1AtSearchCache，9MB 级文件避免每次请求重新解析）。文件不存在/损坏抛给调用方处理。"""
    fp = Path(get_config()["resourceDir"]) / f"activation_terms_{mode}.json"
    mt = fp.stat().st_mtime
    cached = _at_cache.get(mode)
    if cached and cached[0] == mt:
        return cached[1]
    data = json.loads(fp.read_text(encoding="utf-8"))
    _at_cache[mode] = (mt, data)
    return data


@app.post("/atSearch")
async def at_search(req: Request) -> dict[str, Any]:
    """AT 主词库搜索（只读，全维度 termName.includes(q) 扫描，命中上限 50）；对照旧插件
    main.mjs main._action==='atSearch'（L480-504）逐字段返回形状。"""
    body = await req.json()
    mode = body.get("mode") if body.get("mode") in AT_MODES else "chat"
    q = str(body.get("q") or "").strip()
    if not q:
        return {"success": False, "error": "搜索词为空"}
    try:
        at_data = _load_at_data(mode)
    except (OSError, json.JSONDecodeError) as e:
        return {"success": False, "error": str(e)}
    max_hits = int(get_config()["atSearchMaxHits"])
    hits: list[dict[str, str]] = []
    for dim_key, terms in at_data.items():
        if not isinstance(terms, dict):
            continue
        for term_name in terms:
            if q in term_name:
                hits.append({"dim": dim_key, "term": term_name})
                if len(hits) >= max_hits:
                    break
        if len(hits) >= max_hits:
            break
    return {"success": True, "mode": mode, "q": q, "hits": hits, "truncated": len(hits) >= max_hits}


@app.post("/atBrowse")
async def at_browse(req: Request) -> dict[str, Any]:
    body = await req.json()
    mode = body.get("mode") if body.get("mode") in AT_MODES else "chat"
    try:
        at_data = _load_at_data(mode)
    except (OSError, json.JSONDecodeError) as e:
        return {"success": False, "error": f"读取词库失败: {e}"}
    dim = str(body.get("dim") or "")
    if not dim:
        dims = [{"dim": k, "count": len(v)} for k, v in at_data.items() if isinstance(v, dict)]
        return {"success": True, "mode": mode, "dims": dims}
    terms = at_data.get(dim)
    if not isinstance(terms, dict):
        return {"success": False, "error": f"维度不存在: {dim}"}
    names = list(terms.keys())
    cfg = get_config()
    offset = max(0, int(body.get("offset") or 0))
    limit = min(int(cfg["atBrowseLimitMax"]), max(1, int(body.get("limit") or cfg["atBrowseLimitDefault"])))
    page = [{"term": t, "concepts": (terms[t] or {}).get("concepts", []) if isinstance(terms[t], dict) else []}
            for t in names[offset:offset + limit]]
    return {"success": True, "mode": mode, "dim": dim, "total": len(names), "offset": offset, "limit": limit, "entries": page}


def _safe_vocab_path(name: str, username: str = "") -> Path | None:
    fn = Path(str(name)).name  # 剥目录穿越
    if not _VOCAB_NAME_RE.match(fn):
        return None
    return _vocab_dir(username) / fn


@app.post("/getUserVocab")
async def get_user_vocab(req: Request) -> dict[str, Any]:
    body = await req.json()
    p = _safe_vocab_path(body.get("file") or "", _username(req, body))
    if p is None or not p.exists():
        return {"success": False, "error": "词库不存在或文件名非法"}
    try:
        return {"success": True, "file": p.name, "content": json.loads(p.read_text(encoding="utf-8"))}
    except (OSError, json.JSONDecodeError) as e:
        return {"success": False, "error": str(e)}


@app.post("/saveUserVocab")
async def save_user_vocab(req: Request) -> dict[str, Any]:
    """新建/覆盖用户词库。校验规则对照旧插件 main.mjs main._action==='saveUserVocab'（L546-565）
    逐条照搬：文件名必须 .json 结尾；content 需 {_meta, entries:{词:[关联词,...]}}；entries 每个值
    必须是字符串数组；_meta 缺省时 name 用文件名/modes 用 ['all']/enabled 默认 true（盘为真相单源）。"""
    body = await req.json()
    fn = str(body.get("file") or "")
    if not fn.endswith(".json"):
        return {"success": False, "error": "文件名必须 .json 结尾"}
    p = _safe_vocab_path(fn, _username(req, body))
    if p is None:
        return {"success": False, "error": "文件名非法"}
    content = body.get("content")
    if not isinstance(content, dict) or not isinstance(content.get("entries"), dict):
        return {"success": False, "error": "格式错误：需要 {_meta, entries:{词:[关联词,...]}}"}
    entries = content["entries"]
    for k, v in entries.items():
        if not isinstance(v, list) or any(not isinstance(x, str) for x in v):
            return {"success": False, "error": f'entries["{k}"] 必须是字符串数组'}
    meta = content.get("_meta") if isinstance(content.get("_meta"), dict) else {}
    modes = meta.get("modes")
    content["_meta"] = {
        "name": str(meta.get("name") or p.name),
        "modes": modes if isinstance(modes, list) and modes else ["all"],
        "enabled": meta.get("enabled") is not False,
    }
    try:
        tmp = p.with_suffix(f".tmp{int(time.time() * 1000)}")
        tmp.write_text(json.dumps(content, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(p)
    except OSError as e:
        return {"success": False, "error": str(e)}
    return {"success": True, "file": p.name, "entryCount": len(entries)}


@app.post("/toggleUserVocab")
async def toggle_user_vocab(req: Request) -> dict[str, Any]:
    body = await req.json()
    p = _safe_vocab_path(body.get("file") or "", _username(req, body))
    if p is None or not p.exists():
        return {"success": False, "error": "词库不存在或文件名非法"}
    try:
        j = json.loads(p.read_text(encoding="utf-8"))
        j.setdefault("_meta", {})["enabled"] = bool(body.get("enabled", True))
        p.write_text(json.dumps(j, ensure_ascii=False, indent=2), encoding="utf-8")
        return {"success": True, "file": p.name, "enabled": j["_meta"]["enabled"]}
    except (OSError, json.JSONDecodeError) as e:
        return {"success": False, "error": str(e)}


@app.post("/deleteUserVocab")
async def delete_user_vocab(req: Request) -> dict[str, Any]:
    body = await req.json()
    p = _safe_vocab_path(body.get("file") or "", _username(req, body))
    if p is None or not p.exists():
        return {"success": False, "error": "词库不存在或文件名非法"}
    p.unlink()
    return {"success": True, "file": p.name}


# ── 运行记录（前端 p1run「运行记录」卡片消费；只读，写侧单点在 _append_run_log）──

@app.post("/getRunLogInfo")
async def get_run_log_info(req: Request) -> dict[str, Any]:
    body = await req.json()
    cfg = get_config()
    runs = _runs_dir_for(str(body.get("username") or _username(req, body)), str(body.get("charName") or ""))
    files: list[dict[str, Any]] = []
    try:
        for p in runs.glob("p1_runs_*.jsonl"):
            if not _RUN_LOG_NAME_RE.match(p.name):
                continue
            try:
                st = p.stat()
                files.append({"file": p.name, "size": st.st_size, "mtime": int(st.st_mtime * 1000)})
            except OSError:
                continue
    except OSError:
        pass
    files.sort(key=lambda f: f["file"], reverse=True)
    return {"success": True, "dir": str(runs), "enabled": cfg.get("runLogEnabled") is not False,
            "keepDays": int(cfg.get("runLogKeepDays") or 0), "files": files}


@app.post("/getRunLog")
async def get_run_log(req: Request) -> dict[str, Any]:
    body = await req.json()
    fn = Path(str(body.get("file") or "")).name
    if not _RUN_LOG_NAME_RE.match(fn):
        return {"success": False, "error": "文件名不合法"}
    runs = _runs_dir_for(str(body.get("username") or _username(req, body)), str(body.get("charName") or ""))
    fp = runs / fn
    try:
        lines = [ln for ln in fp.read_text(encoding="utf-8").splitlines() if ln.strip()]
    except OSError as e:
        return {"success": False, "error": str(e)}
    total = len(lines)
    limit = min(100, max(1, int(body.get("limit") or 20)))
    offset = max(0, int(body.get("offset") or 0))
    # 记录按时间顺序追加，前端要最新在前：从尾部往前取一页再反转
    lo = max(0, total - offset - limit)
    hi = max(0, total - offset)
    entries: list[dict[str, Any]] = []
    for ln in reversed(lines[lo:hi]):
        try:
            entries.append(json.loads(ln))
        except json.JSONDecodeError:
            entries.append({"broken": True, "raw": ln[:200]})
    return {"success": True, "file": fn, "total": total, "offset": offset, "limit": limit, "entries": entries}


# ── P9 词库维护 AI 提示词数据件（默认件自持在 service/ 下；用户微调副本落 service/data/p9_prompts.json）──
# 对照旧插件 main.mjs main._action in {getP9Prompts,saveP9Prompts,resetP9Prompts}（L589-610）。
# P9 执行器（AI runner 接入）待 002 拍板，本服务先交付数据件机制（同旧插件口径）。

@app.post("/getP9Prompts")
async def get_p9_prompts(_req: Request) -> dict[str, Any]:
    try:
        default_data = json.loads(_P9_DEFAULT_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        return {"success": False, "error": str(e)}
    user_data = None
    try:
        user_data = json.loads(_P9_USER_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        pass  # 无用户副本=用默认，合法路径
    prompts = user_data.get("prompts") if isinstance(user_data, dict) and user_data.get("prompts") else default_data.get("prompts")
    return {"success": True, "prompts": prompts, "isUserCopy": user_data is not None, "executorPending": True}


@app.post("/saveP9Prompts")
async def save_p9_prompts(req: Request) -> dict[str, Any]:
    body = await req.json()
    prompts = body.get("prompts")
    if not isinstance(prompts, list):
        return {"success": False, "error": "prompts 必须是数组"}
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = _P9_USER_FILE.with_suffix(f".tmp{int(time.time() * 1000)}")
        tmp.write_text(json.dumps({"_meta": {"savedAt": int(time.time() * 1000)}, "prompts": prompts}, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(_P9_USER_FILE)
    except OSError as e:
        return {"success": False, "error": str(e)}
    return {"success": True, "count": len(prompts)}


@app.post("/resetP9Prompts")
async def reset_p9_prompts(_req: Request) -> dict[str, Any]:
    try:
        _P9_USER_FILE.unlink()
        return {"success": True}
    except OSError as e:
        return {"success": False, "error": str(e)}


def _ensure_cluster():
    """集群三服务懒启动: 探活→不在就 spawn→后台运行(unref 语义: 主进程退出不杀子服务)。
    每个服务独立进程、独立端口、懒加载(首次请求才加载模型/数据)——内存只在实际使用时增长。"""
    _BRIDGE_DIR = _nos.path.join(_nos.path.dirname(_nos.path.abspath(__file__)),
                                  "..", "..", "..", "..", "..", "yonban", "core", "functions", "memory", "p1", "bridge")
    _CLUSTER = [
        {"name": "tokenize", "script": "tokenize_service.py", "port": 13151, "env_port": "P1_TOK_PORT"},
        {"name": "vector",   "script": "vector_service.py",   "port": 13152, "env_port": "P1_VEC_PORT"},
        {"name": "llmtok",   "script": "llmtok_service.py",   "port": 13153, "env_port": "P1_LLMTOK_PORT"},
    ]
    import urllib.request
    for svc in _CLUSTER:
        port = int(_nos.environ.get(svc["env_port"]) or svc["port"])
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2)
            print(f"[p1_server] 集群 {svc['name']}:{port} 已在运行")
            continue
        except Exception:
            pass
        script = _nos.path.join(_BRIDGE_DIR, svc["script"])
        if not _nos.path.exists(script):
            print(f"[p1_server] 集群 {svc['name']} 脚本不存在: {script}")
            continue
        try:
            p = _nsp.Popen(
                ["python", script, "--port", str(port)],
                stdout=_nsp.DEVNULL, stderr=_nsp.DEVNULL, stdin=_nsp.DEVNULL,
                cwd=_BRIDGE_DIR,
            )
            print(f"[p1_server] 集群 {svc['name']}:{port} 已自动启动 (pid={p.pid})")
        except Exception as e:
            print(f"[p1_server] 集群 {svc['name']} 启动失败: {e}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="P1 召回独立服务（拉线测试入口：直接运行本文件）")
    parser.add_argument("--port", type=int, default=None, help="覆盖 config 端口（默认 13150）")
    parser.add_argument("--no-cluster", action="store_true", help="不自动启动集群服务")
    args = parser.parse_args()
    _ensure_resources()
    if not args.no_cluster:
        _ensure_cluster()
    import uvicorn  # noqa: PLC0415
    port = args.port or int(get_config()["port"])
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
