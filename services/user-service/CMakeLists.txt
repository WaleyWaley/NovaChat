cmake_minimum_required(VERSION 3.16)

# =============================================================================
# NovaChat — User Service
# 产物: nova_user_service (可执行文件)
#
# 依赖:
#   libnova_common.a       — 共享库 (Snowflake, Config, Logger, Redis, MySQL)
#   libnova_proto.a         — 生成的 Protobuf + bRPC 服务桩
#   bRPC + Protobuf (传递)
# =============================================================================

# --- 源文件 ---
set(USER_SERVICE_SOURCES
    server.cc
    user_service_impl.cc
    user_dao.cc
)

set(USER_SERVICE_HEADERS
    user_service_impl.h
    user_dao.h
)

# --- 构建可执行文件 ---
add_executable(nova_user_service
    ${USER_SERVICE_SOURCES}
    ${USER_SERVICE_HEADERS}
)

target_include_directories(nova_user_service PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_SOURCE_DIR}/services/common/include
    ${BRPC_INCLUDE_DIR}
    ${CMAKE_BINARY_DIR}/gen/cpp
)

target_link_libraries(nova_user_service
    nova_common
    nova_proto
    ${BRPC_LIBRARY}
    pthread
)

target_compile_features(nova_user_service PRIVATE cxx_std_20)

target_compile_options(nova_user_service PRIVATE
    -Wall -Wextra -Wno-unused-parameter
)
