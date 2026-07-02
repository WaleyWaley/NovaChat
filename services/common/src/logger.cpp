// =============================================================================
// NovaChat — 日志系统实现
// Phase 1: 封装 butil logging (glog 兼容) 的初始化逻辑
// Phase 3: 替换为双缓冲异步日志
// =============================================================================

#include "nova/logger.h"

// InitLogger 和 ShutdownLogger 已在 logger.h 中以 inline 方式实现
// (because they're simple wrappers around google::InitGoogleLogging/ShutdownGoogleLogging)
//
// 本文件为 Phase 3 占位: 届时在此实现双缓冲异步日志核心逻辑

namespace nova {
    // Phase 3 预留
}  // namespace nova
