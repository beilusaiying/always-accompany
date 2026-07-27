#!/usr/bin/env python3
"""
桌面截图工具 (Python 版)

功能：
1. 系统托盘 ✦ 图标
2. 全局快捷键 Alt+Shift+S 触发框选截图
3. 桌面全屏截图 → 透明窗口框选 → 裁剪 → 发送对话框
4. HTTP POST 发送到 beilu 后端 后端 (localhost:1314)

依赖：pip install mss Pillow pystray keyboard
"""

import sys
import os
import io
import json
import base64
import threading
import time
import urllib.request
import urllib.error
import ctypes
from datetime import datetime
from pathlib import Path

# pythonw 模式下 stdout/stderr 可能为 None
# 重定向到 devnull 避免 print() 报错
if sys.stdout is None:
    sys.stdout = open(os.devnull, 'w')
if sys.stderr is None:
    sys.stderr = open(os.devnull, 'w')

# Windows 高 DPI 感知 — 必须在任何 GUI 操作之前设置
if sys.platform == 'win32':
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PROCESS_PER_MONITOR_DPI_AWARE
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass

import mss
import mss.tools
from PIL import Image, ImageDraw, ImageTk
import pystray
import keyboard

# ============================================================
# 配置
# ============================================================

BEILU_PORT = int(os.environ.get("BEILU_PORT", 1314))
BEILU_HOST = os.environ.get("BEILU_HOST", "localhost")
INJECT_ENDPOINT = "/api/eye/inject"

# inject per-user 鉴权令牌(A4): beilu-eye/main.mjs 拉起本进程时经 env BEILU_PET_TOKEN 注入,
#   绑定本截图客户端拥有者 username。inject 请求带 header x-pet-token → 端点反解 username 只给该 user 推图。
#   缺失(独立直跑,非经 beilu-eye 拉起)=空字符串 → 端点 resolvePetToken 返回 null → 403(安全:只 beilu 拉起的客户端能注入)。
PET_TOKEN = os.environ.get("BEILU_PET_TOKEN", "")

# ============================================================
# 全局状态
# ============================================================

_tray_icon = None
_capture_active = False
_orb_root = None  # 悬浮球 tkinter 根窗口（主线程）


def _get_target_window():
    """W61/F2: 从eye_config.json读取targetWindow设置"""
    try:
        config_path = Path(__file__).resolve().parent.parent / "data" / "users"
        # 找第一个用户目录下的eye_config.json
        if config_path.exists():
            for user_dir in config_path.iterdir():
                eye_path = user_dir / "eye_config.json"
                if eye_path.exists():
                    with open(eye_path, "r", encoding="utf-8") as f:
                        config = json.load(f)
                        return config.get("targetWindow") or config.get("captureWindow")
    except Exception as e:
        # 诊断可见(2026-07-10 审计C修):此前 pass 静默,eye_config.json 损坏时"目标窗口"配置无声失效
        print(f"[desktop-eye] eye_config 读取失败(目标窗口配置未生效): {e}")
    return None


def _get_capture_resolution():
    """从 eye_config.json 读取 captureResolution（目标降采样宽度）。
    默认 1080，clamp 到 480~2160（与后端 endpoints.mjs /api/eye/config 的范围一致）。
    仿 _get_target_window 的"找第一个用户目录"逻辑。"""
    default = 1080
    try:
        config_path = Path(__file__).resolve().parent.parent / "data" / "users"
        if config_path.exists():
            for user_dir in config_path.iterdir():
                eye_path = user_dir / "eye_config.json"
                if eye_path.exists():
                    with open(eye_path, "r", encoding="utf-8") as f:
                        config = json.load(f)
                        val = config.get("captureResolution")
                        if isinstance(val, (int, float)) and val > 0:
                            return int(max(480, min(2160, val)))
                        return default
    except Exception as e:
        print(f"[desktop-eye] eye_config 读取失败(分辨率配置未生效,用默认{default}): {e}")
    return default


def _get_filter_config():
    """从 eye_config.json 读【智能过滤】参数(设计稿"智能过滤"段 4 控件,前端 /api/eye/config 写)：
       dedupHammingThreshold(L1 去重阈值,默认5,clamp 0~20)、l2RegionDiff(L2 自适应区域差分)、
       l3Grading(L3 变化分级入meta)、metaTimestamp(语义时间戳元数据)。缺/异常→默认(阈值5,三项全开)。"""
    cfg = {"threshold": _DEFAULT_HAMMING_THRESHOLD, "l2": True, "l3": True, "ts": True}
    try:
        config_path = Path(__file__).resolve().parent.parent / "data" / "users"
        if config_path.exists():
            for user_dir in config_path.iterdir():
                eye_path = user_dir / "eye_config.json"
                if eye_path.exists():
                    with open(eye_path, "r", encoding="utf-8") as f:
                        c = json.load(f)
                    v = c.get("dedupHammingThreshold")
                    if isinstance(v, (int, float)) and v >= 0:
                        cfg["threshold"] = int(max(0, min(20, v)))
                    if isinstance(c.get("l2RegionDiff"), bool):
                        cfg["l2"] = c["l2RegionDiff"]
                    if isinstance(c.get("l3Grading"), bool):
                        cfg["l3"] = c["l3Grading"]
                    if isinstance(c.get("metaTimestamp"), bool):
                        cfg["ts"] = c["metaTimestamp"]
                    return cfg
    except Exception as e:
        print(f"[desktop-eye] eye_config 读取失败(智能过滤配置未生效,用默认): {e}")
    return cfg


