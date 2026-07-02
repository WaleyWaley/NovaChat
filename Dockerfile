# =============================================================================
# NovaChat — C++ Services Dockerfile (Multi-stage)
#
# Stage 1: Build bRPC + NovaChat C++ services
# Stage 2: Minimal runtime
#
# Build:
#   docker build -t novachat-services .
# Run:
#   docker run -p 8001:8001 novachat-services
# =============================================================================

# =========================== Stage 1: Builder ================================
FROM ubuntu:22.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC

# --- System build dependencies ---
# g++-12 for C++20 support (std::chrono, concepts, etc.)
# protobuf: libprotobuf-dev + protobuf-compiler for .proto compilation
# gflags: bRPC config system
# leveldb + snappy: bRPC optional but recommended
# openssl: bRPC SSL support
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    cmake \
    curl \
    g++-12 \
    gcc-12 \
    git \
    libgflags-dev \
    libgoogle-glog-dev \
    libleveldb-dev \
    libprotobuf-dev \
    libprotoc-dev \
    libsnappy-dev \
    libssl-dev \
    make \
    protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

# Set g++-12 as default compiler
RUN update-alternatives --install /usr/bin/g++ g++ /usr/bin/g++-12 100 \
    && update-alternatives --install /usr/bin/gcc gcc /usr/bin/gcc-12 100 \
    && update-alternatives --install /usr/bin/cc cc /usr/bin/gcc-12 100 \
    && update-alternatives --install /usr/bin/c++ c++ /usr/bin/g++-12 100

# --- Build bRPC from source ---
ARG BRPC_VERSION=1.11.0
WORKDIR /tmp/brpc-build
RUN echo "Building bRPC ${BRPC_VERSION} with GLOG=ON" \
    && git clone --depth 1 --branch ${BRPC_VERSION} https://github.com/apache/brpc.git . \
    && cmake -B build \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX=/usr/local \
        -DBUILD_SHARED_LIBS=OFF \
        -DWITH_GLOG=ON \
    && cmake --build build -j$(nproc) \
    && cmake --install build \
    && echo "=== Looking for protoc-gen-brpc ===" \
    && find build -type f -executable -name "*protoc*" 2>/dev/null || echo "(no protoc binaries found)" \
    && ls build/tools/ 2>/dev/null || echo "(no build/tools)" \
    && ls build/output/bin/ 2>/dev/null || echo "(no build/output/bin)" \
    && rm -rf /tmp/brpc-build

# Verify bRPC installation
RUN test -f /usr/local/include/brpc/server.h \
    && test -f /usr/local/lib/libbrpc.a \
    && echo "bRPC installed successfully"
# Note: protoc-gen-brpc may not be built by default; we use hand-written stubs

# --- Build NovaChat ---
WORKDIR /novachat-build

# Copy only what's needed for the build
COPY CMakeLists.txt .
COPY cmake/ cmake/
COPY proto/ proto/
COPY services/ services/

# --- Pre-generate proto C++ code (must be in build/gen/cpp for CMake include paths) ---
RUN mkdir -p build/gen/cpp \
    && protoc \
        --proto_path=proto \
        --cpp_out=build/gen/cpp \
        proto/nova/common/common.proto \
        proto/nova/user/user.proto \
        proto/nova/gateway/push.proto \
    && echo "Proto C++ code generated" \
    && find build/gen/cpp -type f | sort

# --- Patch CMakeLists to use pre-generated proto files + hand-written brpc stubs ---
RUN sed -i 's|include(cmake/ProtoGen.cmake)|# proto generated manually (brpc stubs hand-written)\
add_library(nova_proto STATIC\
  build/gen/cpp/nova/common/common.pb.cc\
  build/gen/cpp/nova/gateway/push.pb.cc\
  build/gen/cpp/nova/user/user.pb.cc\
)\
target_include_directories(nova_proto PUBLIC build/gen/cpp ${BRPC_INCLUDE_DIR})\
target_link_libraries(nova_proto PUBLIC ${BRPC_LIBRARY})\
target_compile_features(nova_proto PUBLIC cxx_std_20)\
target_compile_options(nova_proto PRIVATE -Wno-unused-parameter -Wno-sign-compare)|' CMakeLists.txt \
    && sed -i 's|user_dao.cc|user_dao.cc user.brpc.cc|' services/user-service/CMakeLists.txt

# Build
RUN cmake -B build \
        -DCMAKE_BUILD_TYPE=Release \
        -DBRPC_ROOT=/usr/local \
    && cmake --build build -j$(nproc)

# Verify build output
RUN test -f build/services/user-service/nova_user_service \
    && echo "NovaChat user-service built successfully"

# =========================== Stage 2: Runtime ================================
FROM ubuntu:22.04 AS runtime

ENV DEBIAN_FRONTEND=noninteractive

# Runtime dependencies (lighter than build deps)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    libgflags2.2 \
    libprotobuf23 \
    libleveldb1d \
    libsnappy1v5 \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

# Copy bRPC libraries
COPY --from=builder /usr/local/lib/libbrpc.a /usr/local/lib/

# Copy NovaChat binary
COPY --from=builder /novachat-build/build/services/user-service/nova_user_service /app/nova_user_service

# Copy config files
COPY services/user-service/conf/ /app/conf/

WORKDIR /app

EXPOSE 8001

HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
    CMD curl -sf http://localhost:8001/status || exit 1

ENTRYPOINT ["./nova_user_service"]
CMD ["--flagfile=conf/user_service.flags"]
