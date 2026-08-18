// =============================================================================
// NovaChat — MessageDao 实现 (Phase 3: ACK + 去重)
// =============================================================================

#include "message_dao.h"
#include "nova/logger.h"

#include <algorithm>
#include <mutex>
#include <chrono>

namespace nova {
namespace message {

std::optional<MessageRecord> MessageDao::SaveMessage(
        const MessageRecord& msg, const std::string& idempotency_key) {
    std::lock_guard<std::mutex> lock(mu_);

    // Phase 3 去重
    if (!idempotency_key.empty()) {
        if (idempotency_keys_.count(idempotency_key)) {
            NOVA_LOG_INFO << "MessageDao: Duplicate message blocked (key="
                          << idempotency_key << ")";
            return std::nullopt;  // 重复消息, 不存储
        }
        idempotency_keys_.insert(idempotency_key);
        // 去重集合太大时清理旧条目 (保留最近 10000 个)
        if (idempotency_keys_.size() > 10000) {
            idempotency_keys_.clear();
            NOVA_LOG_WARN << "MessageDao: Idempotency key cache cleared (size limit)";
        }
    }

    MessageRecord stored = msg;
    if (stored.message_id == 0) {
        stored.message_id = next_local_id_++;
    }
    stored.created_at = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    stored.status = 1;  // SENT

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
    std::lock_guard<std::mutex> lock(mu_);

    std::vector<MessageRecord> results;
    if (limit <= 0 || limit > 100) limit = 20;

    for (const auto& msg : messages_) {
        if (msg.to_peer_type != to_peer_type || msg.to_peer_id != to_peer_id) continue;
        if (offset_id > 0 && msg.message_id >= offset_id) continue;
        results.push_back(msg);
        if (static_cast<int32_t>(results.size()) >= limit) break;
    }
    return results;
}

std::optional<MessageRecord> MessageDao::FindById(int64_t message_id) {
    std::lock_guard<std::mutex> lock(mu_);

    auto it = std::find_if(messages_.begin(), messages_.end(),
        [message_id](const MessageRecord& m) { return m.message_id == message_id; });
    if (it != messages_.end()) return *it;
    return std::nullopt;
}

// ============================= ACK (Phase 3) =================================

int MessageDao::AckMessages(int32_t peer_type, int64_t peer_id,
                             int64_t max_ack_msg_id, int32_t new_status) {
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

// ============================= Sync State (Phase 3) ===========================

PeerSyncState MessageDao::GetSyncState(
        int32_t peer_type, int64_t peer_id) const {
    std::lock_guard<std::mutex> lock(mu_);

    PeerSyncState state = {0, 0, 0};
    int64_t latest = 0, last_ack = 0;
    int32_t unread = 0;

    for (const auto& msg : messages_) {
        if (msg.to_peer_type != peer_type || msg.to_peer_id != peer_id) continue;
        if (msg.message_id > latest) latest = msg.message_id;
        if (msg.status >= 3) {  // READ
            if (msg.message_id > last_ack) last_ack = msg.message_id;
        } else {
            unread++;
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
    if (idempotency_key.empty()) return false;
    std::lock_guard<std::mutex> lock(mu_);
    return idempotency_keys_.count(idempotency_key) > 0;
}

size_t MessageDao::Count() const {
    return messages_.size();
}

}  // namespace message
}  // namespace nova
