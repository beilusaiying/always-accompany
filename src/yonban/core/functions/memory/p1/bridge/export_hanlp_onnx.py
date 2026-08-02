# export_hanlp_onnx.py — HanLP CTB9 POS 模型导出 ONNX（一次性，导出后桥用 onnxruntime 推理）
# 跑法: python export_hanlp_onnx.py
# 产出: p1_res/p1v2_derived/hanlp_pos_ctb9.onnx + hanlp_pos_ctb9_labels.json + hanlp_pos_ctb9_vocab.json
import io, sys, os, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

OUT_DIR = os.path.join(os.path.dirname(__file__), '..', '..', 'p1_res', 'p1v2_derived')
os.makedirs(OUT_DIR, exist_ok=True)

print("1. 加载 HanLP CTB9 POS 模型...")
import torch
import hanlp
pos_model = hanlp.load(hanlp.pretrained.pos.CTB9_POS_ELECTRA_SMALL)

# HanLP 的 POS 模型内部是 transformer encoder + linear classifier
# 需要找到内部的 torch module
model = pos_model.model if hasattr(pos_model, 'model') else pos_model
print(f"  模型类型: {type(model).__name__}")

# 尝试直接导出整个模型
# HanLP v2 的 POS tagger 内部结构: encoder(electra) + decoder(linear)
# 我们需要: tokenizer vocab + label 映射 + onnx 模型

# 保存标签映射
if hasattr(pos_model, 'vocabs') and 'tag' in pos_model.vocabs:
    labels = pos_model.vocabs['tag'].idx_to_token
    json.dump(labels, open(os.path.join(OUT_DIR, 'hanlp_pos_ctb9_labels.json'), 'w'))
    print(f"  标签: {len(labels)} 个 → hanlp_pos_ctb9_labels.json")
elif hasattr(pos_model, 'tag_vocab'):
    labels = list(pos_model.tag_vocab.idx_to_token)
    json.dump(labels, open(os.path.join(OUT_DIR, 'hanlp_pos_ctb9_labels.json'), 'w'))
    print(f"  标签: {len(labels)} 个")
else:
    print("  ⚠ 找不到标签映射,检查模型结构")
    # 打印模型属性帮助定位
    for attr in dir(pos_model):
        if not attr.startswith('_') and 'vocab' in attr.lower():
            print(f"    attr: {attr} = {type(getattr(pos_model, attr))}")

# 保存 tokenizer vocab(electra 用 BertTokenizer)
if hasattr(pos_model, 'tokenizer'):
    tok = pos_model.tokenizer
    vocab = tok.vocab if hasattr(tok, 'vocab') else None
    if vocab:
        json.dump(dict(vocab), open(os.path.join(OUT_DIR, 'hanlp_pos_ctb9_vocab.json'), 'w', encoding='utf-8'), ensure_ascii=False)
        print(f"  词表: {len(vocab)} 个 → hanlp_pos_ctb9_vocab.json")

# 尝试 ONNX 导出
print("2. 导出 ONNX...")
try:
    model.eval()
    # electra small 输入: input_ids, token_type_ids, attention_mask (all int64, shape [batch, seq])
    dummy_input_ids = torch.randint(0, 1000, (1, 16))
    dummy_attention_mask = torch.ones(1, 16, dtype=torch.long)
    dummy_token_type_ids = torch.zeros(1, 16, dtype=torch.long)

    onnx_path = os.path.join(OUT_DIR, 'hanlp_pos_ctb9.onnx')
    torch.onnx.export(
        model,
        (dummy_input_ids, dummy_token_type_ids, dummy_attention_mask),
        onnx_path,
        input_names=['input_ids', 'token_type_ids', 'attention_mask'],
        output_names=['logits'],
        dynamic_axes={
            'input_ids': {0: 'batch', 1: 'seq'},
            'token_type_ids': {0: 'batch', 1: 'seq'},
            'attention_mask': {0: 'batch', 1: 'seq'},
            'logits': {0: 'batch', 1: 'seq'},
        },
        opset_version=14,
    )
    size_mb = os.path.getsize(onnx_path) / 1024 / 1024
    print(f"  导出成功: {onnx_path} ({size_mb:.1f}MB)")
except Exception as e:
    print(f"  直接导出失败: {e}")
    print("  尝试只导出 encoder+classifier 子模块...")
    # HanLP POS 内部可能是 TransformerTaggingModel
    for name, mod in model.named_children():
        print(f"    子模块: {name} = {type(mod).__name__}")

print("done")
