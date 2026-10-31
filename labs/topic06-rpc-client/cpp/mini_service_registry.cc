#include "mini_service_registry.h"

#include <stdexcept>

namespace lab {

MiniServiceRegistry::MiniServiceRegistry() {
    //   registry_["user-service"]    = { "user-service",    "http://127.0.0.1:8001", "nova.user.UserService" };
    //   registry_["message-service"] = { "message-service", "http://127.0.0.1:8002", "nova.message.MessageService" };
    ServiceInfo user_;
    user_.full_service_name = "nova.user.UserService";
    user_.name = "user-service";
    user_.url = "http://127.0.0.1:8001";
    registry_.insert({"user-service", user_});

    ServiceInfo message_;
    message_.full_service_name = "nova.message.MessageService";
    message_.name = "message-service";
    message_.url = "http://127.0.0.1:8002";
    registry_.insert({"message-service",message_});
}

std::string MiniServiceRegistry::get_url(const std::string& name) const {
    auto it = registry_.find(name);
    if(it == registry_.end())
        throw std::runtime_error("service not found: " + name);
    return it->second.url;
}

std::string MiniServiceRegistry::get_full_service_name(const std::string& name) const {
    auto it = registry_.find(name);
    if(it == registry_.end())
        throw std::runtime_error("service not found: " + name);
    return it->second.full_service_name;
}

}  // namespace lab
