// =============================================================================
// NovaChat — MessageDao 实现 (Phase 4: MySQL 持久化 + 内存回退)
// =============================================================================

#include "message_dao.h"
#include "nova/logger.h"

#include <algorithm>
#include <mutex>
#include <chrono>
#include <sstream>
#include <cstdlib>

namespace nova {
namespace message {

// ============================= 初始化 (Phase 4) ==============================

bool MessageDao::InitMySql(const std::string& addr, int port,
                           const std::string& user, const std::string& passwd,
                           const std::string& db, int pool_size) {
    mysql_ = std::make_unique<nova::MySqlPool>();
    if (!mysql_->Init(addr, port, user, passwd, db, pool_size)) {
        NOVA_LOG_ERROR << "MessageDao: Failed to initialize MySQL pool";
        mysql_.reset();   // 失败销毁池, IsStorageReady 门控保持 false → 走内存回退
        return false;
    }
    NOVA_LOG_INFO << "MessageDao: MySQL pool ready (" << addr << ":" << port
                  << "/" << db << ")";
    return true;
}

namespace {

// SQL 字符串字面量转义 (与 UserDao 一致: 转义 ' 和 \)
std::string EscapeSql(const std::string& s) {
    std::string r;
    r.reserve(s.size() + 2);
    for (char c : s) {
        if (c == '\'') r += "\\'";
        else if (c == '\\') r += "\\\\";
        else r += c;
    }
    return r;
}

// 从 Row 解析 int64; 缺失或空串 (SQL NULL 被 MySqlPool 转成 "") → 0
int64_t ParseI64(const nova::Row& row, const std::string& key) {
    auto it = row.find(key);
    if (it == row.end() || it->second.empty()) return 0;
    return std::strtoll(it->second.c_str(), nullptr, 10);
}

// 行 → MessageRecord 的 SELECT 列
// (from_user_id 用别名对齐字段 from_peer_id; is_silent 存于 flags bit1)
constexpr const char* kSelectRowColumns =
    "message_id, from_peer_type, from_user_id AS from_peer_id, "
    "to_peer_type, to_peer_id, msg_type, text, reply_to_msg_id, "
    "(flags & 2) AS is_silent, created_at, status";

// Row → MessageRecord (GetMessages / FindById 共用)
MessageRecord ParseRow(const nova::Row& row) {
    MessageRecord r;
    r.message_id      = ParseI64(row, "message_id");
    r.from_peer_type  = static_cast<int32_t>(ParseI64(row, "from_peer_type"));
    r.from_peer_id    = ParseI64(row, "from_peer_id");
    r.to_peer_type    = static_cast<int32_t>(ParseI64(row, "to_peer_type"));
    r.to_peer_id      = ParseI64(row, "to_peer_id");
    r.msg_type        = static_cast<int32_t>(ParseI64(row, "msg_type"));
    r.text            = row.count("text") ? row.at("text") : "";
    r.reply_to_msg_id = ParseI64(row, "reply_to_msg_id");
    r.is_silent       = (row.count("is_silent") && row.at("is_silent") != "0");
    r.created_at      = ParseI64(row, "created_at");
    r.status          = static_cast<int32_t>(ParseI64(row, "status"));
    return r;
}

}  // anonymous namespace


// optional 返回值的设计：函数返回值不是bool而是要么存进去了看结果，要么没存进去返回std::nullopt，调用方可以根据返回值判断是否存储成功
std::optional<MessageRecord> MessageDao::SaveMessage(const MessageRecord& msg, const std::string& idempotency_key) {
    // 备份消息后再修改。因为入参是 const& 不能改，而存储前要补齐 message_id、created_at、status字段，但不能动用调用方的数据。
    MessageRecord stored = msg;

    // 存储前补齐字段 (两种模式共享)
    stored.created_at = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    stored.status = 1;  // SENT

    // --- MySQL 路径 (Phase 4) ---
    if (mysql_ && mysql_->IsReady() && stored.message_id != 0) {
        bool has_key = !idempotency_key.empty();
        int flags = stored.is_silent ? 2 : 0;   // bit1 = silent (schema 约定)

        std::ostringstream sql;
        if (has_key) {
            // INSERT IGNORE + 唯一索引 = 原子去重; affected==0 ⇒ 重复
            sql << "INSERT IGNORE INTO messages "
                << "(message_id, from_peer_type, from_user_id, to_peer_type, "
                << "to_peer_id, msg_type, text, reply_to_msg_id, flags, "
                << "created_at, status, idempotency_key) VALUES ("
                << stored.message_id << ", "
                << stored.from_peer_type << ", "
                << stored.from_peer_id << ", "
                << stored.to_peer_type << ", "
                << stored.to_peer_id << ", "
                << stored.msg_type << ", "
                << "'" << EscapeSql(stored.text) << "', "
                << stored.reply_to_msg_id << ", "
                << flags << ", "
                << stored.created_at << ", "
                << "1, "
                << "'" << EscapeSql(idempotency_key) << "')";
        } else {
            // 空 key → 普通 INSERT (不吞错误; NULL 幂等键永不冲突)
            sql << "INSERT INTO messages "
                << "(message_id, from_peer_type, from_user_id, to_peer_type, "
                << "to_peer_id, msg_type, text, reply_to_msg_id, flags, "
                << "created_at, status) VALUES ("
                << stored.message_id << ", "
                << stored.from_peer_type << ", "
                << stored.from_peer_id << ", "
                << stored.to_peer_type << ", "
                << stored.to_peer_id << ", "
                << stored.msg_type << ", "
                << "'" << EscapeSql(stored.text) << "', "
                << stored.reply_to_msg_id << ", "
                << flags << ", "
                << stored.created_at << ", "
                << "1)";
        }

        int64_t affected = 0;
        butil::Status st = mysql_->ExecuteAffected(sql.str(), &affected);
        if (!st.ok()) {
            NOVA_LOG_ERROR << "MessageDao: MySQL INSERT failed: " << st.error_str();
            return std::nullopt;
        }
        if (affected == 0) {
            // 只有 INSERT IGNORE + 唯一键冲突才会 0 行
            NOVA_LOG_INFO << "MessageDao: Duplicate message blocked (key="
                          << idempotency_key << ")";
            return std::nullopt;  // 重复消息, 不存储
        }

        NOVA_VLOG(2) << "MessageDao: Saved msg_id=" << stored.message_id
                     << " from=" << stored.from_peer_id
                     << " to_peer=(" << stored.to_peer_type << "," << stored.to_peer_id << ")"
                     << " key=" << idempotency_key
                     << " (MySQL)";
        return stored;
    }

    if (mysql_ && mysql_->IsReady()) {
        // 走到这里说明 message_id==0 但 MySQL 已激活 (实际不可达: impl 总是给雪花 ID)
        NOVA_LOG_WARN << "MessageDao: message_id==0 with MySQL active, "
                      << "using in-memory fallback";
    }

    // --- 内存回退 (Phase 1-3 原逻辑不变) ---
    std::lock_guard<std::mutex> lock(mu_);

    // Phase 3 去重
    if (!idempotency_key.empty()) {
        if (idempotency_keys_.count(idempotency_key)) {
            NOVA_LOG_INFO << "MessageDao: Duplicate message blocked (key=" << idempotency_key << ")";
            return std::nullopt;  // 重复消息, 不存储
        }
        idempotency_keys_.insert(idempotency_key);
        // 去重集合太大时清理旧条目 (保留最近 10000 个)
        if (idempotency_keys_.size() > 10000) {
            idempotency_keys_.clear();  // 超限全清
            NOVA_LOG_WARN << "MessageDao: Idempotency key cache cleared (size limit)";
        }
    }

    // 兜底ID，防止 message_service_impl 的雪花算法ID 调用方没有给message_id赋值
    if (stored.message_id == 0) {
        stored.message_id = next_local_id_++;
    }

    // 按 message_id 降序排列
    auto it = std::lower_bound(messages_.begin(), messages_.end(), stored,
        [](const MessageRecord& a, const MessageRecord& b) {
            return a.message_id > b.message_id;
        });

    messages_.insert(it, stored);

    NOVA_VLOG(2) << "MessageDao: Saved msg_id=" << stored.message_id
                 << " from=" << stored.from_peer_id
                 << " to_peer=(" << stored.to_peer_type << "," << stored.to_peer_id << ")"
                 << " key=" << idempotency_key;

    return stored;
}

std::vector<MessageRecord> MessageDao::GetMessages(
        int32_t to_peer_type, int64_t to_peer_id,
        int32_t limit, int64_t offset_id) {

    std::vector<MessageRecord> results;

    // 限流保护 (两种模式共享)
    if (limit <= 0 || limit > 100) limit = 20;

    // --- MySQL 路径 (Phase 4) ---
    if (mysql_ && mysql_->IsReady()) {
        std::ostringstream sql;
        sql << "SELECT " << kSelectRowColumns << " FROM messages "
            << "WHERE to_peer_type = " << to_peer_type
            << " AND to_peer_id = " << to_peer_id;
        if (offset_id > 0) {
            sql << " AND message_id < " << offset_id;  // 游标: 只取更旧的
        }
        sql << " ORDER BY message_id DESC LIMIT " << limit;

        std::vector<nova::Row> rows;
        butil::Status st = mysql_->QueryAll(sql.str(), &rows);
        if (!st.ok()) {
            NOVA_LOG_ERROR << "MessageDao: MySQL GetMessages failed: " << st.error_str();
            return results;   // 空结果
        }
        for (const auto& row : rows) {
            results.push_back(ParseRow(row));
        }
        return results;
    }

    // --- 内存回退 (原逻辑不变, 锁内) ---
    std::lock_guard<std::mutex> lock(mu_);

    for (const auto& msg : messages_) {
        if (msg.to_peer_type != to_peer_type || msg.to_peer_id != to_peer_id) continue;
        // offset_id 是"客户端上次看到的最后一条"。msg.message_id >= offset_id 的全部跳过,只留更旧的。因为 vector 降序，遍历顺序天然"从新到旧"，匹配 filter 后拿到的前 limit 条就是"offset 之前的最近 limit 条"
        if (offset_id > 0 && msg.message_id >= offset_id) continue;
        results.push_back(msg);
        // 够了就停，不扫全盘
        if (static_cast<int32_t>(results.size()) >= limit) break;
    }

    // 返回的是拷贝的 vector——注意所有方法都返回拷贝，不返回引用。这是因为锁在 return 前就释放了，给调用方引用就等于把门打开让人家进屋随便翻。拷贝是"锁内取快照，锁外慢慢用"的标准做法
    return results;
}

std::optional<MessageRecord> MessageDao::FindById(int64_t message_id) {

    // --- MySQL 路径 (Phase 4) ---
    if (mysql_ && mysql_->IsReady()) {
        std::ostringstream sql;
        sql << "SELECT " << kSelectRowColumns << " FROM messages "
            << "WHERE message_id = " << message_id << " LIMIT 1";

        std::vector<nova::Row> rows;
        butil::Status st = mysql_->QueryAll(sql.str(), &rows);
        if (!st.ok()) {
            NOVA_LOG_ERROR << "MessageDao: MySQL FindById failed: " << st.error_str();
            return std::nullopt;
        }
        if (rows.empty()) return std::nullopt;
        return ParseRow(rows[0]);
    }

    // --- 内存回退 ---
    std::lock_guard<std::mutex> lock(mu_);

    auto it = std::find_if(messages_.begin(), messages_.end(),
        [message_id](const MessageRecord& m) { return m.message_id == message_id; });
    if (it != messages_.end()) return *it;
    return std::nullopt;
}

// ============================= ACK (Phase 3) =================================

int MessageDao::AckMessages(int32_t peer_type, int64_t peer_id,
                             int64_t max_ack_msg_id, int32_t new_status) {

    // --- MySQL 路径 (Phase 4) ---
    // 与内存语义一致: status < new_status 只升不降 (DELIVERED→READ / SENT→DELIVERED
    // 都会被计入; 已到更高状态的不会被降级, 也不会被重复计数)
    if (mysql_ && mysql_->IsReady()) {
        std::ostringstream sql;
        sql << "UPDATE messages SET status = " << new_status
            << " WHERE to_peer_type = " << peer_type
            << " AND to_peer_id = " << peer_id
            << " AND message_id <= " << max_ack_msg_id
            << " AND status < " << new_status;

        int64_t affected = 0;
        butil::Status st = mysql_->ExecuteAffected(sql.str(), &affected);
        if (!st.ok()) {
            NOVA_LOG_ERROR << "MessageDao: MySQL AckMessages failed: " << st.error_str();
            return 0;
        }
        NOVA_LOG_INFO << "MessageDao: ACK " << affected << " messages in peer ("
                      << peer_type << "," << peer_id << ") up to msg_id="
                      << max_ack_msg_id << " status=" << new_status << " (MySQL)";
        return static_cast<int>(affected);
    }

    // --- 内存回退 ---
    std::lock_guard<std::mutex> lock(mu_);

    int updated = 0;
    for (auto& msg : messages_) {
        if (msg.to_peer_type == peer_type && msg.to_peer_id == peer_id &&
            msg.message_id <= max_ack_msg_id && msg.status < new_status) {
            msg.status = new_status;
            updated++;
        }
    }

    NOVA_LOG_INFO << "MessageDao: ACK " << updated << " messages in peer ("
                  << peer_type << "," << peer_id << ") up to msg_id="
                  << max_ack_msg_id << " status=" << new_status;

    return updated;
}

// ============================= GetAckedSenders (Phase 4) ======================

std::vector<int64_t> MessageDao::GetAckedSenders(int32_t peer_type, int64_t peer_id,
                                                 int64_t max_ack_msg_id) {
    // --- MySQL 路径 ---
    if (mysql_ && mysql_->IsReady()) {
        std::ostringstream sql;
        sql << "SELECT DISTINCT from_user_id FROM messages "
            << "WHERE to_peer_type = " << peer_type
            << " AND to_peer_id = " << peer_id
            << " AND message_id <= " << max_ack_msg_id
            << " AND from_peer_type = 1";   // 只通知用户类型发送者

        std::vector<nova::Row> rows;
        butil::Status st = mysql_->QueryAll(sql.str(), &rows);
        if (!st.ok()) {
            NOVA_LOG_ERROR << "MessageDao: MySQL GetAckedSenders failed: " << st.error_str();
            return {};
        }
        std::vector<int64_t> senders;
        for (const auto& row : rows) {
            int64_t uid = ParseI64(row, "from_user_id");
            if (uid > 0) senders.push_back(uid);
        }
        return senders;
    }

    // --- 内存回退 ---
    std::lock_guard<std::mutex> lock(mu_);
    std::unordered_set<int64_t> seen;
    for (const auto& msg : messages_) {
        if (msg.to_peer_type == peer_type && msg.to_peer_id == peer_id &&
            msg.message_id <= max_ack_msg_id && msg.from_peer_type == 1) {
            seen.insert(msg.from_peer_id);
        }
    }
    return std::vector<int64_t>(seen.begin(), seen.end());
}

// ============================= Sync State (Phase 3) ===========================

// last_ack_msg_id 只统计 READ 的消息，但 unread 把 SENT(1) 和 DELIVERED(2) 都算进去了，虽然字段名字叫最后确认，但是实际语义是最后已读，DELIVERED 不算 ACK
PeerSyncState MessageDao::GetSyncState(
        int32_t peer_type, int64_t peer_id) const {

    // --- MySQL 路径 (Phase 4) ---
    // 单条聚合查询, 一次拿到三个统计量; 无 GROUP BY 的聚合恒返回 1 行
    if (mysql_ && mysql_->IsReady()) {
        std::ostringstream sql;
        sql << "SELECT MAX(message_id) AS latest, "
            << "MAX(IF(status >= 3, message_id, NULL)) AS last_ack, "
            << "SUM(IF(status < 3, 1, 0)) AS unread "
            << "FROM messages WHERE to_peer_type = " << peer_type
            << " AND to_peer_id = " << peer_id;

        std::vector<nova::Row> rows;
        butil::Status st = mysql_->QueryAll(sql.str(), &rows);
        if (!st.ok()) {
            NOVA_LOG_ERROR << "MessageDao: MySQL GetSyncState failed: " << st.error_str();
            return {0, 0, 0};
        }

        PeerSyncState state = {0, 0, 0};
        if (!rows.empty()) {
            // 空对话: MAX/SUM 全 NULL → MySqlPool 转成 "" → ParseI64 得 0
            state.latest_msg_id   = ParseI64(rows[0], "latest");
            state.last_ack_msg_id = ParseI64(rows[0], "last_ack");
            state.unread_count    = static_cast<int32_t>(ParseI64(rows[0], "unread"));
        }
        return state;
    }

    // --- 内存回退 ---
    std::lock_guard<std::mutex> lock(mu_);

    PeerSyncState state = {0, 0, 0};
    int64_t latest = 0, last_ack = 0;
    int32_t unread = 0;

    for (const auto& msg : messages_) {
        if (msg.to_peer_type != peer_type || msg.to_peer_id != peer_id) continue;

        if (msg.message_id > latest) latest = msg.message_id;  // 更新最新消息ID

        if (msg.status >= 3) {  // READ
            if (msg.message_id > last_ack) last_ack = msg.message_id;   // 更新最后已读消息ID
        } else {
            unread++;   // 未读
        }
    }

    state.latest_msg_id  = latest;
    state.last_ack_msg_id = last_ack;
    state.unread_count   = unread;
    return state;
}

std::vector<PeerSyncState> MessageDao::GetSyncStates(
        const std::vector<std::pair<int32_t, int64_t>>& peers) const {
    std::vector<PeerSyncState> results;
    results.reserve(peers.size());
    for (const auto& p : peers) {
        results.push_back(GetSyncState(p.first, p.second));
    }
    return results;
}

bool MessageDao::IsDuplicate(const std::string& idempotency_key) const {
    if (idempotency_key.empty()) return false;   // 空 key 快速路径, 不进锁

    // --- MySQL 路径 (Phase 4) ---
    if (mysql_ && mysql_->IsReady()) {
        std::string sql = "SELECT COUNT(*) AS c FROM messages WHERE idempotency_key = '"
                        + EscapeSql(idempotency_key) + "'";
        std::vector<nova::Row> rows;
        butil::Status st = mysql_->QueryAll(sql, &rows);
        if (!st.ok()) return false;
        if (!rows.empty() && rows[0].count("c") && rows[0].at("c") != "0") return true;
        return false;
    }

    // --- 内存回退 ---
    std::lock_guard<std::mutex> lock(mu_);
    return idempotency_keys_.count(idempotency_key) > 0;
}

size_t MessageDao::Count() const {
    // --- MySQL 路径 (Phase 4) ---
    if (mysql_ && mysql_->IsReady()) {
        std::vector<nova::Row> rows;
        butil::Status st = mysql_->QueryAll("SELECT COUNT(*) AS c FROM messages", &rows);
        if (!st.ok()) return 0;
        if (!rows.empty()) return static_cast<size_t>(ParseI64(rows[0], "c"));
        return 0;
    }

    // --- 内存回退 ---
    return messages_.size();
}

// ==================== Phase 4.2: 历史恢复 =====================================

std::vector<DialogEntry> MessageDao::GetDialogs(int64_t user_id, int32_t limit) {
    if (limit <= 0 || limit > 100) limit = 50;

    // --- MySQL 路径 ---
    if (mysql_ && mysql_->IsReady()) {
        // 双向收集对端: 我发出的 (to_peer) ∪ 发给我的 (from_peer), 每组取最新消息 ID
        std::ostringstream sql;
        sql << "SELECT p_type, p_id, MAX(message_id) AS latest FROM ("
            << "SELECT to_peer_type AS p_type, to_peer_id AS p_id, message_id "
            << "FROM messages WHERE from_peer_type = 1 AND from_user_id = " << user_id
            << " UNION ALL "
            << "SELECT from_peer_type AS p_type, from_user_id AS p_id, message_id "
            << "FROM messages WHERE to_peer_type = 1 AND to_peer_id = " << user_id
            << ") t GROUP BY p_type, p_id ORDER BY latest DESC LIMIT " << limit;

        std::vector<nova::Row> rows;
        butil::Status st = mysql_->QueryAll(sql.str(), &rows);
        if (!st.ok()) {
            NOVA_LOG_ERROR << "MessageDao: MySQL GetDialogs failed: " << st.error_str();
            return {};
        }
        std::vector<DialogEntry> dialogs;
        for (const auto& row : rows) {
            DialogEntry d;
            d.peer_type      = static_cast<int32_t>(ParseI64(row, "p_type"));
            d.peer_id        = ParseI64(row, "p_id");
            d.latest_msg_id  = ParseI64(row, "latest");
            if (d.peer_id > 0) dialogs.push_back(d);
        }
        return dialogs;
    }

    // --- 内存回退 ---
    std::lock_guard<std::mutex> lock(mu_);
    std::unordered_map<int64_t, DialogEntry> by_peer;  // key: peer_id (仅用户类型)
    for (const auto& msg : messages_) {
        int64_t pid = 0;
        if (msg.to_peer_type == 1 && msg.to_peer_id == user_id) {
            if (msg.from_peer_type != 1) continue;
            pid = msg.from_peer_id;
        } else if (msg.from_peer_type == 1 && msg.from_peer_id == user_id) {
            if (msg.to_peer_type != 1) continue;
            pid = msg.to_peer_id;
        } else {
            continue;
        }
        auto& d = by_peer[pid];
        if (d.peer_id == 0) { d.peer_type = 1; d.peer_id = pid; }
        if (msg.message_id > d.latest_msg_id) d.latest_msg_id = msg.message_id;
    }
    std::vector<DialogEntry> dialogs;
    dialogs.reserve(by_peer.size());
    for (auto& [pid, d] : by_peer) dialogs.push_back(d);
    std::sort(dialogs.begin(), dialogs.end(),
        [](const DialogEntry& a, const DialogEntry& b) { return a.latest_msg_id > b.latest_msg_id; });
    if (static_cast<int32_t>(dialogs.size()) > limit) dialogs.resize(limit);
    return dialogs;
}

std::vector<MessageRecord> MessageDao::GetConversation(
        int64_t me, int32_t peer_type, int64_t peer_id,
        int32_t limit, int64_t offset_id) {
    std::vector<MessageRecord> results;
    if (limit <= 0 || limit > 100) limit = 50;

    // --- MySQL 路径 ---
    if (mysql_ && mysql_->IsReady()) {
        std::ostringstream sql;
        sql << "SELECT " << kSelectRowColumns << " FROM messages WHERE ("
            << "(from_peer_type = 1 AND from_user_id = " << me
            << " AND to_peer_type = " << peer_type << " AND to_peer_id = " << peer_id << ")"
            << " OR "
            << "(from_peer_type = " << peer_type << " AND from_user_id = " << peer_id
            << " AND to_peer_type = 1 AND to_peer_id = " << me << ")"
            << ")";
        if (offset_id > 0) {
            sql << " AND message_id < " << offset_id;   // 游标: 只取更旧的
        }
        sql << " ORDER BY message_id DESC LIMIT " << limit;

        std::vector<nova::Row> rows;
        butil::Status st = mysql_->QueryAll(sql.str(), &rows);
        if (!st.ok()) {
            NOVA_LOG_ERROR << "MessageDao: MySQL GetConversation failed: " << st.error_str();
            return results;
        }
        for (const auto& row : rows) {
            results.push_back(ParseRow(row));
        }
        return results;
    }

    // --- 内存回退 ---
    std::lock_guard<std::mutex> lock(mu_);
    for (const auto& msg : messages_) {
        bool mine_to_peer = (msg.from_peer_type == 1 && msg.from_peer_id == me &&
                             msg.to_peer_type == peer_type && msg.to_peer_id == peer_id);
        bool peer_to_me   = (msg.from_peer_type == peer_type && msg.from_peer_id == peer_id &&
                             msg.to_peer_type == 1 && msg.to_peer_id == me);
        if (!mine_to_peer && !peer_to_me) continue;
        if (offset_id > 0 && msg.message_id >= offset_id) continue;
        results.push_back(msg);
        if (static_cast<int32_t>(results.size()) >= limit) break;
    }
    return results;
}

}  // namespace message
}  // namespace nova
