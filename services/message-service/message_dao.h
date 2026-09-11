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
#include <memory>
#include <cstdint>

#include "nova/common/common.pb.h"
#include "nova/mysql_pool.h"

namespace nova {
namespace message {

struct MessageRecord {
    int64_t  message_id;
    int32_t  from_peer_type;    // 发送方类型 (1=用户)
    int64_t  from_peer_id;
    int32_t  to_peer_type;      // 接收方类型 (1=用户, 2=群组)
    int64_t  to_peer_id;
    int32_t  msg_type;          // MessageType (common.proto): TEXT=0, PHOTO=1, VIDEO=2, AUDIO=3, VOICE=4, DOCUMENT=5
    std::string text;
    int64_t  reply_to_msg_id;   // 回复的消息ID (0=无)
    bool     is_silent;         // 是否静默消息 (存库但是不推送)
    int64_t  created_at;        // 毫秒时间戳
    int32_t  status;            // MessageStatus: SENT=1, DELIVERED=2, READ=3
};

// 每个对话的同步状态
struct PeerSyncState {
    int64_t latest_msg_id;      // 该对话最新的 message_id
    int64_t last_ack_msg_id;    // 最后确认的 message_id
    int32_t unread_count;       // 未读消息数
};

// 会话列表条目 (Phase 4.2: 客户端恢复历史用)
struct DialogEntry {
    int32_t  peer_type;
    int64_t  peer_id;
    int64_t  latest_msg_id;
};

class MessageDao {
public:
    MessageDao() = default;

    // ==================== 初始化 (Phase 4) ====================

    // 初始化 MySQL 连接池. 失败返回 false (调用方回退内存存储)
    bool InitMySql(const std::string& addr, int port,
                   const std::string& user, const std::string& passwd,
                   const std::string& db, int pool_size = 8);

    // MySQL 是否就绪
    bool IsStorageReady() const { return mysql_ != nullptr; }

    // 当前存储模式
    std::string StorageMode() const {
        return IsStorageReady() ? "mysql" : "in-memory";
    }

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

    // 返回被 ACK 消息的发送者集合 (去重, 仅用户类型)
    // 用途: ACK 后向发送方推送"已读"回执 (UPDATE_MESSAGE_READ)
    std::vector<int64_t> GetAckedSenders(int32_t peer_type, int64_t peer_id,
                                         int64_t max_ack_msg_id);

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

    // ==================== Phase 4.2: 历史恢复 ====================

    // 用户聊过天的对端列表 (双向: 我发出的 + 发给我的), 按最新消息排序
    std::vector<DialogEntry> GetDialogs(int64_t user_id, int32_t limit);

    // 与某个对端的完整双向对话 (我发出的 + 对方发来的), message_id 降序, 游标分页
    std::vector<MessageRecord> GetConversation(
        int64_t me, int32_t peer_type, int64_t peer_id,
        int32_t limit, int64_t offset_id);

private:
    std::vector<MessageRecord> messages_;               // 消息本体，按ID降序排列
    std::unordered_set<std::string> idempotency_keys_;  // 去重键缓存
    mutable std::mutex mu_;                             // 一把锁保护全部
    int64_t next_local_id_ = 1;

    // Phase 4: 持久化存储 (unique_ptr 可选所有权, 与 UserDao 一致)
    std::unique_ptr<nova::MySqlPool> mysql_;
};

}  // namespace message
}  // namespace nova
