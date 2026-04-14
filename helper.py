#!/usr/bin/env python3
"""Privilege-dropping helper.

Invoked by app.py (running as root) with --user/--uid/--gid/--home + a sub-command.
Drops to the target user's identity before touching the filesystem, so the kernel
enforces access control. Also validates paths stay under HOME for a sane UI.

Output convention:
    JSON ops  → one JSON object/array on stdout, exit 0
    Stream ops (read_stream, write_stream) → binary on stdout / stdin, exit 0
    Error     → JSON {"error": "..."} on stderr, exit 1
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import stat
import sys
import time
from pathlib import Path


def die(msg: str, code: int = 1) -> None:
    sys.stderr.write(json.dumps({"error": msg}))
    sys.stderr.flush()
    sys.exit(code)


def drop_privileges(user: str, uid: int, gid: int, home: str) -> None:
    if os.geteuid() == 0:
        try:
            os.setgroups([])
            os.initgroups(user, gid)
            os.setgid(gid)
            os.setuid(uid)
        except OSError as e:
            die(f"setuid failed: {e}")
        if os.getuid() != uid or os.geteuid() != uid:
            die("setuid assertion failed")
    elif os.geteuid() != uid:
        die(f"helper not root and running as uid={os.geteuid()} (expected {uid})")
    try:
        os.chdir(home)
    except OSError as e:
        die(f"chdir home failed: {e}")
    os.umask(0o022)


def safe_resolve(home: Path, relpath: str) -> Path:
    """Resolve a user-supplied relative path under HOME. Reject escapes + symlink escapes."""
    relpath = relpath.lstrip("/")
    candidate = (home / relpath) if relpath else home
    try:
        resolved = candidate.resolve(strict=False)
    except (OSError, RuntimeError) as e:
        die(f"resolve failed: {e}")
    home_resolved = home.resolve(strict=False)
    if resolved != home_resolved and home_resolved not in resolved.parents:
        die("path escapes home")
    return resolved


def entry_info(p: Path, name: str | None = None) -> dict:
    try:
        st = p.lstat()
    except OSError as e:
        return {"name": name or p.name, "error": str(e)}
    is_link = stat.S_ISLNK(st.st_mode)
    if is_link:
        try:
            tgt_st = p.stat()
            kind = "dir" if stat.S_ISDIR(tgt_st.st_mode) else "file"
            size = tgt_st.st_size
        except OSError:
            kind = "broken_symlink"
            size = 0
    else:
        if stat.S_ISDIR(st.st_mode):
            kind, size = "dir", 0
        elif stat.S_ISREG(st.st_mode):
            kind, size = "file", st.st_size
        else:
            kind, size = "other", 0
    return {
        "name": name or p.name,
        "type": kind,
        "size": size,
        "mtime": int(st.st_mtime),
        "mode": stat.S_IMODE(st.st_mode),
        "is_symlink": is_link,
    }


def op_list(home: Path, relpath: str) -> None:
    p = safe_resolve(home, relpath)
    if not p.is_dir():
        die("not a directory")
    is_home_root = (p.resolve() == home.resolve())
    items: list[dict] = []
    try:
        with os.scandir(p) as it:
            for de in it:
                # 家目录根的 .filemgr-trash 不在普通浏览里显示，走专门的回收站 UI
                if is_home_root and de.name == TRASH_DIR_NAME:
                    continue
                items.append(entry_info(Path(de.path), name=de.name))
    except PermissionError as e:
        die(f"permission denied: {e}")
    items.sort(key=lambda x: (x.get("type") != "dir", x.get("name", "").lower()))
    sys.stdout.write(json.dumps(items))


def op_stat(home: Path, relpath: str) -> None:
    p = safe_resolve(home, relpath)
    if not p.exists():
        die("not found")
    sys.stdout.write(json.dumps(entry_info(p)))


def op_dirsize(home: Path, relpath: str, max_files: int, timeout: float) -> None:
    p = safe_resolve(home, relpath)
    if not p.is_dir():
        die("not a directory")
    total = 0
    count = 0
    truncated = False
    deadline = time.monotonic() + timeout
    stack = [str(p)]
    while stack:
        if time.monotonic() > deadline or count >= max_files:
            truncated = True
            break
        cur = stack.pop()
        try:
            with os.scandir(cur) as it:
                for de in it:
                    try:
                        st = de.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    if stat.S_ISDIR(st.st_mode):
                        if de.name == TRASH_DIR_NAME:
                            continue
                        stack.append(de.path)
                    elif stat.S_ISREG(st.st_mode):
                        total += st.st_size
                        count += 1
                        if count >= max_files:
                            truncated = True
                            break
        except (PermissionError, FileNotFoundError):
            continue
    sys.stdout.write(json.dumps({
        "size_bytes": total, "file_count": count, "truncated": truncated
    }))


def op_mkdir(home: Path, relpath: str) -> None:
    p = safe_resolve(home, relpath)
    if p == home.resolve():
        die("cannot mkdir home")
    try:
        p.mkdir(parents=False, exist_ok=False)
    except FileExistsError:
        die("already exists")
    except OSError as e:
        die(f"mkdir failed: {e}")
    sys.stdout.write(json.dumps({"ok": True}))


def op_rename(home: Path, src_rel: str, dst_rel: str) -> None:
    src = safe_resolve(home, src_rel)
    dst = safe_resolve(home, dst_rel)
    home_r = home.resolve()
    if src == home_r or dst == home_r:
        die("refusing to touch home itself")
    if not src.exists():
        die("source not found")
    if dst.exists():
        die("destination exists")
    try:
        os.rename(src, dst)
    except OSError as e:
        die(f"rename failed: {e}")
    sys.stdout.write(json.dumps({"ok": True}))


TRASH_DIR_NAME = ".filemgr-trash"


def _ensure_trash(home: Path) -> tuple[Path, Path]:
    trash = home / TRASH_DIR_NAME
    meta_dir = trash / ".meta"
    trash.mkdir(mode=0o700, exist_ok=True)
    meta_dir.mkdir(mode=0o700, exist_ok=True)
    return trash, meta_dir


def _purge_expired_trash(home: Path, retention_days: float) -> int:
    """尽力清掉超过 retention_days 的回收站条目；返回清掉的条目数。失败静默忽略。"""
    if retention_days <= 0:
        return 0
    trash = home / TRASH_DIR_NAME
    meta_dir = trash / ".meta"
    if not meta_dir.is_dir():
        return 0
    cutoff = time.time() - retention_days * 86400
    purged = 0
    for f in list(meta_dir.iterdir()):
        if f.suffix != ".json":
            continue
        try:
            m = json.loads(f.read_text())
        except (OSError, json.JSONDecodeError):
            # 坏 meta 直接删
            try: f.unlink()
            except OSError: pass
            continue
        if m.get("deleted_at", 0) > cutoff:
            continue
        entry = trash / m.get("entry_name", "")
        try:
            if entry.is_dir() and not entry.is_symlink():
                shutil.rmtree(entry)
            elif entry.exists() or entry.is_symlink():
                entry.unlink()
        except OSError:
            continue
        try: f.unlink()
        except OSError: pass
        purged += 1
    return purged


def op_delete(home: Path, relpath: str, permanent: bool = False,
              retention_days: float = 0.0) -> None:
    p = safe_resolve(home, relpath)
    if p == home.resolve():
        die("refusing to delete home")
    if not p.exists() and not p.is_symlink():
        die("not found")
    # 顺手清掉过期的回收站条目
    if retention_days > 0:
        _purge_expired_trash(home, retention_days)
    # 不允许把 trash 自己软删除（否则下次查 meta 会找不到）；permanent 清空整个 trash 另走 empty
    trash_root = (home / TRASH_DIR_NAME).resolve()
    try:
        if p == trash_root or trash_root in p.parents:
            # 在回收站内部的东西，走永久删除逻辑
            permanent = True
    except Exception:
        pass
    if permanent:
        try:
            if p.is_dir() and not p.is_symlink():
                shutil.rmtree(p)
            else:
                p.unlink()
        except OSError as e:
            die(f"delete failed: {e}")
        sys.stdout.write(json.dumps({"ok": True, "permanent": True}))
        return
    # 软删除：rename 到 ~/.filemgr-trash/{entry_id}__{basename}
    trash, meta_dir = _ensure_trash(home)
    import secrets as _s
    entry_id = f"{int(time.time()*1000)}-{_s.token_hex(4)}"
    # basename 里 / 不应该出现，但防御性替换
    safe_name = p.name.replace("/", "_")
    entry_name = f"{entry_id}__{safe_name}"
    dst = trash / entry_name
    try:
        p.rename(dst)
    except OSError as e:
        die(f"delete failed: {e}")
    # 原始路径相对 home 保存
    home_resolved = home.resolve()
    try:
        original_rel = "/" + str(p.relative_to(home_resolved).as_posix())
    except ValueError:
        original_rel = relpath
    is_dir = dst.is_dir() and not dst.is_symlink()
    meta = {
        "entry_id": entry_id,
        "entry_name": entry_name,
        "original_path": original_rel,
        "original_name": p.name,
        "deleted_at": int(time.time()),
        "is_dir": is_dir,
    }
    try:
        if dst.is_file():
            meta["size"] = dst.stat().st_size
        (meta_dir / f"{entry_id}.json").write_text(json.dumps(meta))
    except OSError:
        pass
    sys.stdout.write(json.dumps({"ok": True, "permanent": False, **meta}))


def op_trash_list(home: Path, retention_days: float = 0.0) -> None:
    # 打开回收站时先清一轮过期项
    if retention_days > 0:
        _purge_expired_trash(home, retention_days)
    trash = home / TRASH_DIR_NAME
    meta_dir = trash / ".meta"
    items: list[dict] = []
    if meta_dir.is_dir():
        for f in meta_dir.iterdir():
            if f.suffix != ".json":
                continue
            try:
                m = json.loads(f.read_text())
                entry = trash / m.get("entry_name", "")
                if not entry.exists():
                    # 元数据孤儿，清掉
                    f.unlink(missing_ok=True)
                    continue
                # 补充实时 size（目录需要递归）
                if m.get("is_dir"):
                    total = 0
                    for root_, _d, files in os.walk(entry):
                        for nm in files:
                            try:
                                total += os.stat(os.path.join(root_, nm)).st_size
                            except OSError:
                                pass
                    m["size"] = total
                items.append(m)
            except (OSError, json.JSONDecodeError):
                continue
    items.sort(key=lambda m: m.get("deleted_at", 0), reverse=True)
    sys.stdout.write(json.dumps({"items": items}))


def op_trash_restore(home: Path, entry_id: str, dst_relpath: str) -> None:
    trash = home / TRASH_DIR_NAME
    meta_dir = trash / ".meta"
    meta_file = meta_dir / f"{entry_id}.json"
    if not meta_file.exists():
        die("trash entry not found")
    try:
        meta = json.loads(meta_file.read_text())
    except (OSError, json.JSONDecodeError) as e:
        die(f"bad meta: {e}")
    src = trash / meta.get("entry_name", "")
    if not src.exists():
        die("trash file missing")
    dst = safe_resolve(home, dst_relpath)
    if dst.exists():
        die("target exists")
    parent = dst.parent
    if not parent.is_dir():
        die("target parent missing")
    try:
        src.rename(dst)
        meta_file.unlink(missing_ok=True)
    except OSError as e:
        die(f"restore failed: {e}")
    sys.stdout.write(json.dumps({"ok": True, "restored_to": dst_relpath}))


def op_trash_purge(home: Path, entry_id: str = "") -> None:
    trash = home / TRASH_DIR_NAME
    meta_dir = trash / ".meta"
    if entry_id:
        meta_file = meta_dir / f"{entry_id}.json"
        if not meta_file.exists():
            die("trash entry not found")
        try:
            meta = json.loads(meta_file.read_text())
        except (OSError, json.JSONDecodeError) as e:
            die(f"bad meta: {e}")
        target = trash / meta.get("entry_name", "")
        try:
            if target.is_dir() and not target.is_symlink():
                shutil.rmtree(target)
            elif target.exists() or target.is_symlink():
                target.unlink()
            meta_file.unlink(missing_ok=True)
        except OSError as e:
            die(f"purge failed: {e}")
        sys.stdout.write(json.dumps({"ok": True, "entry_id": entry_id}))
    else:
        # 清空整个回收站
        if trash.is_dir():
            try:
                shutil.rmtree(trash)
            except OSError as e:
                die(f"empty trash failed: {e}")
        sys.stdout.write(json.dumps({"ok": True, "emptied": True}))


def op_read_stream(home: Path, relpath: str, offset: int, length: int,
                   gunzip: bool = False) -> None:
    p = safe_resolve(home, relpath)
    if not p.is_file():
        die("not a regular file")
    try:
        if gunzip:
            import gzip as _gz
            f = _gz.open(p, "rb")
        else:
            f = open(p, "rb")
        with f:
            if offset:
                if gunzip:
                    # gzip 流不支持 seek；用读后丢弃替代
                    to_skip = offset
                    while to_skip > 0:
                        d = f.read(min(to_skip, 1 << 20))
                        if not d:
                            break
                        to_skip -= len(d)
                else:
                    f.seek(offset)
            out = sys.stdout.buffer
            remaining = length if length > 0 else None
            chunk = 1024 * 1024
            while True:
                n = chunk if remaining is None else min(chunk, remaining)
                if n <= 0:
                    break
                buf = f.read(n)
                if not buf:
                    break
                out.write(buf)
                if remaining is not None:
                    remaining -= len(buf)
            out.flush()
    except OSError as e:
        die(f"read failed: {e}")


_BOUNDARY_CHARS = frozenset("._-/ ")

_TYPE_EXTS = {
    "image":    frozenset(("png","jpg","jpeg","gif","webp","svg","bmp","tiff","ico","heic","heif","avif")),
    "video":    frozenset(("mp4","mkv","mov","avi","webm","m4v","flv","wmv","ts")),
    "audio":    frozenset(("mp3","wav","flac","ogg","m4a","aac","opus","wma")),
    "pdf":      frozenset(("pdf",)),
    # 注意：纯压缩扩展 .gz/.bz2/.xz/.zst 不放进 archive，避免压掉 .fastq.gz 等复合名；
    # 纯压缩文件（无内层扩展）会在 categorize() 里 fallback 到 archive。
    "archive":  frozenset(("zip","tar","tgz","tbz","txz","rar","7z","lz4")),
    "code":     frozenset(("py","js","ts","tsx","jsx","go","rs","c","cpp","h","hpp","sh",
                           "r","java","html","css","sql","rb","php","swift","kt","scala","lua","pl","vb","m","mm",
                           "nf","wdl","smk","snakefile","rmd","qmd","ipynb")),
    "document": frozenset(("doc","docx","xls","xlsx","ppt","pptx","odt","ods","odp","rtf")),
    "text":     frozenset(("txt","md","log","csv","tsv","json","yaml","yml","xml","ini","conf","toml","rst","org","tex")),
    # ---- 生信专用 ----
    "sequencing": frozenset(("fastq","fq","sam","bam","cram","bai","crai")),
    "variants":   frozenset(("vcf","bcf","tbi","csi")),
    "reference":  frozenset(("fa","fasta","fna","faa","ffn","fai",
                             "gff","gff3","gtf",
                             "bed","bedgraph","wig","bigwig","bw","2bit","chain")),
    "matrix":     frozenset(("h5","h5ad","loom","mtx","h5mu","zarr","anndata")),
    "rdata":      frozenset(("rds","rdata","rda")),
    "notebook":   frozenset(("ipynb","qmd","rmd")),
    "container":  frozenset(("sif","img","sqsh","simg")),
}
# 后加的生信 notebook 类占优，需要把 ipynb/qmd/rmd 从 code 里去掉
_EXT_TO_CAT: dict[str, str] = {}
_CAT_PRIORITY = (  # 冲突时靠后的优先（生信类别压倒通用类别）
    "image", "video", "audio", "pdf", "archive", "document", "text", "code",
    "container", "rdata", "matrix", "reference", "variants", "sequencing", "notebook",
)
for _cat in _CAT_PRIORITY:
    for _ext in _TYPE_EXTS.get(_cat, ()):
        _EXT_TO_CAT[_ext] = _cat

_COMPRESSION_EXTS = ("gz", "bgz", "bz2", "xz", "zst")


def categorize(name: str) -> str:
    """给文件名分类。正确处理 .fastq.gz / .vcf.gz / .tar.gz / chrom.sizes 等。"""
    lower = name.lower()
    stem = lower
    comp = ""
    for zx in _COMPRESSION_EXTS:
        if stem.endswith("." + zx):
            stem = stem[: -(len(zx) + 1)]
            comp = zx
            break
    # 双段后缀
    if stem.endswith(".chrom.sizes"):
        return "reference"
    if stem.endswith(".tar"):
        return "archive"
    dot = stem.rfind(".")
    ext = stem[dot + 1:] if dot > 0 else ""
    cat = _EXT_TO_CAT.get(ext)
    if cat:
        return cat
    if comp:
        return "archive"
    return "other"


def fuzzy_score(query: str, name: str) -> tuple[int, list[int]] | None:
    """VS Code 风格子序列打分。返回 (score, match_positions) 或 None。

    - 行首 / 分隔符后 / CamelCase 边界的命中加分
    - 连续命中额外加分，跳字符有惩罚
    - 名字越短加分
    """
    if not query:
        return None
    q = query.lower()
    n = name.lower()
    # 快速拒绝：name 缺 query 的任一字符 → 不可能匹配
    n_set = set(n)
    for c in q:
        if c not in n_set:
            return None
    positions: list[int] = []
    qi = 0
    prev = -2
    score = 0
    ql = len(q)
    for i, nc in enumerate(n):
        if qi >= ql:
            break
        if nc != q[qi]:
            continue
        # 位置加分（开头 / 分隔符后 / CamelCase 边界）
        if i == 0:
            score += 14
        elif n[i - 1] in _BOUNDARY_CHARS:
            score += 9
        elif name[i - 1].islower() and name[i].isupper():
            score += 7
        # 连续/跳字符加减分——只在已有上一次命中时才考虑
        if prev >= 0:
            if i == prev + 1:
                score += 10    # 连续命中最重要：保证子串整匹配胜过零散匹配
            else:
                score -= 3     # 间隔小惩罚
        positions.append(i)
        prev = i
        qi += 1
    if qi < ql:
        return None
    score -= len(name) // 10
    return score, positions


def op_stats(home: Path, relpath: str, top_n: int, recent_days: int,
             max_files: int, timeout: float) -> None:
    import heapq
    start = safe_resolve(home, relpath)
    if not start.is_dir():
        die("not a directory")
    home_abs = str(home.resolve())
    by_type: dict[str, dict[str, int]] = {c: {"size": 0, "count": 0}
                                          for c in list(_TYPE_EXTS) + ["other"]}
    total_size = 0
    file_count = 0
    dir_count = 0
    recent_count = 0
    now = time.time()
    recent_threshold = now - recent_days * 86400
    top_heap: list[tuple[int, int, str]] = []     # (size, mtime, rel) — min-heap
    recent_heap: list[tuple[int, int, str]] = []  # (mtime, size, rel)
    deadline = time.monotonic() + timeout
    truncated = False
    stack = [str(start)]
    scanned = 0
    home_abs_len = len(home_abs)
    while stack:
        if scanned % 2000 == 0 and time.monotonic() > deadline:
            truncated = True
            break
        cur = stack.pop()
        try:
            with os.scandir(cur) as it:
                for de in it:
                    scanned += 1
                    if scanned > max_files:
                        truncated = True
                        break
                    try:
                        st = de.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    if stat.S_ISDIR(st.st_mode):
                        if de.name == TRASH_DIR_NAME:
                            continue
                        dir_count += 1
                        stack.append(de.path)
                        continue
                    if not stat.S_ISREG(st.st_mode):
                        continue
                    file_count += 1
                    size = st.st_size
                    total_size += size
                    cat = categorize(de.name)
                    bucket = by_type.setdefault(cat, {"size": 0, "count": 0})
                    bucket["size"] += size
                    bucket["count"] += 1
                    mt = int(st.st_mtime)
                    if mt > recent_threshold:
                        recent_count += 1
                    # top-N largest & most-recent：用 min-heap 保持 O(N log k)
                    if len(top_heap) < top_n or size > top_heap[0][0]:
                        full = de.path
                        if full.startswith(home_abs):
                            rel = full[home_abs_len:] or "/"
                            if not rel.startswith("/"):
                                rel = "/" + rel
                            entry = (size, mt, rel)
                            if len(top_heap) < top_n:
                                heapq.heappush(top_heap, entry)
                            else:
                                heapq.heapreplace(top_heap, entry)
                    if len(recent_heap) < top_n or mt > recent_heap[0][0]:
                        full = de.path
                        if full.startswith(home_abs):
                            rel = full[home_abs_len:] or "/"
                            if not rel.startswith("/"):
                                rel = "/" + rel
                            entry2 = (mt, size, rel)
                            if len(recent_heap) < top_n:
                                heapq.heappush(recent_heap, entry2)
                            else:
                                heapq.heapreplace(recent_heap, entry2)
                if scanned > max_files:
                    break
        except (PermissionError, FileNotFoundError):
            continue
    top_files = [{"path": p, "size": s, "mtime": m}
                 for s, m, p in sorted(top_heap, reverse=True)]
    recent_files = [{"path": p, "size": s, "mtime": m}
                    for m, s, p in sorted(recent_heap, reverse=True)]
    sys.stdout.write(json.dumps({
        "total_size": total_size,
        "file_count": file_count,
        "dir_count": dir_count,
        "recent_count": recent_count,
        "recent_days": recent_days,
        "scanned": scanned,
        "by_type": by_type,
        "top_files": top_files,
        "recent_files": recent_files,
        "truncated": truncated,
        "generated_at": int(now),
    }))


def op_top_by_type(home: Path, relpath: str, category: str, top_n: int,
                   max_files: int, timeout: float) -> None:
    import heapq
    start = safe_resolve(home, relpath)
    if not start.is_dir():
        die("not a directory")
    home_abs = str(home.resolve())
    home_abs_len = len(home_abs)
    heap: list[tuple[int, int, str]] = []
    deadline = time.monotonic() + timeout
    truncated = False
    stack = [str(start)]
    scanned = 0
    matched = 0
    while stack:
        if scanned % 2000 == 0 and time.monotonic() > deadline:
            truncated = True
            break
        cur = stack.pop()
        try:
            with os.scandir(cur) as it:
                for de in it:
                    scanned += 1
                    if scanned > max_files:
                        truncated = True
                        break
                    try:
                        st = de.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    if stat.S_ISDIR(st.st_mode):
                        if de.name == TRASH_DIR_NAME:
                            continue
                        stack.append(de.path)
                        continue
                    if not stat.S_ISREG(st.st_mode):
                        continue
                    if categorize(de.name) != category:
                        continue
                    matched += 1
                    size = st.st_size
                    mt = int(st.st_mtime)
                    if len(heap) < top_n or size > heap[0][0]:
                        full = de.path
                        if full.startswith(home_abs):
                            rel = full[home_abs_len:] or "/"
                            if not rel.startswith("/"):
                                rel = "/" + rel
                            entry = (size, mt, rel)
                            if len(heap) < top_n:
                                heapq.heappush(heap, entry)
                            else:
                                heapq.heapreplace(heap, entry)
                if scanned > max_files:
                    break
        except (PermissionError, FileNotFoundError):
            continue
    items = [{"path": p, "size": s, "mtime": m}
             for s, m, p in sorted(heap, reverse=True)]
    sys.stdout.write(json.dumps({
        "category": category,
        "items": items,
        "matched": matched,
        "scanned": scanned,
        "truncated": truncated,
    }))


def op_search(home: Path, relpath: str, query: str, max_n: int,
              timeout: float, include_dirs: bool) -> None:
    start = safe_resolve(home, relpath)
    if not start.is_dir():
        die("not a directory")
    if not query:
        die("empty query")
    home_abs = str(home.resolve())
    results: list[dict] = []
    truncated = False
    deadline = time.monotonic() + timeout
    stack = [str(start)]
    scanned = 0
    while stack:
        # 每 2000 条检查一次时间，别每次 entry 都 monotonic()
        if scanned % 2000 == 0 and time.monotonic() > deadline:
            truncated = True
            break
        cur = stack.pop()
        try:
            with os.scandir(cur) as it:
                for de in it:
                    scanned += 1
                    try:
                        st = de.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    is_dir = stat.S_ISDIR(st.st_mode)
                    is_file = stat.S_ISREG(st.st_mode)
                    if is_dir:
                        if de.name == TRASH_DIR_NAME:
                            continue
                        stack.append(de.path)
                    if is_dir and not include_dirs:
                        continue
                    m = fuzzy_score(query, de.name)
                    if m is None:
                        continue
                    score, positions = m
                    full = de.path
                    if not full.startswith(home_abs):
                        continue
                    rel = full[len(home_abs):] or "/"
                    if not rel.startswith("/"):
                        rel = "/" + rel
                    kind = "dir" if is_dir else ("file" if is_file else "other")
                    results.append({
                        "name": de.name,
                        "path": rel,
                        "type": kind,
                        "size": 0 if is_dir else st.st_size,
                        "mtime": int(st.st_mtime),
                        "score": score,
                        "match": positions,
                    })
        except (PermissionError, FileNotFoundError):
            continue
    # 按分数降序；同分按名字长度升序（更短 = 更具体）
    results.sort(key=lambda r: (-r["score"], len(r["name"])))
    if len(results) > max_n:
        results = results[:max_n]
        truncated = True
    sys.stdout.write(json.dumps({"matches": results, "truncated": truncated}))


def op_write_stream(home: Path, relpath: str, overwrite: bool) -> None:
    p = safe_resolve(home, relpath)
    if p == home.resolve():
        die("cannot write home")
    parent = p.parent
    if not parent.is_dir():
        die("parent directory missing")
    if p.exists() and not overwrite:
        die("already exists")
    tmp = parent / f".{p.name}.part.{os.getpid()}"
    total = 0
    try:
        with open(tmp, "wb") as f:
            chunk = 1024 * 1024
            src = sys.stdin.buffer
            while True:
                buf = src.read(chunk)
                if not buf:
                    break
                f.write(buf)
                total += len(buf)
            f.flush()
            os.fsync(f.fileno())
        os.rename(tmp, p)
    except OSError as e:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        die(f"write failed: {e}")
    sys.stdout.write(json.dumps({"ok": True, "size": total}))


def main() -> None:
    ap = argparse.ArgumentParser(allow_abbrev=False)
    ap.add_argument("--user", required=True)
    ap.add_argument("--uid", required=True, type=int)
    ap.add_argument("--gid", required=True, type=int)
    ap.add_argument("--home", required=True)
    sub = ap.add_subparsers(dest="cmd", required=True)

    for name in ("list", "stat", "mkdir"):
        s = sub.add_parser(name)
        s.add_argument("path")

    s = sub.add_parser("delete")
    s.add_argument("path")
    s.add_argument("--permanent", action="store_true")
    s.add_argument("--retention-days", type=float, default=0.0)

    s = sub.add_parser("trash_list")
    s.add_argument("--retention-days", type=float, default=0.0)

    s = sub.add_parser("trash_restore")
    s.add_argument("entry_id")
    s.add_argument("dst")
    s = sub.add_parser("trash_purge")
    s.add_argument("--entry-id", dest="entry_id", default="")

    s = sub.add_parser("dirsize")
    s.add_argument("path")
    s.add_argument("--max-files", type=int, default=100_000)
    s.add_argument("--timeout", type=float, default=30.0)

    s = sub.add_parser("rename")
    s.add_argument("src")
    s.add_argument("dst")

    s = sub.add_parser("read_stream")
    s.add_argument("path")
    s.add_argument("--offset", type=int, default=0)
    s.add_argument("--length", type=int, default=0)
    s.add_argument("--gunzip", action="store_true")

    s = sub.add_parser("write_stream")
    s.add_argument("path")
    s.add_argument("--overwrite", action="store_true")

    s = sub.add_parser("search")
    s.add_argument("path")
    s.add_argument("query")
    s.add_argument("--max", dest="max_n", type=int, default=300)
    s.add_argument("--timeout", type=float, default=5.0)
    s.add_argument("--include-dirs", action="store_true")

    s = sub.add_parser("stats")
    s.add_argument("path")
    s.add_argument("--top", dest="top_n", type=int, default=5)
    s.add_argument("--recent-days", type=int, default=7)
    s.add_argument("--max-files", type=int, default=200_000)
    s.add_argument("--timeout", type=float, default=20.0)

    s = sub.add_parser("top_by_type")
    s.add_argument("path")
    s.add_argument("category")
    s.add_argument("--top", dest="top_n", type=int, default=20)
    s.add_argument("--max-files", type=int, default=200_000)
    s.add_argument("--timeout", type=float, default=20.0)

    args = ap.parse_args()

    home = Path(args.home)
    if not home.is_absolute():
        die("home must be absolute")
    drop_privileges(args.user, args.uid, args.gid, args.home)

    try:
        if args.cmd == "list":
            op_list(home, args.path)
        elif args.cmd == "stat":
            op_stat(home, args.path)
        elif args.cmd == "dirsize":
            op_dirsize(home, args.path, args.max_files, args.timeout)
        elif args.cmd == "mkdir":
            op_mkdir(home, args.path)
        elif args.cmd == "delete":
            op_delete(home, args.path, args.permanent, args.retention_days)
        elif args.cmd == "trash_list":
            op_trash_list(home, args.retention_days)
        elif args.cmd == "trash_restore":
            op_trash_restore(home, args.entry_id, args.dst)
        elif args.cmd == "trash_purge":
            op_trash_purge(home, args.entry_id)
        elif args.cmd == "rename":
            op_rename(home, args.src, args.dst)
        elif args.cmd == "read_stream":
            op_read_stream(home, args.path, args.offset, args.length, args.gunzip)
        elif args.cmd == "write_stream":
            op_write_stream(home, args.path, args.overwrite)
        elif args.cmd == "search":
            op_search(home, args.path, args.query, args.max_n,
                      args.timeout, args.include_dirs)
        elif args.cmd == "stats":
            op_stats(home, args.path, args.top_n, args.recent_days,
                     args.max_files, args.timeout)
        elif args.cmd == "top_by_type":
            op_top_by_type(home, args.path, args.category, args.top_n,
                           args.max_files, args.timeout)
        else:
            die("unknown command")
    except SystemExit:
        raise
    except Exception as e:  # last-ditch
        die(f"internal error: {type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
