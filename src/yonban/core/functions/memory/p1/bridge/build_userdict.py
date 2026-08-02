# build_userdict.py — jieba 自定义词典合并(设计§分词: jieba_dict.txt + 领域词典 load_userdict)
# 产出:
#   userdict_main.txt   = acg(4文件) + THUOCL(全部)  ≈几十万词,桥默认加载(秒级)
#   userdict_domain_full.txt = DomainWordsDict 68领域916万词, env P1_USERDICT_FULL=on 才加载(冷启分钟级,如实取舍)
import io, sys, glob, os

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
BASE = r"<local-dev-path>"
OUT = r"<local-dev-path>"


def emit(out, word, freq):
    w = word.strip()
    if not w or " " in w or len(w) > 16:
        return 0
    f = max(3, min(int(freq) if str(freq).strip().isdigit() else 3, 2000000))
    out.write(f"{w} {f}\n")
    return 1


def build(name, sources):
    path = os.path.join(OUT, name)
    n = 0
    with open(path, "w", encoding="utf-8") as out:
        for pat, delim in sources:
            for f in glob.glob(pat, recursive=True):
                try:
                    for line in open(f, encoding="utf-8", errors="replace"):
                        parts = line.strip().split(delim) if delim else line.strip().split()
                        if not parts or not parts[0].strip():
                            continue
                        n += emit(out, parts[0], parts[1] if len(parts) > 1 else 3)
                except OSError:
                    continue
    print(f"[{name}] {n} 词 -> {path}")


build("userdict_main.txt", [
    (BASE + r"\acg-chinese-words\*.txt", None),          # "词 频率"
    (BASE + r"\THUOCL\data\THUOCL_*.txt", "\t"),         # "词 \t 频率"
])
build("userdict_domain_full.txt", [
    (BASE + r"\DomainWordsDict\data\*.txt", "\t"),       # "词\t频率"
])
print("done")
