#pragma once

// =============================================================================
// NovaChat — Snowflake 分布式 ID 生成器
//
// 64-bit Snowflake 结构:
// ┌──┬───────────────────────────┬───────────────┬─────────────────────┐
// │ 0│     41 bits timestamp     │ 10 bits worker │ 12 bits sequence   │
// └──┴───────────────────────────┴───────────────┴─────────────────────┘
//   高          毫秒差值             0–1023           0–4095/ms
//
// epoch: 2024-01-01 00:00:00 UTC (1704067200000)
// 寿命:  2^41 ms ≈ 69 年 (到 2093 年)
// 吞吐:  4096 IDs/ms/worker ≈ 4M IDs/s (单机)
//
// 线程安全: sequence_ 用 atomic, last_timestamp_ 用 mutex 保护
// 时钟回拨: ≤ 5ms spin 等待; > 5ms FATAL crash
// =============================================================================

#include <atomic>
#include <mutex>
#include <cstdint>
#include <string>

namespace nova {

class Snowflake {
public:
    // worker_id: 0–1023, 每个服务实例在集群中唯一
    explicit Snowflake(int64_t worker_id);

    Snowflake(const Snowflake&) = delete;
    Snowflake& operator=(const Snowflake&) = delete;

    // 生成下一个唯一 ID
    int64_t NextId();

    // --- 工具方法: 从 ID 反解信息 (调试/日志用) ---
    static int64_t ExtractTimestamp(int64_t id);
    static int64_t ExtractWorkerId(int64_t id);
    static int64_t ExtractSequence(int64_t id);

    // 格式化输出 (human-readable)
    static std::string ToString(int64_t id);

    // 获取当前 worker_id
    int64_t WorkerId() const { return worker_id_; }

private:
    int64_t CurrentMs();
    int64_t WaitNextMs(int64_t last);

    const int64_t worker_id_;
    const int64_t worker_id_shift_;

    std::atomic<int64_t> sequence_{0};
    std::mutex            mu_;
    int64_t               last_timestamp_{0};
};

}  // namespace nova
