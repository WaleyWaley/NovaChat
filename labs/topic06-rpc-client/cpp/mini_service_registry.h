#pragma once

#include <map>
#include <string>

namespace lab {

/** 一个后端服务的注册信息 */
struct ServiceInfo {
    std::string name;               // "user-service"
    std::string url;                // "http://127.0.0.1:8001"
    std::string full_service_name;  // "nova.user.UserService" (用于拼 bRPC 端点)
};

/**
 * 服务注册表 (对应网关 gateway/src/clients/service_registry.ts)
 *
 * Phase 1: 硬编码地址; 生产环境可换成 Consul/Etcd。
 */
class MiniServiceRegistry {
 public:
    MiniServiceRegistry();

    /** 获取服务 URL; 未注册则抛 std::runtime_error */
    std::string get_url(const std::string& name) const;

    /** 获取完整 Protobuf 服务名; 未注册则抛 std::runtime_error */
    std::string get_full_service_name(const std::string& name) const;

 private:
    std::map<std::string, ServiceInfo> registry_;
};

}  // namespace lab
