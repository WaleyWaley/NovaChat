// =============================================================================
// NovaChat — PushDispatcher 实现 (Phase 2.5: HTTP 推送)
// =============================================================================

#include "push_dispatcher.h"
#include "nova/logger.h"

#include <brpc/channel.h>
#include <google/protobuf/util/json_util.h>

namespace nova {
namespace message {

PushDispatcher::PushDispatcher() = default;

bool PushDispatcher::Init(const std::string& gateway_addr) {
    gateway_addr_ = gateway_addr;
    NOVA_LOG_INFO << "PushDispatcher: Gateway target = " << gateway_addr_;
    return true;
}

// ============================= PushToUser ====================================

bool PushDispatcher::PushToUser(int64_t user_id,
                                const ::nova::common::Update& update) {
    ::nova::gateway::PushUpdateReq req;
    req.set_target_user_id(user_id);
    req.mutable_update()->CopyFrom(update);

    bool ok = CallGatewayPush(req);
    if (ok) {
        NOVA_LOG_INFO << "PushDispatcher: Pushed to user " << user_id;
    }
    return ok;
}

// ============================= PushToUsers ===================================

std::pair<int, int> PushDispatcher::PushToUsers(
        const std::vector<int64_t>& user_ids,
        const ::nova::common::Update& update) {
    int delivered = 0, missed = 0;
    for (auto uid : user_ids) {
        if (PushToUser(uid, update)) {
            delivered++;
        } else {
            missed++;
        }
    }
    return {delivered, missed};
}

// ============================= CallGatewayPush ===============================

bool PushDispatcher::CallGatewayPush(
        const ::nova::gateway::PushUpdateReq& req) {
    if (gateway_addr_.empty()) {
        NOVA_LOG_WARN << "PushDispatcher: No gateway target configured";
        return false;
    }

    // Serialize to JSON
    std::string json_body;
    google::protobuf::util::JsonPrintOptions json_opts;
    json_opts.always_print_primitive_fields = true;
    auto status = google::protobuf::util::MessageToJsonString(req, &json_body, json_opts);
    if (!status.ok()) {
        NOVA_LOG_ERROR << "PushDispatcher: JSON serialize failed";
        return false;
    }

    // bRPC HTTP Channel → 网关 PushService
    brpc::Channel channel;
    brpc::ChannelOptions options;
    options.protocol = brpc::PROTOCOL_HTTP;
    options.timeout_ms = 3000;
    options.max_retry = 1;

    if (channel.Init(gateway_addr_.c_str(), &options) != 0) {
        NOVA_LOG_INFO << "PushDispatcher: Cannot reach gateway at " << gateway_addr_;
        return false;
    }

    brpc::Controller cntl;
    cntl.http_request().uri() = "/nova.gateway.PushService/PushUpdate";
    cntl.http_request().set_method(brpc::HTTP_METHOD_POST);
    cntl.http_request().SetHeader("Content-Type", "application/json");
    cntl.request_attachment().append(json_body);

    channel.CallMethod(nullptr, &cntl, nullptr, nullptr, nullptr);

    if (cntl.Failed()) {
        NOVA_LOG_INFO << "PushDispatcher: Gateway push failed: " << cntl.ErrorText();
        return false;
    }

    NOVA_LOG_INFO << "PushDispatcher: Push delivered to gateway " << gateway_addr_;
    return true;
}

}  // namespace message
}  // namespace nova
