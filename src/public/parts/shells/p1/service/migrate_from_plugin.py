"""migrate_from_plugin.py — 一次性迁移：旧 Deno 插件的配置与用户词库 → P1 独立服务自持数据。

功能链：
    python migrate_from_plugin.py [--plugin-dir <path>] [--dry]
    读 data/plugins/beilu-p1-selfdriven/{config.json, vocab/*.json}
    → 写 service/data/config.json（只带 DEFAULTS 已知键，layerWeight* 等新键保默认）
    → 拷 vocab/*.json 到 config.vocabDir（默认 service/data/vocab/）

why 独立脚本而非启动时自动读旧目录：读旧插件目录若做成运行行为=对本体目录约定的依赖
    （002 0731"除了前端需要依赖,其他如果需要依赖那么就是高耦合"）；迁移是一次性部署动作。
影响范围：只写 service/data/，只读旧插件目录；不删除旧数据（002 域，删除动作留给 002）。
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from p1_config import DEFAULTS, DATA_DIR, CONFIG_FILE, update_config

SERVICE_DIR = Path(__file__).resolve().parent
_REPO_ROOT = SERVICE_DIR.parents[5]
DEFAULT_PLUGIN_DIR = _REPO_ROOT / "data" / "plugins" / "beilu-p1-selfdriven"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plugin-dir", default=str(DEFAULT_PLUGIN_DIR))
    parser.add_argument("--dry", action="store_true", help="只打印将迁移的内容不落盘")
    args = parser.parse_args()
    plugin_dir = Path(args.plugin_dir)

    # 1. 配置：只带已知键（idleUnloadMinutes 等插件宿主生命周期键不适用独立服务，弃）
    old_cfg_file = plugin_dir / "config.json"
    picked: dict = {}
    if old_cfg_file.exists():
        old = json.loads(old_cfg_file.read_text(encoding="utf-8"))
        picked = {k: v for k, v in old.items() if k in DEFAULTS}
        print(f"[config] 旧配置 {len(old)} 键 → 带入 {len(picked)} 键: {sorted(picked)}")
    else:
        print(f"[config] 旧配置不存在 ({old_cfg_file})，全默认")

    # 2. 用户词库
    old_vocab = plugin_dir / "vocab"
    vocab_files = sorted(old_vocab.glob("*.json")) if old_vocab.exists() else []
    print(f"[vocab] 待迁移 {len(vocab_files)} 个: {[p.name for p in vocab_files]}")

    if args.dry:
        print("[dry] 未写任何文件")
        return

    cfg = update_config(picked)  # 写 service/data/config.json（含钳制）
    dst_vocab = Path(cfg["vocabDir"])
    dst_vocab.mkdir(parents=True, exist_ok=True)
    for p in vocab_files:
        dst = dst_vocab / p.name
        if dst.exists():
            print(f"[vocab] 跳过已存在: {p.name}")
            continue
        shutil.copy2(p, dst)
        print(f"[vocab] 拷入: {p.name}")
    print(f"[done] config → {CONFIG_FILE}\n[done] vocab  → {dst_vocab}\n旧插件数据未删除（删除留给 002 决定）")


if __name__ == "__main__":
    main()
