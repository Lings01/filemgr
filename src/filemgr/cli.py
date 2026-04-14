"""filemgr CLI — entry point for `pip install`ed use.

Subcommands:
    filemgr quickstart          one-shot: config + systemd + start (root needed)
    filemgr run                 start the web server (foreground)
    filemgr init-config [PATH]  write a sample config.toml
    filemgr install-service     install systemd unit (requires root)
    filemgr uninstall-service   remove systemd unit (requires root)
    filemgr status              `systemctl status filemgr`
    filemgr logs                `journalctl -u filemgr -f`
    filemgr version
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from importlib import resources
from pathlib import Path

from . import __version__

SERVICE_NAME = "filemgr"
SERVICE_UNIT_PATH = Path("/etc/systemd/system") / f"{SERVICE_NAME}.service"


# ---- 小工具 ----
def _template_text(name: str) -> str:
    return (resources.files("filemgr") / "templates" / name).read_text(encoding="utf-8")


def _need_root(why: str) -> None:
    if os.geteuid() != 0:
        sys.stderr.write(f"✗ {why} requires root; re-run with sudo.\n")
        sys.exit(1)


def _scan_system_users(min_uid: int = 1000, max_uid: int = 65533) -> list[dict]:
    """Enumerate local accounts with UID in [min_uid, max_uid)."""
    import pwd
    users: list[dict] = []
    for u in pwd.getpwall():
        if min_uid <= u.pw_uid < max_uid:
            users.append({"name": u.pw_name, "root": u.pw_dir})
    users.sort(key=lambda u: u["name"])
    return users


def _render_config(users: list[dict] | None,
                   host: str | None = None,
                   port: int | None = None) -> str:
    """Render config.toml text. If `users` is given, replace the example
    `[[users]]` block at the bottom with our own list. If None, return the
    template verbatim. `host` / `port` override the template's defaults.
    """
    tmpl = _template_text("config.toml.example")
    lines: list[str] = []
    body_end = None
    for i, line in enumerate(tmpl.splitlines()):
        if host is not None and line.startswith("listen_host"):
            line = f'listen_host = "{host}"'
        if port is not None and line.startswith("listen_port"):
            line = f"listen_port = {int(port)}"
        if users is not None and line.startswith("[[users]]"):
            body_end = i
            break
        lines.append(line)
    if users is None:
        return "\n".join(lines).rstrip() + "\n" if (host or port) else tmpl
    lines.append("# Auto-generated whitelist.")
    for u in users:
        lines.append("")
        lines.append("[[users]]")
        lines.append(f'name = "{u["name"]}"')
        lines.append(f'root = "{u["root"]}"')
    return "\n".join(lines).rstrip() + "\n"


def _users_from_arg(arg: str) -> list[dict]:
    """Parse --users alice,bob into [{name, root-from-/etc/passwd}]."""
    import pwd
    out: list[dict] = []
    for n in (x.strip() for x in arg.split(",")):
        if not n:
            continue
        try:
            pw = pwd.getpwnam(n)
        except KeyError:
            sys.stderr.write(f"✗ no such system account: {n}\n")
            sys.exit(1)
        out.append({"name": n, "root": pw.pw_dir})
    return out


# ---- run ----
def cmd_run(args: argparse.Namespace) -> None:
    if args.config:
        os.environ["FILEMGR_CONFIG"] = str(Path(args.config).expanduser().resolve())
    # 导入 app 才会触发 CFG 加载
    try:
        from . import app as fm_app
    except Exception as e:
        sys.stderr.write(f"✗ startup failed: {e}\n")
        sys.exit(1)
    host = args.host or fm_app.CFG.get("listen_host", "127.0.0.1")
    port = args.port or int(fm_app.CFG.get("listen_port", 8765))
    import uvicorn

    uvicorn.run(
        "filemgr.app:app",
        host=host,
        port=port,
        log_level=args.log_level,
    )


# ---- init-config ----
def cmd_init_config(args: argparse.Namespace) -> None:
    dst = Path(args.path).expanduser().resolve()
    if dst.exists() and not args.force:
        sys.stderr.write(f"✗ {dst} already exists; pass --force to overwrite.\n")
        sys.exit(1)
    users: list[dict] | None = None
    if args.all_users:
        users = _scan_system_users()
    elif args.users:
        users = _users_from_arg(args.users)
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(_render_config(users, args.host, args.port), encoding="utf-8")
    n = len(users) if users is not None else 0
    if users is None:
        sys.stdout.write(f"✓ wrote {dst} (with example alice/bob users — edit before starting)\n")
    elif n == 0:
        sys.stdout.write(f"✓ wrote {dst} with an EMPTY whitelist — add [[users]] blocks before starting\n")
    else:
        sys.stdout.write(f"✓ wrote {dst} with {n} allowed users\n")
    sys.stdout.write("  next: `sudo filemgr install-service` then `sudo systemctl enable --now filemgr`\n")
    sys.stdout.write("  or:   `sudo filemgr quickstart` to do everything in one go\n")


# ---- quickstart ----
def cmd_quickstart(args: argparse.Namespace) -> None:
    _need_root("quickstart")
    cfg = Path(args.config).expanduser().resolve()
    # 1) config
    if cfg.exists() and not args.force:
        sys.stdout.write(f"• {cfg} exists — keeping it\n")
    else:
        users: list[dict] | None
        if args.users:
            users = _users_from_arg(args.users)
        elif args.all_users or (not args.users):
            # quickstart 的默认行为：扫 UID>=1000 全部加进白名单
            users = _scan_system_users()
        else:
            users = None
        cfg.parent.mkdir(parents=True, exist_ok=True)
        cfg.write_text(_render_config(users, args.host, args.port), encoding="utf-8")
        sys.stdout.write(f"✓ wrote {cfg} with {len(users or [])} allowed users\n")
    # 2) install systemd unit
    cmd_install_service(argparse.Namespace(config=str(cfg)))
    # 3) enable + start
    subprocess.run(["systemctl", "enable", "--now", SERVICE_NAME], check=True)
    # 4) banner
    import tomllib
    try:
        c = tomllib.load(open(cfg, "rb"))
    except Exception:
        c = {}
    host = c.get("listen_host", "127.0.0.1")
    port = c.get("listen_port", 8765)
    url = f"http://{host}:{port}"
    sys.stdout.write("\n")
    sys.stdout.write(f"  \033[1mfilemgr is running\033[0m\n")
    sys.stdout.write(f"  \033[90mopen:\033[0m \033[1m{url}\033[0m\n")
    sys.stdout.write(f"  \033[90mlogs:\033[0m filemgr logs -f\n")
    sys.stdout.write(f"  \033[90mstop:\033[0m sudo systemctl stop filemgr\n\n")
    if host in ("127.0.0.1", "localhost"):
        sys.stdout.write(
            "  \033[90mremote:\033[0m ssh -L "
            f"{port}:127.0.0.1:{port} user@$(hostname -I | awk '{{print $1}}')\n\n"
        )


# ---- install-service ----
def cmd_install_service(args: argparse.Namespace) -> None:
    _need_root("install-service")
    config_path = Path(args.config).expanduser().resolve()
    if not config_path.exists():
        sys.stderr.write(
            f"✗ config file missing: {config_path}\n"
            f"  run `filemgr init-config {config_path}` first\n"
        )
        sys.exit(1)
    # filemgr 命令位置：取当前解释器同级 bin 里的；兼容 venv / pipx / 系统安装
    filemgr_exe = Path(sys.executable).parent / "filemgr"
    if not filemgr_exe.exists():
        # fallback: 用 -m 方式
        exec_cmd = f"{sys.executable} -m filemgr run --config {config_path}"
    else:
        exec_cmd = f"{filemgr_exe} run --config {config_path}"

    unit_text = _template_text("filemgr.service").format(
        exec_start=exec_cmd,
        config_path=str(config_path),
    )
    SERVICE_UNIT_PATH.write_text(unit_text, encoding="utf-8")
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    sys.stdout.write(f"✓ installed {SERVICE_UNIT_PATH}\n")


# ---- uninstall-service ----
def cmd_uninstall_service(args: argparse.Namespace) -> None:
    _need_root("uninstall-service")
    subprocess.run(["systemctl", "disable", "--now", SERVICE_NAME],
                   check=False, stderr=subprocess.DEVNULL)
    if SERVICE_UNIT_PATH.exists():
        SERVICE_UNIT_PATH.unlink()
        subprocess.run(["systemctl", "daemon-reload"], check=False)
        sys.stdout.write(f"✓ removed {SERVICE_UNIT_PATH}\n")
    else:
        sys.stdout.write(f"({SERVICE_UNIT_PATH} did not exist; skipped)\n")


# ---- status / logs ----
def cmd_status(args: argparse.Namespace) -> None:
    subprocess.run(["systemctl", "status", SERVICE_NAME, "--no-pager"], check=False)


def cmd_logs(args: argparse.Namespace) -> None:
    cmd = ["journalctl", "-u", SERVICE_NAME, "--no-pager"]
    if args.follow:
        cmd.append("-f")
    if args.tail:
        cmd.extend(["-n", str(args.tail)])
    subprocess.run(cmd, check=False)


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(
        prog="filemgr",
        description="Web file manager with PAM auth and per-user privilege isolation.",
    )
    p.add_argument("-V", "--version", action="version",
                   version=f"filemgr {__version__}")
    sub = p.add_subparsers(dest="cmd", required=True, metavar="COMMAND")

    pr = sub.add_parser("run", help="start the server in the foreground")
    pr.add_argument("--host", help="override listen_host from config")
    pr.add_argument("--port", type=int, help="override listen_port from config")
    pr.add_argument("--config", help="path to config.toml")
    pr.add_argument("--log-level", default="info",
                    choices=["critical", "error", "warning", "info", "debug", "trace"])
    pr.set_defaults(fn=cmd_run)

    pc = sub.add_parser("init-config",
                        help="write a sample config.toml to PATH (default ./config.toml)")
    pc.add_argument("path", nargs="?", default="config.toml")
    pc.add_argument("-f", "--force", action="store_true", help="overwrite existing file")
    pc.add_argument("--all-users", action="store_true",
                    help="pre-fill whitelist with every local account (UID >= 1000)")
    pc.add_argument("--users",
                    help="pre-fill whitelist with these accounts (comma-separated)")
    pc.add_argument("--host", help="override listen_host in the generated config")
    pc.add_argument("--port", type=int, help="override listen_port in the generated config")
    pc.set_defaults(fn=cmd_init_config)

    pq = sub.add_parser("quickstart",
                        help="one-shot: write config (all local users by default), "
                             "install systemd unit, enable and start the service")
    pq.add_argument("--config", default="/etc/filemgr/config.toml",
                    help="where to write/read the config (default: /etc/filemgr/config.toml)")
    pq.add_argument("--users",
                    help="only whitelist these accounts (comma-separated); "
                         "default is every local account with UID >= 1000")
    pq.add_argument("--all-users", action="store_true",
                    help="explicitly use all local accounts (this is also the default)")
    pq.add_argument("--host", help="listen_host for the generated config "
                                   "(default: whatever the template says, currently 0.0.0.0)")
    pq.add_argument("--port", type=int,
                    help="listen_port for the generated config (default: 8765)")
    pq.add_argument("-f", "--force", action="store_true",
                    help="overwrite an existing config")
    pq.set_defaults(fn=cmd_quickstart)

    pi = sub.add_parser("install-service",
                        help="install the systemd unit file (needs root)")
    pi.add_argument("--config", default="/etc/filemgr/config.toml",
                    help="path to the config file the service should load")
    pi.set_defaults(fn=cmd_install_service)

    pu = sub.add_parser("uninstall-service",
                        help="remove the systemd unit (needs root)")
    pu.set_defaults(fn=cmd_uninstall_service)

    ps = sub.add_parser("status", help="systemctl status filemgr")
    ps.set_defaults(fn=cmd_status)

    pl = sub.add_parser("logs", help="journalctl -u filemgr")
    pl.add_argument("-f", "--follow", action="store_true")
    pl.add_argument("-n", "--tail", type=int, help="show last N lines before following")
    pl.set_defaults(fn=cmd_logs)

    args = p.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":  # pragma: no cover
    main()
