#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "mini_mysql_pool.h"  // 复用 lab07 的连接池 (通过 -I 引用)

namespace lab {

/** 消息状态 (对应 common.proto 的 MessageStatus) */
namespace MsgStatus {
    constexpr int SENT = 1;
    constexpr int DELIVERED = 2;
    constexpr int READ = 3;
}  // namespace MsgStatus

/** 一个对话的同步状态 (对应 message_dao.cc 的 PeerSyncState) */
struct PeerSyncState {
    int64_t latest_msg_id = 0;    // 该对话最新消息 id
    int64_t last_ack_msg_id = 0;  // 最后已读消息 id (status >= READ)
    int32_t unread_count = 0;     // status < READ 的未读条数
};

/**
 * MessageDao — 消息存取 + ACK 确认 (对应 services/message-service/message_dao.cc)
 *
 * 消息模型 (1:1 对话):
 *   - alice 发给 bob: 存 to_peer_id = bob  (bob 的收件箱)
 *   - bob 发给 alice: 存 to_peer_id = alice
 *   每张"收件箱视图"以 to_peer_id 为键做 ACK / 同步状态。
 *
 * ACK 语义 (对应 message_dao.cc 的 AckMessages):
 *   - 批量: 一条 SQL 把 msg_id <= max_ack 的消息全部升级
 *   - 只升不降: status < new_status, 已 READ 的不会被降级/重复计数
 *   - 幂等: 重复 ACK 返回 0, 不出错
 */
class MiniMessageDao {
 public:
    explicit MiniMessageDao(MiniMySqlPool* pool) : pool_(pool) {}

    /**
     * 保存一条消息 (status = SENT), 返回新 message_id。
     * @param from_peer_id 发送者 (user_id)
     * @param to_peer_id   接收者 (user_id)
     */
    int64_t save_message(int64_t from_peer_id, int64_t to_peer_id,
                         const std::string& text);

    /**
     * 批量确认: 把 to_peer_id 收件箱里 msg_id <= max_ack 且 status < new_status 的消息
     * 升级为 new_status。
     * @return 实际更新的行数
     */
    int ack_messages(int64_t to_peer_id, int64_t max_ack_msg_id, int32_t new_status);

    /**
     * 返回被 ACK 消息的发送者集合 (去重), 用于反向推送"已读"回执。
     * 对应 message_dao.cc 的 GetAckedSenders。
     */
    std::vector<int64_t> get_acked_senders(int64_t to_peer_id, int64_t max_ack_msg_id);

    /**
     * 拉取某收件箱的同步状态 (latest / last_ack / unread)。
     * 对应 message_dao.cc 的 GetSyncState。
     */
    PeerSyncState get_sync_state(int64_t to_peer_id);

 private:
    MiniMySqlPool* pool_;  // 借用, 不持有
};

}  // namespace lab
