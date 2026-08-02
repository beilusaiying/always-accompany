"""test_node0_parity.py — 分身B 召回层拉线测试（调用形状对照 p1shiyanshi/test_p1_recall_1600_runner.mjs）。

流程（与 JS runner 同口径）：
  1. 读 causal ide 库 cases.private.json（前 30 条，过滤 <5 字输入——runner MIN_INPUT_LEN=5）。
  2. user_ctx={"username":"002","charName":"p1_test_code_causal"}，mode="code"（runner ALL_MODE_MAP.ide）。
  3. history = userContext[-5:]（002"历史对话就5条"）。
  4. run_pipeline(input, history, "code", user_ctx, {"recall": {"recallOnly": True, "dataRecall": True}})
     ——与 runner L110 完全同参；另跑一轮 nbRerank=True 以拉通 NB300 subset 复核链（runner 默认不开
     nbRerank，此轮单独标记 nb_rerank_pass，不与基线混淆）。
  5. 结果落 D:\\shajiuguan\\p1shiyanshi\\py_parity\\parity_node0_py.json。
只读红线：002 真实记忆（含 _global）只读——本脚本仅 open(...,"r")，零写入记忆目录。
分身A 模块缺席时自动注入 tests/ 下 *_stub（sys.modules 顶名），_meta.stubbed 记录哪些层是 stub
——stub 态的 parity 数值只验证分身B 层自身可跑通+形状正确，JS↔Py 全量等价对照待 A 落盘后由主 AI 跑。
"""
from __future__ import annotations

import importlib
import json
import sys
import time
from pathlib import Path

_PIPELINE_DIR = Path(__file__).resolve().parent
_TESTS_DIR = _PIPELINE_DIR / "tests"
for p in (str(_PIPELINE_DIR), str(_PIPELINE_DIR.parent)):
    if p not in sys.path:
        sys.path.insert(0, p)

CASES_FILE = Path(r"D:\shajiuguan\p1shiyanshi\eval_data\recall_causal_4mode_private"
                  r"\2026-07-29T13-47-46-988Z\private\ide\cases.private.json")
OUT_DIR = Path(r"D:\shajiuguan\p1shiyanshi\py_parity")
OUT_FILE = OUT_DIR / "parity_node0_py.json"
CASE_LIMIT = 30
MIN_INPUT_LEN = 5  # runner 同款


def _inject_stubs() -> list[str]:
    """分身A 模块缺席 → 注入 tests/*_stub 到 sys.modules（正式模块在则零介入）。"""
    stubbed = []
    if str(_TESTS_DIR) not in sys.path:
        sys.path.insert(0, str(_TESTS_DIR))
    for real, stub in (
        ("p1_node1_tokenize", "p1_node1_tokenize_stub"),
        ("p1_node2_swow", "p1_node2_swow_stub"),
        ("p1_pool", "p1_pool_stub"),
    ):
        try:
            importlib.import_module(real)
        except ImportError:
            sys.modules[real] = importlib.import_module(stub)
            stubbed.append(real)
    return stubbed


def _pctl(sorted_arr, p):
    if not sorted_arr:
        return 0
    return sorted_arr[min(len(sorted_arr) - 1, int(len(sorted_arr) * p))]


def _case_row(case, result, ms):
    recall = (result.get("trace") or {}).get("recall") or {}
    records = result.get("recalledRecords") or []
    data_trace = recall.get("dataRecall") or {}
    return {
        "id": case.get("id"),
        "input": (case.get("input") or "")[:100],
        "ms": ms,
        "inputWords": recall.get("inputWords") or [],
        "poolSize": recall.get("swowPoolSize") or 0,
        "anchorCount": recall.get("anchorCount") or 0,
        "anchors": recall.get("anchors") or [],
        "recordCount": len(records),
        "records": [{
            "recordId": r.get("recordId"),
            "layer": r.get("layer"),
            "sourceRel": r.get("sourceRel"),
            "timestamp": r.get("timestamp"),
            "matchedTerms": r.get("matchedTerms"),
            "dLex": r.get("dLex"),
            "dSem": r.get("dSem"),
            "dImp": r.get("dImp"),
            "baseScore": r.get("baseScore"),
            "blqScore": r.get("blqScore"),
            "finalScore": r.get("finalScore"),
            "content": (r.get("content") or "")[:120],
        } for r in records],
        "dataRecall": {
            "reason": data_trace.get("reason"),
            "indexFiles": data_trace.get("indexFiles"),
            "indexRecords": data_trace.get("indexRecords"),
            "located": data_trace.get("located"),
            "sparseAccepted": data_trace.get("sparseAccepted"),
            "hitFiles": data_trace.get("hitFiles"),
            "layerDist": data_trace.get("layerDist"),
            "semanticEnabled": data_trace.get("semanticEnabled"),
            "semanticAvailable": data_trace.get("semanticAvailable"),
            "vectorBackend": data_trace.get("vectorBackend"),
            "subsetLoadedWords": data_trace.get("subsetLoadedWords"),
            "semanticReranked": data_trace.get("semanticReranked"),
            "anchors": data_trace.get("anchors"),
            "totalMs": data_trace.get("totalMs"),
        },
    }


