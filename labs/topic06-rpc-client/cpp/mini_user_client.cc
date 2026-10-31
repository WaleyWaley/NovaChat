#include "mini_user_client.h"

namespace lab {

MiniUserClient::MiniUserClient()
    : registry_(), client_(registry_.get_url("user-service")) {
    // 注意: 成员按声明顺序初始化 —— registry_ 先于 client_,
    //       所以这里 registry_.get_url(...) 已经可用。
}

nlohmann::json MiniUserClient::register_user(const std::string& username,
                                             const std::string& password,
                                             const std::string& first_name,
                                             const std::string& last_name) {

    nlohmann::json body = {{"username", username},
                           {"password", password},
                           {"first_name", first_name},
                           {"last_name", last_name}};
    return client_.call(registry_.get_full_service_name("user-service"), "Register", body);
}

nlohmann::json MiniUserClient::login(const std::string& username,
                                     const std::string& password,
                                     const std::string& device_type) {
    // TODO: 构造 LoginReq { username, password, device_type }, 调 "Login"
    nlohmann::json body = {
        {"username", username}, {"password", password}, {"device_type", device_type}
    };
    return client_.call(registry_.get_full_service_name("user-service"), "Login", body);
}

nlohmann::json MiniUserClient::get_user_profile_by_id(long long user_id) {
    // TODO: 构造 GetUserProfileReq { user_id }, 调 "GetUserProfile"
    nlohmann::json body = {
        {"user_id", user_id}
    };
    return client_.call(registry_.get_full_service_name("user-service"), "GetUserProfile", body);
}

nlohmann::json MiniUserClient::get_user_profile_by_username(const std::string& username) {
    // TODO: 构造 GetUserProfileReq { username }, 调 "GetUserProfile"
    nlohmann::json body = {
        {"username", username}
    };
    return client_.call(registry_.get_full_service_name("user-service"), "GetUserProfile", body);
}

}  // namespace lab
