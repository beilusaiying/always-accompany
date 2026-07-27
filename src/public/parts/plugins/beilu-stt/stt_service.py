"""
beilu-stt: FastAPI microservice wrapping MOSS-Transcribe-Diarize 0.9B.

Provides /transcribe (POST multipart), /health (GET), /config (GET).
Model path and port are configurable via CLI args --model and --port.
"""

from __future__ import annotations

import argparse
import importlib
import logging
import os
import sys
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# 依赖白盒检测 — 启动前逐项检查，缺什么报什么
# ---------------------------------------------------------------------------
_REQUIRED = [
    ("torch", "torch"),
    ("transformers", "transformers>=5.0.0"),
    ("fastapi", "fastapi"),
    ("uvicorn", "uvicorn"),
    ("multipart", "python-multipart"),
    ("av", "av"),
    ("librosa", "librosa"),
    ("soundfile", "soundfile"),
    ("sounddevice", "sounddevice"),
    ("noisereduce", "noisereduce"),
    ("silero_vad", "silero-vad"),
]
_missing = []
for _mod, _pkg in _REQUIRED:
    try:
        importlib.import_module(_mod)
    except ImportError:
        _missing.append(_pkg)
if _missing:
    import subprocess
    print(f"[beilu-stt] 自动安装缺少的依赖: {', '.join(_missing)}", file=sys.stderr)
    subprocess.check_call(
        [sys.executable, "-m", "pip", "install", "--quiet"] + _missing,
        stdout=sys.stderr,
    )
    for _mod, _pkg in _REQUIRED:
        if _pkg in _missing:
            importlib.import_module(_mod)

import torch
import uvicorn
from fastapi import FastAPI, File, Form, Query, UploadFile
from fastapi.responses import JSONResponse

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("beilu-stt")

# ---------------------------------------------------------------------------
# Global state — populated during lifespan startup
# ---------------------------------------------------------------------------
_state: dict[str, Any] = {
    "model": None,
    "processor": None,
    "device": None,
    "dtype": None,
    "model_path": None,
    "loaded": False,
    "load_error": None,
}

# Supported languages — MOSS-Transcribe-Diarize supports 50+ languages;
# listing the most common ones for the /config endpoint.
SUPPORTED_LANGUAGES = [
    "auto", "zh", "en", "ja", "ko", "es", "fr", "de", "pt", "ru",
    "it", "nl", "pl", "tr", "ar", "th", "vi", "id", "ms", "hi",
    "uk", "cs", "ro", "sv", "da", "fi", "no", "hu", "el", "he",
]

SUPPORTED_AUDIO_EXTENSIONS = {
    ".wav", ".mp3", ".flac", ".ogg", ".opus", ".m4a", ".aac", ".wma", ".webm",
    ".mp4", ".m4v", ".mov", ".mkv", ".avi", ".flv", ".wmv",
}

# Language-specific default prompts
LANGUAGE_PROMPTS: dict[str, str] = {
    "zh": (
        "请将音频转写为文本，每一段需以起始时间戳和说话人编号"
        "（[S01]、[S02]、[S03]…）开头，正文为对应的语音内容，"
        "并在段末标注结束时间戳，以清晰标明该段语音范围。"
    ),
    "en": (
        "Transcribe the audio. For each segment, start with the timestamp "
        "and speaker ID ([S01], [S02], [S03], ...), then the spoken text, "
        "and end with the segment timestamp."
    ),
}
DEFAULT_PROMPT = LANGUAGE_PROMPTS["zh"]

# 模型没有硬性 language 参数（官方 server.py 只接受 prompt，README 称 language 为"可选的语言提示"），
# 语言选择只能以提示词方式生效：非 zh/en 语言在默认 prompt 后追加"音频语言为X"提示。
LANGUAGE_NAMES: dict[str, str] = {
    "ja": "日语", "ko": "韩语", "es": "西班牙语", "fr": "法语", "de": "德语",
    "pt": "葡萄牙语", "ru": "俄语", "it": "意大利语", "nl": "荷兰语", "pl": "波兰语",
    "tr": "土耳其语", "ar": "阿拉伯语", "th": "泰语", "vi": "越南语", "id": "印尼语",
    "ms": "马来语", "hi": "印地语", "uk": "乌克兰语", "cs": "捷克语", "ro": "罗马尼亚语",
    "sv": "瑞典语", "da": "丹麦语", "fi": "芬兰语", "no": "挪威语", "hu": "匈牙利语",
    "el": "希腊语", "he": "希伯来语",
}


