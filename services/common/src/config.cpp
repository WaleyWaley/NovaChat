// =============================================================================
// NovaChat — 配置加载器实现 (gflags 封装)
// =============================================================================

#include "nova/config.h"

#include <gflags/gflags.h>
#include "nova/logger.h"

namespace nova {

void Config::Init(int* argc, char*** argv, const std::string& usage) {
    // gflags 解析命令行参数
    google::SetUsageMessage(usage);
    google::ParseCommandLineFlags(argc, argv, true);  // true = 不移除已处理的 flag

    NOVA_LOG_INFO << "Config initialized. Running with flags:";
    NOVA_LOG_INFO << "  (use --flagfile=path to load from file)";
}

void Config::LoadFlagFile(const std::string& path) {
    google::ReadFromFlagsFile(path, "", false);  // false = 不覆盖已设置的 flag
    NOVA_LOG_INFO << "Loaded flagfile: " << path;
}

std::string Config::GetStringFlag(const std::string& name) {
    return google::GetCommandLineFlagInfoOrDie(name.c_str()).current_value;
}

int32_t Config::GetInt32Flag(const std::string& name) {
    return std::stoi(GetStringFlag(name));
}

int64_t Config::GetInt64Flag(const std::string& name) {
    return std::stoll(GetStringFlag(name));
}

bool Config::GetBoolFlag(const std::string& name) {
    return google::GetCommandLineFlagInfoOrDie(name.c_str()).current_value == "true";
}

double Config::GetDoubleFlag(const std::string& name) {
    return std::stod(GetStringFlag(name));
}

}  // namespace nova
