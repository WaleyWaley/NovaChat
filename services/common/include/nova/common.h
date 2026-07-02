#pragma once

// =============================================================================
// NovaChat — 公共类型定义、常量、命名空间
// =============================================================================

#include <cstdint>
#include <string>
#include <memory>
#include <chrono>

namespace nova {

// --- 版本 ---
constexpr const char* kVersion = "0.1.0";

// --- 时间类型 ---
using Timestamp = int64_t;  // Unix timestamp, 毫秒

// --- 常用常量 ---
constexpr int   kMaxUsernameLen     = 32;
constexpr int   kMinUsernameLen     = 3;
constexpr int   kMaxFirstNameLen    = 64;
constexpr int   kMaxLastNameLen     = 64;
constexpr int   kMaxBioLen          = 256;
constexpr int   kMaxMessageLen      = 4096;   // UTF-8 字符数
constexpr int   kMaxBatchSize       = 100;
constexpr int   kMaxPushBatchSize   = 500;
constexpr int   kMaxPasswordLen     = 128;
constexpr int   kMinPasswordLen     = 8;

// --- Snowflake 参数 ---
constexpr int64_t kSnowflakeEpoch   = 1704067200000LL;  // 2024-01-01 00:00:00 UTC
constexpr int     kWorkerIdBits     = 10;
constexpr int     kSequenceBits     = 12;
constexpr int64_t kMaxWorkerId      = (1LL << kWorkerIdBits) - 1;   // 1023
constexpr int64_t kMaxSequence      = (1LL << kSequenceBits) - 1;   // 4095

// --- Token ---
constexpr int64_t kAccessTokenTTL   = 3600;     // 1 小时 (秒)
constexpr int64_t kRefreshTokenTTL  = 2592000;  // 30 天 (秒)

// --- 在线路由 ---
constexpr int kSessionRouteTTL      = 30;       // Redis 在线路由表 TTL (秒)
constexpr int kHeartbeatInterval    = 15;       // 网关心跳刷新间隔 (秒)

// --- 消息 ---
constexpr int kMaxMessageEntities   = 100;      // 单条消息最多 Entity 数量
constexpr int kMaxPinCount          = 5;        // 单个对话最多置顶消息数
constexpr int kSlowModeMinSeconds   = 0;
constexpr int kSlowModeMaxSeconds   = 3600;

// --- 工具函数 ---
inline Timestamp NowMs() {
    auto now = std::chrono::system_clock::now();
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        now.time_since_epoch()
    ).count();
}

}  // namespace nova
