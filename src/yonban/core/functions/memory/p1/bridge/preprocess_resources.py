# preprocess_resources.py — 重资源一次性预处理(原始压缩包 → 管线可直读的派生文件)
# 产出统一落 <local-dev-path>
# 每份产出打印 [源文件/格式探测/行数],不静默猜格式(白盒原则)
#
# 产出清单:
#   swow_zh.tsv      cue\tresponse\tstrength   (SWOW-ZH24)
#   swow_en.tsv      cue\tresponse\tstrength   (SWOW-EN18)
#   conceptnet_zh.json / conceptnet_en.json    {word: [[rel, target, weight], ...]}
#   cilin.tsv        code\t词1 词2 ...          (GBK→utf8)
#   numberbatch_meta.txt  探测报告(向量文件真身路径+格式)

import csv, gzip, io, json, os, sys, zipfile, glob

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

# 繁简归一(白盒0801确诊: SWOW-ZH24 繁体采集/ConceptNet zh 繁简混合,简体输入查不到)
from opencc import OpenCC
_t2s = OpenCC("t2s")
t2s = _t2s.convert

BASE = r"<local-dev-path>"
OUT = r"<local-dev-path>"
os.makedirs(OUT, exist_ok=True)


def log(*a):
    print(*a, flush=True)


# ---- SWOW: zip 内 csv 探测 cue/response 列 ----
def preprocess_swow(src_hint, out_name, lang):
    out_path = os.path.join(OUT, out_name)
    if os.path.exists(out_path) and os.path.getsize(out_path) > 1024:
        log(f"[swow:{lang}] 已存在跳过 {out_path}")
        return
    # 候选: 目录下已解压 csv,或 zip
    cands = []
    for pat in ("**/*.csv", "**/*.tsv"):
        cands += glob.glob(os.path.join(src_hint, pat), recursive=True)
    zips = glob.glob(os.path.join(src_hint, "**/*.zip"), recursive=True)
    rows_written = 0

    def sniff_and_write(fobj, name, out):
        nonlocal rows_written
        # SWOW 官方发布列名: cue,response + R1/R123/strength 变体;逐一探测
        head = fobj.readline()
        delim = "\t" if "\t" in head else ","
        cols = [c.strip().strip('"').lower() for c in head.strip().split(delim)]
        log(f"  [{name}] 列: {cols}")
        try:
            ci = next(i for i, c in enumerate(cols) if c in ("cue", "word"))
            ri = next(i for i, c in enumerate(cols) if c in ("response", "resp"))
        except StopIteration:
            log(f"  [{name}] 无 cue/response 列, 跳过")
            return False
        # 列优先级: 归一化 strength 列绝对优先;r1/count 是原始计数,量纲差百倍
        # (白盒0801教训: 英文表误选 r1 → snake str=71 爆表压倒全池)
        si = next((i for i, c in enumerate(cols) if "strength" in c), None)
        if si is None:
            si = next((i for i, c in enumerate(cols) if c in ("r1", "r123", "n", "count")), None)
        reader = csv.reader(fobj, delimiter=delim)
        for r in reader:
            if len(r) <= max(ci, ri):
                continue
            cue, resp = r[ci].strip(), r[ri].strip()
            if not cue or not resp or resp.lower() in ("na", "nan", "unknown word", "no more responses"):
                continue
            if lang == "zh":
                cue, resp = t2s(cue), t2s(resp)
            s = r[si].strip() if si is not None and len(r) > si else "1"
            out.write(f"{cue}\t{resp}\t{s}\n")
            rows_written += 1
        return True

    with open(out_path, "w", encoding="utf-8") as out:
        out.write("cue\tresponse\tstrength\n")
        done = False
        # 优先找文件名带 strength 的官方聚合表(cue,response,R1,strength)
        ranked = sorted(cands, key=lambda p: (0 if "strength" in os.path.basename(p).lower() else 1, len(p)))
        for p in ranked:
            with open(p, encoding="utf-8", errors="replace") as f:
                if sniff_and_write(f, os.path.basename(p), out):
                    done = True
                    break
        if not done:
            for zp in zips:
                with zipfile.ZipFile(zp) as z:
                    names = sorted([n for n in z.namelist() if n.lower().endswith(".csv")],
                                   key=lambda n: (0 if "strength" in n.lower() else 1, len(n)))
                    for n in names:
                        with z.open(n) as raw:
                            f = io.TextIOWrapper(raw, encoding="utf-8", errors="replace")
                            if sniff_and_write(f, f"{os.path.basename(zp)}!{n}", out):
                                done = True
                                break
                if done:
                    break
    log(f"[swow:{lang}] 写出 {rows_written} 行 -> {out_path}")


