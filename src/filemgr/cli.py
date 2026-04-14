"""filemgr CLI — entry point for `pip install`ed use.

Subcommands:
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
        sys.stderr.write(f"✗ {why} 需要 root；请用 sudo 重跑。\n")
        sys.exit(1)


# ---- run ----
def cmd_run(args: argparse.Namespace) -> None:
    if args.config:
        os.environ["FILEMGR_CONFIG"] = str(Path(args.config).expanduser().resolve())
    # 导入 app 才会触发 CFG 加载
    try:
        from . import app as fm_app
    except Exception as e:
        sys.stderr.write(f"✗ 启动失败：{e}\n")
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
        sys.stderr.write(f"✗ {dst} 已存在；加 --force 覆盖\n")
        sys.exit(1)
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(_template_text("config.toml.example"), encoding="utf-8")
    sys.stdout.write(f"✓ 已写入 {dst}\n")
    sys.stdout.write("  下一步：编辑 [[users]] 白名单，然后 `filemgr run`\n")


# ---- install-service ----
def cmd_install_service(args: argparse.Namespace) -> None:
    _need_root("安装 systemd 服务")
    config_path = Path(args.config).expanduser().resolve()
    if not config_path.exists():
        sys.stderr.write(
            f"✗ 配置文件不存在：{config_path}\n"
            f"  先 `filemgr init-config {config_path}` 生成\n"
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
    sys.stdout.write(f"✓ 已安装 {SERVICE_UNIT_PATH}\n")
    sys.stdout.write("  启用并启动：\n")
    sys.stdout.write(f"    sudo systemctl enable --now {SERVICE_NAME}\n")
    sys.stdout.write(f"    filemgr status\n")


# ---- uninstall-service ----
def cmd_uninstall_service(args: argparse.Namespace) -> None:
    _need_root("卸载 systemd 服务")
    subprocess.run(["systemctl", "disable", "--now", SERVICE_NAME],
                   check=False, stderr=subprocess.DEVNULL)
    if SERVICE_UNIT_PATH.exists():
        SERVICE_UNIT_PATH.unlink()
        subprocess.run(["systemctl", "daemon-reload"], check=False)
        sys.stdout.write(f"✓ 已卸载 {SERVICE_UNIT_PATH}\n")
    else:
        sys.stdout.write(f"（{SERVICE_UNIT_PATH} 不存在，跳过）\n")


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
    pc.set_defaults(fn=cmd_init_config)

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
