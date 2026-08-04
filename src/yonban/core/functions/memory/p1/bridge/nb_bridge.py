# nb_bridge.py — Numberbatch 余弦查询桥(int8 量化子集版)
# stdin: {"anchors": [...], "candidates": [...]}
# stdout: {"cos": {word: cos_with_anchor_centroid}, "oov": [...], "provider": "..."}
#
# 数据源: resources_derived/nb_words.txt + nb_vec_int8.npy
#   由 preprocess_resources.py 从 numberbatch-19.08.txt.gz 抽取 zh(已t2s)/en 子集,
#   L2 归一后 int8 量化(×127);原 mini.h5 是截断坏文件(eof 10MB/应 632MB, 2026-08-01 确诊)
# 缺失 → exit 3 + stderr 说明(JS 侧如实降级,不吞)

import sys, io, json, os

sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8-sig")  # -sig: 容 BOM(0801确诊)
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

DERIVED = os.environ.get("P1V2_DERIVED") or os.path.join(
    os.environ.get("P1_RESOURCE_DIR") or os.path.join(os.path.dirname(__file__), "..", "resources"),
    "p1v2_derived")
W_PATH = os.path.join(DERIVED, "nb_words.txt")
V_PATH = os.path.join(DERIVED, "nb_vec_int8.npy")

try:
    import numpy as np
except ImportError as e:
    sys.stderr.write(f"missing dep: {e}\n")
    sys.exit(3)

if not (os.path.exists(W_PATH) and os.path.exists(V_PATH)):
    sys.stderr.write(f"nb subset not built yet: {W_PATH}\n")
    sys.exit(3)

with open(W_PATH, encoding="utf-8") as f:
    _words = f.read().split("\n")
_index = {w: i for i, w in enumerate(_words)}
_mat = np.load(V_PATH, mmap_mode="r")  # mmap: 桥进程不整载矩阵


def get_vec(word):
    w = word.strip().lower().replace(" ", "_")
    for key in (f"zh/{w}", f"en/{w}"):
        i = _index.get(key)
        if i is not None:
            v = _mat[i].astype("float32") / 127.0
            n = np.linalg.norm(v)
            return v / n if n > 0 else None
    return None


def main():
    req = json.load(sys.stdin)
    anchors, candidates = req.get("anchors", []), req.get("candidates", [])
    avecs = [v for v in (get_vec(a) for a in anchors) if v is not None]
    out = {"provider": "numberbatch_int8_subset", "cos": {}, "oov": [],
           "anchorHit": len(avecs), "anchorTotal": len(anchors)}
    if not avecs:
        json.dump(out, sys.stdout, ensure_ascii=False)
        return
    centroid = np.mean(avecs, axis=0)
    n = np.linalg.norm(centroid)
    centroid = centroid / n if n > 0 else centroid
    for c in candidates:
        v = get_vec(c)
        if v is None:
            out["oov"].append(c)
        else:
            out["cos"][c] = round(float(np.dot(centroid, v)), 4)
    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