def _build_prompt(language: str, hotwords: str | None) -> str:
    """Build the transcription prompt from language and optional hotwords."""
    lang = language.lower().strip() if language else "auto"
    prompt = LANGUAGE_PROMPTS.get(lang, DEFAULT_PROMPT)
    if lang not in ("auto", "zh", "en"):
        prompt += f"音频语言为{LANGUAGE_NAMES.get(lang, lang)}。"
    if hotwords:
        # Follow the MOSS convention: append hotword hint
        if lang == "en":
            prompt += f" Hotwords: {hotwords}"
        else:
            prompt += f"热词提示：{hotwords}"
    return prompt


# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------
def load_model(model_path: str) -> None:
    """Load the MOSS-Transcribe-Diarize model and processor into _state."""
    logger.info("Loading model from %s ...", model_path)
    t0 = time.monotonic()

    try:
        from moss_transcribe_diarize.inference_utils import resolve_device
        from transformers import AutoModelForCausalLM, AutoProcessor

        device = resolve_device("auto")
        dtype = torch.bfloat16 if device.type == "cuda" else torch.float32

        model = AutoModelForCausalLM.from_pretrained(
            model_path,
            trust_remote_code=True,
            dtype="auto",
        ).to(dtype=dtype).to(device).eval()

        processor = AutoProcessor.from_pretrained(
            model_path,
            trust_remote_code=True,
        )

        _state["model"] = model
        _state["processor"] = processor
        _state["device"] = device
        _state["dtype"] = dtype
        _state["model_path"] = model_path
        _state["loaded"] = True
        _state["load_error"] = None

        elapsed = time.monotonic() - t0
        logger.info(
            "Model loaded in %.1fs — device=%s, dtype=%s",
            elapsed, device, dtype,
        )

    except Exception as exc:
        _state["loaded"] = False
        _state["load_error"] = str(exc)
        logger.error("Failed to load model: %s", exc, exc_info=True)


