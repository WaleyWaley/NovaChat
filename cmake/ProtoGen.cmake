# =============================================================================
# NovaChat — CMake Proto Generation Module
#
# 在构建时自动生成 protobuf C++ 代码 (.pb.h/.pb.cc + .brpc.h/.brpc.cc)
# 使用方式: 在顶层 CMakeLists.txt 中 include(cmake/ProtoGen.cmake)
# =============================================================================

# --- 查找 protoc ---
find_program(PROTOC_EXECUTABLE protoc
    HINTS ${BRPC_ROOT}/output/bin
    DOC "Protocol Buffers compiler"
)

if(NOT PROTOC_EXECUTABLE)
    message(FATAL_ERROR "protoc not found. Install protobuf or set BRPC_ROOT.")
endif()
message(STATUS "Found protoc: ${PROTOC_EXECUTABLE}")

# --- 查找 bRPC protoc 插件 ---
find_program(PROTOC_GEN_BRPC protoc-gen-brpc
    HINTS ${BRPC_ROOT}/output/bin
          /usr/local/bin
          /usr/bin
    DOC "bRPC protoc plugin"
)

if(PROTOC_GEN_BRPC)
    message(STATUS "Found protoc-gen-brpc: ${PROTOC_GEN_BRPC}")
    set(HAS_BRPC_PLUGIN TRUE)
else()
    message(WARNING "protoc-gen-brpc not found. Will generate .pb only (no bRPC service stubs).")
    message(WARNING "Install bRPC to get full service code generation.")
    set(HAS_BRPC_PLUGIN FALSE)
endif()

# --- Proto 源文件收集 ---
set(PROTO_DIR "${CMAKE_SOURCE_DIR}/proto")
set(PROTO_GEN_DIR "${CMAKE_BINARY_DIR}/gen/cpp")

file(GLOB_RECURSE PROTO_FILES "${PROTO_DIR}/*.proto")
list(SORT PROTO_FILES)

# --- 生成命令 ---
set(PROTO_GEN_SOURCES "")  # 收集所有生成的 .cc 文件

foreach(PROTO_FILE ${PROTO_FILES})
    file(RELATIVE_PATH REL_PATH "${PROTO_DIR}" "${PROTO_FILE}")
    get_filename_component(PROTO_REL_DIR "${REL_PATH}" DIRECTORY)
    get_filename_component(PROTO_BASENAME "${PROTO_FILE}" NAME_WE)

    set(PB_HEADER "${PROTO_GEN_DIR}/${PROTO_REL_DIR}/${PROTO_BASENAME}.pb.h")
    set(PB_SOURCE "${PROTO_GEN_DIR}/${PROTO_REL_DIR}/${PROTO_BASENAME}.pb.cc")

    # protoc 命令行
    set(PROTOC_ARGS
        --proto_path="${PROTO_DIR}"
        --cpp_out="${PROTO_GEN_DIR}"
    )

    set(PROTO_OUTPUTS "${PB_HEADER}" "${PB_SOURCE}")

    if(HAS_BRPC_PLUGIN)
        set(BRPC_HEADER "${PROTO_GEN_DIR}/${PROTO_REL_DIR}/${PROTO_BASENAME}.brpc.h")
        set(BRPC_SOURCE "${PROTO_GEN_DIR}/${PROTO_REL_DIR}/${PROTO_BASENAME}.brpc.cc")
        list(APPEND PROTOC_ARGS --brpc_out="${PROTO_GEN_DIR}")
        list(APPEND PROTO_OUTPUTS "${BRPC_HEADER}" "${BRPC_SOURCE}")
        list(APPEND PROTO_GEN_SOURCES "${BRPC_SOURCE}")
    endif()

    add_custom_command(
        OUTPUT ${PROTO_OUTPUTS}
        COMMAND ${PROTOC_EXECUTABLE} ${PROTOC_ARGS} "${PROTO_FILE}"
        DEPENDS "${PROTO_FILE}"
        COMMENT "Generating C++ from ${REL_PATH}"
        VERBATIM
    )

    list(APPEND PROTO_GEN_SOURCES "${PB_SOURCE}")
endforeach()

# --- 创建 proto 生成库 (编译生成的 .cc 文件) ---
add_library(nova_proto STATIC ${PROTO_GEN_SOURCES})

target_include_directories(nova_proto PUBLIC
    ${PROTO_GEN_DIR}
    ${BRPC_INCLUDE_DIR}
)

target_link_libraries(nova_proto PUBLIC
    ${BRPC_LIBRARY}
)

target_compile_features(nova_proto PUBLIC cxx_std_20)

# Proto 生成的代码可能有未使用参数的警告, 关闭之
target_compile_options(nova_proto PRIVATE
    -Wno-unused-parameter
    -Wno-sign-compare
)

message(STATUS "Proto generation configured: ${PROTO_GEN_DIR}")
