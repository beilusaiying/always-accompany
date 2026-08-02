# daemon_http.py — 常驻 HTTP 服务: tokenize + nb + gigatoken 三合一
#
# 启动: python bridge/daemon_http.py [port]  (默认 13160)
# 端点: POST /tokenize, /nb, /gigatoken
# 同一 Python 进程，一次冷启后续请求 <10ms

import sys, io, json, os, traceback
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 13160
DERIVED = os.environ.get('P1V2_DERIVED', r'D:\shajiuguan\自驱动召回\resources_derived')
ONNX_DIR = os.path.join(DERIVED, 'hanlp_onnx')

print(f'[daemon] Loading resources from {DERIVED}', flush=True)

# ---- tokenize ----
import jieba
import jieba.posseg as pseg
import numpy as np

for ud in ['userdict_main.txt', 'userdict_moetype_acg.txt']:
    p = os.path.join(DERIVED, ud)
    if os.path.exists(p):
        jieba.load_userdict(p)
        print(f'[daemon] Loaded userdict: {ud}', flush=True)

jieba.initialize()
FREQ = jieba.dt.FREQ

_hanlp_sess = None
_hanlp_tok = None
_hanlp_tags = None
CTB_MAP = {
    'NN':'n','NR':'nr','NT':'nt','VV':'v','VA':'a','VC':'v','VE':'v',
    'JJ':'a','AD':'d','CD':'m','OD':'m','M':'m','P':'p','CC':'c','CS':'c',
    'DT':'r','PN':'r','DEC':'u','DEG':'u','DEV':'u','DER':'u',
    'LC':'f','BA':'p','LB':'p','SB':'p','SP':'y','AS':'u','ETC':'u','MSP':'u',
    'PU':'w','FW':'nx','IJ':'e','URL':'nx','EM':'nx','ON':'o','NOI':'x','IC':'x',
}

try:
    import onnxruntime as ort
    from transformers import ElectraTokenizerFast
    mp = os.path.join(ONNX_DIR, 'pos_ctb9_electra_small.onnx')
    if os.path.exists(mp):
        _hanlp_tok = ElectraTokenizerFast.from_pretrained(os.path.join(ONNX_DIR, 'tokenizer'))
        _hanlp_sess = ort.InferenceSession(mp, providers=['CPUExecutionProvider'])
        _hanlp_tags = json.load(open(os.path.join(ONNX_DIR, 'tag_vocab.json'), encoding='utf-8'))
        print('[daemon] HanLP ONNX loaded', flush=True)
except Exception as e:
    print(f'[daemon] HanLP ONNX unavailable: {e}', flush=True)

def hanlp_pos_chars(text):
    if not _hanlp_sess: return None
    enc = _hanlp_tok(text, return_tensors='np', padding=True, truncation=True, max_length=512)
    logits = _hanlp_sess.run(None, {'input_ids': enc['input_ids']})[0]
    preds = np.argmax(logits, axis=-1)[0]
    tokens = _hanlp_tok.convert_ids_to_tokens(enc['input_ids'][0])
    return [(t, _hanlp_tags.get(str(p), 'NN'))
            for t, p in zip(tokens, preds) if t not in ('[CLS]','[SEP]','[PAD]')]

def do_tokenize(body):
    results = []
    for text in body.get('texts', []):
        toks = []
        char_tags = hanlp_pos_chars(text)
        off = 0
        for w, pj in pseg.cut(text):
            w2 = w.strip()
            if not w2: off += len(w); continue
            pos = pj
            if char_tags and off < len(char_tags):
                pos = CTB_MAP.get(char_tags[off][1], 'x')
            toks.append({"w": w2, "pos": pos, "oov": w2 not in FREQ or FREQ.get(w2,0)==0})
            off += len(w)
        results.append(toks)
    return {"provider": {"segmenter":"jieba_precise","pos":"hanlp_onnx_ctb9" if _hanlp_sess else "jieba_posseg"}, "results": results}

# ---- nb ----
W_PATH = os.path.join(DERIVED, "nb_words.txt")
V_PATH = os.path.join(DERIVED, "nb_vec_int8.npy")
_nb_index = {}
_nb_mat = None

if os.path.exists(W_PATH) and os.path.exists(V_PATH):
    with open(W_PATH, encoding="utf-8") as f:
        _nb_index = {w: i for i, w in enumerate(f.read().split("\n"))}
    _nb_mat = np.load(V_PATH, mmap_mode="r")
    print(f'[daemon] NB loaded: {len(_nb_index)} words', flush=True)

def nb_vec(word):
    w = word.strip().lower().replace(" ","_")
    for key in (f"zh/{w}", f"en/{w}"):
        i = _nb_index.get(key)
        if i is not None:
            v = _nb_mat[i].astype("float32")/127.0
            n = np.linalg.norm(v)
            return v/n if n>0 else None
    return None

def do_nb(body):
    anchors, candidates = body.get("anchors",[]), body.get("candidates",[])
    avecs = [v for v in (nb_vec(a) for a in anchors) if v is not None]
    out = {"cos":{}, "oov":[], "anchorHit":len(avecs)}
    if not avecs: return out
    c = np.mean(avecs, axis=0); n=np.linalg.norm(c); c = c/n if n>0 else c
    for w in candidates:
        v = nb_vec(w)
        if v is None: out["oov"].append(w)
        else: out["cos"][w] = round(float(np.dot(c,v)),4)
    return out

# ---- gigatoken ----
_gt = None
try:
    import gigatoken as gt
    _gt = gt.Tokenizer("Qwen/Qwen3-8B")
    print('[daemon] Gigatoken loaded', flush=True)
except: pass

def do_gigatoken(body):
    if not _gt: return {"error":"gigatoken not loaded"}
    results = []
    for t in body.get("texts",[]):
        ids = _gt.encode(t)
        toks, buf = [], b""
        for i in ids:
            piece = _gt.decode([i])
            buf += piece.encode("utf-8") if isinstance(piece,str) else bytes(piece)
            try: s=buf.decode("utf-8")
            except UnicodeDecodeError: continue
            if s.strip(): toks.append(s)
            buf = b""
        results.append(toks)
    return {"provider":f"gigatoken:Qwen/Qwen3-8B","results":results}

# ---- HTTP handler ----
ROUTES = {'/tokenize': do_tokenize, '/nb': do_nb, '/gigatoken': do_gigatoken}

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        fn = ROUTES.get(self.path)
        if not fn:
            self.send_error(404); return
        try:
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            result = fn(body)
            data = json.dumps(result, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type','application/json')
            self.send_header('Content-Length', len(data))
            self.end_headers()
            self.wfile.write(data)
        except Exception:
            err = traceback.format_exc()[:500].encode('utf-8')
            self.send_response(500)
            self.send_header('Content-Length', len(err))
            self.end_headers()
            self.wfile.write(err)
    def log_message(self, *a): pass  # 静默请求日志

print(f'[daemon] Starting HTTP on :{PORT}', flush=True)
HTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
