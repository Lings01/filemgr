"""Web 文件管家 — FastAPI 主程序。

以 root 身份运行；每个文件操作 fork 一个 helper.py 子进程并 setuid 到
对应的登录用户，借内核的 uid/gid 检查做真正的多用户隔离。
"""
from __future__ import annotations

import asyncio
import json
import mimetypes
import os
import pwd
import secrets
import sys
import time
import tomllib
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import AsyncIterator

import pam as pam_mod
from fastapi import Cookie, FastAPI, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import (
    HTMLResponse,
    JSONResponse,
    PlainTextResponse,
    Response,
    StreamingResponse,
)
from fastapi.staticfiles import StaticFiles


PKG_DIR = Path(__file__).resolve().parent
STATIC_DIR = PKG_DIR / "static"
PY = sys.executable
# `-I` 进入 isolated 模式：不加载 site.py、不读 PYTHON* 环境变量、
# 不把 CWD 加入 sys.path —— 省 20–30ms 的 Python 冷启动，每次 fork 都见效。
PY_ARGS = ["-I", "-m", "filemgr.helper"]
COOKIE_NAME = "fmgr_session"
CHUNK = 1024 * 1024

# stat 结果缓存：键 (uid, abs_path)；省掉重复请求（图片预览 + 下载的 stat 探测、
# 视频 Range 请求每段都 stat 等场景）的第二次 fork。
_STAT_CACHE: "OrderedDict[tuple[int, str], tuple[dict, float]]" = OrderedDict()
STAT_CACHE_TTL = 10.0     # 秒
STAT_CACHE_MAX = 1000


def _find_config_path() -> Path:
    """按以下顺序查找 config.toml：
       $FILEMGR_CONFIG → ./config.toml → ~/.config/filemgr/config.toml → /etc/filemgr/config.toml
    """
    candidates: list[str | None] = [
        os.environ.get("FILEMGR_CONFIG"),
        "./config.toml",
        str(Path.home() / ".config" / "filemgr" / "config.toml"),
        "/etc/filemgr/config.toml",
    ]
    for c in candidates:
        if not c:
            continue
        p = Path(c).expanduser()
        if p.exists():
            return p.resolve()
    raise RuntimeError(
        "找不到 config.toml。可以 `filemgr init-config` 生成一份，"
        "或设置 FILEMGR_CONFIG 环境变量指向它。"
    )


def load_config() -> dict:
    path = _find_config_path()
    with open(path, "rb") as f:
        cfg = tomllib.load(f)
    cfg["_config_path"] = str(path)
    return cfg


CFG = load_config()
ALLOWED_USERS: dict[str, dict] = {
    u["name"]: u for u in CFG.get("users", [])
}


@dataclass
class Session:
    user: str
    uid: int
    gid: int
    home: str
    created: float
    expires: float


SESSIONS: dict[str, Session] = {}
SESSION_LOCK = asyncio.Lock()


def _now() -> float:
    return time.time()


def _sweep_sessions() -> None:
    now = _now()
    for tok in [t for t, s in SESSIONS.items() if s.expires < now]:
        SESSIONS.pop(tok, None)


async def get_session(token: str | None) -> Session:
    if not token:
        raise HTTPException(status_code=401, detail="未登录")
    async with SESSION_LOCK:
        _sweep_sessions()
        s = SESSIONS.get(token)
        if not s:
            raise HTTPException(status_code=401, detail="会话无效或已过期")
        return s


def pam_auth(user: str, password: str) -> bool:
    """Try the configured PAM service first, fall back to common services."""
    candidates = [CFG.get("pam_service", "login"), "common-auth", "passwd", "sshd"]
    tried = []
    for svc in dict.fromkeys(candidates):  # dedupe preserving order
        if not svc:
            continue
        tried.append(svc)
        try:
            p = pam_mod.pam()
            if p.authenticate(user, password, service=svc):
                return True
        except Exception:
            continue
    return False


async def run_helper(
    session: Session,
    *args: str,
    stdin_bytes: bytes | None = None,
    stdin_stream: AsyncIterator[bytes] | None = None,
    capture_stdout: bool = True,
) -> tuple[int, bytes, bytes]:
    cmd = [
        PY, *PY_ARGS,
        "--user", session.user,
        "--uid", str(session.uid),
        "--gid", str(session.gid),
        "--home", session.home,
        *args,
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.PIPE if (stdin_bytes is not None or stdin_stream is not None) else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE if capture_stdout else asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
        close_fds=True,
    )
    async def feed() -> None:
        try:
            if stdin_bytes is not None:
                proc.stdin.write(stdin_bytes)
                await proc.stdin.drain()
            elif stdin_stream is not None:
                async for chunk in stdin_stream:
                    proc.stdin.write(chunk)
                    await proc.stdin.drain()
        finally:
            try:
                proc.stdin.close()
            except Exception:
                pass

    feeder = asyncio.create_task(feed()) if (stdin_bytes is not None or stdin_stream is not None) else None
    out, err = await proc.communicate()
    if feeder:
        await feeder
    return proc.returncode or 0, out, err


