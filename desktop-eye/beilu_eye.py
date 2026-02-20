#!/usr/bin/env python3
"""
贝露的眼睛 — 桌面截图工具 (Python 版)

功能：
1. 系统托盘 ✦ 图标
2. 全局快捷键 Alt+Shift+S 触发框选截图
3. 桌面全屏截图 → 透明窗口框选 → 裁剪 → 发送对话框
4. HTTP POST 发送到 Fount 后端 (localhost:1314)

依赖：pip install mss Pillow pystray keyboard
"""

import sys
import os
import io
import json
import base64
import threading
import urllib.request
import urllib.error
import ctypes
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

FOUNT_PORT = 1314
FOUNT_HOST = "localhost"
INJECT_ENDPOINT = "/api/eye/inject"

# ============================================================
# 全局状态
# ============================================================

_tray_icon = None
_capture_active = False
_orb_root = None  # 悬浮球 tkinter 根窗口（主线程）

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

    root.title("贝露的眼睛 — 框选")
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
    root.title("贝露的眼睛 — 发送截图")
    root.geometry("480x620")
    root.attributes("-topmost", True)
    root.configure(bg="#1a1a2e")
    root.resizable(False, False)

    # 标题
    tk.Label(
        root, text="✦ 发送给贝露",
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
        mode_frame, text="主动发送（贝露会回复）",
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
                send_to_fount(cropped_img, message, mode)
                root.after(0, lambda: status_var.set("✦ 已发送给贝露！"))
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
# HTTP 发送到 Fount
# ============================================================

def send_to_fount(image: Image.Image, message: str = "", mode: str = "active"):
    """将截图发送到 Fount 后端"""
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
    }).encode("utf-8")

    url = f"http://{FOUNT_HOST}:{FOUNT_PORT}{INJECT_ENDPOINT}"
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status == 200:
                print(f"[desktop-eye] 截图已发送到 Fount，模式: {mode}")
            else:
                raise Exception(f"HTTP {resp.status}")
    except urllib.error.URLError as e:
        print(f"[desktop-eye] 连接 Fount 失败: {e}")
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
        "贝露的眼睛 ✦",
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
        "贝露的眼睛",
        "贝露的眼睛 v0.2.0 (Python)\n"
        "桌面截图 → 临时注入 AI 上下文\n\n"
        "快捷键: Alt+Shift+S\n"
        "托盘左键点击: 框选截图",
    )
    root.destroy()


def _quit_app(icon=None):
    """退出应用"""
    print("[desktop-eye] 贝露的眼睛退出")
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
    """注册全局快捷键 Alt+Shift+S"""
    keyboard.add_hotkey("alt+shift+s", start_crop_capture, suppress=True)
    print("[desktop-eye] 快捷键已注册: Alt+Shift+S")


# ============================================================
# 桌面悬浮球（tkinter 置顶小窗口）
# ============================================================

_orb_root = None

