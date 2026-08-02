# -*- coding: utf-8 -*-
"""
era_pipeline.py — ERA 地图管线（Python 单源，凛倾 2026-07-31 拍板「改python,重写管线」）。

职责（管线全链，原 JS mapEngine/mapStore 写侧/摘要的唯一权威，JS 侧只留桥+读侧+前端渲染）：
  解析 <era-map>/<era-patch> → 确定性布局（拓扑→几何，零随机） → 原子落盘 → 提示词摘要重算

独立运行（凛倾「这个插件需要独立运行」）：
  python era_pipeline.py -            # stdin 读 JSON job → stdout 写 JSON result
  python era_pipeline.py --job x.json # 文件模式
  job 形状: {"action": "process"|"layout"|"regenerate",
             "content": "...含<era-map>/<era-patch>的文本(process用)",
             "topology": {...}(layout用),
             "eraDir": "地图数据目录(调用方给定;JS桥=ensureMemoryDir单源/测试台=任意测试目录)",
             "caps": {...era能力谱(grid/roomSizes/prompt模板等,来自capabilities.mjs三层merge)},
             "enabled": true}
  result: {"ok": bool, "touched": {"id","rev"}|null, "errors": [...], "layout": {...}(layout用)}

契约对齐（勿破坏，前端/JS 读侧按此消费）：
  - 地图文件: <eraDir>/maps/<encodeURIComponent(id)>.json（quote safe 集与 JS encodeURIComponent 逐字对齐）
  - 激活指针: <eraDir>/_active.json {"mapId": ...}
  - 摘要文件: <eraDir>/_prompt_summary.txt（{{era_map}} 宏读点，getPromptHandler 透明透传）
  - 布局 JSON: {w,h,floors:{"0":{rooms,corridors,doors,stairs}},entities,errors}（floors 键为字符串）

确定性：无随机数。放置顺序=rooms 数组序；候选位扫描序固定。同输入恒同布局。
容错：未知 op/放不下/JSON 坏 → errors[] 记录跳过，不抛（错误随 result 返回给调用方落痕，不吞）。
路径安全：本脚本只在调用方传入的 eraDir 内读写，不自行推导任何项目路径。
"""
import io
import json
import os
import re
import sys
import unicodedata
import urllib.parse
from collections import deque
from datetime import datetime, timezone

# Windows 控制台 GBK 防线：stdout/stderr 强制 utf-8（本机 PowerShell 乱码经验）
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

# ============================================================
# 布局引擎（移植 JS mapEngine.mjs，算法逐步对齐：首次适配扫描/L走廊/跨层楼梯/实体房内落点）
# ============================================================


def _resolve_size(size, caps):
    """房型 → [w,h]。值域唯一来源=caps.roomSizes（禁代码第二份默认副本）；解析不了返回 None（调用方记错跳过）。"""
    sizes = (caps or {}).get("roomSizes") or {}
    if isinstance(size, list) and len(size) == 2:
        try:
            w = max(2, int(size[0]))
            h = max(2, int(size[1]))
            return [w, h]
        except (TypeError, ValueError):
            pass
    if isinstance(size, str) and size in sizes:
        return [sizes[size][0], sizes[size][1]]
    if "m" in sizes:
        return [sizes["m"][0], sizes["m"][1]]
    if sizes:
        first = sizes[sorted(sizes.keys())[0]]
        return [first[0], first[1]]
    return None


class _Grid:
    __slots__ = ("w", "h", "cells")

    def __init__(self, w, h):
        self.w = w
        self.h = h
        self.cells = bytearray(w * h)


def _rect_free(grid, x, y, w, h, margin):
    if x < 0 or y < 0 or x + w > grid.w or y + h > grid.h:
        return False
    x0 = max(0, x - margin)
    y0 = max(0, y - margin)
    x1 = min(grid.w - 1, x + w - 1 + margin)
    y1 = min(grid.h - 1, y + h - 1 + margin)
    for yy in range(y0, y1 + 1):
        base = yy * grid.w
        for xx in range(x0, x1 + 1):
            if grid.cells[base + xx]:
                return False
    return True


def _rect_mark(grid, x, y, w, h):
    for yy in range(y, y + h):
        base = yy * grid.w
        for xx in range(x, x + w):
            grid.cells[base + xx] = 1


def _find_spot_near(grid, anchor, w, h, margin, gap, dir_offset):
    """锚点周围首个可放位（确定性）。
    优化（凛倾 0731「为什么不去优化算法」）：
      - 方向序按 dir_offset（放置序号）轮转 右/下/左/上——布局向四周生长，不再永远 right-first 排成一条线
      - 起始距离 = gap（caps.grid.corridorGap）——房间拉开真走廊距，L 走廊成线而非退化成单门格
    """
    max_d = max(grid.w, grid.h)
    # 四方向槽生成器：给定距离 d 与滑移 s，产各方向候选位
    def slots_for(direction, d, s):
        ax, ay, aw, ah = anchor["x"], anchor["y"], anchor["w"], anchor["h"]
        if direction == 0:  # 右
            base = [(ax + aw + d - 1, ay + s)]
            if s > 0:
                base.append((ax + aw + d - 1, ay - s))
        elif direction == 1:  # 下
            base = [(ax + s, ay + ah + d - 1)]
            if s > 0:
                base.append((ax - s, ay + ah + d - 1))
        elif direction == 2:  # 左
            base = [(ax - w - d + 1, ay + s)]
            if s > 0:
                base.append((ax - w - d + 1, ay - s))
        else:  # 上
            base = [(ax + s, ay - h - d + 1)]
            if s > 0:
                base.append((ax - s, ay - h - d + 1))
        return base

    dirs = [(dir_offset + i) % 4 for i in range(4)]
    for d in range(max(gap, margin + 1), max_d + 1):
        for s in range(0, max_d + 1):
            for direction in dirs:
                for px, py in slots_for(direction, d, s):
                    if _rect_free(grid, px, py, w, h, margin):
                        return {"x": px, "y": py}
    return None


def _find_spot_anywhere(grid, w, h, margin):
    for y in range(margin, grid.h - h - margin + 1):
        for x in range(margin, grid.w - w - margin + 1):
            if _rect_free(grid, x, y, w, h, margin):
                return {"x": x, "y": y}
    return None


def _carve_corridor(a, b, rooms_on_floor, W, H):
    """走廊寻路：BFS 最短路（确定性邻居序 右/下/左/上），第三方房=障碍。
    （压力测试 P4/P5 根治：原 L 直线遇房丢格→视觉断裂+绕远；BFS 路径连续、不穿房、天然最短绕行）
    返回 (cells, doors, ok)：贴 A/B 房边界第一格=门，其余=走廊格；不通=ok False（调用方记错）。"""
    def in_rect(r, x, y):
        return r["x"] <= x < r["x"] + r["w"] and r["y"] <= y < r["y"] + r["h"]

    obstacles = set()
    for other in rooms_on_floor:
        if other is a or other is b:
            continue
        for yy in range(other["y"], other["y"] + other["h"]):
            for xx in range(other["x"], other["x"] + other["w"]):
                obstacles.add((xx, yy))

    start = (a["cx"], a["cy"])
    goal = (b["cx"], b["cy"])
    prev = {start: None}
    q = deque([start])
    while q:
        cur = q.popleft()
        if cur == goal:
            break
        x, y = cur
        for nxt in ((x + 1, y), (x, y + 1), (x - 1, y), (x, y - 1)):
            if not (0 <= nxt[0] < W and 0 <= nxt[1] < H):
                continue
            if nxt in obstacles or nxt in prev:
                continue
            prev[nxt] = cur
            q.append(nxt)
    if goal not in prev:
        return [], [], False

    # 路径（start→goal 序）→ 分类。门收敛（凛倾「垃圾」返工：沿墙路径贴墙格全判门=++++乱线）：
    # 每条走廊门最多 2 个——离开 A 房后的第一格 + 进入 B 房前的最后一格，其余一律走廊线。
    path = []
    cur = goal
    while cur is not None:
        path.append(cur)
        cur = prev[cur]
    path.reverse()
    outside = [(x, y) for (x, y) in path if not (in_rect(a, x, y) or in_rect(b, x, y))]
    cells = []
    doors = []
    for i, (x, y) in enumerate(outside):
        if i == 0 or i == len(outside) - 1:
            doors.append([x, y])
        else:
            cells.append([x, y])
    return cells, doors, True


