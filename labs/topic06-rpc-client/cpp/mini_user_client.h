#pragma once

#include <string>

#include "json.hpp"
#include "mini_brpc_client.h"
#include "mini_service_registry.h"

namespace lab {

/**
 * UserService 客户端 (对应网关 gateway/src/clients/user_client.ts)
 *
 * 每个方法构造请求 JSON → MiniBrpcClient::call → 返回响应 JSON。
 * 入参/出参字段与 proto/nova/user/user.proto 对齐。
 */
class MiniUserClient {
 public:
    MiniUserClient();

    /** Register: 注册新用户, 返回 { error_code, user_id, user } */
    nlohmann::json register_user(const std::string& username,
                                 const std::string& password,
                                 const std::string& first_name,
                                 const std::string& last_name = "");

    /** Login: 登录, 返回 { error_code, user } */
    nlohmann::json login(const std::string& username,
                         const std::string& password,
                         const std::string& device_type = "desktop");

    /** GetUserProfile (按 user_id) */
    nlohmann::json get_user_profile_by_id(long long user_id);

    /** GetUserProfile (按 username) */
    nlohmann::json get_user_profile_by_username(const std::string& username);

 private:
    MiniServiceRegistry registry_;
    MiniBrpcClient client_;
};

}  // namespace lab
