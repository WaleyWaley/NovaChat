// =============================================================================
// NovaChat — Snowflake 分布式 ID 生成器实现
//
// ID 结构:
//   [0] [········ 41 bits timestamp ········] [10 bits worker] [12 bits seq]
//   保留  毫秒差值 (epoch=2024-01-01)           0–1023            0–4095
//
// 单机吞吐: 4096 * 1000 = 4,096,000 IDs/s  (理论上限)
// =============================================================================

#include "nova/snowflake.h"
#include "nova/common.h"
#include "nova/logger.h"

#include <chrono>
#include <thread>
#include <sstream>
#include <iomanip>

#include <butil/logging.h>

namespace nova {

// 位偏移常量
static constexpr int kTimestampShift = kWorkerIdBits + kSequenceBits;  // 22
static constexpr int kWorkerIdShift  = kSequenceBits;                  // 12

Snowflake::Snowflake(int64_t worker_id)
    : worker_id_(worker_id)
    , worker_id_shift_(worker_id << kWorkerIdShift) {

    if (worker_id < 0 || worker_id > kMaxWorkerId) {
        NOVA_LOG_FATAL << "Snowflake worker_id out of range: "
                       << worker_id << " (0–" << kMaxWorkerId << ")";
    }

    NOVA_LOG_INFO << "Snowflake initialized: worker_id=" << worker_id_
                  << ", epoch=" << kSnowflakeEpoch;
}

int64_t Snowflake::NextId() {
    int64_t ts = CurrentMs();

    // 序列号自增 (同一毫秒内)
    int64_t seq = sequence_.fetch_add(1, std::memory_order_relaxed);

    {
        std::lock_guard<std::mutex> lock(mu_);

        if (ts > last_timestamp_) {
            // 进入新毫秒, 重置序列号
            last_timestamp_ = ts;
            sequence_.store(0, std::memory_order_relaxed);
            seq = 0;
        } else if (ts < last_timestamp_) {
            // 时钟回拨
            int64_t back = last_timestamp_ - ts;

            if (back <= 5) {
                // 轻微回拨 (≤ 5ms): spin 等待时钟追上
                NOVA_LOG_WARN << "Clock rollback detected: " << back
                              << "ms, waiting...";
                ts = WaitNextMs(last_timestamp_);
                last_timestamp_ = ts;
                sequence_.store(0, std::memory_order_relaxed);
                seq = 0;
            } else {
                // 严重回拨 (> 5ms): 不可恢复, FATAL 退出
                NOVA_LOG_FATAL << "Severe clock rollback: " << back
                               << "ms. Worker cannot continue safely.";
                // LOG(FATAL) 会 abort, 此行不可达
            }
        }
        // ts == last_timestamp_: 同一毫秒, seq 已自增, 继续
    }

    // 序列号溢出保护: 同一毫秒内超过 4096 个请求
    // 实际场景几乎不可能 (单机 4M QPS), 但做防御
    while (seq > kMaxSequence) {
        ts = WaitNextMs(last_timestamp_);
        {
            std::lock_guard<std::mutex> lock(mu_);
            last_timestamp_ = ts;
            sequence_.store(0, std::memory_order_relaxed);
        }
        // 重试: 在新毫秒获取序列号
        return NextId();  // 递归, 最多一层
    }

    // 组装 ID
    int64_t timestamp_part = (ts - kSnowflakeEpoch) << kTimestampShift;
    return timestamp_part | worker_id_shift_ | seq;
}

int64_t Snowflake::CurrentMs() {
    return NowMs();
}

int64_t Snowflake::WaitNextMs(int64_t last) {
    int64_t now = CurrentMs();
    while (now <= last) {
        std::this_thread::sleep_for(std::chrono::microseconds(100));
        now = CurrentMs();
    }
    return now;
}

// --- 反解工具 ---

int64_t Snowflake::ExtractTimestamp(int64_t id) {
    return (id >> kTimestampShift) + kSnowflakeEpoch;
}

int64_t Snowflake::ExtractWorkerId(int64_t id) {
    return (id >> kWorkerIdShift) & kMaxWorkerId;
}

int64_t Snowflake::ExtractSequence(int64_t id) {
    return id & kMaxSequence;
}

std::string Snowflake::ToString(int64_t id) {
    std::ostringstream oss;
    oss << "Snowflake{id=" << id
        << ", timestamp=" << ExtractTimestamp(id)
        << ", worker=" << ExtractWorkerId(id)
        << ", seq=" << ExtractSequence(id)
        << "}";
    return oss.str();
}

}  // namespace nova