def create_desktop_orb():
    """创建桌面悬浮球（金色 ✦ 小窗口，置顶可拖动）"""
    global _orb_root
    import tkinter as tk

    root = tk.Tk()
    _orb_root = root
    root.title("beilu-eye-orb")
    root.overrideredirect(True)  # 无边框
    root.attributes("-topmost", True)  # 置顶

    orb_size = 44
    # 初始位置：屏幕右下角
    screen_w = root.winfo_screenwidth()
    screen_h = root.winfo_screenheight()
    x = screen_w - orb_size - 20
    y = screen_h - orb_size - 100
    root.geometry(f"{orb_size}x{orb_size}+{x}+{y}")

    # 半透明
    root.attributes("-alpha", 0.85)

    # 透明背景色（Windows 用 -transparentcolor 实现真透明）
    transparent_color = "#f0f0f0"
    root.configure(bg=transparent_color)
    if sys.platform == 'win32':
        root.attributes("-transparentcolor", transparent_color)

    # 圆形画布
    canvas = tk.Canvas(root, width=orb_size, height=orb_size,
                       bg=transparent_color, highlightthickness=0, bd=0)
    canvas.pack()

    # 金色圆形背景（渐变效果：外圈深金，内圈浅金）
    pad = 1
    # 外圈（阴影）
    canvas.create_oval(pad + 1, pad + 1, orb_size - pad + 1, orb_size - pad + 1,
                       fill="#8B6914", outline="")
    # 主圆
    canvas.create_oval(pad, pad, orb_size - pad, orb_size - pad,
                       fill="#d4a017", outline="#c4960f", width=1)
    # 高光
    canvas.create_oval(pad + 6, pad + 4, orb_size - pad - 6, orb_size // 2,
                       fill="#e8c547", outline="")

    # ✦ 符号
    canvas.create_text(orb_size // 2, orb_size // 2 + 1,
                       text="✦", fill="#1a1a2e",
                       font=("Segoe UI Symbol", 16, "bold"))

    # 拖拽和点击区分
    drag_data = {"x": 0, "y": 0, "dragged": False}

    def on_press(event):
        drag_data["x"] = event.x
        drag_data["y"] = event.y
        drag_data["dragged"] = False

    def on_drag(event):
        drag_data["dragged"] = True
        dx = event.x - drag_data["x"]
        dy = event.y - drag_data["y"]
        new_x = root.winfo_x() + dx
        new_y = root.winfo_y() + dy
        root.geometry(f"+{new_x}+{new_y}")

    def on_release(event):
        if not drag_data["dragged"]:
            # 单击（非拖拽）→ 启动截图
            start_crop_capture()

    canvas.bind("<ButtonPress-1>", on_press)
    canvas.bind("<B1-Motion>", on_drag)
    canvas.bind("<ButtonRelease-1>", on_release)

    # 右键菜单
    def show_context_menu(event):
        menu = tk.Menu(root, tearoff=0)
        menu.add_command(label="✂ 框选截图  (Alt+Shift+S)", command=start_crop_capture)
        menu.add_separator()
        menu.add_command(label="ℹ 关于", command=_show_about)
        menu.add_separator()
        menu.add_command(label="✕ 退出", command=lambda: _quit_app())
        menu.post(event.x_root, event.y_root)

    canvas.bind("<Button-3>", show_context_menu)

    # 悬浮提示
    _create_tooltip(canvas, "✦ 贝露的眼睛\n点击：框选截图\n右键：更多选项")

    return root


def _create_tooltip(widget, text):
    """为 widget 创建悬浮提示"""
    import tkinter as tk
    tip = None

    def show_tip(event):
        nonlocal tip
        if tip:
            return
        tip = tk.Toplevel(widget)
        tip.overrideredirect(True)
        tip.attributes("-topmost", True)
        tip.geometry(f"+{event.x_root + 10}+{event.y_root - 60}")
        label = tk.Label(tip, text=text, bg="#1a1a2e", fg="#d4a017",
                         font=("Microsoft YaHei", 9), padx=8, pady=4,
                         bd=1, relief="solid")
        label.pack()

    def hide_tip(event):
        nonlocal tip
        if tip:
            tip.destroy()
            tip = None

    widget.bind("<Enter>", show_tip)
    widget.bind("<Leave>", hide_tip)


# ============================================================
# 入口
# ============================================================

def main():
    global _tray_icon

    print("[desktop-eye] 贝露的眼睛已启动 (Python)")
    print(f"[desktop-eye] Fount 端点: http://{FOUNT_HOST}:{FOUNT_PORT}{INJECT_ENDPOINT}")

    # 注册全局快捷键
    register_hotkey()

    # 创建系统托盘（在后台线程中运行）
    _tray_icon = create_tray_icon()
    print("[desktop-eye] 系统托盘已创建，快捷键: Alt+Shift+S")

    # 启动托盘在后台线程
    tray_thread = threading.Thread(target=_tray_icon.run, daemon=True)
    tray_thread.start()

    # 创建桌面悬浮球（在主线程运行 tkinter mainloop）
    orb = create_desktop_orb()
    print("[desktop-eye] 桌面悬浮球已创建")
    orb.mainloop()


if __name__ == "__main__":
    main()