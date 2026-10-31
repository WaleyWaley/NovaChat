cmake_minimum_required(VERSION 3.16)
project(topic01_connection_manager_lab CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# 单头文件依赖 (cpp-httplib + nlohmann/json), 见 fetch_deps.ps1
add_executable(topic01_conn_mgr
    connection.cc
    mini_connection_manager.cc
    main.cc
)

target_include_directories(topic01_conn_mgr PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/third_party
)

target_compile_options(topic01_conn_mgr PRIVATE -Wall -Wextra -Wno-unused-parameter)

if(WIN32)
    target_link_libraries(topic01_conn_mgr PRIVATE ws2_32)
endif()

find_package(Threads REQUIRED)
target_link_libraries(topic01_conn_mgr PRIVATE Threads::Threads)
