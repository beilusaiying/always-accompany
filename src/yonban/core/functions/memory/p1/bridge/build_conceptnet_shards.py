"""Build bounded-memory ConceptNet lookup shards from the bundled JSON objects.

The source files are one-line JSON objects. Loading either with json.load/JSON.parse
expands hundreds of MB into a much larger resident object. This builder scans only
the top-level object, decodes one key/value pair at a time, and writes 256 JSONL
shards. Runtime then loads only the shards touched by current anchor words.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
from collections import OrderedDict
from pathlib import Path
from typing import BinaryIO, Iterator

FORMAT_VERSION = 1
SHARD_COUNT = 256
MAX_OPEN_FILES = 32


def _iter_top_level_pairs(path: Path) -> Iterator[bytes]:
    """Yield raw `"key": value` byte slices without materializing the root object."""
    started = False
    depth = 0
    in_string = False
    escaped = False
    pair = bytearray()

    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            for byte in chunk:
                if not started:
                    if byte in b" \t\r\n":
                        continue
                    if byte != ord("{"):
                        raise ValueError(f"{path.name}: expected top-level object")
                    started = True
                    depth = 1
                    continue

                if in_string:
                    pair.append(byte)
                    if escaped:
                        escaped = False
                    elif byte == ord("\\"):
                        escaped = True
                    elif byte == ord('"'):
                        in_string = False
                    continue

                if byte == ord('"'):
                    in_string = True
                    pair.append(byte)
                elif byte in (ord("["), ord("{")):
                    depth += 1
                    pair.append(byte)
                elif byte == ord("}") and depth == 1:
                    if pair.strip():
                        yield bytes(pair)
                    return
                elif byte in (ord("]"), ord("}")):
                    depth -= 1
                    if depth < 1:
                        raise ValueError(f"{path.name}: malformed nesting")
                    pair.append(byte)
                elif byte == ord(",") and depth == 1:
                    if pair.strip():
                        yield bytes(pair)
                    pair.clear()
                else:
                    pair.append(byte)

    raise ValueError(f"{path.name}: unterminated top-level object")


class _ShardWriters:
    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.handles: OrderedDict[str, BinaryIO] = OrderedDict()

    def write(self, shard: str, payload: bytes) -> None:
        handle = self.handles.pop(shard, None)
        if handle is None:
            if len(self.handles) >= MAX_OPEN_FILES:
                _, old = self.handles.popitem(last=False)
                old.close()
            handle = (self.directory / f"{shard}.jsonl").open("ab")
        self.handles[shard] = handle
        handle.write(payload)
        handle.write(b"\n")

    def close(self) -> None:
        for handle in self.handles.values():
            handle.close()
        self.handles.clear()


# [0804 根因修·B8] freshness 从 mtimeNs 改内容 hash（与 DomainWords v2 同病：复制/发布安装改 mtime
#   → shards stale → warmup fail）。sourceSha256 跨复制稳定；旧 manifest（无 sourceSha256）在
#   _record_matches 因 record.get() 返 None 不匹配而触发重建，自愈。size 保留为廉价预筛，hash 权威。
def _source_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _source_record(path: Path) -> dict[str, int | str]:
    stat = path.stat()
    return {"file": path.name, "size": stat.st_size, "sourceSha256": _source_sha256(path), "sourceFingerprintVersion": 2}


def _record_matches(record: dict | None, source: Path, root: Path) -> bool:
    if not record:
        return False
    expected = _source_record(source)
    directory = root / str(record.get("dir") or "")
    return (
        record.get("file") == expected["file"]
        and record.get("size") == expected["size"]
        and record.get("sourceSha256") == expected["sourceSha256"]
        and record.get("sourceFingerprintVersion") == 2
        and directory.is_dir()
    )


def _build_language(lang: str, source: Path, root: Path) -> dict:
    _rec = _source_record(source)
    # 目录名内容寻址（用 hash 短码，跨复制稳定；不再用 mtime）
    stem = f"{lang}_{_rec['size']}_{_rec['sourceSha256'][:16]}"
    final_dir = root / stem
    if final_dir.exists():
        final_dir = root / f"{stem}_{int(time.time())}_{os.getpid()}"
    temp_dir = root / f".{final_dir.name}.building.{os.getpid()}.{time.time_ns()}"
    temp_dir.mkdir(parents=True, exist_ok=False)

    writers = _ShardWriters(temp_dir)
    count = 0
    started = time.time()
    try:
        for raw_pair in _iter_top_level_pairs(source):
            item = json.loads(b"{" + raw_pair + b"}")
            if len(item) != 1:
                raise ValueError(f"{source.name}: top-level pair decoded to {len(item)} keys")
            key, edges = next(iter(item.items()))
            shard = hashlib.sha256(key.encode("utf-8")).hexdigest()[:2]
            line = json.dumps([key, edges], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            writers.write(shard, line)
            count += 1
            if count % 50000 == 0:
                print(f"[conceptnet-shards] {lang}: {count} keys", flush=True)
    finally:
        writers.close()

    os.replace(temp_dir, final_dir)
    elapsed = round(time.time() - started, 2)
    return {
        **_source_record(source),
        "dir": final_dir.name,
        "entries": count,
        "shards": SHARD_COUNT,
        "format": "jsonl-pairs-v1",
        "buildSeconds": elapsed,
    }


def build(derived: Path) -> dict:
    root = derived / "conceptnet_shards"
    root.mkdir(parents=True, exist_ok=True)
    manifest_path = root / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        manifest = {"version": FORMAT_VERSION, "languages": {}}
    if manifest.get("version") != FORMAT_VERSION:
        manifest = {"version": FORMAT_VERSION, "languages": {}}

    languages = dict(manifest.get("languages") or {})
    changed = False
    for lang in ("zh", "en"):
        source = derived / f"conceptnet_{lang}.json"
        if not source.is_file():
            raise FileNotFoundError(source)
        if _record_matches(languages.get(lang), source, root):
            print(f"[conceptnet-shards] {lang}: current ({languages[lang]['entries']} keys)", flush=True)
            continue
        languages[lang] = _build_language(lang, source, root)
        changed = True
        print(
            f"[conceptnet-shards] {lang}: built {languages[lang]['entries']} keys "
            f"in {languages[lang]['buildSeconds']}s",
            flush=True,
        )

    result = {"version": FORMAT_VERSION, "shardCount": SHARD_COUNT, "languages": languages}
    if changed or not manifest_path.exists():
        temp_manifest = root / f".manifest.{os.getpid()}.tmp"
        temp_manifest.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temp_manifest, manifest_path)
    return result


def main() -> None:
    default_derived = Path(os.environ.get("P1_RESOURCE_DIR") or (Path(__file__).resolve().parent.parent / "resources")) / "p1v2_derived"
    parser = argparse.ArgumentParser(description="Build low-memory ConceptNet lookup shards")
    parser.add_argument("--derived", type=Path, default=default_derived)
    args = parser.parse_args()
    result = build(args.derived.resolve())
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
