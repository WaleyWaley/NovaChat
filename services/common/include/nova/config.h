#pragma once

// =============================================================================
// NovaChat — 配置加载器 (基于 gflags)
//
// 使用方式:
//   1. 在你的 main() 之前用 DEFINE_* 宏声明 flag (各服务自行定义)
//   2. 调用 nova::Config::Init(argc, argv, usage_string)
//   3. 通过 FLAGS_* 全局变量读取配置
//
// Phase 1: 直接使用 gflags, 不做额外封装
// Phase 3: 可扩展为 YAML/JSON 配置加载
// =============================================================================

#include <string>
#include <gflags/gflags.h>

namespace nova {

class Config {
public:
    // 初始化 gflags 并解析命令行参数
    // argc/argv 按 gflags 惯例传入指针地址
    // usage: 程序的帮助文本 (bRPC Server 也用它)
    static void Init(int* argc, char*** argv, const std::string& usage);

    // 从文件加载 flag 配置, 等价于命令行 --flagfile=path
    // 调用时机: Init() 之后, Server 启动之前
    static void LoadFlagFile(const std::string& path);

    // 便捷读取: 等价于 google::GetCommandLineFlagInfoOrDie(name).current_value
    static std::string GetStringFlag(const std::string& name);
    static int32_t     GetInt32Flag(const std::string& name);
    static int64_t     GetInt64Flag(const std::string& name);
    static bool        GetBoolFlag(const std::string& name);
    static double      GetDoubleFlag(const std::string& name);

private:
    Config() = default;
};

}  // namespace nova