async def cached_stat(session: Session, path: str) -> dict:
    """一段时间内同一 path 的 stat 只调一次 helper，专治图片/视频预览的重复请求。"""
    key = (session.uid, path)
    now = time.monotonic()
    hit = _STAT_CACHE.get(key)
    if hit is not None:
        meta, exp = hit
        if exp > now:
            _STAT_CACHE.move_to_end(key)
            return meta
        _STAT_CACHE.pop(key, None)
    meta = await helper_json(session, "stat", path)
    if isinstance(meta, dict):
        _STAT_CACHE[key] = (meta, now + STAT_CACHE_TTL)
        while len(_STAT_CACHE) > STAT_CACHE_MAX:
            _STAT_CACHE.popitem(last=False)
    return meta  # type: ignore[return-value]


def _etag_for(meta: dict) -> str:
    return f'W/"{int(meta.get("size") or 0)}-{int(meta.get("mtime") or 0)}"'


async def helper_json(session: Session, *args: str) -> dict | list:
    rc, out, err = await run_helper(session, *args)
    if rc != 0:
        try:
            e = json.loads(err.decode("utf-8", "replace"))
            msg = e.get("error", err.decode("utf-8", "replace"))
        except Exception:
            msg = err.decode("utf-8", "replace") or "helper error"
        code = 403 if "escape" in msg or "denied" in msg else 400
        raise HTTPException(status_code=code, detail=msg)
    try:
        return json.loads(out.decode("utf-8"))
    except Exception:
        raise HTTPException(status_code=500, detail="bad helper output")


app = FastAPI(title="File Manager", docs_url=None, redoc_url=None)


@app.get("/", response_class=HTMLResponse)
async def root() -> Response:
    return HTMLResponse((STATIC_DIR / "index.html").read_text(encoding="utf-8"))


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.post("/api/login")
async def api_login(request: Request) -> Response:
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="bad json")
    user = (body.get("user") or "").strip()
    password = body.get("password") or ""
    if not user or not password:
        await asyncio.sleep(1)
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    if user not in ALLOWED_USERS:
        await asyncio.sleep(1)
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    ok = await asyncio.to_thread(pam_auth, user, password)
    if not ok:
        await asyncio.sleep(1)
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    try:
        pw = pwd.getpwnam(user)
    except KeyError:
        raise HTTPException(status_code=500, detail="系统无此账户")
    root_dir = ALLOWED_USERS[user].get("root") or pw.pw_dir
    if not Path(root_dir).is_dir():
        raise HTTPException(status_code=500, detail=f"root dir 不存在: {root_dir}")
    token = secrets.token_urlsafe(32)
    ttl = int(CFG.get("session_ttl_seconds", 28800))
    sess = Session(
        user=user, uid=pw.pw_uid, gid=pw.pw_gid, home=str(Path(root_dir).resolve()),
        created=_now(), expires=_now() + ttl,
    )
    async with SESSION_LOCK:
        SESSIONS[token] = sess
    resp = JSONResponse({"user": user, "home": sess.home})
    resp.set_cookie(
        COOKIE_NAME, token, httponly=True, samesite="strict",
        max_age=ttl, path="/",
    )
    return resp


@app.post("/api/logout")
async def api_logout(fmgr_session: str | None = Cookie(default=None)) -> Response:
    if fmgr_session:
        async with SESSION_LOCK:
            SESSIONS.pop(fmgr_session, None)
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE_NAME, path="/")
    return resp


@app.get("/api/whoami")
async def api_whoami(fmgr_session: str | None = Cookie(default=None)) -> dict:
    s = await get_session(fmgr_session)
    return {"user": s.user, "home": s.home}


@app.get("/api/list")
async def api_list(
    path: str = Query(default=""),
    fmgr_session: str | None = Cookie(default=None),
) -> list:
    s = await get_session(fmgr_session)
    data = await helper_json(s, "list", path)
    return data  # list[dict]


