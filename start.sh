#!/usr/bin/env bash
# 一键启动/管理 文件管家。
#   ./start.sh          # 启动（首次自动安装 systemd unit）
#   ./start.sh stop     # 停止
#   ./start.sh restart  # 重启
#   ./start.sh status   # 查状态
#   ./start.sh logs     # 实时日志
#   ./start.sh dev      # 前台以 root 跑（不用 systemd，Ctrl-C 停）
#   ./start.sh uninstall# 卸载 systemd unit

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="filemgr"
UNIT_SRC="$HERE/deploy/${SERVICE_NAME}.service"
UNIT_DST="/etc/systemd/system/${SERVICE_NAME}.service"
VENV_PY="$HERE/venv/bin/python"
CFG="$HERE/config.toml"

# ---- 颜色 ----
if [[ -t 1 ]]; then
    C_OK=$'\e[32m'; C_WARN=$'\e[33m'; C_ERR=$'\e[31m'; C_DIM=$'\e[90m'; C_B=$'\e[1m'; C_R=$'\e[0m'
else
    C_OK=''; C_WARN=''; C_ERR=''; C_DIM=''; C_B=''; C_R=''
fi
say()  { printf '%s%s%s\n' "$C_DIM" "• $*" "$C_R"; }
ok()   { printf '%s%s%s\n' "$C_OK"  "✓ $*" "$C_R"; }
warn() { printf '%s%s%s\n' "$C_WARN" "! $*" "$C_R"; }
err()  { printf '%s%s%s\n' "$C_ERR" "✗ $*" "$C_R" >&2; }

need_sudo() {
    if [[ $EUID -eq 0 ]]; then "$@"; else sudo "$@"; fi
}

read_listen() {
    ( cd "$HERE" && "$VENV_PY" -c 'import tomllib; c=tomllib.load(open("config.toml","rb")); print(c.get("listen_host","0.0.0.0"), c.get("listen_port",8765))' ) 2>/dev/null || echo "0.0.0.0 8765"
}

preflight() {
    [[ -x "$VENV_PY" ]] || { err "venv 缺失: $VENV_PY  （请先按 README 初始化依赖）"; exit 1; }
    [[ -f "$CFG" ]]     || { err "配置缺失: $CFG"; exit 1; }
    [[ -f "$UNIT_SRC" ]] || { err "unit 模板缺失: $UNIT_SRC"; exit 1; }
    # 关键：确认依赖真的装进了 venv 自己的 site-packages，而不是只在 user-site 能看到
    local pf_out pf_rc
    pf_out=$("$VENV_PY" -c '
import sys, os
venv_sp = os.path.join(sys.prefix, "lib", f"python{sys.version_info.major}.{sys.version_info.minor}", "site-packages")
missing = []
for m in ("fastapi","uvicorn","pam","multipart","six"):
    try:
        mod = __import__(m)
        if not mod.__file__ or not mod.__file__.startswith(venv_sp):
            missing.append(f"{m} (loaded from {mod.__file__})")
    except ImportError as e:
        missing.append(f"{m} (not installed: {e})")
if missing:
    print("\n".join(missing)); sys.exit(1)
' 2>&1) || pf_rc=$?
    if [[ -n "${pf_rc:-}" ]]; then
        err "venv 依赖未就绪（需要装到 venv/lib/.../site-packages/ 而不是 ~/.local/）："
        printf '%s\n\n' "$pf_out" >&2
        err "修复：cd $HERE && ./venv/bin/pip install -r requirements.txt"
        exit 1
    fi
}

install_unit() {
    if [[ -f "$UNIT_DST" ]] && cmp -s "$UNIT_SRC" "$UNIT_DST"; then
        return 0
    fi
    say "安装 systemd unit（需要 sudo）：$UNIT_DST"
    need_sudo cp "$UNIT_SRC" "$UNIT_DST"
    need_sudo systemctl daemon-reload
    ok "已安装"
}

cmd_start() {
    preflight
    install_unit
    say "启动 $SERVICE_NAME.service（需要 sudo）"
    need_sudo systemctl enable --now "$SERVICE_NAME"
    sleep 1
    if systemctl is-active --quiet "$SERVICE_NAME"; then
        ok "已运行"
        print_banner
    else
        err "启动失败，最近日志："
        need_sudo journalctl -u "$SERVICE_NAME" -n 30 --no-pager
        exit 1
    fi
}

cmd_stop() {
    say "停止 $SERVICE_NAME.service（需要 sudo）"
    need_sudo systemctl stop "$SERVICE_NAME" || true
    ok "已停止"
}

cmd_restart() {
    preflight
    install_unit
    need_sudo systemctl restart "$SERVICE_NAME"
    sleep 1
    systemctl is-active --quiet "$SERVICE_NAME" \
        && { ok "已重启"; print_banner; } \
        || { err "重启失败"; need_sudo journalctl -u "$SERVICE_NAME" -n 30 --no-pager; exit 1; }
}

cmd_status() {
    systemctl status "$SERVICE_NAME" --no-pager || true
    echo
    print_banner
}

cmd_logs() {
    need_sudo journalctl -u "$SERVICE_NAME" -f --no-pager
}

cmd_dev() {
    preflight
    if [[ $EUID -ne 0 ]]; then
        warn "非 root 前台运行——PAM 认证可过，但文件操作会因无法 setuid 报错。"
        warn "生产用 ./start.sh 走 systemd；或 sudo ./start.sh dev 前台 root 跑。"
    fi
    read HOST PORT < <(read_listen)
    say "前台启动：http://$HOST:$PORT  （Ctrl-C 退出）"
    cd "$HERE"
    exec "$VENV_PY" -m uvicorn app:app --host "$HOST" --port "$PORT"
}

cmd_uninstall() {
    need_sudo systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
    if [[ -f "$UNIT_DST" ]]; then
        need_sudo rm -f "$UNIT_DST"
        need_sudo systemctl daemon-reload
    fi
    ok "已卸载 systemd unit（代码和 venv 保留）"
}

print_banner() {
    read HOST PORT < <(read_listen)
    local url="http://$HOST:$PORT"
    local extra=""
    if [[ "$HOST" == "0.0.0.0" || "$HOST" == "localhost" ]]; then
        local ext_ip
        ext_ip=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)
        [[ -n "$ext_ip" ]] && extra=$'\n  '"${C_DIM}远程访问请建 SSH 隧道: ssh -L $PORT:0.0.0.0:$PORT ${USER}@$ext_ip${C_R}"
    fi
    echo
    printf '  %s文件管家 已就绪%s\n' "$C_B" "$C_R"
    printf '  %s打开:%s %s%s%s\n' "$C_DIM" "$C_R" "$C_B" "$url" "$C_R"
    printf '  %s日志:%s ./start.sh logs\n' "$C_DIM" "$C_R"
    printf '  %s停止:%s ./start.sh stop\n' "$C_DIM" "$C_R"
    [[ -n "$extra" ]] && printf '%s\n' "$extra"
    echo
}

case "${1:-start}" in
    start)     cmd_start ;;
    stop)      cmd_stop ;;
    restart)   cmd_restart ;;
    status)    cmd_status ;;
    logs)      cmd_logs ;;
    dev)       cmd_dev ;;
    uninstall) cmd_uninstall ;;
    -h|--help|help)
        sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
        ;;
    *)
        err "未知命令: $1"
        sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
        exit 2
        ;;
esac
