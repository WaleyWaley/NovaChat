#pragma once

// =============================================================================
// NovaChat — Redis 客户端 (基于 brpc::Channel)
//
// bRPC 内置 Redis 协议支持 (brpc::PROTOCOL_REDIS):
//   brpc::Channel 初始化后, 调用 CallMethod 发送 Redis 命令,
//   自动挂载到 bthread, I/O 不阻塞 pthread.
//
// 使用场景:
//   - 在线路由表: user:online:<user_id> → gateway_addr
//   - Session 缓存: session:<token> → user_id
//   - 频率限制: rate:<user_id>:<action> → count
//   - 消息队列 (Phase 3)
// =============================================================================

#include <string>
#include <brpc/channel.h>
#include <butil/status.h>

namespace nova {

class RedisClient {
public:
    RedisClient() = default;
    ~RedisClient() = default;

    RedisClient(const RedisClient&) = delete;
    RedisClient& operator=(const RedisClient&) = delete;

    // 初始化 Redis 连接
    // addr:     Redis 地址 (IP 或域名)
    // port:     Redis 端口 (默认 6379)
    // password: Redis 密码 (空字符串表示无密码)
    bool Init(const std::string& addr, int port,
              const std::string& password = "");

    // ===================== Key/Value 操作 =====================

    // SET key value [EX ttl_sec]
    butil::Status Set(const std::string& key, const std::string& value,
                      int ttl_sec = 0);

    // GET key → value
    butil::Status Get(const std::string& key, std::string* value);

    // DEL key [key ...]
    butil::Status Del(const std::string& key);

    // EXISTS key → bool
    butil::Status Exists(const std::string& key, bool* exists);

    // EXPIRE key ttl_sec
    butil::Status Expire(const std::string& key, int ttl_sec);

    // TTL key → seconds (-1: 永不过期, -2: key 不存在)
    butil::Status TTL(const std::string& key, int64_t* ttl);

    // ===================== Hash 操作 =====================

    // HSET key field value
    butil::Status HSet(const std::string& key, const std::string& field,
                       const std::string& value);

    // HGET key field → value
    butil::Status HGet(const std::string& key, const std::string& field,
                       std::string* value);

    // HDEL key field
    butil::Status HDel(const std::string& key, const std::string& field);

    // HGETALL key → all field-value pairs
    butil::Status HGetAll(const std::string& key,
                          std::map<std::string, std::string>* result);

    // ===================== Set 操作 =====================

    // SADD key member
    butil::Status SAdd(const std::string& key, const std::string& member);

    // SREM key member
    butil::Status SRem(const std::string& key, const std::string& member);

    // SISMEMBER key member → bool
    butil::Status SIsMember(const std::string& key, const std::string& member,
                            bool* is_member);

    // SMEMBERS key → all members
    butil::Status SMembers(const std::string& key,
                           std::vector<std::string>* members);

    // ===================== 工具方法 =====================

    // 是否已初始化
    bool IsReady() const { return ready_; }

private:
    // 执行 Redis 命令 (底层: 通过 brpc::Channel 发送 RESP 协议)
    butil::Status SendCommand(const std::string& cmd, std::string* reply);

    brpc::Channel channel_;
    bool ready_ = false;
};

}  // namespace nova
