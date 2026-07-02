cmake_minimum_required(VERSION 3.16)

# =============================================================================
# NovaChat — 顶层 CMake 构建文件
#
# 构建:
#   mkdir build && cd build
#   cmake .. -DBRPC_ROOT=/path/to/brpc
#   make -j$(nproc)
#
# 目录结构:
#   services/common/       → libnova_common.a (静态库)
#   services/user-service/ → nova_user_service (可执行文件)
#   ... 更多服务逐步加入
# =============================================================================

project(NovaChat VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# 全局编译选项
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)  # 生成 compile_commands.json (IDE/LSP 友好)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Debug CACHE STRING "Build type" FORCE)
endif()

message(STATUS "NovaChat build type: ${CMAKE_BUILD_TYPE}")

# =============================================================================
# --- 查找 bRPC (全局共享) ---
# =============================================================================

set(BRPC_ROOT "" CACHE PATH "bRPC installation root")

find_path(BRPC_INCLUDE_DIR brpc/server.h
    HINTS ${BRPC_ROOT}/include
          ${BRPC_ROOT}/output/include
          /usr/local/include
          /usr/include
)

find_library(BRPC_LIBRARY brpc
    HINTS ${BRPC_ROOT}/lib
          ${BRPC_ROOT}/output/lib
          /usr/local/lib
          /usr/lib
)

if(NOT BRPC_INCLUDE_DIR OR NOT BRPC_LIBRARY)
    message(FATAL_ERROR "bRPC not found. Set BRPC_ROOT to your bRPC installation path.
    Build bRPC: https://github.com/apache/brpc/blob/master/docs/en/getting_started.md")
endif()

message(STATUS "Found bRPC include: ${BRPC_INCLUDE_DIR}")
message(STATUS "Found bRPC library: ${BRPC_LIBRARY}")

# =============================================================================
# --- Proto 代码生成 ---
# =============================================================================

include(cmake/ProtoGen.cmake)

# =============================================================================
# --- 子目录 ---
# =============================================================================

# 公共库
add_subdirectory(services/common)

# 微服务
add_subdirectory(services/user-service)

# Phase 2: add_subdirectory(services/message-service)
# Phase 4: add_subdirectory(services/media-service)