@app.get("/api/dirsize")
async def api_dirsize(
    path: str = Query(default=""),
    fmgr_session: str | None = Cookie(default=None),
) -> dict:
    s = await get_session(fmgr_session)
    return await helper_json(
        s, "dirsize", path,
        "--max-files", str(int(CFG.get("dirsize_max_files", 100_000))),
        "--timeout", str(float(CFG.get("dirsize_timeout_seconds", 30))),
    )


@app.post("/api/mkdir")
async def api_mkdir(request: Request, fmgr_session: str | None = Cookie(default=None)) -> dict:
    s = await get_session(fmgr_session)
    body = await request.json()
    path = body.get("path") or ""
    if not path:
        raise HTTPException(status_code=400, detail="path 必填")
    return await helper_json(s, "mkdir", path)


@app.post("/api/rename")
async def api_rename(request: Request, fmgr_session: str | None = Cookie(default=None)) -> dict:
    s = await get_session(fmgr_session)
    body = await request.json()
    src = body.get("src") or ""
    dst = body.get("dst") or ""
    if not src or not dst:
        raise HTTPException(status_code=400, detail="src/dst 必填")
    return await helper_json(s, "rename", src, dst)


@app.post("/api/delete")
async def api_delete(request: Request, fmgr_session: str | None = Cookie(default=None)) -> dict:
    s = await get_session(fmgr_session)
    body = await request.json()
    path = body.get("path") or ""
    if not path:
        raise HTTPException(status_code=400, detail="path 必填")
    permanent = bool(body.get("permanent"))
    retention = float(CFG.get("trash_retention_days", 3))
    args = ["delete", path, "--retention-days", str(retention)]
    if permanent:
        args.append("--permanent")
    return await helper_json(s, *args)  # type: ignore[return-value]


@app.get("/api/trash/list")
async def api_trash_list(fmgr_session: str | None = Cookie(default=None)) -> dict:
    s = await get_session(fmgr_session)
    retention = float(CFG.get("trash_retention_days", 3))
    data = await helper_json(s, "trash_list", "--retention-days", str(retention))
    if isinstance(data, dict):
        data["retention_days"] = retention
    return data  # type: ignore[return-value]


@app.post("/api/trash/restore")
async def api_trash_restore(request: Request, fmgr_session: str | None = Cookie(default=None)) -> dict:
    s = await get_session(fmgr_session)
    body = await request.json()
    entry_id = (body.get("entry_id") or "").strip()
    dst = (body.get("dst") or "").strip()
    if not entry_id or not dst:
        raise HTTPException(status_code=400, detail="entry_id 和 dst 必填")
    return await helper_json(s, "trash_restore", entry_id, dst)  # type: ignore[return-value]


@app.post("/api/trash/purge")
async def api_trash_purge(request: Request, fmgr_session: str | None = Cookie(default=None)) -> dict:
    s = await get_session(fmgr_session)
    body = await request.json() if request.headers.get("content-length") else {}
    entry_id = (body.get("entry_id") or "").strip() if isinstance(body, dict) else ""
    args = ["trash_purge"]
    if entry_id:
        args.extend(["--entry-id", entry_id])
    return await helper_json(s, *args)  # type: ignore[return-value]


# stats 结果缓存：按 (uid,) 存，TTL 5 分钟，扫大家目录成本高。
_STATS_CACHE: "dict[int, tuple[dict, float]]" = {}
STATS_CACHE_TTL = 300.0


@app.get("/api/stats")
async def api_stats(
    refresh: int = Query(default=0),
    fmgr_session: str | None = Cookie(default=None),
) -> dict:
    s = await get_session(fmgr_session)
    now = time.monotonic()
    if not refresh:
        cached = _STATS_CACHE.get(s.uid)
        if cached and cached[1] > now:
            return cached[0]
    data = await helper_json(
        s, "stats", "/",
        "--top", "5",
        "--recent-days", "7",
        "--max-files", "200000",
        "--timeout", "20.0",
    )
    if isinstance(data, dict):
        _STATS_CACHE[s.uid] = (data, now + STATS_CACHE_TTL)
    return data  # type: ignore[return-value]


@app.get("/api/top_by_type")
async def api_top_by_type(
    cat: str = Query(..., min_length=1, max_length=40),
    top: int = Query(default=20, ge=1, le=200),
    fmgr_session: str | None = Cookie(default=None),
) -> dict:
    s = await get_session(fmgr_session)
    return await helper_json(
        s, "top_by_type", "/", cat,
        "--top", str(top),
        "--max-files", "200000",
        "--timeout", "20.0",
    )  # type: ignore[return-value]


