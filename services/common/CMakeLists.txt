cmake_minimum_required(VERSION 3.16)

# =============================================================================
# NovaChat — Common 共享库
# 产物: libnova_common.a (静态库)
# 依赖: bRPC (brpc::Channel, butil, bthread, glog/protobuf)
# =============================================================================

# --- 源文件 ---
set(NOVA_COMMON_HEADERS
    include/nova/common.h
    include/nova/config.h
    include/nova/logger.h
    include/nova/snowflake.h
    include/nova/mysql_pool.h
    include/nova/redis_client.h
)

set(NOVA_COMMON_SOURCES
    src/config.cpp
    src/logger.cpp
    src/snowflake.cpp
    src/mysql_pool.cpp
    src/redis_client.cpp
)

# --- 构建静态库 ---
add_library(nova_common STATIC ${NOVA_COMMON_SOURCES} ${NOVA_COMMON_HEADERS})

target_include_directories(nova_common PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${BRPC_INCLUDE_DIR}
)

target_link_libraries(nova_common PUBLIC
    ${BRPC_LIBRARY}
    pthread
)

target_compile_features(nova_common PUBLIC cxx_std_20)

# 编译选项
target_compile_options(nova_common PRIVATE
    -Wall -Wextra -Wno-unused-parameter
)
