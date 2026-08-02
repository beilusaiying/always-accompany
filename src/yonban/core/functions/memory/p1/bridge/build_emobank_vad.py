# build_emobank_vad.py — EmoBank 句子级 VAD → 词级聚合(设计§标注打分: emobank[word]→{V,A,D})
# EmoBank 本体是句子级语料;设计要求词级查表 → 一次性聚合: 词的 VAD = 含该词句子的 V/A/D 均值(≥2句)
import io, sys, csv, glob, os, re
from collections import defaultdict

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
SRC_DIR = r"D:\shajiuguan\p1shiyanshi\09_P1自驱动_专项\06_资源库_词库\P1资源库\EmoBank"
OUT = r"D:\shajiuguan\自驱动召回\resources_derived\emobank_word_vad.tsv"

cands = [f for f in glob.glob(os.path.join(SRC_DIR, "**", "*.csv"), recursive=True)
         if ".git" not in f]
cands.sort(key=lambda f: (0 if os.path.basename(f).lower() == "emobank.csv" else 1))
src = cands[0]
print("source:", src)

acc = defaultdict(lambda: [0.0, 0.0, 0.0, 0])
with open(src, encoding="utf-8", errors="replace") as f:
    reader = csv.DictReader(f)
    print("columns:", reader.fieldnames)
    vk = next(k for k in reader.fieldnames if k.strip().upper() == "V")
    ak = next(k for k in reader.fieldnames if k.strip().upper() == "A")
    dk = next(k for k in reader.fieldnames if k.strip().upper() == "D")
    tk = next(k for k in reader.fieldnames if k.strip().lower() == "text")
    for row in reader:
        try:
            v, a, d = float(row[vk]), float(row[ak]), float(row[dk])
        except (ValueError, TypeError):
            continue
        for w in set(re.findall(r"[a-z]+", (row[tk] or "").lower())):
            if len(w) < 3:
                continue
            e = acc[w]
            e[0] += v; e[1] += a; e[2] += d; e[3] += 1

n = 0
with open(OUT, "w", encoding="utf-8") as out:
    out.write("word\tV\tA\tD\tn\n")
    for w, (v, a, d, c) in acc.items():
        if c < 2:
            continue
        out.write(f"{w}\t{v/c:.3f}\t{a/c:.3f}\t{d/c:.3f}\t{c}\n")
        n += 1
print(f"written {n} words -> {OUT}")