@app.get("/api/search")
async def api_search(
    q: str = Query(..., min_length=1, max_length=200),
    path: str = Query(default="/"),
    include_dirs: int = Query(default=1),
    fmgr_session: str | None = Cookie(default=None),
) -> dict:
    s = await get_session(fmgr_session)
    args = ["search", path or "/", q, "--max", "300", "--timeout", "5.0"]
    if include_dirs:
        args.append("--include-dirs")
    return await helper_json(s, *args)  # type: ignore[return-value]


@app.post("/api/upload")
async def api_upload(
    request: Request,
    path: str = Query(...),
    overwrite: int = Query(default=0),
    file: UploadFile = None,  # type: ignore[assignment]
    fmgr_session: str | None = Cookie(default=None),
) -> dict:
    s = await get_session(fmgr_session)
    if file is None:
        raise HTTPException(status_code=400, detail="缺少文件")
    target = path
    if target.endswith("/") or not os.path.basename(target):
        target = os.path.join(target, file.filename or "upload.bin")
    max_bytes = int(CFG.get("max_upload_bytes", 10 * 1024**3))
    sent = 0

    async def stream() -> AsyncIterator[bytes]:
        nonlocal sent
        while True:
            buf = await file.read(CHUNK)
            if not buf:
                return
            sent += len(buf)
            if sent > max_bytes:
                raise HTTPException(status_code=413, detail="文件超过上传上限")
            yield buf

    args = ["write_stream", target]
    if overwrite:
        args.append("--overwrite")
    rc, out, err = await run_helper(s, *args, stdin_stream=stream())
    if rc != 0:
        try:
            e = json.loads(err.decode("utf-8", "replace"))
            msg = e.get("error", "upload failed")
        except Exception:
            msg = err.decode("utf-8", "replace") or "upload failed"
        raise HTTPException(status_code=400, detail=msg)
    try:
        return json.loads(out.decode("utf-8"))
    except Exception:
        return {"ok": True, "size": sent}


def _parse_range(header: str | None, size: int) -> tuple[int, int] | None:
    if not header or not header.startswith("bytes="):
        return None
    spec = header[6:].split(",")[0].strip()
    if "-" not in spec:
        return None
    a, b = spec.split("-", 1)
    try:
        if a == "":
            length = int(b)
            start = max(0, size - length)
            end = size - 1
        else:
            start = int(a)
            end = int(b) if b else size - 1
    except ValueError:
        return None
    if start < 0 or end >= size or start > end:
        return None
    return start, end


async def _stream_file(session: Session, path: str, offset: int, length: int) -> AsyncIterator[bytes]:
    cmd = [
        PY, *PY_ARGS,
        "--user", session.user, "--uid", str(session.uid),
        "--gid", str(session.gid), "--home", session.home,
        "read_stream", path,
        "--offset", str(offset), "--length", str(length),
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        close_fds=True,
    )
    try:
        assert proc.stdout is not None
        while True:
            chunk = await proc.stdout.read(CHUNK)
            if not chunk:
                break
            yield chunk
    finally:
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
        await proc.wait()


@app.get("/api/download")
async def api_download(
    request: Request,
    path: str = Query(...),
    fmgr_session: str | None = Cookie(default=None),
) -> Response:
    s = await get_session(fmgr_session)
    meta = await cached_stat(s, path)
    if not isinstance(meta, dict) or meta.get("type") != "file":
        raise HTTPException(status_code=400, detail="只能下载普通文件")
    size = int(meta["size"])
    name = os.path.basename(path) or "download"
    mime = mimetypes.guess_type(name)[0] or "application/octet-stream"

    rng = _parse_range(request.headers.get("range"), size)
    if rng is None:
        headers = {
            "Content-Length": str(size),
            "Content-Disposition": f"attachment; filename*=UTF-8''{_percent(name)}",
            "Accept-Ranges": "bytes",
        }
        return StreamingResponse(
            _stream_file(s, path, 0, 0), media_type=mime, headers=headers,
        )
    start, end = rng
    length = end - start + 1
    headers = {
        "Content-Range": f"bytes {start}-{end}/{size}",
        "Content-Length": str(length),
        "Content-Disposition": f"attachment; filename*=UTF-8''{_percent(name)}",
        "Accept-Ranges": "bytes",
    }
    return StreamingResponse(
        _stream_file(s, path, start, length), media_type=mime,
        headers=headers, status_code=206,
    )


