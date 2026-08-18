#pragma once

// =============================================================================
// NovaChat — PushDispatcher (Phase 2.5)
//
// 推送链路:
//   message-service → HTTP → 网关 PushService/PushUpdate → WebSocket → 用户
//
// 简化: 不查 Redis 在线路由表，直接向所有网关广播推送请求。
//       网关 PushService 自己判断用户是否在线。
// =============================================================================

#include <string>
#include <vector>
#include <cstdint>

#include "nova/common/common.pb.h"
#include "nova/gateway/push.pb.h"

namespace nova {
namespace message {

class PushDispatcher {
public:
    PushDispatcher();

    // 初始化
    bool Init(const std::string& gateway_addr);

    // 推送给单个用户
    bool PushToUser(int64_t user_id, const ::nova::common::Update& update);

    // 推送给多个用户
    std::pair<int, int> PushToUsers(
        const std::vector<int64_t>& user_ids,
        const ::nova::common::Update& update);

private:
    // HTTP POST 到网关 PushService
    bool CallGatewayPush(const ::nova::gateway::PushUpdateReq& req);

    std::string gateway_addr_;  // e.g. "gateway:3000"
};

}  // namespace message
}  // namespace nova
