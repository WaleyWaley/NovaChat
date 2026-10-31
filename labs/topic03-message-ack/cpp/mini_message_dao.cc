#include "mini_message_dao.h"

#include <atomic>
#include <chrono>
#include <iostream>

namespace lab {

namespace {

int64_t now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}

/**
 * 简化版雪花 ID (对应 NovaChat 的 nova::Snowflake) —— 已提供, 直接用。
 *   41 bit 毫秒时间戳 | 10 bit worker | 12 bit 序列号
 *
 * 为什么不用 AUTO_INCREMENT + LAST_INSERT_ID():
 *   LAST_INSERT_ID() 按连接生效, 连接池里 INSERT 和 SELECT LAST_INSERT_ID 会落到
 *   不同连接, 拿到的 id 是错的。所以 ID 由应用侧生成, 不依赖连接上下文。
 */
int64_t next_id() {
    static std::atomic<int64_t> seq{0};
    const int64_t ms = now_ms();
    const int64_t s = seq.fetch_add(1);
    return (ms << 22) | (1LL << 12) | (s & 0xFFF);
}

// 转义单引号, 防止 SQL 注入 / 语法错误 (真实项目应用 prepared statement)
std::string escape(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (char c : s) {
        if (c == '\'') out += "''";
        else out += c;
    }
    return out;
}

// 把字符串转成 int64 (空串/非数字 -> 0)
int64_t parse_i64(const std::string& s) {
    if (s.empty()) return 0;
    try {
        return std::stoll(s);
    } catch (...) {
        return 0;
    }
}

}  // namespace

int64_t MiniMessageDao::save_message(int64_t from_peer_id, int64_t to_peer_id,
                                     const std::string& text) {
    // TODO:
    //  1. const int64_t id = next_id();   // 应用侧生成 ID, 不靠 AUTO_INCREMENT
    //  2. 拼 INSERT (message_id 显式带上, peer_type=1, status=MsgStatus::SENT):
    //     INSERT INTO messages(message_id, from_peer_type, from_peer_id,
    //                          to_peer_type, to_peer_id, text, status, created_at)
    //     VALUES(id, 1, from, 1, to, 'escaped_text', 1, now_ms)
    //     用 pool_->execute(...) 执行, 失败返回 0
    //  3. 成功 return id
    const int64_t id = next_id();
    const std::string sql =
        "INSERT INTO messages(message_id, from_peer_type, from_peer_id, to_peer_type, to_peer_id, "
        "text, status, created_at) VALUES(" +
        std::to_string(id) + ", 1," + std::to_string(from_peer_id) + ", 1, " +
        std::to_string(to_peer_id) + ",'" + escape(text) + "'," + std::to_string(MsgStatus::SENT) +
        "," + std::to_string(now_ms()) + ")";
    if (not pool_->execute(sql))
        return 0;
    return id;
}

int MiniMessageDao::ack_messages(int64_t to_peer_id, int64_t max_ack_msg_id,
                                 int32_t new_status) {
    // TODO (对应 message_dao.cc 的 AckMessages, 关键语义: 只升不降):
    //  UPDATE messages SET status = new_status
    //  WHERE to_peer_type = 1 AND to_peer_id = to_peer_id
    //    AND message_id <= max_ack_msg_id AND status < new_status
    //  用 pool_->execute_affected(...) 执行, 返回 affected
    const std::string sql =
        "UPDATE messages SET status = " + std::to_string(new_status) +
        " WHERE to_peer_type = 1 AND to_peer_id = " + std::to_string(to_peer_id) +
        " AND message_id <= " + std::to_string(max_ack_msg_id) + " AND status < " +
        std::to_string(new_status);
    // affected 失败返回的-1
    int64_t affected = pool_->execute_affected(sql);
    return affected < 0 ? 0 : static_cast<int>(affected);
}

std::vector<int64_t> MiniMessageDao::get_acked_senders(int64_t to_peer_id,
                                                       int64_t max_ack_msg_id) {
    // TODO (对应 GetAckedSenders):
    //  SELECT DISTINCT from_peer_id
    //  FROM messages
    //  WHERE to_peer_type = 1 AND to_peer_id = to_peer_id
    //    AND message_id <= max_ack_msg_id AND from_peer_type = 1
    //  用 pool_->query(...), 把每行 from_peer_id 收集成 vector<int64_t>
    const std::string sql =
        "SELECT DISTINCT from_peer_id FROM messages WHERE to_peer_type = 1 AND to_peer_id = " +
        std::to_string(to_peer_id) + " AND message_id <= " + std::to_string(max_ack_msg_id) +
        " AND from_peer_type = 1";

    auto rows = pool_->query(sql);
    std::vector<int64_t> senders;
    if (rows.empty())
        return {};
    for(const auto& row:rows){
        auto it = row.find("from_peer_id");
        if(it != row.end()){
            senders.push_back(parse_i64(it->second));
        }
    }
    return senders;
}

PeerSyncState MiniMessageDao::get_sync_state(int64_t to_peer_id) {
    // TODO (对应 GetSyncState):
    //  SELECT MAX(message_id) AS latest,
    //         MAX(IF(status >= 3, message_id, NULL)) AS last_ack,
    //         SUM(IF(status < 3, 1, 0)) AS unread
    //  FROM messages
    //  WHERE to_peer_type = 1 AND to_peer_id = to_peer_id
    //  空对话时 MAX/SUM 返回 NULL -> query 得到 "" -> parse_i64 = 0
    //  填 PeerSyncState{latest, last_ack, unread}
    const std::string sql =
        "SELECT MAX(message_id) AS latest, MAX(IF(status >= 3, message_id, NULL)) AS last_ack, "
        "SUM(if(status < 3, 1, 0)) AS unread FROM messages WHERE to_peer_type = 1 AND to_peer_id "
        "= " +
        std::to_string(to_peer_id);
    auto rows = pool_->query(sql);
    if(rows.empty())
        return {};
    PeerSyncState pss;
    const Row& row = rows[0];
    pss.latest_msg_id = parse_i64(row.at("latest"));
    pss.last_ack_msg_id = parse_i64(row.at("last_ack"));
    pss.unread_count = static_cast<int32_t>(parse_i64(row.at("unread")));
    return pss;
}

}  // namespace lab