# ---- ConceptNet: assertions 5.7 gz → zh/en 倒排 ----
# 标准格式 TSV: uri, /r/Rel, /c/lang/word, /c/lang/word, json(weight)
REL_KEEP = {"Causes", "MotivatedByGoal", "CapableOf", "UsedFor", "HasSubevent",
            "CausesDesire", "HasProperty", "AtLocation", "HasA", "PartOf",
            "RelatedTo", "IsA", "Synonym", "Antonym"}
CN_PER_WORD_CAP = 60  # 每词每语言总关联上限(按 weight 降序),防索引爆炸


def preprocess_conceptnet():
    out_zh = os.path.join(OUT, "conceptnet_zh.json")
    out_en = os.path.join(OUT, "conceptnet_en.json")
    if os.path.exists(out_zh) and os.path.exists(out_en):
        log("[conceptnet] 已存在跳过")
        return
    src = os.path.join(BASE, "conceptnet", "conceptnet-assertions-5.7.0.csv.gz")
    inv = {"zh": {}, "en": {}}

    def word_of(uri):
        # /c/zh/苹果 或 /c/en/apple/n → (lang, word)
        parts = uri.split("/")
        if len(parts) < 4 or parts[1] != "c":
            return None, None
        return parts[2], parts[3].replace("_", " ")

    n_read = n_kept = 0
    with gzip.open(src, "rt", encoding="utf-8", errors="replace") as f:
        for line in f:
            n_read += 1
            if n_read % 5000000 == 0:
                log(f"  ...{n_read} 行")
            cols = line.rstrip("\n").split("\t")
            if len(cols) < 5:
                continue
            rel = cols[1].rsplit("/", 1)[-1]
            if rel not in REL_KEEP:
                continue
            l1, w1 = word_of(cols[2])
            l2, w2 = word_of(cols[3])
            if not w1 or not w2:
                continue
            try:
                weight = json.loads(cols[4]).get("weight", 1.0)
            except Exception:
                weight = 1.0
            # 只收 zh-zh / en-en 同语言边(跨语言翻译边不是发散关系)
            if l1 == l2 and l1 in ("zh", "en"):
                inv[l1].setdefault(w1, []).append([rel, w2, round(weight, 2)])
                inv[l1].setdefault(w2, []).append([rel + "~", w1, round(weight, 2)])  # ~=反向边
                n_kept += 1
    for lang, path in (("zh", out_zh), ("en", out_en)):
        for w in inv[lang]:
            inv[lang][w].sort(key=lambda x: -x[2])
            inv[lang][w] = inv[lang][w][:CN_PER_WORD_CAP]
        with open(path, "w", encoding="utf-8") as f:
            json.dump(inv[lang], f, ensure_ascii=False)
        log(f"[conceptnet:{lang}] 词条 {len(inv[lang])} -> {path}")
    log(f"[conceptnet] 读 {n_read} 行, 保留 {n_kept} 条边")


# ---- 词林扩展版: GBK → utf8 tsv ----
def preprocess_cilin():
    out_path = os.path.join(OUT, "cilin.tsv")
    if os.path.exists(out_path):
        log("[cilin] 已存在跳过")
        return
    src_dir = os.path.join(BASE, "HIT-IR-Lab-Tongyici-Cilin-Extended")
    cands = glob.glob(os.path.join(src_dir, "**/*.txt"), recursive=True)
    n = 0
    with open(out_path, "w", encoding="utf-8") as out:
        for p in sorted(cands, key=lambda x: -os.path.getsize(x)):
            ok = False
            for enc in ("gbk", "utf-8", "gb18030"):
                try:
                    with open(p, encoding=enc) as f:
                        lines = f.readlines()
                    ok = True
                    break
                except UnicodeDecodeError:
                    continue
            if not ok:
                continue
            # 标准行: Aa01A01= 人 士 人物 ...  (=同义 #相关 @独立)
            import re
            pat = re.compile(r"^([A-Z][a-z]\d{2}[A-Z]\d{2})([=#@])\s+(.+)$")
            for line in lines:
                m = pat.match(line.strip())
                if m:
                    out.write(f"{m.group(1)}{m.group(2)}\t{m.group(3)}\n")
                    n += 1
            if n > 0:
                log(f"[cilin] 源 {os.path.basename(p)} (编码 {enc})")
                break
    log(f"[cilin] 写出 {n} 行 -> {out_path}")


