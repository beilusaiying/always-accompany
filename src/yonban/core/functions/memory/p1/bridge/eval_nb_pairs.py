# eval_nb_pairs.py — 评测专用: 词对批量余弦相似度
# stdin: {"pairs": [["word1","word2"], ...], "lang": "en"|"zh"|"auto"}
# stdout: {"cosines": [float|null, ...], "oov": [int, ...], "vocabSize": int}
#
# 与 nb_bridge.py 共享同一数据源(nb_words.txt + nb_vec_int8.npy),
# 但计算逻辑不同: nb_bridge 算锚集质心→候选余弦; 本脚本算逐对 cos(w1,w2)
# 调用方: eval.mjs via spawnSync(同 node3_score.mjs 调 nb_bridge.py 的模式)

import sys, io, json, os
import numpy as np

sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8-sig")
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

DERIVED = os.environ.get("P1V2_DERIVED") or os.path.join(
    os.environ.get("P1_RESOURCE_DIR") or os.path.join(os.path.dirname(__file__), "..", "resources"),
    "p1v2_derived")
W_PATH = os.path.join(DERIVED, "nb_words.txt")
V_PATH = os.path.join(DERIVED, "nb_vec_int8.npy")

if not (os.path.exists(W_PATH) and os.path.exists(V_PATH)):
    sys.stderr.write(f"nb subset not built: {W_PATH}\n")
    sys.exit(3)

with open(W_PATH, encoding="utf-8") as f:
    _words = f.read().split("\n")
_index = {w: i for i, w in enumerate(_words)}
_mat = np.load(V_PATH, mmap_mode="r")


def get_vec(word, lang="auto"):
    """查词向量, lang=auto 时先试 zh/ 再试 en/ 前缀"""
    w = word.strip().lower().replace(" ", "_")
    if lang == "zh":
        prefixes = [f"zh/{w}"]
    elif lang == "en":
        prefixes = [f"en/{w}"]
    else:
        prefixes = [f"zh/{w}", f"en/{w}"]
    for key in prefixes:
        i = _index.get(key)
        if i is not None:
            v = _mat[i].astype("float32") / 127.0
            n = np.linalg.norm(v)
            return v / n if n > 0 else None
    return None


def main():
    req = json.load(sys.stdin)
    pairs = req.get("pairs", [])
    lang = req.get("lang", "auto")

    cosines = []
    oov_indices = []

    for idx, pair in enumerate(pairs):
        w1, w2 = pair[0], pair[1]
        v1, v2 = get_vec(w1, lang), get_vec(w2, lang)
        if v1 is None or v2 is None:
            cosines.append(None)
            oov_indices.append(idx)
        else:
            cosines.append(round(float(np.dot(v1, v2)), 6))

    json.dump({
        "cosines": cosines,
        "oov": oov_indices,
        "total": len(pairs),
        "covered": len(pairs) - len(oov_indices),
        "vocabSize": len(_words),
    }, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
