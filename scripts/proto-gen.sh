#!/usr/bin/env bash
# =============================================================================
# NovaChat — Proto 代码一键生成脚本
#
# 生成目标:
#   - C++:  protobuf 消息类 (.pb.h/.pb.cc) + bRPC 服务桩 (.brpc.h/.brpc.cc)
#   - TS:   (Phase 1.7+ 接入, 使用 ts-proto 或 protobuf-ts)
#
# 依赖:
#   - protoc (Protocol Buffers compiler)
#   - protoc-gen-brpc (bRPC protoc plugin, 随 bRPC 安装)
#
# 使用:
#   ./scripts/proto-gen.sh              # 生成所有语言的代码
#   ./scripts/proto-gen.sh cpp          # 仅生成 C++
#   ./scripts/proto-gen.sh ts           # 仅生成 TypeScript
#   BRPC_ROOT=/path/to/brpc ./scripts/proto-gen.sh  # 指定 bRPC 路径
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROTO_DIR="$PROJECT_ROOT/proto"
GEN_DIR="$PROJECT_ROOT/gen"

# --- 颜色输出 ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

# --- 参数解析 ---
TARGET="${1:-all}"   # all | cpp | ts

# --- 查找 protoc ---
PROTOC=""
if command -v protoc &> /dev/null; then
    PROTOC="protoc"
elif [ -n "${BRPC_ROOT:-}" ] && [ -x "$BRPC_ROOT/output/bin/protoc" ]; then
    PROTOC="$BRPC_ROOT/output/bin/protoc"
else
    log_error "protoc not found. Install protobuf-compiler or set BRPC_ROOT."
    exit 1
fi
log_info "Using protoc: $PROTOC ($($PROTOC --version))"

# --- 查找 protoc-gen-brpc ---
# bRPC 的 protoc 插件用于生成 Service 基类桩代码
find_brpc_plugin() {
    # 1. 直接检查 PATH
    if command -v protoc-gen-brpc &> /dev/null; then
        echo "protoc-gen-brpc"
        return
    fi
    # 2. 从 BRPC_ROOT 查找
    if [ -n "${BRPC_ROOT:-}" ]; then
        local candidate="$BRPC_ROOT/output/bin/protoc-gen-brpc"
        if [ -x "$candidate" ]; then
            echo "$candidate"
            return
        fi
    fi
    # 3. 常见安装位置
    for candidate in \
        /usr/local/bin/protoc-gen-brpc \
        /usr/bin/protoc-gen-brpc \
        /usr/local/lib/protoc-gen-brpc; do
        if [ -x "$candidate" ]; then
            echo "$candidate"
            return
        fi
    done
    echo ""
}

# ============================= C++ 代码生成 ===================================

