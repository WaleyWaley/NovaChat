#pragma once

// =============================================================================
// NovaChat — 日志宏封装
//
// Phase 1-2: 直接代理到 butil/glog (bRPC 内置, 已足够高效)
// Phase 3:   日志接口不变。glog 自带异步缓冲 (logbufsecs), 无需双缓冲。
//            配置 `--logbufsecs=30` 即可实现 30 秒批量刷盘。
//            如需独立双缓冲日志, 实现 AsyncLogger 并替换下方宏。
//
// 使用示例:
//   NOVA_LOG_INFO << "User " << user_id << " logged in";
//   NOVA_LOG_ERROR << "Failed to connect Redis: " << err;
// =============================================================================

#include <glog/logging.h>
#include <string>

namespace nova {

inline void InitLogger(const std::string& name, const std::string& log_dir = "./logs") {
    FLAGS_log_dir = log_dir;
    FLAGS_logtostderr = false;
    FLAGS_alsologtostderr = true;
    // Phase 3: glog 自带异步缓冲, 设置刷新间隔即可
    if (FLAGS_logbufsecs == 0) FLAGS_logbufsecs = 30;  // 30 秒批量刷盘
    google::InitGoogleLogging(name.c_str());
}

inline void ShutdownLogger() {
    google::ShutdownGoogleLogging();
}

}  // namespace nova

// 日志宏 (Phase 3: 接口不变, glog 已内置异步缓冲)
#define NOVA_LOG_INFO   LOG(INFO)
#define NOVA_LOG_WARN   LOG(WARNING)
#define NOVA_LOG_ERROR  LOG(ERROR)
#define NOVA_LOG_FATAL  LOG(FATAL)
#define NOVA_VLOG(v)    VLOG(v)
#define NOVA_DLOG_INFO  DLOG(INFO)
#define NOVA_DVLOG(v)   DVLOG(v)