# ============================================================
# 截图相似度去重 + 自适应变化区域检测（纯 PIL，无 numpy/imagehash，守离线 + 最小依赖）
# ============================================================

# 去重网格 / 块级差分网格尺寸
_DHASH_W, _DHASH_H = 9, 8          # dHash: 缩 9x8 灰度，比相邻像素得 8x8=64 位
_BLOCK_GRID = 8                    # 自适应变化区域：8x8 网格分块
_DEFAULT_HAMMING_THRESHOLD = 5    # 汉明距离 < 阈值 = 相似 → 跳过不发
_BLOCK_DIFF_THRESHOLD = 12        # 块平均灰度差 > 此值 = 该块"在变"（0~255）

# 上次"已发送"图的指纹（模块级，单会话记忆）
_last_sent_dhash = None           # int，64 位 dHash
_last_sent_blocks = None          # list[int]，每块平均灰度（块级差分基准）
_capture_sequence = 0             # 本会话已发送的第几张
_last_sent_at = None              # 上次发送时刻（time.time()），算 elapsed_since_last


def _compute_dhash(image):
    """纯 PIL 差异哈希(dHash)：缩 9x8 灰度 → 比每行相邻像素 → 64 位整数。"""
    small = image.convert("L").resize((_DHASH_W, _DHASH_H), Image.LANCZOS)
    px = small.load()
    bits = 0
    idx = 0
    for y in range(_DHASH_H):
        for x in range(_DHASH_W - 1):
            bit = 1 if px[x, y] > px[x + 1, y] else 0
            bits |= (bit << idx)
            idx += 1
    return bits


def _hamming_distance(a, b):
    """两个 dHash 整数的汉明距离（不同位个数）。"""
    if a is None or b is None:
        return 64  # 无基准 → 视为最大差异（必发）
    x = a ^ b
    # bin().count 在 py3.10+ 也可用 int.bit_count，但 bin 更稳兼容
    return bin(x).count("1")


