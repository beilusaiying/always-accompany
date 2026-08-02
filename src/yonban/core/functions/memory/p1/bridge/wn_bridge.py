# wn_bridge.py — WordNet 路径相似度桥(设计§标注打分 审查机制4: path_similarity ∈ [0,1])
# stdin: {"anchors": [...], "candidates": [...]} (英文词)
# stdout: {"sim": {word: max_path_similarity_over_anchors}, "provider": "..."}
# 用途: 英文候选与锚词的 WordNet 结构相似度,与 NB300 cosine 双重验证(阈值白盒定)
# nltk/wordnet 缺失 → exit 3(JS 侧如实降级)

import sys, io, json

sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8-sig")
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

try:
    from nltk.corpus import wordnet as wn
    wn.synsets("dog")  # 触发数据加载,缺数据在此抛
except Exception as e:
    sys.stderr.write(f"wordnet unavailable: {str(e)[:200]}\n")
    sys.exit(3)


def main():
    req = json.load(sys.stdin)
    # isascii 过滤: WordNet 仅英文,中文词 synsets 必空,先剔省查询;中文相似度走 nb_bridge
    anchors = [a for a in req.get("anchors", []) if a.isascii()]
    candidates = [c for c in req.get("candidates", []) if c.isascii()]
    anchor_syns = []
    for a in anchors:
        ss = wn.synsets(a.replace(" ", "_"))
        if ss:
            anchor_syns.append(ss[0])  # 首义项(设计公式 path_similarity(synset_a, synset_b))
    out = {"provider": "nltk_wordnet", "sim": {}, "anchorHit": len(anchor_syns)}
    for c in candidates:
        ss = wn.synsets(c.replace(" ", "_"))
        if not ss:
            continue
        best = 0.0
        for asyn in anchor_syns:
            v = ss[0].path_similarity(asyn)
            if v is not None and v > best:
                best = v
        if best > 0:
            out["sim"][c] = round(best, 3)
    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
