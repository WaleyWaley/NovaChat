#pragma once

// =============================================================================
// NovaChat — 日志宏封装
//
// Phase 1: 直接代理到 butil logging (glog 兼容接口)
// Phase 3: 替换为双缓冲异步日志实现, 对外接口不变
//
// 使用示例:
//   NOVA_LOG_INFO << "User " << user_id << " logged in";
//   NOVA_LOG_ERROR << "Failed to connect Redis: " << err;
// =============================================================================

#include <glog/logging.h>
#include <string>

namespace nova {

// 初始化日志系统
inline void InitLogger(const std::string& name, const std::string& log_dir = "./logs") {
    (void)name;
    FLAGS_log_dir = log_dir;
    FLAGS_logtostderr = false;
    FLAGS_alsologtostderr = true;
    google::InitGoogleLogging(name.c_str());
}

// 关闭日志 (进程退出前调用)
inline void ShutdownLogger() {
    google::ShutdownGoogleLogging();
}

}  // namespace nova

// --- 日志宏：Phase 3 替换点 ---

#define NOVA_LOG_INFO   LOG(INFO)
#define NOVA_LOG_WARN   LOG(WARNING)
#define NOVA_LOG_ERROR  LOG(ERROR)
#define NOVA_LOG_FATAL  LOG(FATAL)
#define NOVA_VLOG(v)    VLOG(v)
#define NOVA_DLOG_INFO  DLOG(INFO)
#define NOVA_DVLOG(v)   DVLOG(v)