# ---------------------------------------------------------------------------
# FastAPI lifespan
# ---------------------------------------------------------------------------
# 路径默认全部仓库相对(凛倾 0722:禁机器硬编码;模型统一放仓库根 moxin/):
# 本文件位于 <root>/src/public/parts/plugins/beilu-stt/ → parents[5]=仓库根
_PLUGIN_DIR = Path(__file__).resolve().parent
_REPO_ROOT = Path(__file__).resolve().parents[5]
DEFAULT_VENDOR_DIR = str(_PLUGIN_DIR / "vendor")
DEFAULT_MODEL_DIR = str(_REPO_ROOT / "moxin" / "MOSS-Transcribe-Diarize")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup: add vendored MOSS package dir to sys.path and load the model."""
    moss_repo = os.environ.get("MOSS_REPO_PATH", DEFAULT_VENDOR_DIR)
    if moss_repo not in sys.path:
        sys.path.insert(0, moss_repo)
        logger.info("Added to sys.path: %s", moss_repo)

    model_path = os.environ.get("STT_MODEL_PATH", app.state.model_path)
    load_model(model_path)
    yield


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(
    title="beilu-stt",
    description="Speech-to-text service powered by MOSS-Transcribe-Diarize 0.9B",
    version="0.1.0",
    lifespan=lifespan,
)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/health")
async def health():
    """Health check — returns model load status."""
    if _state["loaded"]:
        return {
            "status": "ok",
            "model_loaded": True,
            "device": str(_state["device"]),
            "dtype": str(_state["dtype"]),
            "model_path": _state["model_path"],
        }
    return JSONResponse(
        status_code=503,
        content={
            "status": "unavailable",
            "model_loaded": False,
            "error": _state["load_error"],
        },
    )


@app.get("/config")
async def config():
    """Return current configuration and capabilities."""
    return {
        "model_path": _state["model_path"],
        "model_loaded": _state["loaded"],
        "device": str(_state["device"]) if _state["device"] else None,
        "dtype": str(_state["dtype"]) if _state["dtype"] else None,
        "supported_languages": SUPPORTED_LANGUAGES,
        "supported_audio_extensions": sorted(SUPPORTED_AUDIO_EXTENSIONS),
        "default_max_new_tokens": 8192,
        "default_language": "auto",
    }


def _audio_forensics(tmp_path: str, size_bytes: int):
    """白盒:服务端音频体检(解码后波形能量),与前端录音节点对账。
    静音判据依 20260722 实测:静音录音 peak≤0.009,正常语音 peak≈0.5。"""
    try:
        import numpy as _np
        from moss_transcribe_diarize.inference_utils import load_audio_item
        _wave = load_audio_item(tmp_path, sampling_rate=16000)
        info = {
            "duration_s": round(len(_wave) / 16000, 2),
            "rms": round(float(_np.sqrt((_wave ** 2).mean())), 6),
            "peak": round(float(_np.abs(_wave).max()), 6),
            "size_bytes": size_bytes,
        }
        logger.info("Audio forensics: %s", info)
        return info
    except Exception as _fx:
        logger.warning("Audio forensics failed: %s", _fx)
        return None


# ── 拾音+降噪管线(凛倾 0722"降噪+拾音,看专业项目直接拿来用") ──────────────────
# ①拾音增益归一化:peak<0.3 判拾音弱,提到 0.9(上限 20x)
# ②降噪后端择优:DeepFilterNet CLI(Rikorose/DeepFilterNet 官方 Rust 单文件 exe,深度全频带降噪,
#   Discord级质量;pip 包在 Python3.14 无轮子,CLI exe 才是"直接拿来用") > noisereduce 谱减(保底)
#   exe 位置:env DEEP_FILTER_EXE > <repo>/moxin/tools/deep-filter.exe(面板可下载)
# ③Silero VAD 静音裁剪:段间留 0.2s 拼接,砍长静音防 decoder 幻觉+省算力;全静音不裁(交静音门暴露)
_VAD = None


def _vad_model():
    global _VAD
    if _VAD is None:
        import shutil
        import torch
        import silero_vad as _sv
        jit = Path(_sv.__file__).parent / "data" / "silero_vad.jit"
        try:
            _VAD = torch.jit.load(str(jit))
        except Exception:
            # torch Windows fopen 非 ASCII 路径 bug(用户名/仓库含中文时实测复现)→ 拷 ASCII 缓存再载
            cache = Path("C:/tmp/beilu_stt_cache") if os.name == "nt" else Path(tempfile.gettempdir()) / "beilu_stt_cache"
            cache.mkdir(parents=True, exist_ok=True)
            dst = cache / "silero_vad.jit"
            if not dst.exists():
                shutil.copy(jit, dst)
            _VAD = torch.jit.load(str(dst))
    return _VAD


def _enhance_audio(tmp_path: str):
    """拾音+降噪管线,返回 (增强后wav路径, info)。info={gain,backend,vad,...}"""
    import numpy as np
    import soundfile as sf
    from moss_transcribe_diarize.inference_utils import load_audio_item
    info = {"gain": 1.0, "backend": None, "vad": None}
    w = load_audio_item(tmp_path, sampling_rate=16000)

    # ① 拾音增益归一化
    peak = float(np.abs(w).max()) if len(w) else 0.0
    if 0 < peak < 0.3:
        g = min(0.9 / peak, 20.0)
        w = np.clip(w * g, -1.0, 1.0)
        info["gain"] = round(g, 2)

    # ② 降噪
    dfe = os.environ.get("DEEP_FILTER_EXE") or str(_REPO_ROOT / "moxin" / "tools" / "deep-filter.exe")
    if os.path.exists(dfe):
        try:
            import subprocess
            with tempfile.TemporaryDirectory() as td:
                ind = os.path.join(td, "in"); outd = os.path.join(td, "out")
                os.makedirs(ind); os.makedirs(outd)
                inp = os.path.join(ind, "a.wav")
                sf.write(inp, w, 16000, format="WAV", subtype="PCM_16")
                subprocess.run([dfe, "-o", outd, inp], check=True, capture_output=True, timeout=180)
                w = load_audio_item(os.path.join(outd, "a.wav"), sampling_rate=16000)
            info["backend"] = "deepfilternet"
        except Exception as e:
            logger.warning("deep-filter 失败,回退 noisereduce: %s", e)
    if info["backend"] is None:
        import noisereduce
        w = noisereduce.reduce_noise(y=w, sr=16000)
        info["backend"] = "noisereduce"

    # ③ VAD 静音裁剪
    try:
        import torch
        from silero_vad import get_speech_timestamps
        ts = get_speech_timestamps(torch.from_numpy(w.astype(np.float32)), _vad_model(), sampling_rate=16000)
        if ts:
            pad = int(0.2 * 16000)
            kept = np.concatenate([w[max(0, t["start"] - pad):min(len(w), t["end"] + pad)] for t in ts])
            if 0 < len(kept) < len(w):
                info["vad"] = {"segs": len(ts), "kept_s": round(len(kept) / 16000, 2), "orig_s": round(len(w) / 16000, 2)}
                w = kept
        else:
            info["vad"] = {"segs": 0}
    except Exception as e:
        logger.warning("VAD 跳过: %s", e)

    outp = tmp_path + ".denoised.wav"
    sf.write(outp, w.astype(np.float32), 16000, format="WAV", subtype="PCM_16")
    return outp, info


def _run_transcription(tmp_path: str, size_bytes: int, language: str, max_new_tokens: int, hotwords,
                       denoise: bool = False):
    """转录统一收口:三个入口(transcribe_json / transcribe / record/transcribe)共用。
    denoise=游戏/环境降噪(凛倾 0722):推理前对波形做谱减降噪(noisereduce),
    针对游戏音效/背景噪泄入麦克风的场景;在收口做=三入口一致生效。"""
    prompt = _build_prompt(language, hotwords)
    from moss_transcribe_diarize import parse_transcript
    from moss_transcribe_diarize.inference_utils import build_transcription_messages, generate_transcription

    enhance_info = None
    if denoise:
        try:
            _t0 = time.monotonic()
            tmp_path, enhance_info = _enhance_audio(tmp_path)
            enhance_info["time_s"] = round(time.monotonic() - _t0, 2)
            logger.info("Enhance pipeline: %s", enhance_info)
        except Exception as _dn_err:
            # 增强失败不阻断转录(诚实降级:meta 带实际态)
            logger.warning("Enhance failed, using raw audio: %s", _dn_err)
            denoise = False

    try:
        audio_forensics = _audio_forensics(tmp_path, size_bytes)

        messages = build_transcription_messages(tmp_path, prompt=prompt)
        t0 = time.monotonic()
        result = generate_transcription(
            _state["model"], _state["processor"], messages,
            max_new_tokens=max_new_tokens, do_sample=False,
            device=_state["device"], dtype=_state["dtype"],
        )
        inference_time = time.monotonic() - t0
        raw_text = result["text"]
        logger.info("Inference done in %.1fs — tokens=%s, raw=%r", inference_time, result.get("generated_tokens"), raw_text[:500])

        parsed = parse_transcript(raw_text)
        segments = [{"start": round(s.start, 2), "end": round(s.end, 2), "speaker": s.speaker, "text": s.text} for s in parsed]
        speakers = sorted(set(s.speaker for s in parsed))
        duration = round(max((s.end for s in parsed), default=0.0), 2)
        return {
            "segments": segments, "raw_text": raw_text, "duration": duration, "speakers": speakers,
            "meta": {"language": language, "max_new_tokens": max_new_tokens, "inference_time_s": round(inference_time, 2),
                     "prompt_tokens": result.get("prompt_len"), "generated_tokens": result.get("generated_tokens"),
                     "audio": audio_forensics, "prompt": prompt, "denoise": denoise,
                     "enhance": enhance_info},
        }
    finally:
        # 降噪派生的临时 wav 由本收口负责清理(调用方的 finally 只删原始 tmp)
        if denoise and tmp_path.endswith(".denoised.wav") and os.path.exists(tmp_path):
            try: os.unlink(tmp_path)
            except OSError: pass


@app.post("/transcribe_json")
async def transcribe_json(req: dict):
    """JSON endpoint: accepts {audioBase64, fileName, language, max_new_tokens, hotwords}."""
    import base64 as b64mod
    audio_b64 = req.get("audioBase64", "")
    file_name = req.get("fileName", "audio.webm")
    language = req.get("language", "auto")
    max_new_tokens = int(req.get("max_new_tokens", 8192))
    hotwords = req.get("hotwords")
    denoise = bool(req.get("denoise"))

    if not audio_b64:
        return JSONResponse(status_code=400, content={"error": "No audioBase64 provided"})
    if not _state["loaded"]:
        return JSONResponse(status_code=503, content={"error": "Model not loaded", "detail": _state["load_error"]})

    ext = Path(file_name).suffix.lower() or ".webm"
    tmp_path = None
    try:
        audio_bytes = b64mod.b64decode(audio_b64)
        logger.info("JSON transcribe: file=%s, size=%d bytes, ext=%s", file_name, len(audio_bytes), ext)

        with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
            tmp_path = tmp.name
            tmp.write(audio_bytes)

        return _run_transcription(tmp_path, len(audio_bytes), language, max_new_tokens, hotwords, denoise=denoise)
    except Exception as exc:
        logger.error("Transcription failed: %s", exc, exc_info=True)
        return JSONResponse(status_code=500, content={"error": "Transcription failed", "detail": str(exc)})
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try: os.unlink(tmp_path)
            except: pass


# ---------------------------------------------------------------------------
# 后端录音(系统麦直采) — 凛倾 20260722:"别把录音放到浏览器"
# 浏览器音频栈(默认虚拟麦 NVIDIA Broadcast/Voicemeeter 矩阵)会静音;
# 后端用 sounddevice 直采指定物理设备,浏览器只做遥控+试听。
# 单槽设计(本地单用户):同时只有一路录音。
# ---------------------------------------------------------------------------
_rec = {"stream": None, "chunks": [], "device": None, "started_at": None,
        "wave": None, "peak_recent": 0.0, "error": None}


@app.get("/record/devices")
async def record_devices():
    """枚举输入设备(id/名称/默认标记),供面板下拉。"""
    import sounddevice as sd
    # sd.default.device 是 _InputOutputPair(支持下标但非 list/tuple),直接下标取输入端并强转 int,
    # 否则该对象进 FastAPI jsonable_encoder 会无限递归(实测 RecursionError)
    try:
        default_in = int(sd.default.device[0])
    except Exception:
        default_in = None
    devices = []
    for i, d in enumerate(sd.query_devices()):
        if d["max_input_channels"] > 0:
            devices.append({"id": i, "name": d["name"], "default": i == default_in,
                            "samplerate": float(d["default_samplerate"])})
    return {"devices": devices, "default": default_in}


@app.post("/record/probe")
async def record_probe(req: dict):
    """设备电平探测:采 1.2s 环境音报 rms/peak——活的物理麦有底噪,死虚拟口≈0。
    device 缺省=探测全部输入设备并按 rms 排序(面板"找活麦")。"""
    import numpy as np
    import sounddevice as sd
    duration = float(req.get("duration", 1.2))

    def probe_one(idx):
        rec = sd.rec(int(duration * 16000), samplerate=16000, channels=1, dtype="float32", device=idx)
        sd.wait()
        w = rec.reshape(-1)
        return {"device": idx, "rms": round(float(np.sqrt((w ** 2).mean())), 6),
                "peak": round(float(np.abs(w).max()), 6)}

    if req.get("device") is not None:
        try:
            return probe_one(int(req["device"]))
        except Exception as e:
            return JSONResponse(status_code=400, content={"error": str(e)})

    results = []
    seen = set()
    for i, d in enumerate(sd.query_devices()):
        if d["max_input_channels"] <= 0:
            continue
        key = d["name"]
        if key in seen:
            continue
        seen.add(key)
        try:
            r = probe_one(i)
            # 虚拟口可能吐未归一化垃圾值(实测 Voicemeeter Point peak>1000),排除
            if r["peak"] > 10:
                continue
            r["name"] = d["name"]
            results.append(r)
        except Exception:
            continue
    results.sort(key=lambda r: r["rms"], reverse=True)
    return {"results": results}


@app.post("/record/start")
async def record_start(req: dict):
    """开始后端录音。device 缺省=系统默认输入。"""
    import numpy as np
    import sounddevice as sd
    if _rec["stream"] is not None:
        return JSONResponse(status_code=409, content={"error": "already recording"})
    device = req.get("device")
    device = int(device) if device not in (None, "") else None
    _rec.update({"chunks": [], "device": device, "started_at": time.monotonic(),
                 "wave": None, "peak_recent": 0.0, "error": None})

    def _cb(indata, frames, t, status):
        if status:
            _rec["error"] = str(status)
        data = indata.copy().reshape(-1)
        _rec["chunks"].append(data)
        _rec["peak_recent"] = float(np.abs(data).max())

    try:
        stream = sd.InputStream(samplerate=16000, channels=1, dtype="float32",
                                device=device, callback=_cb)
        stream.start()
        _rec["stream"] = stream
        dev_name = sd.query_devices(device)["name"] if device is not None else \
            sd.query_devices(sd.default.device[0])["name"]
        logger.info("Recording started: device=%s (%s)", device, dev_name)
        return {"status": "recording", "device": device, "device_name": dev_name}
    except Exception as e:
        _rec["stream"] = None
        logger.error("Record start failed: %s", e)
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.get("/record/status")
async def record_status():
    """录音态白盒:时长 + 实时电平(面板电平条)。"""
    recording = _rec["stream"] is not None
    return {"recording": recording,
            "elapsed_s": round(time.monotonic() - _rec["started_at"], 1) if recording and _rec["started_at"] else 0,
            "peak_recent": round(_rec["peak_recent"], 5),
            "has_audio": _rec["wave"] is not None,
            "error": _rec["error"]}


@app.post("/record/stop")
async def record_stop():
    """停止录音,返回体检(duration/rms/peak),音频留在服务端待试听/转录。"""
    import numpy as np
    stream = _rec["stream"]
    if stream is None:
        return JSONResponse(status_code=409, content={"error": "not recording"})
    _rec["stream"] = None
    try:
        stream.stop(); stream.close()
    except Exception as e:
        logger.warning("stream close: %s", e)
    if not _rec["chunks"]:
        return JSONResponse(status_code=422, content={"error": "no audio captured", "detail": _rec["error"]})
    wave = np.concatenate(_rec["chunks"])
    _rec["chunks"] = []
    _rec["wave"] = wave
    forensics = {"duration_s": round(len(wave) / 16000, 2),
                 "rms": round(float(np.sqrt((wave ** 2).mean())), 6),
                 "peak": round(float(np.abs(wave).max()), 6)}
    logger.info("Recording stopped: %s (device=%s)", forensics, _rec["device"])
    return {"status": "stopped", "audio": forensics, "device": _rec["device"], "callback_error": _rec["error"]}


@app.get("/record/audio")
async def record_audio():
    """取最近一段录音的 WAV(试听回放)。"""
    from fastapi.responses import Response
    if _rec["wave"] is None:
        return JSONResponse(status_code=404, content={"error": "no recording available"})
    import io
    import soundfile as sf
    buf = io.BytesIO()
    sf.write(buf, _rec["wave"], 16000, format="WAV", subtype="PCM_16")
    return Response(content=buf.getvalue(), media_type="audio/wav")


@app.post("/record/transcribe")
async def record_transcribe(req: dict):
    """转录服务端持有的最近录音(与 transcribe_json 同收口/同响应形状)。"""
    if _rec["wave"] is None:
        return JSONResponse(status_code=404, content={"error": "no recording available"})
    if not _state["loaded"]:
        return JSONResponse(status_code=503, content={"error": "Model not loaded", "detail": _state["load_error"]})
    language = req.get("language", "auto")
    max_new_tokens = int(req.get("max_new_tokens", 8192))
    hotwords = req.get("hotwords")
    denoise = bool(req.get("denoise"))
    tmp_path = None
    try:
        import soundfile as sf
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp:
            tmp_path = tmp.name
        sf.write(tmp_path, _rec["wave"], 16000, format="WAV", subtype="PCM_16")
        size = os.path.getsize(tmp_path)
        return _run_transcription(tmp_path, size, language, max_new_tokens, hotwords, denoise=denoise)
    except Exception as exc:
        logger.error("Record transcription failed: %s", exc, exc_info=True)
        return JSONResponse(status_code=500, content={"error": "Transcription failed", "detail": str(exc)})
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try: os.unlink(tmp_path)
            except: pass


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(..., description="Audio file to transcribe"),
    language: str = Form(default="auto", description="Language code (auto/zh/en/ja/ko/...)"),
    max_new_tokens: int = Form(default=8192, description="Maximum generated tokens"),
    hotwords: str = Form(default=None, description="Comma-separated hotwords"),
    denoise: bool = Form(default=False, description="Apply spectral noise reduction before inference"),
):
    """
    Transcribe an uploaded audio file.

    Returns structured segments with timestamps, speaker IDs, and text.
    """
    # --- Guard: model must be loaded ---
    if not _state["loaded"]:
        return JSONResponse(
            status_code=503,
            content={"error": "Model not loaded", "detail": _state["load_error"]},
        )

    # --- Validate file extension ---
    original_name = file.filename or "upload"
    ext = Path(original_name).suffix.lower()
    if ext and ext not in SUPPORTED_AUDIO_EXTENSIONS:
        return JSONResponse(
            status_code=400,
            content={
                "error": "Unsupported audio format",
                "detail": f"Extension '{ext}' is not supported. Supported: {sorted(SUPPORTED_AUDIO_EXTENSIONS)}",
            },
        )

    # --- Save upload to temp file ---
    tmp_path: str | None = None
    try:
        suffix = ext if ext else ".wav"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp_path = tmp.name
            content = await file.read()
            tmp.write(content)

        logger.info(
            "Audio received: file=%s, size=%d bytes, ext=%s, language=%s",
            original_name, len(content), ext, language,
        )

        # --- 统一收口:与 /transcribe_json、/record/transcribe 同管线 ---
        return _run_transcription(tmp_path, len(content), language, max_new_tokens, hotwords, denoise=denoise)

    except Exception as exc:
        logger.error("Transcription failed: %s", exc, exc_info=True)
        return JSONResponse(
            status_code=500,
            content={"error": "Transcription failed", "detail": str(exc)},
        )

    finally:
        # Clean up temp file
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="beilu-stt: MOSS-Transcribe-Diarize speech transcription service",
    )
    parser.add_argument(
        "--model",
        type=str,
        default=DEFAULT_MODEL_DIR,
        help="Path to the MOSS-Transcribe-Diarize model directory (default: <repo>/moxin/MOSS-Transcribe-Diarize)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=7861,
        help="Port to listen on (default: 7861)",
    )
    parser.add_argument(
        "--host",
        type=str,
        default="0.0.0.0",
        help="Host to bind to (default: 0.0.0.0)",
    )
    parser.add_argument(
        "--moss-repo",
        type=str,
        default=DEFAULT_VENDOR_DIR,
        help="Dir containing the moss_transcribe_diarize package (default: plugin vendor/)",
    )
    args = parser.parse_args()

    # Inject into env so lifespan can read them
    os.environ["STT_MODEL_PATH"] = args.model
    os.environ["MOSS_REPO_PATH"] = args.moss_repo

    # Also store on app.state for lifespan access
    app.state.model_path = args.model

    # Add MOSS repo to sys.path early so imports work during lifespan
    if args.moss_repo not in sys.path:
        sys.path.insert(0, args.moss_repo)

    logger.info("Starting beilu-stt on %s:%d", args.host, args.port)
    logger.info("Model path: %s", args.model)
    logger.info("MOSS repo:  %s", args.moss_repo)

    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        log_level="info",
    )


if __name__ == "__main__":
    main()
