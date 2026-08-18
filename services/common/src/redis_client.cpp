// =============================================================================
// NovaChat — Redis 客户端实现 (Phase 2: 基于 brpc::Channel + RESP 协议)
//
// 底层: brpc::Channel 以 brpc::PROTOCOL_REDIS 模式连接 Redis
// 命令: 手动构建 RESP (REdis Serialization Protocol) 编码
// 响应: 手动解析 RESP 返回值
//
// 参考:
//   RESP 规范: https://redis.io/docs/latest/develop/reference/protocol-spec/
//   bRPC Redis: https://github.com/apache/brpc/blob/master/docs/en/redis_client.md
// =============================================================================

#include "nova/redis_client.h"
#include "nova/logger.h"

#include <sstream>
#include <vector>
#include <cstring>
#include <cstdlib>

namespace nova {

// ============================= RESP 编码器 ====================================
//
// Redis 命令统一编码为 Array of Bulk Strings:
//   SET key value          → *3\r\n$3\r\nSET\r\n$3\r\nkey\r\n$5\r\nvalue\r\n
//   GET key                → *2\r\n$3\r\nGET\r\n$3\r\nkey\r\n
//   DEL key1 key2          → *3\r\n$3\r\nDEL\r\n$4\r\nkey1\r\n$4\r\nkey2\r\n
//   EXPIRE key 300         → *3\r\n$6\r\nEXPIRE\r\n$3\r\nkey\r\n$3\r\n300\r\n
//   SET key val EX 300     → *5\r\n$3\r\nSET\r\n$3\r\nkey\r\n$3\r\nval\r\n$2\r\nEX\r\n$3\r\n300\r\n

namespace {

// 编码单个 Bulk String: $<len>\r\n<data>\r\n
std::string RespBulkString(const std::string& s) {
    std::string result;
    result.reserve(16 + s.size());
    result.append("$");
    result.append(std::to_string(s.size()));
    result.append("\r\n");
    result.append(s);
    result.append("\r\n");
    return result;
}

// 编码整个命令 (Array of Bulk Strings)
// parts = {"SET", "mykey", "myvalue"}
// → *3\r\n$3\r\nSET\r\n$5\r\nmykey\r\n$7\r\nmyvalue\r\n
std::string RespCommand(const std::vector<std::string>& parts) {
    std::string cmd;
    cmd.reserve(64);
    cmd.append("*");
    cmd.append(std::to_string(parts.size()));
    cmd.append("\r\n");
    for (const auto& p : parts) {
        cmd.append(RespBulkString(p));
    }
    return cmd;
}

}  // anonymous namespace

// ============================= 初始化 =========================================

bool RedisClient::Init(const std::string& addr, int port,
                       const std::string& password) {
    brpc::ChannelOptions options;
    options.protocol = brpc::PROTOCOL_REDIS;
    // Redis 协议是请求-响应模型, 短连接或长连接均可
    options.connection_type = brpc::CONNECTION_TYPE_POOLED;

    std::string server_addr = addr + ":" + std::to_string(port);
    if (channel_.Init(server_addr.c_str(), &options) != 0) {
        NOVA_LOG_ERROR << "RedisClient: Failed to init channel to " << server_addr;
        return false;
    }

    // 如果有密码, 发送 AUTH 命令
    if (!password.empty()) {
        std::string reply;
        butil::Status st = SendCommand(RespCommand({"AUTH", password}), &reply);
        if (!st.ok()) {
            NOVA_LOG_ERROR << "RedisClient: AUTH failed: " << st.error_str();
            return false;
        }
        if (reply.size() < 1 || reply[0] != '+') {
            NOVA_LOG_ERROR << "RedisClient: AUTH rejected: " << reply;
            return false;
        }
    }

    ready_ = true;
    NOVA_LOG_INFO << "RedisClient: Connected to " << server_addr
                  << (password.empty() ? "" : " (auth OK)");
    return true;
}

// ============================= RESP 响应解析 ==================================

// 解析简化的 RESP 响应:
//   +OK\r\n            → "+OK"           (Simple String)
//   -ERR msg\r\n       → "-ERR msg"      (Error)
//   :123\r\n           → ":123"          (Integer)
//   $5\r\nhello\r\n    → "hello"         (Bulk String — 提取内容)
//   $-1\r\n            → ""              (Null Bulk String → 空字符串)
//   *N\r\n...          → "*N..."         (Array —保留原始)

namespace {

// 读取 RESP 中的 Bulk String 内容 (跳过 $len\r\n, 返回 data)
// 返回 true 表示成功解析, data 被填充 (空字符串可能表示 nil)
bool ParseBulkStringContent(const std::string& raw, size_t* pos,
                            std::string* data) {
    if (*pos >= raw.size() || raw[*pos] != '$') return false;

    // 跳过 '$'
    size_t p = *pos + 1;

    // 读取长度
    if (raw[p] == '-') {
        // $-1\r\n → null
        while (p < raw.size() && raw[p] != '\n') p++;
        *pos = p + 1;
        data->clear();
        return true;  // nil → 空字符串
    }

    int len = 0;
    while (p < raw.size() && raw[p] >= '0' && raw[p] <= '9') {
        len = len * 10 + (raw[p] - '0');
        p++;
    }
    if (p >= raw.size() || raw[p] != '\r') return false;
    p++; // skip \r
    if (p >= raw.size() || raw[p] != '\n') return false;
    p++; // skip \n → now at data start

    if (p + len + 2 > raw.size()) return false;  // incomplete

    data->assign(raw.substr(p, len));
    *pos = p + len + 2;  // skip data + \r\n
    return true;
}

// 检查 RESP 响应是否表示成功 (+OK 或 :1 或 Bulk String)
bool IsRespOk(const std::string& reply) {
    if (reply.empty()) return false;
    char first = reply[0];
    return first == '+' || first == ':' || first == '$';
}

// 检查 RESP 响应是否表示错误
bool IsRespError(const std::string& reply) {
    return !reply.empty() && reply[0] == '-';
}

}  // anonymous namespace

// ============================= SendCommand ====================================

butil::Status RedisClient::SendCommand(const std::string& cmd,
                                       std::string* reply) {
    if (!ready_) {
        return butil::Status(-1, "Redis client not initialized");
    }

    brpc::Controller cntl;
    cntl.request_attachment().append(cmd);

    channel_.CallMethod(nullptr, &cntl, nullptr, nullptr, nullptr);

    if (cntl.Failed()) {
        return butil::Status(-1, "Redis RPC failed: " + cntl.ErrorText());
    }

    reply->assign(cntl.response_attachment().to_string());

    if (IsRespError(*reply)) {
        // 去掉 \r\n
        std::string err = *reply;
        while (!err.empty() && (err.back() == '\r' || err.back() == '\n'))
            err.pop_back();
        return butil::Status(-1, "Redis error: " + err);
    }

    return butil::Status::OK();
}

// ============================= Key/Value 操作 ================================

butil::Status RedisClient::Set(const std::string& key, const std::string& value,
                               int ttl_sec) {
    std::vector<std::string> parts = {"SET", key, value};
    if (ttl_sec > 0) {
        parts.push_back("EX");
        parts.push_back(std::to_string(ttl_sec));
    }
    std::string reply;
    butil::Status st = SendCommand(RespCommand(parts), &reply);
    if (!st.ok()) return st;

    if (IsRespOk(reply)) return butil::Status::OK();
    return butil::Status(-1, "SET failed: " + reply);
}

butil::Status RedisClient::Get(const std::string& key, std::string* value) {
    std::string reply;
    butil::Status st = SendCommand(RespCommand({"GET", key}), &reply);
    if (!st.ok()) return st;

    // GET 返回: $<len>\r\n<value>\r\n 或 $-1\r\n (key 不存在)
    size_t pos = 0;
    if (!ParseBulkStringContent(reply, &pos, value)) {
        return butil::Status(-1, "GET parse error: " + reply);
    }
    // 如果 value 为空且 reply 是 $-1 → key 不存在
    if (value->empty() && reply.size() >= 3 && reply.substr(0, 3) == "$-1") {
        return butil::Status(-1, "Key not found: " + key);
    }
    return butil::Status::OK();
}

butil::Status RedisClient::Del(const std::string& key) {
    std::string reply;
    // DEL 支持多个 key, 但我们只用单个
    butil::Status st = SendCommand(RespCommand({"DEL", key}), &reply);
    if (!st.ok()) return st;

    // DEL 返回 :N (删除的 key 数量)
    if (reply[0] == ':') return butil::Status::OK();
    return butil::Status(-1, "DEL failed: " + reply);
}

butil::Status RedisClient::Exists(const std::string& key, bool* exists) {
    std::string reply;
    butil::Status st = SendCommand(RespCommand({"EXISTS", key}), &reply);
    if (!st.ok()) {
        // key 不存在是正常情况, 不是错误
        *exists = false;
        return butil::Status::OK();
    }

    // EXISTS 返回 :1 或 :0
    if (!reply.empty() && reply[0] == ':') {
        *exists = (reply.size() >= 2 && reply[1] == '1');
        return butil::Status::OK();
    }
    *exists = false;
    return butil::Status::OK();
}

butil::Status RedisClient::Expire(const std::string& key, int ttl_sec) {
    std::string reply;
    butil::Status st = SendCommand(
        RespCommand({"EXPIRE", key, std::to_string(ttl_sec)}), &reply);
    if (!st.ok()) return st;

    if (reply[0] == ':') return butil::Status::OK();
    return butil::Status(-1, "EXPIRE failed: " + reply);
}

butil::Status RedisClient::TTL(const std::string& key, int64_t* ttl) {
    std::string reply;
    butil::Status st = SendCommand(RespCommand({"TTL", key}), &reply);
    if (!st.ok()) return st;

    // TTL 返回 :seconds 或 :-1 (永不过期) 或 :-2 (key 不存在)
    if (!reply.empty() && reply[0] == ':') {
        *ttl = std::strtoll(reply.c_str() + 1, nullptr, 10);
        return butil::Status::OK();
    }
    return butil::Status(-1, "TTL parse error: " + reply);
}

// ============================= Hash 操作 =====================================

butil::Status RedisClient::HSet(const std::string& key, const std::string& field,
                                const std::string& value) {
    std::string reply;
    butil::Status st = SendCommand(
        RespCommand({"HSET", key, field, value}), &reply);
    if (!st.ok()) return st;
    if (reply[0] == ':') return butil::Status::OK();
    return butil::Status(-1, "HSET failed: " + reply);
}

butil::Status RedisClient::HGet(const std::string& key, const std::string& field,
                                std::string* value) {
    std::string reply;
    butil::Status st = SendCommand(
        RespCommand({"HGET", key, field}), &reply);
    if (!st.ok()) return st;

    size_t pos = 0;
    if (!ParseBulkStringContent(reply, &pos, value)) {
        return butil::Status(-1, "HGET parse error: " + reply);
    }
    return butil::Status::OK();
}

butil::Status RedisClient::HDel(const std::string& key, const std::string& field) {
    std::string reply;
    butil::Status st = SendCommand(
        RespCommand({"HDEL", key, field}), &reply);
    if (!st.ok()) return st;
    if (reply[0] == ':') return butil::Status::OK();
    return butil::Status(-1, "HDEL failed: " + reply);
}

butil::Status RedisClient::HGetAll(const std::string& key,
                                   std::map<std::string, std::string>* result) {
    std::string reply;
    butil::Status st = SendCommand(
        RespCommand({"HGETALL", key}), &reply);
    if (!st.ok()) return st;

    // HGETALL 返回 Array: *<2N>\r\n$<len>\r\n<field>\r\n$<len>\r\n<value>\r\n...
    // 简化解析: 跳过 *N, 逐个读取 Bulk String
    if (reply.empty() || reply[0] != '*') {
        // 空 hash 返回 *0
        if (reply == "*0\r\n") return butil::Status::OK();
        return butil::Status(-1, "HGETALL parse error: " + reply);
    }

    size_t pos = 1;  // 跳过 '*'
    // 跳过数组长度数字
    while (pos < reply.size() && reply[pos] >= '0' && reply[pos] <= '9') pos++;
    if (pos < reply.size() && reply[pos] == '\r') pos++;
    if (pos < reply.size() && reply[pos] == '\n') pos++;

    result->clear();
    while (pos < reply.size()) {
        std::string field, value;
        if (!ParseBulkStringContent(reply, &pos, &field)) break;
        if (!ParseBulkStringContent(reply, &pos, &value)) break;
        if (!field.empty() || reply.find("$-1", pos - 10) == std::string::npos) {
            (*result)[field] = value;
        }
    }
    return butil::Status::OK();
}

// ============================= Set 操作 ======================================

butil::Status RedisClient::SAdd(const std::string& key, const std::string& member) {
    std::string reply;
    butil::Status st = SendCommand(
        RespCommand({"SADD", key, member}), &reply);
    if (!st.ok()) return st;
    if (reply[0] == ':') return butil::Status::OK();
    return butil::Status(-1, "SADD failed: " + reply);
}

butil::Status RedisClient::SRem(const std::string& key, const std::string& member) {
    std::string reply;
    butil::Status st = SendCommand(
        RespCommand({"SREM", key, member}), &reply);
    if (!st.ok()) return st;
    if (reply[0] == ':') return butil::Status::OK();
    return butil::Status(-1, "SREM failed: " + reply);
}

butil::Status RedisClient::SIsMember(const std::string& key, const std::string& member,
                                     bool* is_member) {
    std::string reply;
    butil::Status st = SendCommand(
        RespCommand({"SISMEMBER", key, member}), &reply);
    if (!st.ok()) {
        *is_member = false;
        return butil::Status::OK();
    }

    // SISMEMBER 返回 :1 或 :0
    *is_member = (!reply.empty() && reply[0] == ':' &&
                  reply.size() >= 2 && reply[1] == '1');
    return butil::Status::OK();
}

butil::Status RedisClient::SMembers(const std::string& key,
                                    std::vector<std::string>* members) {
    std::string reply;
    butil::Status st = SendCommand(
        RespCommand({"SMEMBERS", key}), &reply);
    if (!st.ok()) return st;

    // SMEMBERS 返回 Array of Bulk Strings
    if (reply.empty() || reply[0] != '*') {
        if (reply == "*0\r\n") return butil::Status::OK();
        return butil::Status(-1, "SMEMBERS parse error: " + reply);
    }

    size_t pos = 1;
    while (pos < reply.size() && reply[pos] >= '0' && reply[pos] <= '9') pos++;
    if (pos < reply.size() && reply[pos] == '\r') pos++;
    if (pos < reply.size() && reply[pos] == '\n') pos++;

    members->clear();
    while (pos < reply.size()) {
        std::string member;
        if (!ParseBulkStringContent(reply, &pos, &member)) break;
        members->push_back(member);
    }
    return butil::Status::OK();
}

}  // namespace nova
