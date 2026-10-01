#!/usr/bin/env bash
# 重启前后端服务并验证。
#
#   ./restart.sh          重启后端(:3000) + 前端(:5173)，成功退出码 0
#   ./restart.sh backend  只重启后端
#   ./restart.sh frontend 只重启前端
#
# 要点：
#   - 杀进程用「锚定模式」(^node http-server.js) + 端口属主兜底，绝不 pkill -f
#     裸模式匹配到本 shell 自身命令行（本文件内容不参与匹配，脚本内 pkill 是安全的）；
#   - 启动一律 setsid 脱离会话，服务不随本脚本/终端退出被杀；
#   - 启动后轮询冒烟（登录接口 200 + 首页 200），成功/失败都给出日志指引。
set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND_LOG="${TMPDIR:-/tmp}/mcp-server.log"
FRONTEND_LOG="${TMPDIR:-/tmp}/htmlview.log"
TARGET="${1:-all}" # all | backend | frontend

log() { printf '%s\n' "$*"; }

kill_by_port() {
  # 杀掉占用 $1 端口的进程（匹配 ":$1$" 避免 3000 误伤 30001）
  local pids
  pids=$(ss -ltnp 2>/dev/null | awk -v p=":$1" '$4 ~ p"$" {print $NF}' \
    | grep -oE 'pid=[0-9]+' | grep -oE '[0-9]+' | sort -u)
  if [ -n "${pids:-}" ]; then
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
  fi
}

stop_backend() {
  pkill -f '^node http-server\.js' 2>/dev/null || true
  kill_by_port 3000
}

stop_frontend() {
  pkill -f 'npm run dev' 2>/dev/null || true
  pkill -f '\.bin/vite' 2>/dev/null || true
  kill_by_port 5173
}

start_backend() {
  cd "$ROOT/McpServer" || return 1
  setsid nohup node http-server.js >"$BACKEND_LOG" 2>&1 < /dev/null &
  cd "$ROOT" || true
}

start_frontend() {
  cd "$ROOT/App/HtmlView" || return 1
  setsid nohup npm run dev >"$FRONTEND_LOG" 2>&1 < /dev/null &
  cd "$ROOT" || true
}

http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$@" 2>/dev/null || true; }

wait_backend() {
  local i code=""
  for i in $(seq 1 20); do
    code=$(http_code -X POST http://localhost:3000/api/v1/auth/login \
      -H 'Content-Type: application/json' \
      -d '{"username":"admin","password":"admin123"}')
    [ "$code" = "200" ] && return 0
    sleep 1
  done
  BACKEND_CODE="$code"
  return 1
}

wait_frontend() {
  local i code=""
  for i in $(seq 1 20); do
    code=$(http_code http://localhost:5173/)
    [ "$code" = "200" ] && return 0
    sleep 1
  done
  FRONTEND_CODE="$code"
  return 1
}

BACKEND_CODE=""
FRONTEND_CODE=""
rc=0

case "$TARGET" in
  all | backend)
    log "→ 停止后端…"
    stop_backend
    sleep 1
    log "→ 启动后端 (:3000)…"
    start_backend
    if wait_backend; then
      log "  ✅ 后端 :3000 登录接口 HTTP 200"
    else
      log "  ❌ 后端未就绪（HTTP ${BACKEND_CODE:-无响应}），日志：$BACKEND_LOG"
      rc=1
    fi
    ;;
esac

case "$TARGET" in
  all | frontend)
    log "→ 停止前端…"
    stop_frontend
    sleep 1
    log "→ 启动前端 (:5173)…"
    start_frontend
    if wait_frontend; then
      log "  ✅ 前端 :5173 HTTP 200"
      grep -E 'Network:' "$FRONTEND_LOG" | tail -1 | sed 's/^/  /' || true
    else
      log "  ❌ 前端未就绪（HTTP ${FRONTEND_CODE:-无响应}），日志：$FRONTEND_LOG"
      rc=1
    fi
    ;;
esac

if [ "$rc" -eq 0 ]; then
  log "🎉 重启成功"
else
  log "💥 重启失败（见上方原因与日志）"
fi
exit "$rc"
