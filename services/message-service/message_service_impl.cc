// =============================================================================
// NovaChat — MessageServiceImpl 实现
// =============================================================================

#include "message_service_impl.h"
#include "nova/logger.h"

#include <brpc/controller.h>

namespace nova {
namespace message {

MessageServiceImpl::MessageServiceImpl(nova::Snowflake* snowflake,
                                       MessageDao* dao,
                                       PushDispatcher* push)
    : snowflake_(snowflake), dao_(dao), push_(push) {
    NOVA_LOG_INFO << "MessageServiceImpl created";
}

bool MessageServiceImpl::ValidateSendRequest(
        const ::nova::message::SendMessageReq* req, std::string* error) {
    if (!req->has_from_peer() || !req->has_to_peer()) {
        *error = "from_peer and to_peer are required";
        return false;
    }
    if (req->to_peer().type() == ::nova::common::PEER_TYPE_UNKNOWN) {
        *error = "Invalid to_peer type";
        return false;
    }
    if (req->text().empty() && req->msg_type() == ::nova::common::MESSAGE_TYPE_TEXT) {
        *error = "Text message cannot be empty";
        return false;
    }
    if (req->text().size() > static_cast<size_t>(nova::kMaxMessageLen)) {
        *error = "Message too long (max " +
                 std::to_string(nova::kMaxMessageLen) + " chars)";
        return false;
    }
    return true;
}

// ============================= SendMessage ===================================

void MessageServiceImpl::SendMessage(
        ::google::protobuf::RpcController* controller,
        const ::nova::message::SendMessageReq* request,
        ::nova::message::SendMessageResp* response,
        ::google::protobuf::Closure* done) {
    brpc::ClosureGuard done_guard(done);
    auto* cntl = static_cast<brpc::Controller*>(controller);

    NOVA_LOG_INFO << "SendMessage from=" << request->from_peer().id()
                  << " to_peer_type=" << request->to_peer().type()
                  << " to_peer_id=" << request->to_peer().id();

    // --- 参数校验 ---
    std::string error;
    if (!ValidateSendRequest(request, &error)) {
        response->set_error_code(::nova::common::MESSAGE_EMPTY);
        response->set_error_message(error);
        return;
    }

    // --- 构建消息记录 ---
    MessageRecord record;
    record.message_id     = snowflake_->NextId();
    record.from_peer_type = request->from_peer().type();
    record.from_peer_id   = request->from_peer().id();
    record.to_peer_type   = request->to_peer().type();
    record.to_peer_id     = request->to_peer().id();
    record.msg_type       = static_cast<int32_t>(request->msg_type());
    record.text           = request->text();
    record.reply_to_msg_id = request->reply_to_msg_id();
    record.is_silent      = request->is_silent();

    // --- Phase 3: idempotency_key 去重 ---
    std::string idempotency_key = request->idempotency_key();

    // --- 存储 ---
    auto stored = dao_->SaveMessage(record, idempotency_key);
    if (!stored) {
        // 重复消息 (idempotency_key 已存在) — 返回成功但标记非新
        if (!idempotency_key.empty() && dao_->IsDuplicate(idempotency_key)) {
            response->set_error_code(::nova::common::OK);
            response->set_is_new(false);
            NOVA_LOG_INFO << "Message dedup: idempotency_key already processed";
            return;
        }
        response->set_error_code(::nova::common::INTERNAL_ERROR);
        response->set_error_message("Failed to store message");
        return;
    }

    response->set_is_new(true);

    // --- 填充响应 ---
    response->set_error_code(::nova::common::OK);
    auto* msg = response->mutable_message();
    msg->set_message_id(stored->message_id);
    msg->mutable_from_peer()->set_type(
        static_cast<::nova::common::PeerType>(stored->from_peer_type));
    msg->mutable_from_peer()->set_id(stored->from_peer_id);
    msg->mutable_to_peer()->set_type(
        static_cast<::nova::common::PeerType>(stored->to_peer_type));
    msg->mutable_to_peer()->set_id(stored->to_peer_id);
    msg->set_type(static_cast<::nova::common::MessageType>(stored->msg_type));
    msg->set_text(stored->text);
    msg->set_created_at(stored->created_at);

    NOVA_LOG_INFO << "Message stored: msg_id=" << stored->message_id
                  << " is_silent=" << request->is_silent()
                  << " to_peer_type=" << static_cast<int>(request->to_peer().type())
                  << " PEER_TYPE_USER=" << static_cast<int>(::nova::common::PEER_TYPE_USER);

    // --- Phase 2.5: 推送给接收者 ---
    if (!request->is_silent() && request->to_peer().type() == ::nova::common::PEER_TYPE_USER) {
        NOVA_LOG_INFO << "PushDispatcher: Triggering push to user " << request->to_peer().id();
        ::nova::common::Update update;
        update.set_type(::nova::common::UPDATE_NEW_MESSAGE);
        // 传递消息 ID + peer 信息, 客户端据此拉取完整消息
        auto* new_msg = update.mutable_new_message();
        new_msg->set_message_id(stored->message_id);
        new_msg->mutable_from_peer()->CopyFrom(request->from_peer());
        new_msg->mutable_to_peer()->CopyFrom(request->to_peer());
        new_msg->set_text(stored->text);
        new_msg->set_created_at(stored->created_at);

        push_->PushToUser(request->to_peer().id(), update);
    }
}

// ============================= GetMessages ===================================

void MessageServiceImpl::GetMessages(
        ::google::protobuf::RpcController* controller,
        const ::nova::message::GetMessagesReq* request,
        ::nova::message::GetMessagesResp* response,
        ::google::protobuf::Closure* done) {
    brpc::ClosureGuard done_guard(done);

    NOVA_VLOG(1) << "GetMessages peer_type=" << request->peer().type()
                 << " peer_id=" << request->peer().id()
                 << " limit=" << request->limit()
                 << " offset_id=" << request->offset_id();

    // --- 参数校验 ---
    if (!request->has_peer() ||
        request->peer().type() == ::nova::common::PEER_TYPE_UNKNOWN) {
        response->set_error_code(::nova::common::PEER_NOT_FOUND);
        response->set_error_message("Invalid peer");
        return;
    }

    int32_t limit = request->limit();
    if (limit <= 0 || limit > 100) limit = 20;

    // --- 查询 ---
    auto records = dao_->GetMessages(
        static_cast<int32_t>(request->peer().type()),
        request->peer().id(),
        limit,
        request->offset_id());

    // --- 填充响应 ---
    response->set_error_code(::nova::common::OK);
    for (const auto& rec : records) {
        auto* msg = response->add_messages();
        msg->set_message_id(rec.message_id);
        msg->mutable_from_peer()->set_type(
            static_cast<::nova::common::PeerType>(rec.from_peer_type));
        msg->mutable_from_peer()->set_id(rec.from_peer_id);
        msg->mutable_to_peer()->set_type(
            static_cast<::nova::common::PeerType>(rec.to_peer_type));
        msg->mutable_to_peer()->set_id(rec.to_peer_id);
        msg->set_type(static_cast<::nova::common::MessageType>(rec.msg_type));
        msg->set_text(rec.text);
        msg->set_created_at(rec.created_at);
    }
    response->set_has_more(
        static_cast<int32_t>(records.size()) >= limit);

    NOVA_VLOG(1) << "GetMessages returned " << records.size() << " messages";
}

// ============================= AckMessage (Phase 3) ===========================

void MessageServiceImpl::AckMessage(
        ::google::protobuf::RpcController* controller,
        const ::nova::message::AckMessageReq* request,
        ::nova::message::AckMessageResp* response,
        ::google::protobuf::Closure* done) {
    brpc::ClosureGuard done_guard(done);

    NOVA_LOG_INFO << "AckMessage user=" << request->user_id()
                  << " peer=(" << request->peer().type()
                  << "," << request->peer().id() << ")"
                  << " max_ack_msg_id=" << request->max_ack_msg_id()
                  << " status=" << static_cast<int>(request->status());

    if (!request->has_peer() || request->max_ack_msg_id() <= 0) {
        response->set_error_code(::nova::common::MESSAGE_ID_INVALID);
        response->set_error_message("Invalid peer or max_ack_msg_id");
        return;
    }

    int status = request->status() == ::nova::common::MESSAGE_STATUS_READ ? 3 : 2;
    int updated = dao_->AckMessages(
        static_cast<int32_t>(request->peer().type()),
        request->peer().id(),
        request->max_ack_msg_id(), status);

    response->set_error_code(::nova::common::OK);
    NOVA_LOG_INFO << "AckMessage: " << updated << " messages acknowledged";
}

// ============================= GetSyncState (Phase 3) ========================

void MessageServiceImpl::GetSyncState(
        ::google::protobuf::RpcController* controller,
        const ::nova::message::GetSyncStateReq* request,
        ::nova::message::GetSyncStateResp* response,
        ::google::protobuf::Closure* done) {
    brpc::ClosureGuard done_guard(done);

    NOVA_LOG_INFO << "GetSyncState user=" << request->user_id();

    std::vector<std::pair<int32_t, int64_t>> peers;
    for (const auto& ps : request->peer_states()) {
        peers.emplace_back(1, ps.pts());  // PEER_TYPE_USER=1, 用 pts 存 peer_id
    }

    auto states = dao_->GetSyncStates(peers);

    response->set_error_code(::nova::common::OK);
    for (const auto& s : states) {
        auto* ss = response->add_updated_states();
        ss->set_pts(s.latest_msg_id);
        ss->set_seq(s.unread_count);
        ss->set_date(s.last_ack_msg_id);
    }

    NOVA_LOG_INFO << "GetSyncState returned " << states.size() << " peer states";
}

}  // namespace message
}  // namespace nova