def _compute_block_means(image):
    """把灰度图分成 _BLOCK_GRID×_BLOCK_GRID 网格，返回每块平均灰度（list[int]）。
    用于自适应变化区域检测——不预设任何固定坐标（血条/对话框/任务栏），
    逐块与上一帧比，自动找出"哪些块在变"。"""
    gray = image.convert("L").resize((_BLOCK_GRID * 8, _BLOCK_GRID * 8), Image.LANCZOS)
    px = gray.load()
    cell = 8  # 每块 8x8 像素
    means = []
    for by in range(_BLOCK_GRID):
        for bx in range(_BLOCK_GRID):
            total = 0
            for yy in range(cell):
                for xx in range(cell):
                    total += px[bx * cell + xx, by * cell + yy]
            means.append(total // (cell * cell))
    return means


def _changed_blocks(prev_blocks, cur_blocks):
    """逐块差分，返回 (变化块索引列表, 变化块占比 0~1)。
    自适应定位变化区：哪些块均灰度差 > 阈值就算在变，不依赖固定位置。"""
    if not prev_blocks:
        # 无基准 → 全部视为变化
        idxs = list(range(len(cur_blocks)))
        return idxs, 1.0
    changed = [
        i for i in range(len(cur_blocks))
        if abs(cur_blocks[i] - prev_blocks[i]) > _BLOCK_DIFF_THRESHOLD
    ]
    ratio = len(changed) / len(cur_blocks) if cur_blocks else 0.0
    return changed, ratio


def reset_capture_session():
    """重置去重/时序会话状态（新一轮陪伴会话开始时可调用）。"""
    global _last_sent_dhash, _last_sent_blocks, _capture_sequence, _last_sent_at
    _last_sent_dhash = None
    _last_sent_blocks = None
    _capture_sequence = 0
    _last_sent_at = None


# ============================================================
# 截图 + 框选
# ============================================================

def take_full_screenshot():
    """全屏截图，返回 PIL Image（支持多显示器合并）"""
    with mss.mss() as sct:
        # monitors[0] 是所有显示器合并的虚拟屏幕
        # monitors[1] 是主显示器
        monitor = sct.monitors[0]  # 所有屏幕合并
        raw = sct.grab(monitor)
        img = Image.frombytes("RGB", raw.size, raw.rgb)
    return img


def take_window_screenshot(window_title):
    """W61/F2: 只截取指定窗口（通过标题匹配）"""
    if not window_title:
        return take_full_screenshot()
    try:
        if sys.platform == "win32":
            import ctypes
            user32 = ctypes.windll.user32
            # 枚举窗口找匹配的
            import ctypes.wintypes as wt
            EnumWindows = user32.EnumWindows
            WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
            found_hwnd = [None]
            def callback(hwnd, lParam):
                length = user32.GetWindowTextLengthW(hwnd)
                if length > 0:
                    buf = ctypes.create_unicode_buffer(length + 1)
                    user32.GetWindowTextW(hwnd, buf, length + 1)
                    title = buf.value
                    if window_title.lower() in title.lower() and user32.IsWindowVisible(hwnd):
                        found_hwnd[0] = hwnd
                        return False  # 停止枚举
                return True
            EnumWindows(WNDENUMPROC(callback), 0)
            if found_hwnd[0]:
                # 获取窗口位置
                rect = wt.RECT()
                user32.GetWindowRect(found_hwnd[0], ctypes.byref(rect))
                bbox = (rect.left, rect.top, rect.right, rect.bottom)
                with mss.mss() as sct:
                    monitor = {"left": bbox[0], "top": bbox[1], "width": bbox[2] - bbox[0], "height": bbox[3] - bbox[1]}
                    raw = sct.grab(monitor)
                    return Image.frombytes("RGB", raw.size, raw.rgb)
        # 找不到或非Windows，回退全屏
        print(f"[eye] 窗口 '{window_title}' 未找到，回退全屏截图")
        return take_full_screenshot()
    except Exception as e:
        print(f"[eye] 窗口截图失败: {e}，回退全屏截图")
        return take_full_screenshot()


def start_crop_capture():
    """启动框选截图流程（线程安全：通过主线程调度）"""
    global _capture_active
    if _capture_active:
        return

    # 如果有悬浮球主窗口，通过 after() 调度到主线程执行
    if _orb_root:
        _orb_root.after(0, _do_crop_capture)
    else:
        # 无悬浮球时直接在新线程执行
        t = threading.Thread(target=_do_crop_capture, daemon=True)
        t.start()


def _do_crop_capture():
    """实际执行截图（必须在主线程或独立 tkinter 线程中）"""
    global _capture_active
    if _capture_active:
        return
    _capture_active = True

    try:
        screenshot = take_full_screenshot()
    except Exception as e:
        print(f"[desktop-eye] 截图失败: {e}")
        _capture_active = False
        return

    # 隐藏悬浮球（避免截到自己）
    if _orb_root:
        _orb_root.withdraw()

    _run_crop_window(screenshot)


def _run_crop_window(screenshot: Image.Image):
    """运行框选窗口（使用 Toplevel 如果有主窗口，否则独立 Tk）"""
    global _capture_active
    import tkinter as tk

    # 如果有主悬浮球窗口，用 Toplevel；否则新建 Tk
    if _orb_root:
        root = tk.Toplevel(_orb_root)
    else:
        root = tk.Tk()

    root.title("桌面截图 — 框选")
    root.attributes("-topmost", True)
    root.configure(cursor="crosshair")

    # 获取截图的实际尺寸（DPI 感知后的像素尺寸）
    sw, sh = screenshot.size

    # 设置窗口大小为截图尺寸，覆盖整个屏幕
    root.geometry(f"{sw}x{sh}+0+0")
    root.overrideredirect(True)  # 无边框

    # 显示截图作为背景
    tk_img = ImageTk.PhotoImage(screenshot)
    canvas = tk.Canvas(root, width=sw, height=sh, highlightthickness=0)
    canvas.pack(fill=tk.BOTH, expand=True)
    canvas.create_image(0, 0, anchor=tk.NW, image=tk_img)
    # 防止 PhotoImage 被 GC 回收（Toplevel 模式下函数会立即返回）
    canvas._bg_ref = tk_img

    # 半透明遮罩
    overlay = Image.new("RGBA", screenshot.size, (0, 0, 0, 100))
    overlay_tk = ImageTk.PhotoImage(overlay)
    overlay_id = canvas.create_image(0, 0, anchor=tk.NW, image=overlay_tk)
    canvas._overlay_ref = overlay_tk

    # 提示文字
    hint_id = canvas.create_text(
        sw // 2, 30,
        text="拖拽框选区域 · ESC 取消 · 松开鼠标完成",
        fill="#d4a017",
        font=("Microsoft YaHei", 14, "bold"),
    )

    # 框选状态
    state = {"sx": 0, "sy": 0, "rect_id": None, "clear_ids": []}

    def on_press(event):
        state["sx"] = event.x
        state["sy"] = event.y
        if state["rect_id"]:
            canvas.delete(state["rect_id"])
        for cid in state["clear_ids"]:
            canvas.delete(cid)
        state["clear_ids"] = []

    def on_drag(event):
        if state["rect_id"]:
            canvas.delete(state["rect_id"])
        for cid in state["clear_ids"]:
            canvas.delete(cid)
        state["clear_ids"] = []

        x1, y1 = state["sx"], state["sy"]
        x2, y2 = event.x, event.y

        # 重绘遮罩：在选区外显示暗色，选区内显示原图
        canvas.delete(overlay_id)
        new_overlay = Image.new("RGBA", screenshot.size, (0, 0, 0, 100))
        draw = ImageDraw.Draw(new_overlay)
        # 清除选区部分的遮罩
        left, top = min(x1, x2), min(y1, y2)
        right, bottom = max(x1, x2), max(y1, y2)
        draw.rectangle([left, top, right, bottom], fill=(0, 0, 0, 0))
        new_overlay_tk = ImageTk.PhotoImage(new_overlay)
        cid = canvas.create_image(0, 0, anchor=tk.NW, image=new_overlay_tk)
        state["clear_ids"].append(cid)
        # 保持引用防止 GC
        canvas._overlay_ref = new_overlay_tk

        # 选区边框
        state["rect_id"] = canvas.create_rectangle(
            x1, y1, x2, y2,
            outline="#d4a017", width=2, dash=(5, 3),
        )

        # 尺寸标签
        w_sel = abs(x2 - x1)
        h_sel = abs(y2 - y1)
        size_id = canvas.create_text(
            (x1 + x2) / 2, max(y1, y2) + 20,
            text=f"{w_sel} × {h_sel}",
            fill="#d4a017",
            font=("Microsoft YaHei", 10),
        )
        state["clear_ids"].append(size_id)

    def on_release(event):
        global _capture_active
        x1, y1 = state["sx"], state["sy"]
        x2, y2 = event.x, event.y
        left, top = min(x1, x2), min(y1, y2)
        right, bottom = max(x1, x2), max(y1, y2)

        if right - left < 10 or bottom - top < 10:
            # 太小，忽略
            root.destroy()
            _capture_active = False
            if _orb_root:
                _orb_root.deiconify()
            return

        # 裁剪
        cropped = screenshot.crop((left, top, right, bottom))
        root.destroy()
        _capture_active = False

        # 恢复悬浮球
        if _orb_root:
            _orb_root.deiconify()

        # 打开发送对话框
        if _orb_root:
            _orb_root.after(0, lambda: _run_send_dialog(cropped))
        else:
            t = threading.Thread(target=_run_send_dialog, args=(cropped,), daemon=True)
            t.start()

    def on_escape(event):
        global _capture_active
        root.destroy()
        _capture_active = False
        # 恢复悬浮球
        if _orb_root:
            _orb_root.deiconify()

    canvas.bind("<ButtonPress-1>", on_press)
    canvas.bind("<B1-Motion>", on_drag)
    canvas.bind("<ButtonRelease-1>", on_release)
    root.bind("<Escape>", on_escape)

    # 确保窗口获得焦点并显示在最前
    root.update_idletasks()
    root.focus_force()
    root.lift()

    # 如果有主窗口，不需要独立 mainloop
    if not _orb_root:
        root.mainloop()
        _capture_active = False


def _run_send_dialog(cropped_img: Image.Image):
    """发送对话框"""
    import tkinter as tk
    from tkinter import scrolledtext

    if _orb_root:
        root = tk.Toplevel(_orb_root)
    else:
        root = tk.Tk()
    root.title("桌面截图 — 发送截图")
    root.geometry("480x620")
    root.attributes("-topmost", True)
    root.configure(bg="#1a1a2e")
    root.resizable(False, False)

    # 标题
    tk.Label(
        root, text="✦ 发送给 AI",
        fg="#d4a017", bg="#1a1a2e",
        font=("Microsoft YaHei", 14, "bold"),
    ).pack(pady=(15, 5))

    # 预览图片
    preview = cropped_img.copy()
    max_w, max_h = 440, 200
    preview.thumbnail((max_w, max_h), Image.LANCZOS)
    preview_tk = ImageTk.PhotoImage(preview)
    img_label = tk.Label(root, image=preview_tk, bg="#16213e", bd=1, relief="solid")
    img_label.image = preview_tk  # 防 GC
    img_label.pack(pady=10)

    # 消息输入
    tk.Label(
        root, text="附加消息（可选）：",
        fg="#a0a0b0", bg="#1a1a2e",
        font=("Microsoft YaHei", 10),
    ).pack(anchor="w", padx=20)

    msg_text = scrolledtext.ScrolledText(
        root, height=3, wrap=tk.WORD,
        bg="#16213e", fg="#e0e0e0",
        insertbackground="#d4a017",
        font=("Microsoft YaHei", 10),
        bd=1, relief="solid",
    )
    msg_text.pack(fill=tk.X, padx=20, pady=5)

    # 发送模式
    mode_var = tk.StringVar(value="active")
    mode_frame = tk.Frame(root, bg="#1a1a2e")
    mode_frame.pack(fill=tk.X, padx=20, pady=5)
    tk.Radiobutton(
        mode_frame, text="主动发送（AI 会回复）",
        variable=mode_var, value="active",
        fg="#a0a0b0", bg="#1a1a2e", selectcolor="#16213e",
        activebackground="#1a1a2e", activeforeground="#d4a017",
        font=("Microsoft YaHei", 9),
    ).pack(side=tk.LEFT)
    tk.Radiobutton(
        mode_frame, text="静默分享（仅提供上下文）",
        variable=mode_var, value="passive",
        fg="#a0a0b0", bg="#1a1a2e", selectcolor="#16213e",
        activebackground="#1a1a2e", activeforeground="#d4a017",
        font=("Microsoft YaHei", 9),
    ).pack(side=tk.LEFT, padx=10)

    # 状态标签
    status_var = tk.StringVar(value="")
    status_label = tk.Label(
        root, textvariable=status_var,
        fg="#888", bg="#1a1a2e",
        font=("Microsoft YaHei", 9),
    )
    status_label.pack(pady=2)

    # 按钮
    btn_frame = tk.Frame(root, bg="#1a1a2e")
    btn_frame.pack(fill=tk.X, padx=20, pady=10)

    def do_send():
        status_var.set("正在发送...")
        send_btn.config(state=tk.DISABLED)
        message = msg_text.get("1.0", tk.END).strip()
        mode = mode_var.get()

        def _send():
            try:
                send_to_beilu(cropped_img, message, mode)
                root.after(0, lambda: status_var.set("✦ 已发送！"))
                root.after(1500, root.destroy)
            except Exception as e:
                root.after(0, lambda: status_var.set(f"发送失败: {e}"))
                root.after(0, lambda: send_btn.config(state=tk.NORMAL))

        threading.Thread(target=_send, daemon=True).start()

    send_btn = tk.Button(
        btn_frame, text="发送 ✦",
        bg="#d4a017", fg="#1a1a2e",
        font=("Microsoft YaHei", 11, "bold"),
        bd=0, padx=20, pady=5,
        cursor="hand2",
        command=do_send,
    )
    send_btn.pack(side=tk.RIGHT)

    cancel_btn = tk.Button(
        btn_frame, text="取消",
        bg="#333", fg="#a0a0b0",
        font=("Microsoft YaHei", 10),
        bd=0, padx=15, pady=5,
        cursor="hand2",
        command=root.destroy,
    )
    cancel_btn.pack(side=tk.RIGHT, padx=10)

    root.bind("<Escape>", lambda e: root.destroy())
    if not _orb_root:
        root.mainloop()


# ============================================================
# HTTP 发送到 beilu 后端
# ============================================================

def send_to_beilu(image: Image.Image, message: str = "", mode: str = "active"):
    """将截图发送到 beilu 后端 后端"""
    # 转换为 base64（超过 5MB 时自动压缩）
    MAX_SIZE = 5 * 1024 * 1024  # 5MB（base64 编码前的字节数）

    buf = io.BytesIO()
    image.save(buf, format="PNG")
    raw_size = buf.tell()

    if raw_size > MAX_SIZE:
        # 第一次压缩：转 JPEG quality=75
        print(f"[desktop-eye] 截图过大 ({raw_size // 1024}KB)，压缩为 JPEG...")
        buf = io.BytesIO()
        # 转换为 RGB（JPEG 不支持 RGBA）
        rgb_img = image.convert("RGB") if image.mode != "RGB" else image
        rgb_img.save(buf, format="JPEG", quality=75, optimize=True)

        if buf.tell() > MAX_SIZE:
            # 第二次压缩：缩小分辨率到一半
            print(f"[desktop-eye] 仍然过大 ({buf.tell() // 1024}KB)，缩小分辨率...")
            w, h = rgb_img.size
            rgb_img = rgb_img.resize((w // 2, h // 2), Image.LANCZOS)
            buf = io.BytesIO()
            rgb_img.save(buf, format="JPEG", quality=65, optimize=True)

            if buf.tell() > MAX_SIZE:
                print(f"[desktop-eye] 压缩后仍超过 5MB ({buf.tell() // 1024}KB)，退回")
                raise Exception("截图过大，压缩后仍超过 5MB，请缩小截图区域")

        print(f"[desktop-eye] 压缩完成: {buf.tell() // 1024}KB")

    b64 = base64.b64encode(buf.getvalue()).decode("utf-8")

    body = json.dumps({
        "image": b64,
        "message": message,
        "mode": mode,
        "window_title": get_active_window_title(),
    }).encode("utf-8")

    url = f"http://{BEILU_HOST}:{BEILU_PORT}{INJECT_ENDPOINT}"
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "x-pet-token": PET_TOKEN,  # A4: inject per-user 鉴权令牌(缺失→端点 403)
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status == 200:
                print(f"[desktop-eye] 截图已发送到 beilu 后端，模式: {mode}")
            else:
                raise Exception(f"HTTP {resp.status}")
    except urllib.error.URLError as e:
        print(f"[desktop-eye] 连接 beilu 后端 失败: {e}")
        raise


# ============================================================
# 系统托盘
# ============================================================

def create_tray_icon():
    """创建系统托盘图标"""
    # 创建一个金色圆形图标
    size = 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    # 金色圆形
    draw.ellipse([4, 4, size - 4, size - 4], fill=(212, 160, 23, 255))
    # 中心 ✦ 符号用白色十字近似
    cx, cy = size // 2, size // 2
    draw.line([(cx - 8, cy), (cx + 8, cy)], fill=(255, 255, 255, 255), width=2)
    draw.line([(cx, cy - 8), (cx, cy + 8)], fill=(255, 255, 255, 255), width=2)
    # 对角线
    draw.line([(cx - 5, cy - 5), (cx + 5, cy + 5)], fill=(255, 255, 255, 200), width=1)
    draw.line([(cx - 5, cy + 5), (cx + 5, cy - 5)], fill=(255, 255, 255, 200), width=1)

    menu = pystray.Menu(
        pystray.MenuItem("框选截图  (Alt+Shift+S)", lambda: start_crop_capture()),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("关于", _show_about),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("退出", _quit_app),
    )

    icon = pystray.Icon(
        "beilu-eye",
        img,
        "桌面截图 ✦",
        menu,
    )

    return icon


def _show_about():
    """显示关于对话框"""
    import tkinter as tk
    from tkinter import messagebox
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    messagebox.showinfo(
        "桌面截图",
        "桌面截图 v0.2.0 (Python)\n"
        "桌面截图 → 临时注入 AI 上下文\n\n"
        "快捷键: Alt+Shift+S\n"
        "托盘左键点击: 框选截图",
    )
    root.destroy()


def _quit_app(icon=None):
    """退出应用"""
    print("[desktop-eye] 桌面截图退出")
    keyboard.unhook_all()
    if icon:
        icon.stop()
    elif _tray_icon:
        _tray_icon.stop()
    sys.exit(0)


# ============================================================
# 全局快捷键
# ============================================================

def register_hotkey():
    """注册全局快捷键。
    0715 收口(近期diff审计插件域#1): 原写死 alt+shift+s——captureHotkey 已配置化(B1,权威=
    data/pet_settings.json,Electron 侧同源消费),Python 侧未跟进=用户改了热键此处仍注册旧值。
    读法仿本文件 _get_filter_config 的盘读范式;Electron accelerator 格式(Alt+Shift+S)→keyboard
    库格式(alt+shift+s)=小写化;读失败/注册失败回退默认并打印(与 Electron 侧"注册失败回退默认并通知"同约定)。"""
    default_hotkey = "alt+shift+s"
    hotkey = default_hotkey
    try:
        p = Path(__file__).resolve().parent.parent / "data" / "pet_settings.json"
        if p.exists():
            with open(p, "r", encoding="utf-8") as f:
                v = json.load(f).get("captureHotkey")
            if isinstance(v, str) and v.strip():
                hotkey = v.strip().lower()
    except Exception as e:
        print(f"[desktop-eye] pet_settings 读取失败(快捷键用默认 {default_hotkey}): {e}")
    try:
        keyboard.add_hotkey(hotkey, start_crop_capture, suppress=True)
        print(f"[desktop-eye] 快捷键已注册: {hotkey}")
    except Exception as e:
        print(f"[desktop-eye] 快捷键 {hotkey} 注册失败,回退默认 {default_hotkey}: {e}")
        keyboard.add_hotkey(default_hotkey, start_crop_capture, suppress=True)


# ============================================================
# 桌面悬浮球（tkinter 置顶小窗口）
# ============================================================

_orb_root = None

def get_active_window_title():
    """获取当前活跃窗口标题（Windows）"""
    if sys.platform != 'win32':
        return ""
    try:
        hwnd = ctypes.windll.user32.GetForegroundWindow()
        length = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
        if length > 0:
            buf = ctypes.create_unicode_buffer(length + 1)
            ctypes.windll.user32.GetWindowTextW(hwnd, buf, length + 1)
            return buf.value
    except Exception:
        pass
    return ""


def create_desktop_orb():
    """创建隐藏的 tkinter 根窗口（凛倾 2026-07-09：金球永久删除，任何模式都不画悬浮球）。
    root 必须存活：mainloop + 框选截图 _orb_root.after/deiconify + Alt+Shift+S 全局快捷键 + 陪伴弹窗 Toplevel 父窗。
    窗口移屏外 + alpha=0 全透明，即使 crop 流程 withdraw/deiconify 也始终不可见。
    截图入口：Alt+Shift+S / pystray 托盘菜单 / web 面板 / Electron 桌宠。"""
    global _orb_root
    import tkinter as tk

    root = tk.Tk()
    _orb_root = root
    root.title("beilu-eye-orb")
    root.overrideredirect(True)
    root.attributes("-topmost", True)
    root.geometry("1x1+-100+-100")
    try:
        root.attributes("-alpha", 0.0)
    except Exception:
        pass
    print("[desktop-eye] 隐藏根窗口已创建(悬浮球已删除),截图入口:Alt+Shift+S/托盘/面板/桌宠")
    return root


# ============================================================
# 游戏陪伴弹窗（W15）— 半透明非侵入式
# ============================================================

def show_game_companion_popup(message, char_name="AI"):
    """显示游戏陪伴弹窗（不打断游戏，3秒后自动消失）"""
    import tkinter as tk

    if not _orb_root:
        return

    popup = tk.Toplevel(_orb_root)
    popup.overrideredirect(True)
    popup.attributes("-topmost", True)
    popup.attributes("-alpha", 0.92)

    # 位置：屏幕右下角，悬浮球上方
    screen_w = popup.winfo_screenwidth()
    screen_h = popup.winfo_screenheight()
    popup_w, popup_h = 320, 90
    x = screen_w - popup_w - 20
    y = screen_h - popup_h - 160
    popup.geometry(f"{popup_w}x{popup_h}+{x}+{y}")
    popup.configure(bg="#1a1a2e")

    # 圆角效果（用边框模拟）
    frame = tk.Frame(popup, bg="#1a1a2e", bd=0, highlightthickness=1,
                     highlightbackground="#d4a017")
    frame.pack(fill=tk.BOTH, expand=True, padx=1, pady=1)

    # 头部
    header = tk.Frame(frame, bg="#1a1a2e")
    header.pack(fill=tk.X, padx=10, pady=(8, 2))
    tk.Label(header, text=f"🎮 {char_name}", fg="#d4a017", bg="#1a1a2e",
             font=("Microsoft YaHei", 10, "bold")).pack(side=tk.LEFT)
    close_btn = tk.Label(header, text="✕", fg="#666", bg="#1a1a2e",
                         font=("Microsoft YaHei", 9), cursor="hand2")
    close_btn.pack(side=tk.RIGHT)
    close_btn.bind("<Button-1>", lambda e: _dismiss_popup(popup))

    # 消息
    msg_text = message[:120] + ("..." if len(message) > 120 else "")
    tk.Label(frame, text=msg_text, fg="#e0e0e0", bg="#1a1a2e",
             font=("Microsoft YaHei", 9), wraplength=290,
             justify=tk.LEFT, anchor="w").pack(fill=tk.X, padx=10, pady=(0, 8))

    # 点击弹窗任意位置也可以关闭
    popup.bind("<Button-1>", lambda e: _dismiss_popup(popup))

    # 3秒后自动淡出
    _auto_dismiss(popup, 3000)


def _auto_dismiss(popup, delay_ms):
    """自动淡出关闭弹窗"""
    def fade():
        try:
            alpha = popup.attributes("-alpha")
            if alpha > 0.1:
                popup.attributes("-alpha", alpha - 0.05)
                popup.after(30, fade)
            else:
                popup.destroy()
        except Exception:
            pass  # 窗口已关闭

    popup.after(delay_ms, fade)


def _dismiss_popup(popup):
    """立即关闭弹窗"""
    try:
        popup.destroy()
    except Exception:
        pass


# ============================================================
# 自动截图（游戏陪伴定时器请求时使用）
# ============================================================

def auto_capture_and_send(hamming_threshold=_DEFAULT_HAMMING_THRESHOLD):
    """自动截图并发送（W61: 支持指定窗口截图，用于游戏陪伴/AI 自主定时截图）。

    截图优化（凛倾"人眼5%频率"设计，省 token 是核心）：
      ① dHash 粗过滤：与上次"已发送"图汉明距离 < 阈值 = 静止帧 → 跳过不发。
      ② 自适应变化区域块级差分：8x8 网格逐块比上一帧，自动定位"哪些块在变"
         （不预设血条/对话框/任务栏等固定坐标——游戏各异）。change_score = 变化块占比。
      ③ 配置化分辨率：读 captureResolution（默认 1080, clamp 480~2160）降采样。
      ④ 时序元数据：payload 带 {timestamp, elapsed_since_last, sequence, change_score}，
         让 AI 有时序感（"8秒前→现在变化X%"）。

    返回 dict 便于单测/调用方判断：
      {"sent": bool, "skipped": bool, "blocked": bool, "change_score": float, "reason": str}
    """
    global _last_sent_dhash, _last_sent_blocks, _capture_sequence, _last_sent_at
    try:
        # W61/F2: 检查是否有指定窗口
        target_window = _get_target_window()
        screenshot = take_window_screenshot(target_window) if target_window else take_full_screenshot()
        # 获取当前窗口标题（用于黑名单检查）
        window_title = get_active_window_title()

        # ③ 配置化降采样宽度（默认 1080，clamp 480~2160）
        target_w = _get_capture_resolution()
        w, h = screenshot.size
        if w > target_w:
            ratio = target_w / w
            screenshot = screenshot.resize((target_w, max(1, int(h * ratio))), Image.LANCZOS)

        # 读【智能过滤】配置(设计稿"智能过滤"段4控件,前端 /api/eye/config 写;默认阈值5+三项全开=旧行为)
        fcfg = _get_filter_config()
        _ht = fcfg["threshold"]  # L1 去重阈值(覆盖入参默认)

        # ① dHash 去重：与上次已发送图比，相似则跳过（静止帧不发 = 省 token 关键），阈值由 L1 配置
        cur_dhash = _compute_dhash(screenshot)
        dist = _hamming_distance(_last_sent_dhash, cur_dhash)
        # ② L2 自适应变化区域：开=块级差分定位变化块+占比;关=用 dHash 距离归一估变化度(不做块级,更省)
        if fcfg["l2"]:
            cur_blocks = _compute_block_means(screenshot)
            changed_idxs, change_ratio = _changed_blocks(_last_sent_blocks, cur_blocks)
        else:
            cur_blocks = None
            changed_idxs, change_ratio = [], (dist / 64.0)
        change_score = round(change_ratio, 4)

        if _last_sent_dhash is not None and dist < _ht:
            # 相似 → 跳过（不更新基准：保持与最后真正发出的帧比，避免缓慢漂移逃过过滤）
            print(f"[desktop-eye] 自动截图相似(汉明距离={dist}<{_ht})，跳过不发")
            return {"sent": False, "skipped": True, "blocked": False,
                    "change_score": change_score, "hamming": dist, "reason": "similar"}

        # ④ 元数据：汉明距离恒带；L3 变化分级 / 时间戳 按开关入 meta + message
        now = time.time()
        elapsed = round(now - _last_sent_at, 2) if _last_sent_at is not None else None
        seq = _capture_sequence + 1
        ts_str = datetime.now().strftime("%H:%M:%S")
        meta = {"hamming_distance": dist}
        if fcfg["ts"]:
            meta["timestamp"] = ts_str
            meta["elapsed_since_last"] = elapsed   # 秒；None=本会话首张
            meta["sequence"] = seq
        if fcfg["l3"]:
            meta["change_score"] = change_score    # 变化块占比 0~1
            meta["changed_blocks"] = len(changed_idxs)

        # 发送时附带窗口标题 + 元数据（JPEG quality 退 60）
        buf = io.BytesIO()
        screenshot.convert("RGB").save(buf, format="JPEG", quality=60, optimize=True)
        b64 = base64.b64encode(buf.getvalue()).decode("utf-8")

        _msg_parts = [f"[自动截图] 用户正在: {window_title}"]
        if fcfg["ts"]:
            _msg_parts.append(f"{ts_str} 第{seq}张" + (f"(距上张{elapsed}秒)" if elapsed is not None else "(首张)"))
        if fcfg["l3"]:
            _msg_parts.append(f"变化{int(change_score*100)}%")
        msg = " | ".join(_msg_parts)
        body = json.dumps({
            "image": b64,
            "message": msg,
            "mode": "passive",
            "window_title": window_title,
            "capture_meta": meta,   # 结构化元数据，供后端/AI 取用
        }).encode("utf-8")

        url = f"http://{BEILU_HOST}:{BEILU_PORT}{INJECT_ENDPOINT}"
        req = urllib.request.Request(url, data=body,
                                     headers={"Content-Type": "application/json",
                                              "x-pet-token": PET_TOKEN},  # A4: inject 鉴权令牌
                                     method="POST")
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            if result.get("blocked"):
                print(f"[desktop-eye] 自动截图被黑名单阻止: {result.get('reason', '')}")
                # 被安全门拦截：不更新基准/序号（这张没真正"已发送"给 AI）
                return {"sent": False, "skipped": False, "blocked": True,
                        "change_score": change_score, "reason": "blocked"}
            else:
                # 真正发出 → 更新去重基准 + 时序状态
                _last_sent_dhash = cur_dhash
                _last_sent_blocks = cur_blocks
                _capture_sequence = seq
                _last_sent_at = now
                print(f"[desktop-eye] 自动截图已发送 (窗口: {window_title[:50]}, "
                      f"第{seq}张, 变化{int(change_score*100)}%)")
                return {"sent": True, "skipped": False, "blocked": False,
                        "change_score": change_score, "reason": "sent"}
    except Exception as e:
        print(f"[desktop-eye] 自动截图失败: {e}")
        return {"sent": False, "skipped": False, "blocked": False,
                "change_score": 0.0, "reason": f"error: {e}"}


# ============================================================
# 轮询游戏陪伴截图请求
# ============================================================

_gc_poll_active = False

def start_gc_poll():
    """轮询后端的游戏陪伴截图请求"""
    global _gc_poll_active
    if _gc_poll_active:
        return
    _gc_poll_active = True

    def poll():
        if not _gc_poll_active or not _orb_root:
            return
        try:
            url = f"http://{BEILU_HOST}:{BEILU_PORT}/api/eye/getdata"
            # S9-X7: 带 pet-token 鉴权（端点改双鉴权；缺则桌宠 poll 恒 401 被静默吞→截图请求链断）
            req = urllib.request.Request(url, headers={"x-pet-token": PET_TOKEN}, method="GET")
            with urllib.request.urlopen(req, timeout=3) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                # 接断点③: 后端 /api/eye/getdata 返回 captureRequested
                #   (= 该用户 _gc_capture_request.json 是否存在, gameCompanion/AI 自主触发写入)。
                #   见真 → 截图并发送 (走 auto_capture_and_send → /api/eye/inject 安全门黑名单 fail-closed 照旧)。
                #   gameCompanion 写请求后自己 unlink + 等 hasPendingInjection, 故此处只管"见请求→截图→inject"。
                if data.get("captureRequested"):
                    print("[desktop-eye] 收到截图请求(captureRequested)，自动截图...")
                    # 在后台线程截图发送，避免阻塞 tk after() 轮询循环
                    threading.Thread(target=auto_capture_and_send, daemon=True).start()
        except Exception:
            pass  # 静默
        if _orb_root:
            _orb_root.after(5000, poll)

    if _orb_root:
        _orb_root.after(5000, poll)


# ============================================================
# 入口
# ============================================================

def main():
    global _tray_icon

    print("[desktop-eye] 桌面截图已启动 (Python)")
    print(f"[desktop-eye] beilu 后端 端点: http://{BEILU_HOST}:{BEILU_PORT}{INJECT_ENDPOINT}")

    # 注册全局快捷键
    register_hotkey()

    # 创建系统托盘（在后台线程中运行）
    _tray_icon = create_tray_icon()
    print("[desktop-eye] 系统托盘已创建，快捷键: Alt+Shift+S")

    # 启动托盘在后台线程
    tray_thread = threading.Thread(target=_tray_icon.run, daemon=True)
    tray_thread.start()

    # 创建隐藏根窗口（在主线程运行 tkinter mainloop；悬浮球已删除）
    orb = create_desktop_orb()

    # 启动游戏陪伴截图请求轮询（tkinter .after() 定时器，非阻塞）
    start_gc_poll()

    orb.mainloop()


if __name__ == "__main__":
    main()