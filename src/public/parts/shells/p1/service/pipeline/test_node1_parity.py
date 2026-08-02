# ════════════════════════════════════════════════════════════════════
# test_node1_parity.py — node1 Python↔JS 双跑对照（Python 侧半程）
#
# 功能链：real_dialog_30cases.json 30 条输入 → tokenize_node1(input)（不带 context,
#         JS 对照侧须同样直调 tokenizeNode1(input) 单参）→ 每条 words/权重/截断态
#         → parity_node1_py.json 落 D:\shajiuguan\p1shiyanshi\py_parity\ 供主 AI 与 JS 双跑 diff
# why：设计 MD 保真规则 2——jieba(Python) 与 jieba-wasm 词典有差异, 用双跑对照容忍度报告
#      定性（diff 逐条亲读）, 不为对齐 hack。
# 运行：python test_node1_parity.py [cases_json] [out_json]
# ════════════════════════════════════════════════════════════════════
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from p1_node1_tokenize import jieba_available, tokenize_node1  # noqa: E402

DEFAULT_CASES = Path(r"D:\shajiuguan\p1shiyanshi\eval_data\real_dialog_30cases.json")
DEFAULT_OUT = Path(r"D:\shajiuguan\p1shiyanshi\py_parity\parity_node1_py.json")


def main() -> int:
    cases_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_CASES
    out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_OUT
    cases = json.loads(cases_path.read_text(encoding="utf-8-sig"))
    results = []
    t_all0 = time.time()
    for case in cases:
        t0 = time.time()
        r = tokenize_node1(case.get("input") or "")
        ms = int((time.time() - t0) * 1000)
        results.append({
            "id": case.get("id"),
            "mode": case.get("mode"),
            "inputLen": len(case.get("input") or ""),
            "words": r["words"],
            "wordWeights": r["wordWeights"],
            "demoted": r["demoted"],
            "filtered": r["_trace"]["filtered"],
            "intensifiers": r["intensifiers"],
            "truncated": r["_trace"]["truncated"],
            "strategy": (r["_trace"]["preprocess"] or {}).get("strategy"),
            "processedText": r.get("processedText"),
            "ms": ms,
        })
    out = {
        "meta": {
            "side": "python",
            "invocation": "tokenize_node1(input)  # 单参, 无 context/opts — JS 对照侧须同形调用",
            "jiebaAvailable": jieba_available(),
            "python": sys.version.split()[0],
            "cases": len(results),
            "casesFile": str(cases_path),
            "totalMs": int((time.time() - t_all0) * 1000),
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        },
        "results": results,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"[parity] {len(results)} cases → {out_path}")
    print(f"[parity] jieba={jieba_available()} totalMs={out['meta']['totalMs']}")
    for row in results[:5]:
        print(f"  {row['id']} ({row['mode']}, len={row['inputLen']}, trunc={row['truncated']}): "
              + json.dumps(row["words"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