def layout_map(topology, caps):
    """布局主函数：拓扑 → 几何。纯函数（不读写盘）。返回 {w,h,floors,entities,errors}。"""
    grid_cfg = (caps or {}).get("grid") or {}
    errors = []
    # 网格域唯一来源=caps.grid（禁代码第二份默认）；缺失=诚实报错返回空布局，不发明数值
    if not grid_cfg.get("w") or not grid_cfg.get("h"):
        return {"w": 0, "h": 0, "floors": {}, "entities": [], "errors": ["caps.grid.w/h 缺失（能力谱未传入）"]}
    W = max(16, int(grid_cfg["w"]))
    H = max(10, int(grid_cfg["h"]))
    margin = max(0, int(grid_cfg.get("margin") or 0))
    max_floors = max(1, int(grid_cfg.get("maxFloors") or 1))
    gap = max(1, int(grid_cfg.get("corridorGap") or 1))
    rooms = topology.get("rooms") if isinstance(topology, dict) else None
    rooms = rooms if isinstance(rooms, list) else []
    entities = topology.get("entities") if isinstance(topology, dict) else None
    entities = entities if isinstance(entities, list) else []

    # ── 自动扩格（确定性，凛倾「输出大型地图」需求）：按各层房间需求面积（含走廊距）
    #    估算，网格容量不足则按 1.25 倍步进放大到谱内上限 maxW×maxH ──
    if grid_cfg.get("autoGrow") is not False:
        max_w_cap = max(W, int(grid_cfg.get("maxW") or W))
        max_h_cap = max(H, int(grid_cfg.get("maxH") or H))
        floor_area = {}
        for room in rooms:
            if not isinstance(room, dict):
                continue
            size = _resolve_size(room.get("size"), caps)
            if size is None:
                continue
            # 与放置层同一口径：名字撑宽后估面积（否则大图估小 → 扩格不足）
            _lw = _text_w(f"{room.get('sym') or ''}{room.get('name') or room.get('id') or ''}")
            _w = max(size[0], _lw + 2)
            try:
                f = max(0, min(int(room.get("floor") or 0), max_floors - 1))
            except (TypeError, ValueError):
                f = 0
            floor_area[f] = floor_area.get(f, 0) + (_w + gap) * (size[1] + gap)
        need = max(floor_area.values()) if floor_area else 0
        while W * H < need * 2 and (W < max_w_cap or H < max_h_cap):
            W = min(max_w_cap, max(W + 1, int(W * 1.25)))
            H = min(max_h_cap, max(H + 1, int(H * 1.25)))
        if W * H < need * 2:
            errors.append(f"网格已达上限 {W}x{H} 仍偏挤（需求估算 {need}×2），可调大 caps.grid.maxW/maxH")

    placed = {}   # id → 房间记录
    floors = {}   # int f → {"grid","rooms","corridors","doors","stairs"}
    placed_seq = 0  # 全图放置序号（方向轮转种子，确定性）

    def floor_of(r):
        try:
            f = int(r.get("floor") or 0)
        except (TypeError, ValueError):
            f = 0
        if f < 0:
            f = 0
        if f >= max_floors:
            errors.append(f"房间 {r.get('id')}: floor {f} 超上限 {max_floors - 1}，钳制")
            f = max_floors - 1
        return f

    def ensure_floor(f):
        if f not in floors:
            floors[f] = {"grid": _Grid(W, H), "rooms": [], "corridors": [], "doors": [], "stairs": []}
        return floors[f]

    # ── 房间放置（数组序确定性）──
    for room in rooms:
        if not isinstance(room, dict) or not isinstance(room.get("id"), str) or not room["id"]:
            errors.append("存在缺 id 的房间条目，跳过")
            continue
        if room["id"] in placed:
            errors.append(f"房间 id 重复: {room['id']}，跳过后者")
            continue
        f = floor_of(room)
        fl = ensure_floor(f)
        # AI 自主优先（凛倾 0731「让ai自主发挥」）：w/h 数字直给则直接用；size 档仅是可选缩写
        w = h = None
        try:
            if room.get("w") is not None and room.get("h") is not None:
                w, h = max(2, int(room["w"])), max(2, int(room["h"]))
        except (TypeError, ValueError):
            w = h = None
        if w is None:
            size = _resolve_size(room.get("size"), caps)
            if size is None:
                errors.append(f"房间 {room['id']}: 无 w/h 且 caps.roomSizes 缺失，跳过")
                continue
            w, h = size
        # 细致地图铁则：名字全显——房宽被名字撑开（AI 显式 w 也保名字可读）
        _label_w = _text_w(f"{room.get('sym') or ''}{room.get('name') or room['id']}")
        w = max(w, min(_label_w + 2, W - 2))
        adj = room.get("adj") if isinstance(room.get("adj"), list) else []
        spot = None
        # AI 自主直给坐标（「让ai自主发挥」+「系统是算法修正」）：x/y 数字直接收——
        # 引擎只做修正：越界钳制；与已放房冲突→以 AI 给的点为锚就近找位（不否决，只修）
        try:
            if room.get("x") is not None and room.get("y") is not None:
                ax_ = min(max(int(room["x"]), 0), max(0, W - w))
                ay_ = min(max(int(room["y"]), 0), max(0, H - h))
                if _rect_free(fl["grid"], ax_, ay_, w, h, 0):
                    spot = {"x": ax_, "y": ay_}
                else:
                    spot = _find_spot_near(fl["grid"], {"x": ax_, "y": ay_, "w": 1, "h": 1}, w, h, margin, 1, 0)
                    if spot:
                        errors.append(f"房间 {room['id']}: AI 坐标({ax_},{ay_})与既有房冲突，就近修正到({spot['x']},{spot['y']})")
        except (TypeError, ValueError):
            spot = None
        anchor = None
        if spot is None:
            for aid in adj:
                p = placed.get(aid)
                if p and p["floor"] == f:
                    anchor = p
                    break
            if anchor is None and fl["rooms"]:
                anchor = fl["rooms"][-1]
            if anchor is not None:
                spot = _find_spot_near(fl["grid"], anchor, w, h, margin, gap, placed_seq % 4)
            if spot is None:
                if anchor is not None:
                    spot = _find_spot_anywhere(fl["grid"], w, h, margin)
                else:
                    spot = {"x": (W - w) // 2, "y": (H - h) // 2}
        if spot is None or not _rect_free(fl["grid"], spot["x"], spot["y"], w, h, 0):
            spot = _find_spot_anywhere(fl["grid"], w, h, margin)
        if spot is None:
            errors.append(f"房间 {room['id']}({w}x{h}) 放不下（f{f} 已满）")
            continue
        _rect_mark(fl["grid"], spot["x"], spot["y"], w, h)
        rec = {
            "id": room["id"], "name": room.get("name") or room["id"],
            "x": spot["x"], "y": spot["y"], "w": w, "h": h,
            "cx": spot["x"] + w // 2, "cy": spot["y"] + h // 2,
            "floor": f, "color": room.get("color") or "", "sym": room.get("sym") or "",
            "note": room.get("note") or "",
            # 创作透传（管道不解释内容）：num=地点编号；interior=房内自由字符画块（多行，创作者画，引擎只对齐裁剪）
            "num": room.get("num") if isinstance(room.get("num"), (int, str)) else "",
            "interior": room.get("interior") if isinstance(room.get("interior"), list) else [],
        }
        # AI 自主扩展字段全保留（不认识≠丢弃——持久化+透传渲染端，era 系统的参数域由 AI 自由定义）
        _known = {"id", "name", "size", "adj", "floor", "color", "sym", "note", "num", "interior", "x", "y", "w", "h"}
        _extra = {k: v for k, v in room.items() if k not in _known}
        if _extra:
            rec["extra"] = _extra
        placed[room["id"]] = rec
        fl["rooms"].append(rec)
        placed_seq += 1

    # ── 走廊/楼梯（无向边规范键去重：单向声明也成边）──
    seen_edges = set()
    for room in rooms:
        if not isinstance(room, dict):
            continue
        a = placed.get(room.get("id"))
        if a is None:
            continue
        for aid in (room.get("adj") if isinstance(room.get("adj"), list) else []):
            b = placed.get(aid)
            if b is None:
                errors.append(f"邻接目标不存在: {room.get('id')} → {aid}")
                continue
            if a["id"] == b["id"]:
                continue
            edge_key = f"{a['id']} {b['id']}" if a["id"] < b["id"] else f"{b['id']} {a['id']}"
            if edge_key in seen_edges:
                continue
            seen_edges.add(edge_key)
            if a["floor"] == b["floor"]:
                fl = ensure_floor(a["floor"])
                cells, doors, ok = _carve_corridor(a, b, fl["rooms"], W, H)
                if not ok:
                    errors.append(f"走廊不通: {a['id']} ↔ {b['id']}（被围死）")
                fl["corridors"].append({"from": a["id"], "to": b["id"], "cells": cells})
                fl["doors"].extend(doors)
            else:
                # 同房多楼梯错列（压力测试 P6：双向楼梯同格堆叠只剩一个 ≡）
                def _stairs_spot(fl_obj, room, cx, cy):
                    taken = {(s[0], s[1]) for s in fl_obj["stairs"]}
                    x = cx
                    while (x, cy) in taken and x < room["x"] + room["w"] - 2:
                        x += 1
                    return x, cy
                fa = ensure_floor(a["floor"])
                sx, sy = _stairs_spot(fa, a, a["cx"], a["cy"])
                fa["stairs"].append([sx, sy, b["id"]])
                fb = ensure_floor(b["floor"])
                sx, sy = _stairs_spot(fb, b, b["cx"], b["cy"])
                fb["stairs"].append([sx, sy, a["id"]])

    # ── 实体落点：房间内部格，按同房实体序偏移（与 JS 公式一致）──
    per_room_count = {}
    placed_entities = []
    for ent in entities:
        if not isinstance(ent, dict) or not isinstance(ent.get("id"), str) or not ent["id"]:
            errors.append("存在缺 id 的实体条目，跳过")
            continue
        room = placed.get(ent.get("room"))
        if room is None:
            errors.append(f"实体 {ent['id']} 所在房间不存在: {ent.get('room')}")
            continue
        idx = per_room_count.get(room["id"], 0)
        per_room_count[room["id"]] = idx + 1
        inner_w = max(1, room["w"] - 2)
        # 实体落点避开房名行（首内行=房名内嵌行，凛倾字符级核验抓出"卫G/塔@"盖字冲突）：
        # 房高≥4 从第二内行起排；矮房(h=3 仅一内行)才回退首行与名共存
        if room["h"] >= 4:
            ey_base = room["y"] + 2
            inner_h = max(1, room["h"] - 3)
        else:
            ey_base = room["y"] + 1
            inner_h = max(1, room["h"] - 2)
        # 从左列起排（原 center 起点=与 overlay 默认 center 参照撞格，字符级核验抓出）
        ex = room["x"] + 1 + (idx % inner_w)
        ey = ey_base + ((idx // inner_w) % inner_h)
        placed_entities.append({
            "id": ent["id"], "room": room["id"], "x": ex, "y": ey,
            "floor": room["floor"], "sym": ent.get("sym") or "", "color": ent.get("color") or "",
        })

    out_floors = {}
    for f, fl in floors.items():
        out_floors[str(f)] = {
            "rooms": fl["rooms"], "corridors": fl["corridors"],
            "doors": fl["doors"], "stairs": fl["stairs"],
        }
    return {"w": W, "h": H, "floors": out_floors, "entities": placed_entities, "errors": errors}


# ============================================================
# 持久化（契约与 JS 读侧对齐；原子写=tmp+os.replace）
# ============================================================

# 与 JS encodeURIComponent 未转义集逐字对齐: A-Za-z0-9 - _ . ! ~ * ' ( )
_URI_SAFE = "-_.!~*'()"


def _map_file(era_dir, map_id):
    return os.path.join(era_dir, "maps", urllib.parse.quote(str(map_id), safe=_URI_SAFE) + ".json")


def _atomic_write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with io.open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    os.replace(tmp, path)


def _read_json(path):
    try:
        if os.path.exists(path):
            with io.open(path, "r", encoding="utf-8") as fh:
                return json.load(fh)
    except (OSError, ValueError) as e:
        print(f"[era_pipeline] 读取失败: {path}: {e}", file=sys.stderr)
    return None


def load_map(era_dir, map_id):
    if not map_id:
        return None
    return _read_json(_map_file(era_dir, map_id))


def save_map(era_dir, map_obj):
    _atomic_write(_map_file(era_dir, map_obj["id"]), json.dumps(map_obj, ensure_ascii=False, indent=2))


def get_active_id(era_dir):
    data = _read_json(os.path.join(era_dir, "_active.json"))
    if isinstance(data, dict) and isinstance(data.get("mapId"), str) and data["mapId"]:
        return data["mapId"]
    return None


def set_active_id(era_dir, map_id):
    _atomic_write(os.path.join(era_dir, "_active.json"), json.dumps({"mapId": map_id}, ensure_ascii=False, indent=2))


def write_prompt_summary(era_dir, text):
    _atomic_write(os.path.join(era_dir, "_prompt_summary.txt"), str(text or ""))


# ============================================================
# patch 操作集（与 JS applyOps 同 op 集同语义）
# ============================================================


def apply_ops(map_obj, ops, caps):
    errors = []
    applied = 0
    if not isinstance(ops, list):
        return 0, ["patch 不是数组"]
    topo = map_obj.setdefault("topology", {})
    rooms = topo.setdefault("rooms", [])
    entities = topo.setdefault("entities", [])
    overlays = map_obj.setdefault("overlays", [])

    for p in ops:
        if not isinstance(p, dict) or not isinstance(p.get("op"), str):
            errors.append("非法 patch 条目")
            continue
        op = p["op"]
        if op == "addRoom":
            r = p.get("room")
            if not isinstance(r, dict) or not isinstance(r.get("id"), str) or not r["id"]:
                errors.append("addRoom 缺 room.id")
            elif any(x.get("id") == r["id"] for x in rooms):
                errors.append(f"addRoom 重复 id: {r['id']}")
            else:
                rooms.append(r)
                applied += 1
        elif op == "removeRoom":
            idx = next((i for i, x in enumerate(rooms) if x.get("id") == p.get("id")), -1)
            if idx < 0:
                errors.append(f"removeRoom 不存在: {p.get('id')}")
            else:
                rooms.pop(idx)
                for r in rooms:
                    if isinstance(r.get("adj"), list):
                        r["adj"] = [a for a in r["adj"] if a != p.get("id")]
                entities[:] = [e for e in entities if e.get("room") != p.get("id")]
                applied += 1
        elif op == "setRoom":
            r = next((x for x in rooms if x.get("id") == p.get("id")), None)
            if r is None:
                errors.append(f"setRoom 不存在: {p.get('id')}")
            elif isinstance(p.get("attrs"), dict):
                for k in ("name", "size", "adj", "floor", "color", "sym", "note"):
                    if k in p["attrs"]:
                        r[k] = p["attrs"][k]
                applied += 1
        elif op == "addEntity":
            e = p.get("entity")
            if not isinstance(e, dict) or not isinstance(e.get("id"), str) or not e["id"]:
                errors.append("addEntity 缺 entity.id")
            elif any(x.get("id") == e["id"] for x in entities):
                errors.append(f"addEntity 重复 id: {e['id']}")
            else:
                entities.append(e)
                applied += 1
        elif op == "removeEntity":
            idx = next((i for i, x in enumerate(entities) if x.get("id") == p.get("id")), -1)
            if idx < 0:
                errors.append(f"removeEntity 不存在: {p.get('id')}")
            else:
                entities.pop(idx)
                applied += 1
        elif op == "moveEntity":
            e = next((x for x in entities if x.get("id") == p.get("id")), None)
            if e is None:
                errors.append(f"moveEntity 不存在: {p.get('id')}")
            else:
                e["room"] = p.get("room")
                applied += 1
        elif op == "overlay":
            # 推荐形态=room+at 语义参照（凛倾「不要给坐标,好歹给个范围和参照」，值域=caps.placement 表
            # 用户可增删改）；cell 绝对形态留给精确控制。落点渲染期解析（跟随房间重排移动）。
            room_ref = p.get("room")
            cell = p.get("cell")
            if isinstance(room_ref, str) and room_ref:
                placement_table = (caps or {}).get("placement") or {}
                at = p.get("at")
                if not any(x.get("id") == room_ref for x in rooms):
                    errors.append(f"overlay 房间不存在: {room_ref}")
                elif at is not None and at not in placement_table:
                    errors.append(f"overlay 未知参照 at={at}（可用: {','.join(placement_table.keys())}）")
                else:
                    rec = {"room": room_ref, "sym": p.get("sym") or "", "color": p.get("color") or ""}
                    if isinstance(at, str) and at:
                        rec["at"] = at
                    if isinstance(p.get("near"), str) and p["near"]:
                        rec["near"] = p["near"]
                    idx = next((i for i, o in enumerate(overlays)
                                if o.get("room") == room_ref and o.get("at") == rec.get("at") and o.get("near") == rec.get("near")), -1)
                    if idx >= 0:
                        overlays[idx] = rec
                    else:
                        overlays.append(rec)
                    applied += 1
            elif isinstance(cell, list) and len(cell) == 2:
                try:
                    f = int(p.get("floor") or 0)
                except (TypeError, ValueError):
                    f = 0
                rec = {"x": cell[0], "y": cell[1], "floor": f, "sym": p.get("sym") or "", "color": p.get("color") or ""}
                idx = next((i for i, o in enumerate(overlays)
                            if o.get("x") == cell[0] and o.get("y") == cell[1] and o.get("floor") == f), -1)
                if idx >= 0:
                    overlays[idx] = rec
                else:
                    overlays.append(rec)
                applied += 1
            else:
                errors.append("overlay 缺 room 或 cell:[x,y]")
        elif op == "clearOverlay":
            room_ref = p.get("room")
            cell = p.get("cell")
            if isinstance(room_ref, str) and room_ref:
                before = len(overlays)
                overlays[:] = [o for o in overlays if o.get("room") != room_ref]
                if len(overlays) < before:
                    applied += 1
                else:
                    errors.append(f"clearOverlay 该房无覆盖: {room_ref}")
            elif isinstance(cell, list) and len(cell) == 2:
                try:
                    f = int(p.get("floor") or 0)
                except (TypeError, ValueError):
                    f = 0
                idx = next((i for i, o in enumerate(overlays)
                            if o.get("x") == cell[0] and o.get("y") == cell[1] and o.get("floor") == f), -1)
                if idx >= 0:
                    overlays.pop(idx)
                    applied += 1
                else:
                    errors.append(f"clearOverlay 无此覆盖: ({cell[0]},{cell[1]},f{f})")
            else:
                errors.append("clearOverlay 缺 room 或 cell:[x,y]")
        elif op == "setName":
            if isinstance(p.get("name"), str) and p["name"]:
                map_obj["name"] = p["name"]
                applied += 1
            else:
                errors.append("setName 缺 name")
        elif op in ("set", "delta", "remove"):
            # 通用 JSON 原语（引擎完备层，照 airp stateMachine set/delta/remove 成熟范式）：
            # AI 可改地图数据的任何路径（含引擎不认识的字段——未知即保留即透传），具名 op 只是糖。
            # path=dot 路径（如 "name" / "topology.entities.0.actions" / "style.css"）；
            # 系统域保护：id/rev/layout 只读（layout=引擎产物，改 topology 后自动重排）。
            path = p.get("path")
            segs = [s for s in str(path or "").split(".") if s != ""]
            if not segs:
                errors.append(f"{op} 缺 path")
            elif segs[0] in ("id", "rev", "layout", "updatedAt"):
                errors.append(f"{op} 路径 {segs[0]} 为系统域只读")
            else:
                try:
                    parent = map_obj
                    for s in segs[:-1]:
                        if isinstance(parent, list):
                            parent = parent[int(s)]
                        elif isinstance(parent, dict):
                            parent = parent.setdefault(s, {})
                        else:
                            raise TypeError(f"路径中段 {s} 不可下钻")
                    leaf = segs[-1]
                    key = int(leaf) if isinstance(parent, list) else leaf
                    if op == "set":
                        if isinstance(parent, list) and key == len(parent):
                            parent.append(p.get("value"))
                        else:
                            parent[key] = p.get("value")
                    elif op == "delta":
                        cur = parent[key] if (isinstance(parent, dict) and key in parent) or (isinstance(parent, list) and -len(parent) <= key < len(parent)) else 0
                        parent[key] = (float(cur) if not isinstance(cur, (int, float)) else cur) + float(p.get("value") or 0)
                    else:  # remove
                        if isinstance(parent, list):
                            parent.pop(key)
                        else:
                            parent.pop(key, None)
                    applied += 1
                except (TypeError, ValueError, IndexError, KeyError) as e:
                    errors.append(f"{op}({path}) 失败: {e}")
        elif op == "draw":
            # 自由绘制原语（凛倾 0731「为什么不用字符-,范围xxx,xxx,这种构造」）：
            # AI 直接声明 字符+范围/点+层+色——零概念锁死（不经房间/拓扑），系统只落格修正记录。
            # {"op":"draw","ch":"═","range":[x1,y1,x2,y2],"at":[x,y],"color":..,"density":..,"layer":"map|char|dyn","floor":0}
            d = {k: p[k] for k in ("ch", "range", "at", "color", "density", "layer", "floor") if k in p}
            if not isinstance(d.get("ch"), str) or not d["ch"]:
                errors.append("draw 缺 ch 字符")
            elif not (isinstance(d.get("range"), list) and len(d["range"]) == 4) and not (isinstance(d.get("at"), list) and len(d["at"]) == 2):
                errors.append("draw 缺 range:[x1,y1,x2,y2] 或 at:[x,y]")
            else:
                map_obj.setdefault("draws", []).append(d)
                applied += 1
        elif op == "erase":
            # 擦除范围内的自由绘制（按范围过滤 draws；三层数据不动——擦的是画布层创作）
            rng = p.get("range")
            if not (isinstance(rng, list) and len(rng) == 4):
                errors.append("erase 缺 range:[x1,y1,x2,y2]")
            else:
                try:
                    x1, y1, x2, y2 = (int(v) for v in rng)
                except (TypeError, ValueError):
                    errors.append("erase range 非数字")
                else:
                    draws = map_obj.get("draws") or []
                    before = len(draws)

                    def _hit(dd):
                        if isinstance(dd.get("at"), list) and len(dd["at"]) == 2:
                            return x1 <= dd["at"][0] <= x2 and y1 <= dd["at"][1] <= y2
                        if isinstance(dd.get("range"), list) and len(dd["range"]) == 4:
                            a1, b1, a2, b2 = dd["range"]
                            return not (a2 < x1 or a1 > x2 or b2 < y1 or b1 > y2)
                        return False
                    map_obj["draws"] = [dd for dd in draws if not _hit(dd)]
                    if len(map_obj["draws"]) < before:
                        applied += 1
                    else:
                        errors.append("erase 范围内无绘制")
        elif op == "setStyle":
            # AI 供 CSS/动效通道（凛倾 0731 系统契约「ai可尽可能的制作和给css还有动态」）：
            # css 随图持久化（换 AI 视觉不变）；前端渲染时 scoped 注入（era 块作用域）+CSP 挡外联。
            # 管线只做粗消毒（剥 @import/url( 外联面），内容零解释——创作归 AI。
            css = p.get("css")
            if isinstance(css, str):
                cleaned = re.sub(r"@import[^;]*;", "", css)
                cleaned = re.sub(r"url\s*\(", "_url_blocked(", cleaned)
                map_obj.setdefault("style", {})["css"] = cleaned
                applied += 1
            else:
                errors.append("setStyle 缺 css 字符串")
        else:
            if ((caps or {}).get("fallback") or {}).get("unknownOpSkip") is not False:
                errors.append(f"未知 op 跳过: {op}")
    return applied, errors


# ============================================================
# 提示词摘要（模板全部来自 caps.prompt，本脚本零文案）
# ============================================================


def _fill(tpl, vals):
    return re.sub(r"\{(\w+)\}", lambda m: str(vals.get(m.group(1), "")), str(tpl or ""))


def build_summary(map_obj, caps):
    p = (caps or {}).get("prompt") or {}
    if not map_obj or not map_obj.get("layout"):
        return str(p.get("empty", ""))
    lines = []
    if p.get("wrapOpen"):
        lines.append(p["wrapOpen"])
    layout = map_obj["layout"]
    floors_used = sorted((layout.get("floors") or {}).keys())
    lines.append(_fill(p.get("header"), {
        "name": map_obj.get("name") or map_obj.get("id"), "id": map_obj.get("id"),
        "rev": map_obj.get("rev"), "w": layout.get("w"), "h": layout.get("h"),
        "floors": ",".join(floors_used),
    }))
    topo_rooms = (map_obj.get("topology") or {}).get("rooms") or []
    for f in floors_used:
        for r in (layout["floors"][f].get("rooms") or []):
            topo = next((x for x in topo_rooms if x.get("id") == r["id"]), None)
            adj = topo.get("adj") if topo and isinstance(topo.get("adj"), list) else []
            lines.append(_fill(p.get("roomLine"), {
                "id": r["id"], "cx": r["cx"], "cy": r["cy"], "floor": r["floor"], "adj": ",".join(adj),
            }))
    for e in (layout.get("entities") or []):
        lines.append(_fill(p.get("entityLine"), {
            "id": e["id"], "room": e["room"], "x": e["x"], "y": e["y"], "floor": e["floor"],
        }))
    for o in (map_obj.get("overlays") or []):
        pos = resolve_overlay(o, layout, caps)
        if pos is None:
            continue
        lines.append(_fill(p.get("overlayLine"), {
            "x": pos[0], "y": pos[1], "floor": pos[2], "sym": o.get("sym"),
        }))
    if p.get("wrapClose"):
        lines.append(p["wrapClose"])
    return "\n".join(lines)


def regenerate_summary(era_dir, caps, enabled=True):
    if not enabled:
        write_prompt_summary(era_dir, "")
        return
    active = get_active_id(era_dir)
    map_obj = load_map(era_dir, active) if active else None
    write_prompt_summary(era_dir, build_summary(map_obj, caps))


# ============================================================
# 纯文本字符画渲染（管线自带可视化出口：CLI 独立运行直接看图，零浏览器依赖）
# 与前端 eraRenderer ascii 模式同一约定：盒线房间/图例符号进房内左上角/CJK 房名走图例行
# ============================================================


_CONT = None  # 双宽字符续格哨兵（行拼接时跳过）


def _cw(ch):
    """字符显示宽度：CJK/全角=2 列，其余=1 列（等宽 CJK 字体全角=2×半角的 era 排版共识）。"""
    return 2 if unicodedata.east_asian_width(ch) in ("F", "W") else 1


def _new_mat(W, H):
    return [[" "] * W for _ in range(H)]


def _put(mat, x, y, ch):
    """写单字符（双宽自动占两格，第二格置续格哨兵）。越界/宽度装不下=不写。"""
    W, H = len(mat[0]), len(mat)
    if not ch or not (0 <= y < H):
        return False
    w = _cw(ch)
    if not (0 <= x and x + w <= W):
        return False
    mat[y][x] = ch
    if w == 2:
        mat[y][x + 1] = _CONT
    return True


def _text_w(text):
    """字符串显示总列宽（CJK=2）。"""
    return sum(_cw(ch) for ch in text)


def _put_text(mat, x, y, text, max_x):
    """从 (x,y) 向右写字符串到 max_x（含）为止。返回是否完整写入（截断=False，供图例兜底收集）。"""
    cx = x
    for ch in text:
        w = _cw(ch)
        if cx + w - 1 > max_x:
            return False
        _put(mat, cx, y, ch)
        cx += w
    return True


def _mat_rows(mat):
    """矩阵 → 行字符串（跳过双宽续格哨兵）。"""
    rows = []
    for row in mat:
        rows.append("".join(ch for ch in row if ch is not _CONT).rstrip())
    return rows


def _merge_mats(base, *tops):
    """层合成：上层非空格覆盖下层（dyn > char > map）。返回新矩阵。"""
    W, H = len(base[0]), len(base)
    out = [list(r) for r in base]
    for top in tops:
        for y in range(H):
            for x in range(W):
                c = top[y][x]
                if c is _CONT:
                    out[y][x] = _CONT
                elif c != " ":
                    out[y][x] = c
    return out


def _room_by_id(layout, room_id):
    for f in (layout.get("floors") or {}):
        for r in layout["floors"][f].get("rooms") or []:
            if r["id"] == room_id:
                return r
    return None


def resolve_placement(room, at, near, layout, caps):
    """语义参照 → 格坐标（凛倾「落点由系统计算——不要给坐标,好歹给个范围和参照」）。
    规则表=caps.placement（真数据：anchor 原语 + dx/dy 偏移，用户可增删改参照词）；
    本函数只实现 anchor 几何原语集（几何算法属代码域）。返回 (x,y) 房内钳制后坐标。"""
    table = (caps or {}).get("placement") or {}
    rule = table.get(at or "center") or table.get("center") or {"anchor": "center"}
    anchor = rule.get("anchor") or "center"
    x0, y0 = room["x"], room["y"]
    w, h = room["w"], room["h"]
    cx, cy = x0 + w // 2, y0 + h // 2
    if anchor == "center":
        x, y = cx, cy
    elif anchor == "topleft":
        x, y = x0, y0
    elif anchor == "topright":
        x, y = x0 + w - 1, y0
    elif anchor == "bottomleft":
        x, y = x0, y0 + h - 1
    elif anchor == "bottomright":
        x, y = x0 + w - 1, y0 + h - 1
    elif anchor == "wall_n":
        x, y = cx, y0 + 1
    elif anchor == "wall_s":
        x, y = cx, y0 + h - 2
    elif anchor == "wall_e":
        x, y = x0 + w - 2, cy
    elif anchor == "wall_w":
        x, y = x0 + 1, cy
    elif anchor == "door":
        # 该房第一扇门的内侧邻格；无门=房中心
        x, y = cx, cy
        fl = (layout.get("floors") or {}).get(str(room["floor"])) or {}
        for dx_, dy_ in ((0, 0),):
            pass
        for door in fl.get("doors") or []:
            ddx, ddy = door[0], door[1]
            for nx, ny in ((ddx - 1, ddy), (ddx + 1, ddy), (ddx, ddy - 1), (ddx, ddy + 1)):
                if x0 < nx < x0 + w - 1 and y0 < ny < y0 + h - 1:
                    x, y = nx, ny
                    break
            else:
                continue
            break
    elif anchor == "near":
        # 紧邻实体：实体右侧格，右侧越界取左侧；实体缺失=房中心
        x, y = cx, cy
        for e in (layout.get("entities") or []):
            if e.get("id") == near:
                x, y = e["x"] + 1, e["y"]
                if x >= x0 + w - 1:
                    x = e["x"] - 1
                break
    else:
        x, y = cx, cy
    try:
        x += int(rule.get("dx") or 0)
        y += int(rule.get("dy") or 0)
    except (TypeError, ValueError):
        pass
    # 钳制进房内（保住墙 + 避开房名行：首内行=房名内嵌行，压力测试 P3 盖房名）
    y_min = y0 + 2 if h >= 4 else y0 + 1
    x = min(max(x, x0 + 1), x0 + w - 2)
    y = min(max(y, y_min), y0 + h - 2)
    # 避让实体格（压力测试 P1：near 落点盖掉实体）：命中实体（含双宽续格）→ 房内向右回绕顺延找空格
    ent_cells = set()
    for e in (layout.get("entities") or []):
        if int(e.get("floor") or 0) != int(room["floor"]):
            continue
        ent_cells.add((e["x"], e["y"]))
        sym = e.get("sym") or ""
        if sym and _cw(sym[0]) == 2:
            ent_cells.add((e["x"] + 1, e["y"]))
    if (x, y) in ent_cells:
        inner_w = max(1, w - 2)
        inner_h = max(1, (y0 + h - 1) - y_min)
        for step in range(1, inner_w * inner_h + 1):
            nx = x0 + 1 + ((x - x0 - 1 + step) % inner_w)
            ny = y_min + (((y - y_min) + (x - x0 - 1 + step) // inner_w) % inner_h)
            if (nx, ny) not in ent_cells:
                x, y = nx, ny
                break
    return x, y


def resolve_overlay(o, layout, caps):
    """覆盖层落点：room+at 语义形态（推荐）或 x/y/floor 绝对形态。
    返回 (x, y, floor, room|None)——room 供调用方做双宽贴墙回缩（压力测试 P2）。"""
    if isinstance(o.get("room"), str) and o["room"]:
        room = _room_by_id(layout, o["room"])
        if room is None:
            return None
        x, y = resolve_placement(room, o.get("at"), o.get("near"), layout, caps)
        # 双宽符号贴东墙回缩：全角字符占 2 列，落点在内界最右列会吃掉墙字符
        sym = o.get("sym") or ""
        if sym and _cw(sym[0]) == 2 and x >= room["x"] + room["w"] - 2:
            x = max(room["x"] + 1, room["x"] + room["w"] - 3)
        return x, y, room["floor"], room
    try:
        return int(o.get("x")), int(o.get("y")), int(o.get("floor") or 0), None
    except (TypeError, ValueError):
        return None


def build_layers(map_obj, caps, floor_key):
    """单层楼三渲染层矩阵（凛倾「3层的动态层,地图,人物,动态层」）：
    m_map=地图（房+房名内嵌+走廊+门+楼梯）/ m_char=人物 / m_dyn=动态覆盖。
    返回 (m_map, m_char, m_dyn, truncated_rooms)。"""
    layout = map_obj["layout"]
    fl = layout["floors"][floor_key]
    cs = (caps or {}).get("charset") or {}
    syms = (caps or {}).get("symbols") or {}
    W, H = layout["w"], layout["h"]
    m_map, m_char, m_dyn = _new_mat(W, H), _new_mat(W, H), _new_mat(W, H)
    truncated = []

    # 字符集/符号唯一来源=caps（禁代码第二份默认副本，凛倾 0731「删除全部硬编码」）；缺键=不画（诚实降级）
    for r in fl.get("rooms") or []:
        for x in range(r["x"], r["x"] + r["w"]):
            _put(m_map, x, r["y"], cs.get("wallH") or "")
            _put(m_map, x, r["y"] + r["h"] - 1, cs.get("wallH") or "")
        for y in range(r["y"], r["y"] + r["h"]):
            _put(m_map, r["x"], y, cs.get("wallV") or "")
            _put(m_map, r["x"] + r["w"] - 1, y, cs.get("wallV") or "")
        _put(m_map, r["x"], r["y"], cs.get("cornerTL") or "")
        _put(m_map, r["x"] + r["w"] - 1, r["y"], cs.get("cornerTR") or "")
        _put(m_map, r["x"], r["y"] + r["h"] - 1, cs.get("cornerBL") or "")
        _put(m_map, r["x"] + r["w"] - 1, r["y"] + r["h"] - 1, cs.get("cornerBR") or "")
        # 房名直接进房间首行（era 正统：玩家看名字不查表；写不下→可辨识压缩：首段+末字
        # （压力测试 P8：同前缀房如"螺旋梯1/2/3"纯截头全显"螺旋"无法区分，保末字保住序号））
        name = r.get("name") or r["id"]
        label = f"{r.get('sym') or ''}{name}"
        max_x = r["x"] + r["w"] - 2
        width = max_x - (r["x"] + 1) + 1
        if _text_w(label) > width and len(name) >= 2:
            head = f"{r.get('sym') or ''}"
            tail = name[-1]
            body = ""
            for ch in name[:-1]:
                if _text_w(head + body + ch + tail) > width:
                    break
                body += ch
            label = head + body + tail if _text_w(head + tail) <= width else label
            truncated.append(f"{label}={name}(f{floor_key})")
        elif _text_w(label) > width:
            truncated.append(f"{name}(f{floor_key})")
        _put_text(m_map, r["x"] + 1, r["y"] + 1, label, max_x)
    # 房内自由字符画块（创作者画，引擎只放置对齐+裁剪进内壁；从房名行下一行起）
    for r in fl.get("rooms") or []:
        for li, line in enumerate((r.get("interior") or [])[: max(0, r["h"] - 3)]):
            if isinstance(line, str):
                _put_text(m_map, r["x"] + 1, r["y"] + 2 + li, line, r["x"] + r["w"] - 2)
        # 地点编号（eraTW 标准：编号=传送/选单语义）：房内右下角
        num = str(r.get("num") or "")
        if num:
            _put_text(m_map, max(r["x"] + 1, r["x"] + r["w"] - 1 - _text_w(num)), r["y"] + r["h"] - 2, num, r["x"] + r["w"] - 2)

    # 道路带（eraTW 标准：亮色瓦片带非单线；roadWidth>=2 时右/下膨胀一格铺 road 字符）
    road_w = int(((caps or {}).get("render") or {}).get("roadWidth") or 1)
    road_ch = cs.get("road") or ""
    corridor_ch = cs.get("corridor") or syms.get("corridor") or ""
    for c in fl.get("corridors") or []:
        for x, y in c.get("cells") or []:
            _put(m_map, x, y, (road_ch if road_w >= 2 and road_ch else corridor_ch))
            if road_w >= 2 and road_ch:
                for ex_, ey_ in ((x + 1, y), (x, y + 1))[: road_w - 1]:
                    if 0 <= ex_ < W and 0 <= ey_ < H and m_map[ey_][ex_] is not _CONT and m_map[ey_][ex_] == " ":
                        _put(m_map, ex_, ey_, road_ch)
    for x, y in fl.get("doors") or []:
        _put(m_map, x, y, cs.get("door") or syms.get("door") or "")
    for st in fl.get("stairs") or []:
        _put(m_map, st[0], st[1], cs.get("stairs") or syms.get("stairs") or "")

    # 自由装饰块（鸟居/石碑类：art 多行字符画 + room/at 语义锚；创作内容引擎零解释）
    for d in ((map_obj.get("topology") or {}).get("decor") or []):
        if not isinstance(d, dict) or not isinstance(d.get("art"), list):
            continue
        anchor_room = _room_by_id(layout, d.get("room")) if d.get("room") else None
        if anchor_room is not None:
            if int(anchor_room["floor"]) != int(floor_key):
                continue
            ax, ay = resolve_placement(anchor_room, d.get("at"), d.get("near"), layout, caps)
        else:
            try:
                ax, ay = int(d.get("x")), int(d.get("y"))
                if int(d.get("floor") or 0) != int(floor_key):
                    continue
            except (TypeError, ValueError):
                continue
        for li, line in enumerate(d["art"]):
            if isinstance(line, str):
                _put_text(m_map, ax, ay + li, line, W - 1)

    # 地形纹理层（eraTW 标准零留白）：环境带（拓扑声明 inline chars/color 或 preset 缩写）+ ground 铺满剩余
    terr_cfg = (caps or {}).get("terrain") or {}
    if terr_cfg.get("enabled") is not False:
        band = max(1, int(terr_cfg.get("bandWidth") or 1))
        presets = terr_cfg.get("presets") or {}

        def _terr_chars(spec):
            if isinstance(spec.get("chars"), str) and spec["chars"]:
                return spec["chars"]
            p = presets.get(spec.get("type") or "")
            return p.get("chars") if isinstance(p, dict) and isinstance(p.get("chars"), str) else ""

        def _hash_pick(chars, x, y):
            if not chars:
                return ""
            pool = [ch for ch in chars]
            return pool[(x * 31 + y * 17) % len(pool)]

        def _in_band(at, x, y):
            if at == "north":
                return y < band
            if at == "south":
                return y >= H - band
            if at == "west":
                return x < band
            if at == "east":
                return x >= W - band
            return x < band or x >= W - band or y < band or y >= H - band  # edge

        zones = [z for z in ((map_obj.get("topology") or {}).get("terrain") or []) if isinstance(z, dict)]
        ground = terr_cfg.get("ground") or {}
        ground_chars = ground.get("chars") if isinstance(ground.get("chars"), str) else ""

        def _density_of(spec, fallback=1.0):
            try:
                d = float(spec.get("density"))
                return d if 0.0 <= d <= 1.0 else fallback
            except (TypeError, ValueError):
                p = presets.get(spec.get("type") or "")
                if isinstance(p, dict):
                    try:
                        d = float(p.get("density"))
                        return d if 0.0 <= d <= 1.0 else fallback
                    except (TypeError, ValueError):
                        pass
                return fallback

        def _density_hit(x, y, density):
            # 确定性稀疏散布（eraTW 真图：纹理是散布非密铺——留白也是设计）
            return ((x * 73 + y * 151) % 100) / 100.0 < density

        # ground 晕染掩码（fill='around'：只铺建筑/道路活动区膨胀 radius 格内，外围留黑呼吸）
        g_fill = ground.get("fill") or "around"
        g_radius = max(0, int(ground.get("radius") or 0))
        active_mask = None
        if g_fill == "around":
            active_mask = [[False] * W for _ in range(H)]
            marks = []
            for r in fl.get("rooms") or []:
                marks.append((r["x"], r["y"], r["w"], r["h"]))
            for c in fl.get("corridors") or []:
                for x, y in c.get("cells") or []:
                    marks.append((x, y, 1, 1))
            for x, y in fl.get("doors") or []:
                marks.append((x, y, 1, 1))
            for mx, my, mw, mh in marks:
                for yy in range(max(0, my - g_radius), min(H, my + mh + g_radius)):
                    for xx in range(max(0, mx - g_radius), min(W, mx + mw + g_radius)):
                        active_mask[yy][xx] = True

        for y in range(H):
            for x in range(W):
                if m_map[y][x] is _CONT or m_map[y][x] != " ":
                    continue
                ch = ""
                color_key = ""
                for z in zones:
                    if _in_band(z.get("at") or "edge", x, y):
                        if _density_hit(x, y, _density_of(z)):
                            ch = _hash_pick(_terr_chars(z), x, y)
                            if ch:
                                break
                        else:
                            ch = ""
                            break  # 落在区带但密度未命中 → 留白（不再落 ground）
                else:
                    # 不在任何区带 → ground（按铺法/密度）
                    if g_fill == "all" or (g_fill == "around" and active_mask and active_mask[y][x]):
                        if _density_hit(x, y, _density_of(ground)):
                            ch = _hash_pick(ground_chars, x, y)
                if ch and _cw(ch) == 2 and x + 1 < W and m_map[y][x + 1] != " ":
                    continue  # 双宽纹理字符右邻被占则跳过（防吃字）
                if ch:
                    _put(m_map, x, y, ch)

    for e in layout.get("entities") or []:
        if int(e.get("floor") or 0) == int(floor_key):
            ch = e.get("sym") or syms.get("entity") or ""
            if ch:
                _put(m_char, e["x"], e["y"], ch[0])

    for o in map_obj.get("overlays") or []:
        pos = resolve_overlay(o, layout, caps)
        if pos and int(pos[2]) == int(floor_key):
            ch = o.get("sym") or syms.get("overlayDefault") or ""
            if ch:
                _put(m_dyn, pos[0], pos[1], ch[0])

    return m_map, m_char, m_dyn, truncated


def render_text(map_obj, caps, layer=None):
    """地图 JSON → 纯文本字符画。layer=None 合成三层；'map'/'char'/'dyn' 单层输出（层开关经 caps.layers）。"""
    if not map_obj or not map_obj.get("layout"):
        return "(无布局)"
    layout = map_obj["layout"]
    layers_on = (caps or {}).get("layers") or {}
    labels = (caps or {}).get("textLabels") or {}
    out = [_fill(labels.get("headerLine") or "{name} rev{rev}", {
        "name": map_obj.get("name") or map_obj.get("id"), "id": map_obj.get("id"), "rev": map_obj.get("rev"),
    })]
    truncated_all = []
    floor_rows = []
    min_indent = None  # 全楼层统一左裁（凛倾「垃圾」返工：整图偏右大片左空白；统一裁保持层间列对齐）
    for f in sorted((layout.get("floors") or {}).keys()):
        m_map, m_char, m_dyn, truncated = build_layers(map_obj, caps, f)
        truncated_all.extend(truncated)
        if layer == "map":
            mat = m_map
        elif layer == "char":
            mat = m_char
        elif layer == "dyn":
            mat = m_dyn
        else:
            stack = []
            if layers_on.get("map", True):
                stack.append(m_map)
            if layers_on.get("char", True):
                stack.append(m_char)
            if layers_on.get("dyn", True):
                stack.append(m_dyn)
            mat = _merge_mats(*stack) if stack else _new_mat(layout["w"], layout["h"])
        rows = _mat_rows(mat)
        for r in rows:
            stripped = len(r) - len(r.lstrip(" "))
            if r.strip():
                min_indent = stripped if min_indent is None else min(min_indent, stripped)
        floor_rows.append((f, rows))
    for f, rows in floor_rows:
        cut = min_indent or 0
        rows = [(r[cut:] if len(r) > cut else "") for r in rows]
        top = next((i for i, r in enumerate(rows) if r), 0)
        bot = next((i for i in range(len(rows) - 1, -1, -1) if rows[i]), 0)
        out.append(_fill(labels.get("floorHeader") or "F{f}", {"f": f}))
        out.extend(rows[max(0, top - 1):bot + 2])
    if truncated_all:
        out.append((labels.get("truncatedLine") or "") + "  ".join(truncated_all))
    # 方位标注（机制开关在谱，方位字与行模板在数据）
    comp = (caps or {}).get("compass") or {}
    if comp.get("enabled") is not False and labels.get("compassLine") and (comp.get("n") or comp.get("s")):
        out.append(_fill(labels["compassLine"], {"n": comp.get("n", ""), "s": comp.get("s", ""), "e": comp.get("e", ""), "w": comp.get("w", "")}))
    # 楼梯清单（压力测试 P6：≡ 一格无方向/目标层标识——文本侧补语义清单，图内符号保持极简）
    stair_lines = []
    seen_pairs = set()
    for f in sorted((layout.get("floors") or {}).keys()):
        for sx, sy, to_id in (layout["floors"][f].get("stairs") or []):
            here = next((r["id"] for r in layout["floors"][f].get("rooms") or []
                         if r["x"] <= sx < r["x"] + r["w"] and r["y"] <= sy < r["y"] + r["h"]), "?")
            key = tuple(sorted([f"{here}(f{f})", to_id]))
            if key in seen_pairs:
                continue
            seen_pairs.add(key)
            to_room = _room_by_id(layout, to_id)
            to_f = to_room["floor"] if to_room else "?"
            stair_lines.append(f"{here}(f{f})≡{to_id}(f{to_f})")
    if stair_lines:
        out.append((labels.get("stairsLine") or "") + "  ".join(stair_lines))
    ent_sym_default = ((caps or {}).get("symbols") or {}).get("entity") or ""
    ents = ["{}={}@{}".format((e.get("sym") or ent_sym_default or "?")[0], e["id"], e["room"]) for e in (layout.get("entities") or [])]
    if ents:
        out.append((labels.get("entsLine") or "") + "  ".join(ents))
    return "\n".join(out)


# ============================================================
# era-ui 界面组件系统（eraTW 全套界面的通用化：状态条/编号菜单/面板头/键值行——
#   凛倾 0731「我要的是一整套系统」：组件是引擎的，内容全是 AI/做卡人的数据；
#   格式模板全部住 caps.ui（数据层），未知组件类型诚实降级为 JSON 文本行）
# ============================================================


def _pad_w(text, width):
    """按显示列宽右补空格（CJK=2 列）。"""
    return text + " " * max(0, width - _text_w(text))


def render_ui(ui_obj, caps):
    """UI 数据 → 文本界面。blocks 组件：
    bars{bars:[{label,val,max,color?}]} / menu{title?,items:[{num,label}]} / panel{title}
    / kv{pairs:{k:v} 或 [[k,v]...]} / text{lines:[...]} / hr{}"""
    cfg = (caps or {}).get("ui") or {}
    out = []
    bar_w = max(4, int(cfg.get("barWidth") or 10))
    menu_cols = max(1, int(cfg.get("menuCols") or 1))
    col_w = max(8, int(cfg.get("menuColWidth") or 20))
    for block in (ui_obj.get("blocks") or []):
        if not isinstance(block, dict):
            continue
        t = block.get("type")
        if t == "bars":
            for b in (block.get("bars") or []):
                try:
                    val = float(b.get("val") or 0)
                    mx = float(b.get("max") or 0) or 1.0
                except (TypeError, ValueError):
                    continue
                filled = max(0, min(bar_w, round(bar_w * val / mx)))
                bar = (cfg.get("barChar") or "")[:1] * filled + (cfg.get("barEmptyChar") or " ")[:1] * (bar_w - filled)
                out.append(_fill(cfg.get("barFormat"), {
                    "label": b.get("label") or "", "bar": bar,
                    "val": int(val) if val == int(val) else val,
                    "max": int(mx) if mx == int(mx) else mx,
                }))
        elif t == "menu":
            if block.get("title"):
                out.append(_fill(cfg.get("panelHeader"), {"title": block["title"]}))
            row = []
            for item in (block.get("items") or []):
                cell = _fill(cfg.get("menuItemFormat"), {"num": item.get("num", ""), "label": item.get("label", "")})
                row.append(_pad_w(cell, col_w))
                if len(row) >= menu_cols:
                    out.append("".join(row).rstrip())
                    row = []
            if row:
                out.append("".join(row).rstrip())
        elif t == "panel":
            out.append(_fill(cfg.get("panelHeader"), {"title": block.get("title") or ""}))
        elif t == "kv":
            pairs = block.get("pairs")
            items = pairs.items() if isinstance(pairs, dict) else (pairs or [])
            out.append((cfg.get("kvSep") or " ").join(
                _fill(cfg.get("kvFormat"), {"k": k, "v": v}) for k, v in items))
        elif t == "text":
            for line in (block.get("lines") or []):
                if isinstance(line, str):
                    out.append(line)
        elif t == "hr":
            out.append((cfg.get("hrChar") or "")[:1] * (menu_cols * col_w))
        else:
            out.append(json.dumps(block, ensure_ascii=False))  # 未知组件诚实降级
    return "\n".join(out)


def load_ui(era_dir, ui_id):
    if not ui_id:
        return None
    return _read_json(os.path.join(era_dir, "ui", urllib.parse.quote(str(ui_id), safe=_URI_SAFE) + ".json"))


def save_ui(era_dir, ui_obj):
    _atomic_write(os.path.join(era_dir, "ui", urllib.parse.quote(str(ui_obj["id"]), safe=_URI_SAFE) + ".json"),
                  json.dumps(ui_obj, ensure_ascii=False, indent=2))


# ============================================================
# 指令解析 + 全链处理
# ============================================================

ERA_MAP_RE = re.compile(r"<era-map\b([^>]*)>\s*([\s\S]*?)\s*</era-map>")
ERA_PATCH_RE = re.compile(r"<era-patch\b([^>]*)>\s*([\s\S]*?)\s*</era-patch>")
ERA_UI_RE = re.compile(r"<era-ui\b([^>]*)>\s*([\s\S]*?)\s*</era-ui>")
ATTR_RE = re.compile(r"([\w-]+)\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s\"'>]+))")


def parse_attrs(attr_str):
    attrs = {}
    for m in ATTR_RE.finditer(attr_str or ""):
        attrs[m.group(1)] = m.group(2) if m.group(2) is not None else (
            m.group(3) if m.group(3) is not None else (m.group(4) or ""))
    return attrs


def process_content(content, era_dir, caps, enabled=True):
    """全链：era-map 建图 + era-patch 增量 → 布局 → 落盘 → 摘要。返回 (touched|None, errors)。"""
    all_errors = []
    touched = None
    if not isinstance(content, str) or not re.search(r"<era-(map|patch|ui)\b", content):
        return touched, all_errors

    for m in ERA_MAP_RE.finditer(content):
        attrs = parse_attrs(m.group(1))
        map_id = attrs.get("id")
        if not map_id:
            all_errors.append("era-map 缺 id 属性（默认值不由代码发明——指令必须显式给 id）")
            continue
        try:
            topology = json.loads(m.group(2))
        except ValueError as e:
            all_errors.append(f"era-map({map_id}) JSON 解析失败: {e}")
            continue
        if isinstance(topology, list):
            topology = {"rooms": topology}
        if not isinstance(topology, dict) or not isinstance(topology.get("rooms"), list):
            all_errors.append(f"era-map({map_id}) 缺 rooms 数组")
            continue
        prev = load_map(era_dir, map_id)
        layout = layout_map(topology, caps)
        all_errors.extend(layout["errors"])
        # style 域（AI 供 CSS/动效，随图持久化）：建图可带 topology.style.css，同 setStyle 消毒口径
        style = (prev or {}).get("style") or {}
        t_style = topology.get("style")
        if isinstance(t_style, dict) and isinstance(t_style.get("css"), str):
            cleaned = re.sub(r"@import[^;]*;", "", t_style["css"])
            style = {"css": re.sub(r"url\s*\(", "_url_blocked(", cleaned)}
        map_obj = {
            "id": map_id,
            "name": attrs.get("name") or topology.get("name") or (prev or {}).get("name") or map_id,
            "rev": ((prev or {}).get("rev") or 0) + 1,
            "topology": topology, "layout": layout,
            "overlays": (prev or {}).get("overlays") or [],
            "style": style,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        }
        save_map(era_dir, map_obj)
        set_active_id(era_dir, map_id)
        touched = {"id": map_id, "rev": map_obj["rev"]}

    for m in ERA_PATCH_RE.finditer(content):
        attrs = parse_attrs(m.group(1))
        map_id = attrs.get("id") or get_active_id(era_dir)
        if not map_id:
            all_errors.append("era-patch 无目标地图（无 id 且无激活地图）")
            continue
        map_obj = load_map(era_dir, map_id)
        if map_obj is None:
            all_errors.append(f"era-patch 目标地图不存在: {map_id}")
            continue
        try:
            ops = json.loads(m.group(2))
        except ValueError as e:
            all_errors.append(f"era-patch({map_id}) JSON 解析失败: {e}")
            continue
        applied, errors = apply_ops(map_obj, ops, caps)
        all_errors.extend(errors)
        if applied > 0:
            map_obj["layout"] = layout_map(map_obj.get("topology") or {}, caps)
            all_errors.extend(map_obj["layout"]["errors"])
            map_obj["rev"] = (map_obj.get("rev") or 0) + 1
            map_obj["updatedAt"] = datetime.now(timezone.utc).isoformat()
            save_map(era_dir, map_obj)
            set_active_id(era_dir, map_id)
            touched = {"id": map_id, "rev": map_obj["rev"]}

    # ── <era-ui>：界面数据（存 ui/<id>.json 持久化；rev 演进同地图；组件渲染见 render_ui）──
    for m in ERA_UI_RE.finditer(content):
        attrs = parse_attrs(m.group(1))
        ui_id = attrs.get("id")
        if not ui_id:
            all_errors.append("era-ui 缺 id 属性")
            continue
        try:
            data = json.loads(m.group(2))
        except ValueError as e:
            all_errors.append(f"era-ui({ui_id}) JSON 解析失败: {e}")
            continue
        if isinstance(data, list):
            data = {"blocks": data}
        if not isinstance(data, dict) or not isinstance(data.get("blocks"), list):
            all_errors.append(f"era-ui({ui_id}) 缺 blocks 数组")
            continue
        prev_ui = load_ui(era_dir, ui_id)
        ui_obj = {
            "id": ui_id, "rev": ((prev_ui or {}).get("rev") or 0) + 1,
            "blocks": data["blocks"],
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        }
        save_ui(era_dir, ui_obj)
        touched = touched or {"id": ui_id, "rev": ui_obj["rev"], "kind": "ui"}

    if touched:
        regenerate_summary(era_dir, caps, enabled)
        # 落一份本次生效谱快照：--show 独立可视化/外部工具与在线渲染同谱（缓存数据非权威源，权威=三层 merge）
        try:
            _atomic_write(os.path.join(era_dir, "_caps_cache.json"), json.dumps(caps, ensure_ascii=False, indent=2))
        except OSError as e:
            print(f"[era_pipeline] 谱快照写入失败: {e}", file=sys.stderr)
    return touched, all_errors


# ============================================================
# CLI
# ============================================================


def run_job(job):
    action = job.get("action") or "process"
    caps = job.get("caps") or {}
    era_dir = job.get("eraDir")
    if action == "layout":
        # 纯函数：拓扑 → 布局，不落盘（独立测试/预览用）
        return {"ok": True, "layout": layout_map(job.get("topology") or {}, caps)}
    if not era_dir or not isinstance(era_dir, str):
        return {"ok": False, "errors": ["job 缺 eraDir"]}
    if action == "process":
        touched, errors = process_content(job.get("content") or "", era_dir, caps, job.get("enabled", True))
        return {"ok": True, "touched": touched, "errors": errors}
    if action == "regenerate":
        regenerate_summary(era_dir, caps, job.get("enabled", True))
        return {"ok": True}
    if action == "render_text":
        map_id = job.get("mapId") or get_active_id(era_dir)
        map_obj = load_map(era_dir, map_id) if map_id else None
        if map_obj is None:
            return {"ok": False, "errors": [f"地图不存在: {map_id}"]}
        return {"ok": True, "text": render_text(map_obj, caps, job.get("layer"))}
    if action == "render_ui":
        ui_obj = load_ui(era_dir, job.get("uiId"))
        if ui_obj is None:
            return {"ok": False, "errors": [f"UI 不存在: {job.get('uiId')}"]}
        return {"ok": True, "text": render_ui(ui_obj, caps)}
    if action == "export_html":
        map_id = job.get("mapId") or get_active_id(era_dir)
        map_obj = load_map(era_dir, map_id) if map_id else None
        if map_obj is None:
            return {"ok": False, "errors": [f"地图不存在: {map_id}"]}
        out_path = job.get("out") or os.path.join(era_dir, "export_" + urllib.parse.quote(str(map_id), safe=_URI_SAFE) + ".html")
        err = export_html(map_obj, caps, out_path)
        if err:
            return {"ok": False, "errors": [err]}
        return {"ok": True, "out": out_path}
    return {"ok": False, "errors": [f"未知 action: {action}"]}


# ============================================================
# 独立可视化导出（凛倾 0731「需要启动本体才可以运行=高耦合插件」）：
#   单文件自包含 HTML——数据+JS渲染器+CSS 全内嵌，双击即看彩色三层动效图，零本体零服务。
#   【过渡期耦合备注】渲染器/era.css 现住 beilu-chat 壳（跨 part 读取打包），
#   待迁 plugins/beilu-era/public/ 域后此处改读插件自身资产——迁家后本插件对壳零引用。
# ============================================================

_SHELL_RENDERER = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "public", "render", "eraRenderer.mjs"))
_SHELL_CSS = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "public", "css", "era.css"))


def export_html(map_obj, caps, out_path):
    """地图+谱+渲染器+CSS → 单文件 HTML。返回错误串或 None。"""
    try:
        renderer_src = io.open(_SHELL_RENDERER, encoding="utf-8").read()
        css_src = io.open(_SHELL_CSS, encoding="utf-8").read()
    except OSError as e:
        return f"渲染器/CSS 资产读取失败: {e}"
    # stub 壳依赖（sendAction 仅在线视图加载器用，独立文件零网络）
    renderer_src = renderer_src.replace(
        'import { sendAction } from "../transport/sendAction.mjs"',
        "const sendAction = async () => null")
    style_css = ((map_obj.get("style") or {}).get("css") or "")
    page = (
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>"
        + (map_obj.get("name") or map_obj.get("id") or "era")
        + "</title><style>body{background:#101218;color:#dfe3ea;font-family:system-ui;padding:16px}"
        + css_src + "\n/* AI 供图级样式（setStyle 持久化） */\n" + style_css
        + "</style></head><body><div id=\"stage\" class=\"era-block\"></div>"
        + "<script type=\"module\">\n"
        + renderer_src
        + "\nconst MAP = " + json.dumps(map_obj, ensure_ascii=False)
        + ";\nconst CAPS = " + json.dumps(caps or {}, ensure_ascii=False)
        + ";\ndocument.getElementById('stage').innerHTML = renderEraMap(MAP, CAPS);\n"
        + "</script></body></html>"
    )
    _atomic_write(out_path, page)
    return None


def main(argv):
    # --html <eraDir> [out.html]：独立导出单文件彩色查看器（双击即看，零本体零服务）
    if len(argv) >= 3 and argv[1] == "--html":
        era_dir = argv[2]
        map_id = get_active_id(era_dir)
        map_obj = load_map(era_dir, map_id) if map_id else None
        if map_obj is None:
            print(f"地图不存在: {map_id}", file=sys.stderr)
            return 1
        caps = _read_json(os.path.join(era_dir, "_caps_cache.json")) or {}
        out = argv[3] if len(argv) >= 4 else os.path.join(era_dir, "export_" + urllib.parse.quote(str(map_id), safe=_URI_SAFE) + ".html")
        err = export_html(map_obj, caps, out)
        if err:
            print(err, file=sys.stderr)
            return 1
        print(out)
        return 0
    # --show <eraDir> [mapId] [--layer map|char|dyn] [--caps caps.json]：
    # 独立运行可视化——直接把字符画打到终端（不出 JSON）。caps 缺省=读同目录 _caps_cache.json（若有）。
    if len(argv) >= 3 and argv[1] == "--show":
        rest = argv[3:]
        layer = None
        caps_path = None
        map_id = None
        i = 0
        while i < len(rest):
            if rest[i] == "--layer" and i + 1 < len(rest):
                layer = rest[i + 1]
                i += 2
            elif rest[i] == "--caps" and i + 1 < len(rest):
                caps_path = rest[i + 1]
                i += 2
            else:
                map_id = rest[i]
                i += 1
        map_id = map_id or get_active_id(argv[2])
        map_obj = load_map(argv[2], map_id) if map_id else None
        if map_obj is None:
            print(f"地图不存在: {map_id}", file=sys.stderr)
            return 1
        caps = {}
        for cand in ([caps_path] if caps_path else []) + [os.path.join(argv[2], "_caps_cache.json")]:
            data = _read_json(cand) if cand else None
            if isinstance(data, dict):
                caps = data
                break
        print(render_text(map_obj, caps, layer))
        return 0
    if len(argv) >= 2 and argv[1] == "--job":
        with io.open(argv[2], "r", encoding="utf-8") as fh:
            job = json.load(fh)
    else:
        job = json.loads(sys.stdin.read())
    result = run_job(job)
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception as e:  # 顶层护栏：任何未预期异常以 JSON 错误返回（调用方可解析，不裸 traceback）
        sys.stdout.write(json.dumps({"ok": False, "errors": [f"pipeline 异常: {e.__class__.__name__}: {e}"]}, ensure_ascii=False))
        sys.exit(1)