def _run_pass(run_pipeline, cases, user_ctx, recall_config, label):
    stats = {
        "label": label,
        "recallConfig": recall_config,
        "total": len(cases), "ok": 0, "error": 0,
        "emptyAnchors": 0, "withRecords": 0,
        "layerDist": {"hot": 0, "warm": 0, "cold": 0, "other": 0},
        "sourceDist": {"charSpecific": 0, "global": 0, "unknown": 0},
        "errors": [],
        "cases": [],
    }
    times = []
    for i, c in enumerate(cases):
        history = (c.get("userContext") or [])[-5:]
        try:
            t0 = time.time()
            result = run_pipeline(c.get("input"), history, "code", user_ctx, {"recall": dict(recall_config)})
            ms = int((time.time() - t0) * 1000)
            stats["ok"] += 1
            times.append(ms)
            row = _case_row(c, result, ms)
            stats["cases"].append(row)
            if row["anchorCount"] == 0:
                stats["emptyAnchors"] += 1
            if row["recordCount"] > 0:
                stats["withRecords"] += 1
            for r in result.get("recalledRecords") or []:
                layer = r.get("layer") if r.get("layer") in ("hot", "warm", "cold") else "other"
                stats["layerDist"][layer] += 1
                src = r.get("sourceRel")
                if isinstance(src, str) and src.startswith("0:"):
                    stats["sourceDist"]["charSpecific"] += 1
                elif isinstance(src, str) and src.startswith("1:"):
                    stats["sourceDist"]["global"] += 1
                else:
                    stats["sourceDist"]["unknown"] += 1
            print(f"  [{label}] {i + 1}/{len(cases)} id={c.get('id')} ms={ms} "
                  f"words={len(row['inputWords'])} anchors={row['anchorCount']} records={row['recordCount']}")
        except Exception as err:  # 逐 case 容错, 汇总报告(runner 同款)
            import traceback

            stats["error"] += 1
            stats["errors"].append({"i": i, "id": c.get("id"), "reason": str(err)[:200],
                                    "stack": traceback.format_exc().splitlines()[-3:]})
            print(f"  [{label}] ERROR [{i}] {c.get('id')}: {str(err)[:150]}", file=sys.stderr)
    s = sorted(times)
    stats["summary"] = {
        "p50": _pctl(s, 0.5), "p95": _pctl(s, 0.95), "max": s[-1] if s else 0,
        "emptyAnchorRate": round(stats["emptyAnchors"] / stats["ok"] * 100, 1) if stats["ok"] else 0,
        "recordHitRate": round(stats["withRecords"] / stats["ok"] * 100, 1) if stats["ok"] else 0,
    }
    return stats


def main():
    stubbed = _inject_stubs()
    from p1_pipeline_py import run_pipeline  # stub 注入后再 import 管线

    data = json.loads(CASES_FILE.read_text(encoding="utf-8"))
    all_cases = data.get("cases") or []
    filtered = [c for c in all_cases if (c.get("input") or "").strip() and len((c.get("input") or "").strip()) >= MIN_INPUT_LEN]
    cases = filtered[:CASE_LIMIT]
    print(f"cases: total={len(all_cases)} filtered={len(filtered)} running={len(cases)} stubbed={stubbed}")

    user_ctx = {"username": "002", "charName": "p1_test_code_causal"}

    # 基线: 与 1600 runner 同参（nbRerank 未传 → env 默认 off，同 JS 生产 runner 行为）
    base = _run_pass(run_pipeline, cases, user_ctx, {"recallOnly": True, "dataRecall": True}, "baseline")
    # NB 复核链拉通: nbRerank=True 单独一轮（验证 nb_subset bin 解析/PC1 去偏/候选 cos 复核）
    nb = _run_pass(run_pipeline, cases, user_ctx, {"recallOnly": True, "dataRecall": True, "nbRerank": True},
                   "nb_rerank_pass")

    out = {
        "_meta": {
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "runner": "test_node0_parity.py (python, 分身B 召回层)",
            "shapeRef": "test_p1_recall_1600_runner.mjs (mode=ide→pipelineMode code, history[-5:], recallOnly+dataRecall)",
            "casesFile": str(CASES_FILE),
            "caseLimit": CASE_LIMIT,
            "stubbed": stubbed,
            "stubNote": ("分身A 模块缺席用 tests/*_stub 顶名: 无头尾截断/无POS去虚词/无SWOW发散/无多路池 —— "
                         "本结果验证分身B 层可跑通+形状正确; JS↔Py 全量等价对照待 A 落盘后再跑") if stubbed else None,
            "python": sys.version,
        },
        "baseline": base,
        "nb_rerank_pass": nb,
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(out, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    print(f"\nbaseline: ok={base['ok']}/{base['total']} err={base['error']} "
          f"emptyAnchor={base['summary']['emptyAnchorRate']}% recordHit={base['summary']['recordHitRate']}% "
          f"P50={base['summary']['p50']}ms P95={base['summary']['p95']}ms")
    print(f"nb_rerank: ok={nb['ok']}/{nb['total']} err={nb['error']} "
          f"recordHit={nb['summary']['recordHitRate']}% P50={nb['summary']['p50']}ms P95={nb['summary']['p95']}ms")
    print(f"结果落盘: {OUT_FILE}")


if __name__ == "__main__":
    main()