gen_cpp() {
    log_info "=== Generating C++ protobuf code ==="

    local CPP_OUT="$GEN_DIR/cpp"
    mkdir -p "$CPP_OUT"

    # Make sure protoc can find the brpc plugin
    local BRPC_PLUGIN_PATH=""
    local BRPC_PLUGIN="$(find_brpc_plugin)"

    if [ -z "$BRPC_PLUGIN" ]; then
        log_warn "protoc-gen-brpc not found in PATH or BRPC_ROOT."
        log_warn "Will generate .pb.h/.pb.cc only (no bRPC service stubs)."
        log_warn "Install bRPC or set BRPC_ROOT to get full service generation."
        local BRPC_FLAGS=""
    else
        log_info "Using bRPC plugin: $BRPC_PLUGIN"
        # If the plugin isn't named exactly "protoc-gen-brpc", we need
        # to add its directory to PATH or use --plugin
        if [ "$BRPC_PLUGIN" != "protoc-gen-brpc" ]; then
            BRPC_PLUGIN_PATH="$(dirname "$BRPC_PLUGIN")"
            export PATH="$BRPC_PLUGIN_PATH:$PATH"
            log_info "Added to PATH: $BRPC_PLUGIN_PATH"
        fi
        local BRPC_FLAGS="--brpc_out=$CPP_OUT"
    fi

    # Collect all .proto files
    local PROTO_FILES=()
    while IFS= read -r -d '' f; do
        PROTO_FILES+=("$f")
    done < <(find "$PROTO_DIR" -name "*.proto" -print0 | sort -z)

    if [ ${#PROTO_FILES[@]} -eq 0 ]; then
        log_warn "No .proto files found in $PROTO_DIR"
        return
    fi

    log_info "Found ${#PROTO_FILES[@]} proto file(s):"
    for f in "${PROTO_FILES[@]}"; do
        echo "         ${f#$PROJECT_ROOT/}"
    done

    # Generate: --cpp_out for message classes, --brpc_out for service stubs
    log_info "Generating C++ code..."
    $PROTOC \
        --proto_path="$PROTO_DIR" \
        --cpp_out="$CPP_OUT" \
        $BRPC_FLAGS \
        "${PROTO_FILES[@]}"

    # Move generated files to match proto directory structure
    # protoc outputs to flat or package-based dirs; reorganize into gen/cpp/<package>/
    log_info "C++ generated files in: $CPP_OUT"

    # Count outputs
    local pb_count=$(find "$CPP_OUT" -name "*.pb.h" -o -name "*.pb.cc" | wc -l)
    local brpc_count=$(find "$CPP_OUT" -name "*.brpc.h" -o -name "*.brpc.cc" 2>/dev/null | wc -l)
    log_info "Generated $pb_count protobuf file(s), $brpc_count bRPC service file(s)"
}

# ============================= TypeScript 代码生成 ==============================

gen_ts() {
    log_info "=== Generating TypeScript protobuf code ==="

    local TS_OUT="$GEN_DIR/ts"
    mkdir -p "$TS_OUT"

    # Check for protobuf-ts plugin (preferred) or ts-proto
    if command -v protoc-gen-ts &> /dev/null; then
        log_info "Using protobuf-ts (protoc-gen-ts)"
        local TS_PLUGIN="--ts_out=$TS_OUT"
    elif command -v npx &> /dev/null && npx --no-install ts-proto --version &> /dev/null 2>&1; then
        log_warn "ts-proto found but protoc-gen-ts is preferred. Using ts-proto as fallback."
        # ts-proto generates via its own CLI, not as a protoc plugin by default
        log_info "Generating TS via npx ts-proto..."
        local PROTO_FILES=()
        while IFS= read -r -d '' f; do
            PROTO_FILES+=("${f#$PROJECT_ROOT/}")
        done < <(find "$PROTO_DIR" -name "*.proto" -print0 | sort -z)
        npx ts-proto \
            --protoDir "$PROTO_DIR" \
            --outDir "$TS_OUT" \
            "${PROTO_FILES[@]}"
        log_info "TypeScript generated files in: $TS_OUT"
        return
    else
        log_warn "No TypeScript protobuf plugin found (protoc-gen-ts or ts-proto)."
        log_warn "Install with: npm install -g ts-proto    (or: npm install @protobuf-ts/plugin)"
        log_warn "Skipping TS generation. Run again after installing a plugin."
        return
    fi

    # Generate via protoc with ts plugin
    local PROTO_FILES=()
    while IFS= read -r -d '' f; do
        PROTO_FILES+=("$f")
    done < <(find "$PROTO_DIR" -name "*.proto" -print0 | sort -z)

    $PROTOC \
        --proto_path="$PROTO_DIR" \
        $TS_PLUGIN \
        "${PROTO_FILES[@]}"

    log_info "TypeScript generated files in: $TS_OUT"
}

# ============================= Main ============================================

main() {
    echo ""
    echo "╔══════════════════════════════════════════════════╗"
    echo "║       NovaChat — Proto Code Generator           ║"
    echo "╚══════════════════════════════════════════════════╝"
    echo ""

    case "$TARGET" in
        all)
            gen_cpp
            echo ""
            gen_ts
            ;;
        cpp)
            gen_cpp
            ;;
        ts)
            gen_ts
            ;;
        *)
            log_error "Unknown target: $TARGET (valid: all, cpp, ts)"
            exit 1
            ;;
    esac

    echo ""
    log_info "Done! Generated code is in: $GEN_DIR"
    echo ""
}

main
