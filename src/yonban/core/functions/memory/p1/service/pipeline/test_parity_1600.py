"""test_parity_1600.py — 1600×4mode 全量 JS↔Python 等价对照 runner（分身B，0731）。

口径（与 JS 官方基线 runner test_p1_recall_1600_runner.mjs 逐项对齐）：
  - chat/ide/airp 用 RUN_TAG 2026-07-29T13-47-46-988Z；work 用中文库 RUN_TAG 2026-07-30T18-05-31-600Z
    （旧英文 ABCD 库已废弃不跑——002 拍板 work 官方基线以中文库为准）。
  - 每 mode 全量（库存 400 条），过滤 <5 字输入（MIN_INPUT_LEN=5，统计后剔除不静默）。
  - history = userContext[-5:]；userCtx={username:"002", charName:"p1_test_<m>_causal"}；
    runtime_config={"recall": {"recallOnly": True, "dataRecall": True}}（其余走默认，与 JS L110 同参）。
  - 汇总键与 JS runner stats.summary 逐键同名，便于直接对照
    eval_data\\full_recall_causal_4mode_result_2026-07-31.json / work_zh_work_recall_causal_result_2026-07-31.json。
输出：
  - <local-dev-path>     汇总（每 mode 完成即落盘 partial）
  - <local-dev-path>    逐 case 紧凑行（含 recordId/内容前缀，供 30 条深对照）
  - <local-dev-path>     与 JS 基线逐指标对照表
红线：002 记忆只读；每 mode 结束 clear_data_recall_cache()（纯测试进程内存卫生，索引按 mode 分键互不影响结果）。
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

_PIPELINE_DIR = Path(__file__).resolve().parent
for p in (str(_PIPELINE_DIR), str(_PIPELINE_DIR.parent)):
    if p not in sys.path:
        sys.path.insert(0, p)

from p1_pipeline_py import run_pipeline  # noqa: E402
from p1_node0_data_recall import clear_data_recall_cache  # noqa: E402

EVAL_ROOT = Path(r"<local-dev-path>")
TAG_A = "2026-07-29T13-47-46-988Z"
TAG_B = "2026-07-30T18-05-31-600Z"  # work 中文库
OUT_DIR = Path(r"<local-dev-path>")
JS_BASE_4MODE = Path(r"<local-dev-path>")
JS_BASE_WORKZH = Path(r"<local-dev-path>")
MIN_INPUT_LEN = 5

# JS runner ALL_MODE_MAP 同序 chat→ide→work→airp
MODE_MAP = {
    "chat": {"runTag": TAG_A, "pipelineMode": "chat", "charName": "p1_test_chat_causal"},
    "ide": {"runTag": TAG_A, "pipelineMode": "code", "charName": "p1_test_code_causal"},
    "work": {"runTag": TAG_B, "pipelineMode": "work", "charName": "p1_test_work_causal"},
    "airp": {"runTag": TAG_A, "pipelineMode": "airp", "charName": "p1_test_airp_causal"},
}


def _pctl(sorted_arr, p):
    if not sorted_arr:
        return 0
    return sorted_arr[min(len(sorted_arr) - 1, int(len(sorted_arr) * p))]


def _avg(arr):
    return round(sum(arr) / len(arr), 1) if arr else 0


def run_mode(mode, cfg):
    print(f"\n== {mode} (pipelineMode={cfg['pipelineMode']}, char={cfg['charName']}, tag={cfg['runTag']}) ==",
          flush=True)
    cases_path = EVAL_ROOT / cfg["runTag"] / "private" / mode / "cases.private.json"
    all_cases = json.loads(cases_path.read_text(encoding="utf-8")).get("cases") or []
    filtered = [c for c in all_cases
                if (c.get("input") or "").strip() and len((c.get("input") or "").strip()) >= MIN_INPUT_LEN]
    filtered_out = len(all_cases) - len(filtered)
    print(f"  库 {len(all_cases)} 条 | 过滤 {filtered_out} | 有效 {len(filtered)}", flush=True)

    user_ctx = {"username": "002", "charName": cfg["charName"]}
    stats = {
        "mode": mode, "pipelineMode": cfg["pipelineMode"], "charName": cfg["charName"], "runTag": cfg["runTag"],
        "librarySize": len(all_cases), "filteredOut": filtered_out,
        "total": len(filtered), "ok": 0, "error": 0,
        "emptyAnchors": 0, "withRecords": 0,
        "layerDist": {"hot": 0, "warm": 0, "cold": 0, "other": 0},
        "sourceDist": {"charSpecific": 0, "global": 0, "unknown": 0},
        "errors": [], "sampleFails": [],
    }
    times, word_counts, pool_sizes, anchor_counts, record_counts = [], [], [], [], []
    per_case = []
    for i, c in enumerate(filtered):
        history = (c.get("userContext") or [])[-5:]
        try:
            t0 = time.time()
            result = run_pipeline(c.get("input"), history, cfg["pipelineMode"], user_ctx,
                                  {"recall": {"recallOnly": True, "dataRecall": True}})
            ms = int((time.time() - t0) * 1000)
            recall = (result.get("trace") or {}).get("recall") or {}
            words = recall.get("inputWords") or []
            pool = recall.get("swowPoolSize") or 0
            anchor_count = recall.get("anchorCount") or 0
            records = result.get("recalledRecords") or []
            stats["ok"] += 1
            times.append(ms)
            word_counts.append(len(words))
            pool_sizes.append(pool)
            anchor_counts.append(anchor_count)
            record_counts.append(len(records))
            if anchor_count == 0:
                stats["emptyAnchors"] += 1
                if len(stats["sampleFails"]) < 10:
                    stats["sampleFails"].append({
                        "id": c.get("id"), "input": (c.get("input") or "")[:100],
                        "inputWords": words, "poolSize": pool,
                        "anchors": recall.get("anchors") or [], "recordCount": len(records),
                    })
            if records:
                stats["withRecords"] += 1
            for r in records:
                layer = r.get("layer") if r.get("layer") in ("hot", "warm", "cold") else "other"
                stats["layerDist"][layer] += 1
                src = r.get("sourceRel")
                if isinstance(src, str) and src.startswith("0:"):
                    stats["sourceDist"]["charSpecific"] += 1
                elif isinstance(src, str) and src.startswith("1:"):
                    stats["sourceDist"]["global"] += 1
                else:
                    stats["sourceDist"]["unknown"] += 1
            per_case.append({
                "id": c.get("id"),
                "ms": ms,
                "words": len(words),
                "inputWords": words,
                "pool": pool,
                "anchorCount": anchor_count,
                "anchorNodes": recall.get("anchors") or [],
                "records": [{
                    "recordId": r.get("recordId"),
                    "sourceRel": r.get("sourceRel"),
                    "layer": r.get("layer"),
                    "finalScore": r.get("finalScore"),
                    "matchedTerms": r.get("matchedTerms"),
                    "content80": (r.get("content") or "")[:80],
                } for r in records],
            })
            if (i + 1) % 50 == 0 or i == len(filtered) - 1:
                print(f"  [{int((i + 1) / len(filtered) * 100)}%] {i + 1}/{len(filtered)} | "
                      f"ok={stats['ok']} err={stats['error']} | last={ms}ms words={len(words)} "
                      f"pool={pool} anchors={anchor_count} records={len(records)}", flush=True)
        except Exception as err:
            import traceback

            stats["error"] += 1
            stats["errors"].append({"i": i, "id": c.get("id"), "reason": str(err)[:200],
                                    "stack": traceback.format_exc().splitlines()[-3:]})
            if stats["error"] <= 5:
                print(f"  ERROR [{i}] {c.get('id')}: {str(err)[:150]}", file=sys.stderr, flush=True)
    s = sorted(times)
    stats["summary"] = {
        "p50": _pctl(s, 0.5), "p95": _pctl(s, 0.95), "max": s[-1] if s else 0,
        "avgWords": _avg(word_counts),
        "avgPool": round(_avg(pool_sizes)),
        "avgAnchors": _avg(anchor_counts),
        "avgRecords": _avg(record_counts),
        "emptyAnchorRate": round(stats["emptyAnchors"] / stats["ok"] * 100, 1) if stats["ok"] else 0,
        "recordHitRate": round(stats["withRecords"] / stats["ok"] * 100, 1) if stats["ok"] else 0,
    }
    stats["doneWhen3"] = {
        "zeroError": stats["error"] == 0,
        "nonEmptyRate": stats["summary"]["recordHitRate"],
        "nonEmptyPass": stats["summary"]["recordHitRate"] >= 80,
        "pass": stats["error"] == 0 and stats["summary"]["recordHitRate"] >= 80,
    }
    print(f"  == {mode} 汇总: {stats['ok']}/{stats['total']} ok | err {stats['error']} | "
          f"空锚 {stats['summary']['emptyAnchorRate']}% | 命中 {stats['summary']['recordHitRate']}% | "
          f"P50={stats['summary']['p50']} P95={stats['summary']['p95']}", flush=True)
    return stats, per_case


def _compare_row(py_summary, js_mode_data):
    keys = ["p50", "p95", "avgWords", "avgPool", "avgAnchors", "avgRecords", "emptyAnchorRate", "recordHitRate"]
    row = {"py": {k: py_summary["summary"].get(k) for k in keys},
           "js": {k: (js_mode_data or {}).get(k) for k in keys}}
    row["py"]["ok"] = py_summary["ok"]
    row["py"]["total"] = py_summary["total"]
    row["py"]["error"] = py_summary["error"]
    row["js"]["ok"] = (js_mode_data or {}).get("ok")
    row["js"]["total"] = (js_mode_data or {}).get("total")
    row["js"]["error"] = (js_mode_data or {}).get("error")
    row["py"]["layerDist"] = py_summary["layerDist"]
    row["js"]["layerDist"] = (js_mode_data or {}).get("layerDist")
    row["py"]["sourceDist"] = py_summary["sourceDist"]
    row["js"]["sourceDist"] = (js_mode_data or {}).get("sourceDist")
    return row


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    all_stats = {}
    all_percase = {}
    for mode, cfg in MODE_MAP.items():
        stats, per_case = run_mode(mode, cfg)
        all_stats[mode] = stats
        all_percase[mode] = per_case
        clear_data_recall_cache()  # 测试进程内存卫生: 该 mode 索引用毕即释放(索引按 mode 分键, 不影响结果)
        # 每 mode 落盘一次 partial 防中途挂掉全丢（JS runner 同款）
        (OUT_DIR / "full_1600_py_result.partial.json").write_text(
            json.dumps({m: {k: v for k, v in s.items() if k != "cases"} for m, s in all_stats.items()},
                       ensure_ascii=False, indent=1, default=str), encoding="utf-8")
        (OUT_DIR / "full_1600_py_percase.json").write_text(
            json.dumps(all_percase, ensure_ascii=False, default=str), encoding="utf-8")

    js_4mode = json.loads(JS_BASE_4MODE.read_text(encoding="utf-8")) if JS_BASE_4MODE.exists() else {}
    js_workzh = json.loads(JS_BASE_WORKZH.read_text(encoding="utf-8")) if JS_BASE_WORKZH.exists() else {}
    compare = {}
    for mode in MODE_MAP:
        js_side = js_workzh.get("work") if mode == "work" else js_4mode.get(mode)
        compare[mode] = _compare_row(all_stats[mode], js_side)
    compare["_meta"] = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "jsBaselines": {"chat/ide/airp": str(JS_BASE_4MODE), "work": str(JS_BASE_WORKZH) + " (中文库)"},
        "note": "work 对照 JS 中文库官方基线(旧英文 ABCD 库已废弃)",
    }

    (OUT_DIR / "full_1600_py_result.json").write_text(
        json.dumps({"_meta": compare["_meta"], **all_stats}, ensure_ascii=False, indent=1, default=str),
        encoding="utf-8")
    (OUT_DIR / "parity_1600_compare.json").write_text(
        json.dumps(compare, ensure_ascii=False, indent=1, default=str), encoding="utf-8")

    print("\n===== 对照汇总 =====", flush=True)
    for mode in MODE_MAP:
        r = compare[mode]
        print(f"{mode}: py ok={r['py']['ok']}/{r['py']['total']} err={r['py']['error']} "
              f"空锚={r['py']['emptyAnchorRate']} 命中={r['py']['recordHitRate']} "
              f"avgWords={r['py']['avgWords']} avgRecords={r['py']['avgRecords']} "
              f"P50={r['py']['p50']} P95={r['py']['p95']}", flush=True)
        print(f"     js ok={r['js']['ok']}/{r['js']['total']} err={r['js']['error']} "
              f"空锚={r['js']['emptyAnchorRate']} 命中={r['js']['recordHitRate']} "
              f"avgWords={r['js']['avgWords']} avgRecords={r['js']['avgRecords']} "
              f"P50={r['js']['p50']} P95={r['js']['p95']}", flush=True)
    print(f"\n落盘: {OUT_DIR}", flush=True)


if __name__ == "__main__":
    main()