@app.get("/api/preview")
async def api_preview(
    request: Request,
    path: str = Query(...),
    fmgr_session: str | None = Cookie(default=None),
) -> Response:
    s = await get_session(fmgr_session)
    meta = await cached_stat(s, path)
    if not isinstance(meta, dict) or meta.get("type") != "file":
        raise HTTPException(status_code=400, detail="只能预览普通文件")
    size = int(meta["size"])
    name = os.path.basename(path)
    mime = mimetypes.guess_type(name)[0] or "application/octet-stream"

    text_exts = {
        ".txt", ".md", ".log", ".py", ".js", ".ts", ".css", ".html",
        ".json", ".yaml", ".yml", ".toml", ".ini", ".conf", ".sh",
        ".c", ".h", ".cpp", ".hpp", ".go", ".rs", ".java", ".R", ".r",
        ".csv", ".tsv", ".xml", ".sql", ".rmd", ".qmd",
        # 生信文本格式
        ".fa", ".fasta", ".fna", ".faa", ".ffn", ".fai",
        ".fastq", ".fq", ".sam",
        ".vcf", ".bed", ".gff", ".gff3", ".gtf",
        ".bedgraph", ".wig", ".chain",
        ".nf", ".wdl", ".smk", ".snakefile",
    }
    ext = os.path.splitext(name)[1].lower()
    # 检测 .gz / .bgz / .bz2 等单层压缩，剥开一层取内层扩展做类型判断
    compression: str | None = None
    inner_ext = ext
    if ext in (".gz", ".bgz"):
        inner_ext = os.path.splitext(name[: -len(ext)])[1].lower()
        compression = ext.lstrip(".")
    is_text_plain = mime.startswith("text/") or ext in text_exts
    is_text_gz = compression == "gz" and inner_ext in text_exts
    is_text_gz = is_text_gz or (compression == "bgz" and inner_ext in text_exts)
    is_text = is_text_plain or is_text_gz
    is_media = mime.startswith(("image/", "video/", "audio/")) or mime == "application/pdf"

    if is_text:
        max_bytes = int(CFG.get("preview_text_max_bytes", 1_048_576))
        # 普通文本按大小截；gzip 不知解压后大小，直接取 max_bytes
        length = max_bytes if is_text_gz else min(size, max_bytes)
        args_r = ["read_stream", path, "--offset", "0", "--length", str(length)]
        if is_text_gz:
            args_r.append("--gunzip")
        rc, out, err = await run_helper(s, *args_r)
        if rc != 0:
            raise HTTPException(status_code=400, detail=err.decode("utf-8", "replace"))
        text = out.decode("utf-8", "replace")
        truncated = (size > max_bytes) if not is_text_gz else (len(out) >= max_bytes)
        return JSONResponse({
            "kind": "text", "content": text,
            "truncated": truncated, "size": size,
            "compressed": bool(compression),
            "inner_ext": inner_ext.lstrip(".") if is_text_gz else None,
        })

    if is_media:
        etag = _etag_for(meta)
        # 同一张图/视频片段第二次打开直接 304，零字节返回
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers={
                "ETag": etag,
                "Cache-Control": "private, max-age=3600",
            })
        cache_headers = {
            "ETag": etag,
            "Cache-Control": "private, max-age=3600",
        }
        rng = _parse_range(request.headers.get("range"), size)
        if rng is None:
            headers = {"Content-Length": str(size), "Accept-Ranges": "bytes", **cache_headers}
            return StreamingResponse(
                _stream_file(s, path, 0, 0), media_type=mime, headers=headers,
            )
        start, end = rng
        length = end - start + 1
        headers = {
            "Content-Range": f"bytes {start}-{end}/{size}",
            "Content-Length": str(length),
            "Accept-Ranges": "bytes",
            **cache_headers,
        }
        return StreamingResponse(
            _stream_file(s, path, start, length), media_type=mime,
            headers=headers, status_code=206,
        )

    return JSONResponse({"kind": "unsupported", "mime": mime, "size": size})


def _percent(s: str) -> str:
    from urllib.parse import quote
    return quote(s, safe="")


if __name__ == "__main__":
    # `python -m filemgr.app` 也能直接跑起来（开发调试用）；
    # 生产入口是 `filemgr run` / systemd。
    import uvicorn
    uvicorn.run(
        "filemgr.app:app",
        host=CFG.get("listen_host", "127.0.0.1"),
        port=int(CFG.get("listen_port", 8765)),
        log_level="info",
    )
