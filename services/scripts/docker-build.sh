#!/usr/bin/env bash
# =============================================================================
# NovaChat — Docker 构建脚本
#
# 使用:
#   ./scripts/docker-build.sh              # 构建全部镜像
#   ./scripts/docker-build.sh user-service # 仅构建 user-service
#   ./scripts/docker-build.sh gateway      # 仅构建 gateway
#   ./scripts/docker-build.sh --no-cache   # 强制重建
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

CACHE_ARG=""
TARGET="${1:-all}"

if [ "$TARGET" = "--no-cache" ]; then
    CACHE_ARG="--no-cache"
    TARGET="${2:-all}"
fi

build_user_service() {
    log_info "=== Building C++ user-service ==="
    echo "  This builds bRPC from source + NovaChat (10-20 min first time)"
    docker build ${CACHE_ARG} -t novachat-user-service:latest -f Dockerfile .
    log_info "Built: novachat-user-service:latest"
}

build_gateway() {
    log_info "=== Building TS Gateway ==="
    docker build ${CACHE_ARG} -t novachat-gateway:latest -f gateway/Dockerfile gateway/
    log_info "Built: novachat-gateway:latest"
}

case "$TARGET" in
    all)
        build_user_service
        echo ""
        build_gateway
        echo ""
        log_info "All done! Start with: docker compose up -d"
        ;;
    user-service) build_user_service ;;
    gateway)      build_gateway ;;
    *)
        log_error "Unknown target: $TARGET (all | user-service | gateway)"
        exit 1
        ;;
esac
