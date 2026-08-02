# wordnet_bridge.py — WordNet path_similarity 桥
#
# 设计来源: P1_新管线设计_算法标注版.md §标注打分
# > WordNet 路径相似度 (英文候选交叉验证)
# > path_similarity(synset_a, synset_b) ∈ [0, 1]
# > 与 NB300 cosine 双重验证: 两者都 > 阈值才保留
#
# 协议: stdin JSON {"anchors":["w1",...], "candidates":["w2",...]}
# → stdout JSON {"sim":{"w2": max_path_sim, ...}, "oov":[...]}
# 每个 candidate 对所有 anchor 的 synset 对取 max path_similarity

import sys, io, json

sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8-sig")
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from nltk.corpus import wordnet as wn

def max_path_sim(word_a, word_b):
    syns_a = wn.synsets(word_a)
    syns_b = wn.synsets(word_b)
    if not syns_a or not syns_b:
        return None
    best = 0
    for sa in syns_a[:3]:  # top 3 senses to balance speed vs coverage
        for sb in syns_b[:3]:
            sim = sa.path_similarity(sb)
            if sim is not None and sim > best:
                best = sim
    return round(best, 4) if best > 0 else None

def main():
    payload = json.load(sys.stdin)
    anchors = payload.get("anchors", [])
    candidates = payload.get("candidates", [])

    sim = {}
    oov = []
    for cand in candidates:
        best = 0
        has_synset = bool(wn.synsets(cand))
        if not has_synset:
            oov.append(cand)
            continue
        for anc in anchors:
            s = max_path_sim(anc, cand)
            if s is not None and s > best:
                best = s
        if best > 0:
            sim[cand] = best

    json.dump({"sim": sim, "oov": oov}, sys.stdout, ensure_ascii=False)

if __name__ == "__main__":
    main()
