#pragma once

// =============================================================================
// NovaChat — MessageDao (Phase 3: ACK + 去重 + 离线跟踪)
// =============================================================================

#include <string>
#include <vector>
#include <optional>
#include <unordered_map>
#include <unordered_set>
#include <mutex>
#include <cstdint>

#include "nova/common/common.pb.h"

namespace nova {
namespace message {

struct MessageRecord {
    int64_t  message_id;
    int32_t  from_peer_type;
    int64_t  from_peer_id;
    int32_t  to_peer_type;
    int64_t  to_peer_id;
    int32_t  msg_type;
    std::string text;
    int64_t  reply_to_msg_id;
    bool     is_silent;
    int64_t  created_at;
    int32_t  status;  // MessageStatus: SENT=1, DELIVERED=2, READ=3
};

// 每个对话的同步状态
struct PeerSyncState {
    int64_t latest_msg_id;      // 该对话最新的 message_id
    int64_t last_ack_msg_id;    // 最后确认的 message_id
    int32_t unread_count;       // 未读消息数
};

class MessageDao {
public:
    MessageDao() = default;

    // ===== 消息 CRUD =====

    // 存储消息. idempotency_key 用于去重 (Phase 3)
    std::optional<MessageRecord> SaveMessage(
        const MessageRecord& msg, const std::string& idempotency_key = "");

    // Timeline 拉取
    std::vector<MessageRecord> GetMessages(
        int32_t to_peer_type, int64_t to_peer_id,
        int32_t limit, int64_t offset_id);

    // 按 ID 查找
    std::optional<MessageRecord> FindById(int64_t message_id);

    // ===== ACK 确认 (Phase 3) =====

    // 确认消息已送达/已读. 更新 max_ack_msg_id 及之前所有消息的状态
    // Returns: 实际更新的消息数量
    int AckMessages(int32_t peer_type, int64_t peer_id,
                    int64_t max_ack_msg_id, int32_t new_status);

    // ===== 同步状态 (Phase 3) =====

    // 获取某个对话的同步状态
    PeerSyncState GetSyncState(int32_t peer_type, int64_t peer_id) const;

    // 获取用户在多个对话的同步状态
    std::vector<PeerSyncState> GetSyncStates(
        const std::vector<std::pair<int32_t, int64_t>>& peers) const;

    // 去重: 是否已存在此 idempotency_key
    bool IsDuplicate(const std::string& idempotency_key) const;

    // 消息总数
    size_t Count() const;

private:
    std::vector<MessageRecord> messages_;
    std::unordered_set<std::string> idempotency_keys_;  // Phase 3 去重
    mutable std::mutex mu_;
    int64_t next_local_id_ = 1;
};

}  // namespace message
}  // namespace nova
