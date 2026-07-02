// =============================================================================
// NovaChat — Redis 客户端实现 (Phase 1 stub)
//
// Phase 1: 桩实现 — 所有方法返回错误, user-service 使用内存存储
// Phase 2: 完整实现, 基于 brpc::Channel PROTOCOL_REDIS
// =============================================================================

#include "nova/redis_client.h"
#include "nova/logger.h"

namespace nova {

bool RedisClient::Init(const std::string& addr, int port,
                       const std::string& password) {
    (void)addr; (void)port; (void)password;
    NOVA_LOG_INFO << "RedisClient stub initialized (Phase 2 will connect to " << addr << ":" << port << ")";
    ready_ = true;
    return true;
}

butil::Status RedisClient::Set(const std::string& key, const std::string& value, int ttl_sec) {
    (void)key; (void)value; (void)ttl_sec;
    return butil::Status(-1, "Redis not available in Phase 1");
}

butil::Status RedisClient::Get(const std::string& key, std::string* value) {
    (void)key; (void)value;
    return butil::Status(-1, "Redis not available in Phase 1");
}

butil::Status RedisClient::Del(const std::string& key) {
    (void)key;
    return butil::Status(-1, "Redis not available in Phase 1");
}

butil::Status RedisClient::Exists(const std::string& key, bool* exists) {
    (void)key; (void)exists;
    return butil::Status(-1, "Redis not available in Phase 1");
}

butil::Status RedisClient::Expire(const std::string& key, int ttl_sec) {
    (void)key; (void)ttl_sec;
    return butil::Status(-1, "Redis not available in Phase 1");
}

butil::Status RedisClient::TTL(const std::string& key, int64_t* ttl) {
    (void)key; (void)ttl;
    return butil::Status(-1, "Redis not available in Phase 1");
}

butil::Status RedisClient::HSet(const std::string& key, const std::string& field, const std::string& value) {
    (void)key; (void)field; (void)value;
    return butil::Status(-1, "Redis not available in Phase 1");
}

butil::Status RedisClient::HGet(const std::string& key, const std::string& field, std::string* value) {
    (void)key; (void)field; (void)value;
    return butil::Status(-1, "Redis not available in Phase 1");
}

butil::Status RedisClient::HDel(const std::string& key, const std::string& field) {
    (void)key; (void)field;
    return butil::Status(-1, "Redis not available in Phase 1");
}

butil::Status RedisClient::HGetAll(const std::string& key,
                                    std::map<std::string, std::string>* result) {
    (void)key; (void)result;
    return butil::Status(-1, "Redis not available in Phase 1");
}

butil::Status RedisClient::SAdd(const std::string& key, const std::string& member) {
    (void)key; (void)member;
    return butil::Status(-1, "Redis not available in Phase 1");
}

butil::Status RedisClient::SRem(const std::string& key, const std::string& member) {
    (void)key; (void)member;
    return butil::Status(-1, "Redis not available in Phase 1");
}

butil::Status RedisClient::SIsMember(const std::string& key, const std::string& member, bool* is_member) {
    (void)key; (void)member; (void)is_member;
    return butil::Status(-1, "Redis not available in Phase 1");
}

butil::Status RedisClient::SMembers(const std::string& key, std::vector<std::string>* members) {
    (void)key; (void)members;
    return butil::Status(-1, "Redis not available in Phase 1");
}

}  // namespace nova
