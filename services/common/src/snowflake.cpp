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
    , worker_id_shift_(0) {

    // 先校验再计算位移 (负数位移是未定义行为)
    if (worker_id < 0 || worker_id > kMaxWorkerId) {
        NOVA_LOG_FATAL << "Snowflake worker_id out of range: "
                       << worker_id << " (0–" << kMaxWorkerId << ")";
    }
    worker_id_shift_ = worker_id << kWorkerIdShift;

    NOVA_LOG_INFO << "Snowflake initialized: worker_id=" << worker_id_
                  << ", epoch=" << kSnowflakeEpoch;
}

int64_t Snowflake::NextId() {
    // 全程持锁: 时间戳与序列号是一个整体状态, 锁外读写会造成数据竞争
    // (旧实现曾因锁外 fetch_add + 锁外读 last_timestamp_ 把线程抢占误判为
    //  "时钟回拨" 而随机 FATAL 杀进程)
    std::lock_guard<std::mutex> lock(mu_);

    // 逻辑时钟: 以 last_timestamp_ 为准, 只前进不后退。
    // 物理时钟回拨时沿用逻辑时钟继续派号 (Leaf/UidGenerator 同思路),
    // 绝不因回拨杀进程 — 只有序列空间耗尽时才需要等物理时钟追上。
    int64_t ts = CurrentMs();

    if (ts <= last_timestamp_) {
        if (sequence_ < kMaxSequence) {
            // 同一逻辑毫秒内还有序列空间: 继续派号 (回拨时也在逻辑时间上推进)
            ts = last_timestamp_;
        } else {
            // 序列耗尽 (回拨期间或单毫秒 >4096 请求): 必须等物理时钟越过逻辑时钟
            int64_t back = last_timestamp_ - ts;
            NOVA_LOG_WARN << "Snowflake: sequence exhausted (physical clock "
                          << back << "ms behind logical clock), waiting...";
            ts = WaitNextMs(last_timestamp_);
        }
    }

    if (ts > last_timestamp_) {
        // 进入新毫秒, 重置序列号
        last_timestamp_ = ts;
        sequence_ = 0;
    }

    int64_t seq = sequence_++;   // 同一毫秒内自增 (0..4095)

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
