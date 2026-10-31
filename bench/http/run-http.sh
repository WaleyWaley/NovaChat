#!/usr/bin/env bash
# =============================================================================
# HTTP 接口压测入口 — wrk 跑在 Docker 容器里, 直连 compose 网络内的 gateway
# (绕过 nginx 与宿主网络栈, 测的是网关 + C++ 服务本身)
#
# 用法 (Git Bash / WSL 下运行):
#   bench/http/run-http.sh login       # 登录接口
#   bench/http/run-http.sh register    # 注册接口 (动态用户名)
#   bench/http/run-http.sh profile     # 查资料接口 (带 JWT)
#
# 可选环境变量: THREADS=8 CONNS=200 DUR=30s
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"
# Windows 风格路径 (D:/...) 供 docker -v 使用
SCRIPT_DIR="$(pwd -W)"

BASE="${BASE:-http://localhost:3000}"
THREADS="${THREADS:-8}"
CONNS="${CONNS:-200}"
DUR="${DUR:-30s}"

# 用 node 解析 JSON (宿主机必有 node, 不依赖 jq)
json_field() { node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{console.log(JSON.parse(s)$1)}catch(e){console.log('')}})" ; }

bootstrap_user() {
  # 确保 bench_login 用户存在 (不存在则注册)
  local login_resp
  login_resp=$(curl -s -X POST "$BASE/api/auth/register" \
    -H 'Content-Type: application/json' \
    -d '{"username":"bench_login","password":"bench123456","first_name":"bench"}')
  echo "$login_resp" | json_field ".access_token"
}

case "${1:-}" in
  login)
    LUA=wrk-login.lua
    URL="http://gateway:3000/api/auth/login"
    bootstrap_user >/dev/null 2>&1 || true
    ;;
  register)
    LUA=wrk-register.lua
    URL="http://gateway:3000/api/auth/register"
    ;;
  profile)
    LUA=wrk-profile.lua
    # 注册临时用户, 拿 token + user_id 打受保护接口
    RESP=$(curl -s -X POST "$BASE/api/auth/register" \
      -H 'Content-Type: application/json' \
      -d "{\"username\":\"wrk_prof_$(date +%s)\",\"password\":\"bench123456\",\"first_name\":\"wrk\"}")
    TOKEN=$(echo "$RESP" | json_field ".access_token")
    UID_=$(echo "$RESP" | json_field ".user.user_id")
    URL="http://gateway:3000/api/users/$UID_"
    ;;
  *)
    echo "用法: $0 {login|register|profile}" >&2
    exit 1
    ;;
esac

# compose 网络名带项目前缀 (如 novachat_novachat-net), 自动探测
NETWORK="${NETWORK:-$(docker network ls --format '{{.Name}}' | grep -m1 'novachat.*-net')}"
if [ -z "$NETWORK" ]; then
  echo "未找到 novachat 网络, 先运行: docker compose up -d" >&2
  exit 1
fi

echo "== 压测: $1  ($THREADS 线程 × $CONNS 连接 × $DUR)  网络: $NETWORK =="
# MSYS_NO_PATHCONV=1: 禁止 Git Bash 把 -w /scripts 改写成 Windows 路径
MSYS_NO_PATHCONV=1 docker run --rm \
  --network "$NETWORK" \
  -v "$SCRIPT_DIR:/scripts" -w /scripts \
  -e TOKEN="${TOKEN:-}" \
  williamyeh/wrk \
  -t"$THREADS" -c"$CONNS" -d"$DUR" -s "$LUA" "$URL"
