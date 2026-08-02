# gigatoken_bridge.py — LLM 分词器桥(混合排序层的第二视角分词)
# stdin: {"texts": [...]} → stdout: {"provider", "results": [[token_str,...],...]}
#
# 设计: 用 LLM 的 token 粒度重切原话,用于短语级匹配;不替代 jieba/HanLP,是并行第二视角
# gigatoken 缺失 → exit 3(JS 侧如实降级为字符 n-gram,并在白盒声明)

import sys, io, json

sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8-sig")  # -sig: 容 BOM(0801确诊)
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

try:
    import gigatoken as gt
except ImportError as e:
    sys.stderr.write(f"missing dep: {e}\n")
    sys.exit(3)

MODEL = "Qwen/Qwen3-8B"  # 设计指定;换模型改此处即可

try:
    tokenizer = gt.Tokenizer(MODEL)
except Exception as e:
    sys.stderr.write(f"tokenizer init failed ({MODEL}): {e}\n")
    sys.exit(3)


def main():
    req = json.load(sys.stdin)
    results = []
    for t in req.get("texts", []):
        ids = tokenizer.encode(t)
        # decode([i]) 返回 bytes 且单 token 可能是不完整 UTF-8 片段(中文一字≥2 token 常见,0801确诊),
        # 字节缓冲累积,凑成完整字符才输出——保 token 边界语义同时不产残缺字符
        toks = []
        buf = b""
        for i in ids:
            piece = tokenizer.decode([i])
            buf += piece.encode("utf-8") if isinstance(piece, str) else bytes(piece)
            try:
                s = buf.decode("utf-8")
            except UnicodeDecodeError:
                continue
            if s.strip():
                toks.append(s)
            buf = b""
        results.append(toks)
    json.dump({"provider": f"gigatoken:{MODEL}", "results": results}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
