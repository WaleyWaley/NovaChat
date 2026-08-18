cmake_minimum_required(VERSION 3.16)

# =============================================================================
# NovaChat — Message Service
# 产物: nova_message_service (可执行文件)
# =============================================================================

set(MSG_SERVICE_SOURCES
    server.cc
    message_service_impl.cc
    message_dao.cc
    push_dispatcher.cc
)

set(MSG_SERVICE_HEADERS
    message_service_impl.h
    message_dao.h
    push_dispatcher.h
)

add_executable(nova_message_service ${MSG_SERVICE_SOURCES} ${MSG_SERVICE_HEADERS})

target_include_directories(nova_message_service PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_SOURCE_DIR}/services/common/include
    ${BRPC_INCLUDE_DIR}
    ${CMAKE_BINARY_DIR}/gen/cpp
)

target_link_libraries(nova_message_service
    nova_common
    nova_proto
    ${BRPC_LIBRARY}
    pthread
)

target_compile_features(nova_message_service PRIVATE cxx_std_20)
target_compile_options(nova_message_service PRIVATE -Wall -Wextra -Wno-unused-parameter)