# ---- Numberbatch: 全量 gz 抽 zh/en 子集 → int8 量化(mini.h5 是截断坏文件 10MB/632MB) ----
def extract_numberbatch():
    import numpy as np
    out_words = os.path.join(OUT, "nb_words.txt")
    out_vec = os.path.join(OUT, "nb_vec_int8.npy")
    if os.path.exists(out_words) and os.path.exists(out_vec):
        log("[numberbatch] 已存在跳过")
        return
    src = os.path.join(BASE, "conceptnet-numberbatch", "numberbatch-19.08.txt.gz")
    words, rows = [], []
    n_read = 0
    with gzip.open(src, "rt", encoding="utf-8", errors="replace") as f:
        next(f)  # 首行 = "词数 维度"
        for line in f:
            n_read += 1
            if n_read % 2000000 == 0:
                log(f"  ...{n_read} 行, 已收 {len(words)}")
            if not line.startswith("/c/zh/") and not line.startswith("/c/en/"):
                continue
            parts = line.rstrip().split(" ")
            uri = parts[0]
            lang, word = uri.split("/")[2], uri.split("/")[3]
            if lang == "zh":
                word = t2s(word)
            vec = np.array(parts[1:], dtype="float32")
            n = np.linalg.norm(vec)
            if n == 0:
                continue
            vec = vec / n
            words.append(f"{lang}/{word}")
            rows.append(np.clip(np.round(vec * 127), -127, 127).astype("int8"))
    mat = np.stack(rows)
    np.save(out_vec, mat)
    with open(out_words, "w", encoding="utf-8") as f:
        f.write("\n".join(words))
    log(f"[numberbatch] 抽取 {len(words)} 词 (读{n_read}行) -> {out_vec} {mat.shape}")


# ---- ConceptNet zh 繁简归一(对已生成 json 做 t2s 合并重写) ----
def t2s_conceptnet():
    p = os.path.join(OUT, "conceptnet_zh.json")
    flag = os.path.join(OUT, ".conceptnet_zh.t2s_done")
    if os.path.exists(flag):
        log("[cn_t2s] 已归一跳过")
        return
    with open(p, encoding="utf-8") as f:
        inv = json.load(f)
    merged = {}
    for w, edges in inv.items():
        sw = t2s(w)
        merged.setdefault(sw, []).extend(
            [[rel, t2s(tgt), wt] for rel, tgt, wt in edges])
    for w in merged:
        seen = set()
        uniq = []
        for e in sorted(merged[w], key=lambda x: -x[2]):
            k = (e[0], e[1])
            if k in seen:
                continue
            seen.add(k)
            uniq.append(e)
        merged[w] = uniq[:60]
    with open(p, "w", encoding="utf-8") as f:
        json.dump(merged, f, ensure_ascii=False)
    open(flag, "w").close()
    log(f"[cn_t2s] 繁简归一完成: {len(inv)} → {len(merged)} 词条")


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    if which in ("all", "swow"):
        preprocess_swow(os.path.join(BASE, "SWOWZH"), "swow_zh.tsv", "zh")
        preprocess_swow(os.path.join(BASE, "swow", "SWOW-ZH24"), "swow_zh.tsv", "zh")
        preprocess_swow(os.path.join(BASE, "SWOW-EN18"), "swow_en.tsv", "en")
    if which in ("all", "conceptnet"):
        preprocess_conceptnet()
    if which in ("all", "cilin"):
        preprocess_cilin()
    if which in ("all", "cn_t2s"):
        t2s_conceptnet()
    if which in ("all", "nb"):
        extract_numberbatch()
    log("done")
