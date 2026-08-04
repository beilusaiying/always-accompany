"""test_parity_diff30.py — 逐 case 深对照（每 mode 前 30 条，JS↔Python recalledRecords 比对）。

输入：
  - <local-dev-path> 全量逐 case，取前 30）
  - <local-dev-path> 侧同 30 条，test_parity_dump30_js.mjs 产出）
比对维度（按 case id 对齐）：
  - recordId 集合：identical / overlap(交集数) / disjoint —— recordId=sha256(sourceRel\\0locator\\0contentHash)[:24]，
    条目切分+内容完全一致时两侧必同 id（与打分无关），是最强的"召回同一条记忆"判据。
  - content80 集合：recordId 不同但内容同 → id 构造差异（locator/display 归一化层）；内容也不同 → 真召回差异。
  - inputWords Jaccard / anchors(top5) 交集 —— 差异归因辅助（分词层 vs 检索层）。
输出：<local-dev-path> case 的两侧明细，供亲读定性）。
"""
from __future__ import annotations

import json
from pathlib import Path

OUT_DIR = Path(r"<local-dev-path>")
PY_FILE = OUT_DIR / "full_1600_py_percase.json"
JS_FILE = OUT_DIR / "dump30_js.json"
OUT_FILE = OUT_DIR / "parity_diff30.json"
N = 30


def _jaccard(a, b):
    sa, sb = set(a or []), set(b or [])
    if not sa and not sb:
        return 1.0
    return round(len(sa & sb) / len(sa | sb), 3) if (sa | sb) else 1.0


def main():
    py_all = json.loads(PY_FILE.read_text(encoding="utf-8"))
    js_all = json.loads(JS_FILE.read_text(encoding="utf-8"))
    out = {"_meta": {"n": N, "pyFile": str(PY_FILE), "jsFile": str(JS_FILE)}}
    for mode in ("chat", "ide", "work", "airp"):
        js_rows = {r["id"]: r for r in (js_all.get(mode) or []) if "error" not in r}
        py_rows = {r["id"]: r for r in (py_all.get(mode) or [])[:N]}
        common_ids = [rid for rid in py_rows if rid in js_rows]
        summary = {"cases": len(common_ids), "recordsIdentical": 0, "recordsOverlap": 0,
                   "recordsDisjoint": 0, "sameContentDiffIds": 0,
                   "anchorTop5Identical": 0, "wordsJaccardAvg": 0.0}
        diffs = []
        jac_sum = 0.0
        for cid in common_ids:
            p, j = py_rows[cid], js_rows[cid]
            p_ids = [r["recordId"] for r in p["records"]]
            j_ids = [r["recordId"] for r in j["records"]]
            p_set, j_set = set(p_ids), set(j_ids)
            inter = p_set & j_set
            p_c80 = {r["content80"] for r in p["records"]}
            j_c80 = {r["content80"] for r in j["records"]}
            wj = _jaccard(p.get("inputWords"), j.get("inputWords"))
            jac_sum += wj
            anchors_same = (p.get("anchorNodes") or []) == (j.get("anchorNodes") or [])
            if anchors_same:
                summary["anchorTop5Identical"] += 1
            if p_set == j_set:
                summary["recordsIdentical"] += 1
                cls = "identical"
            elif p_c80 == j_c80:
                summary["sameContentDiffIds"] += 1
                cls = "same-content-diff-ids"
            elif inter:
                summary["recordsOverlap"] += 1
                cls = f"overlap-{len(inter)}/{max(len(p_set), len(j_set))}"
            else:
                summary["recordsDisjoint"] += 1
                cls = "disjoint"
            if cls != "identical" or not anchors_same:
                diffs.append({
                    "id": cid, "class": cls, "wordsJaccard": wj,
                    "anchorsSame": anchors_same,
                    "pyWords": p.get("inputWords"), "jsWords": j.get("inputWords"),
                    "pyAnchors": p.get("anchorNodes"), "jsAnchors": j.get("anchorNodes"),
                    "pyOnlyRecords": [r for r in p["records"] if r["recordId"] not in j_set],
                    "jsOnlyRecords": [r for r in j["records"] if r["recordId"] not in p_set],
                })
        summary["wordsJaccardAvg"] = round(jac_sum / len(common_ids), 3) if common_ids else None
        out[mode] = {"summary": summary, "diffs": diffs}
        print(f"{mode}: {summary}")
    OUT_FILE.write_text(json.dumps(out, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print(f"落盘: {OUT_FILE}")


if __name__ == "__main__":
    main()
