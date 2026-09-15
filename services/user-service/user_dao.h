#pragma once

// =============================================================================
// NovaChat — UserDao (用户数据访问层)
//
// Phase 1: 内存模拟存储 (std::unordered_map)
// Phase 2: MySQL 真实持久化
//
// 注: 会话/Redis 已移除 — 鉴权统一由网关负责 (BFF 模式), 本层只存用户数据。
// =============================================================================

#include <string>
#include <vector>
#include <unordered_map>
#include <mutex>
#include <optional>

#include "nova/common.h"
#include "nova/mysql_pool.h"

// proto 生成的头文件
#include "nova/common/common.pb.h"
#include "nova/user/user.pb.h"

namespace nova {
namespace user {

// 内部存储的用户记录
struct UserRecord {
    int64_t  user_id;
    std::string username;
    std::string password_hash;   // 
    std::string first_name;
    std::string last_name;
    std::string bio;
    std::string avatar_photo_id;
    std::string phone;
    int64_t  created_at;
    int64_t  updated_at;
    int64_t  username_changed_at;  // 上次修改 username 的时间 (限制修改频率)
    bool     is_deleted = false;
};

class UserDao {
public:
    UserDao() = default;
    ~UserDao() = default;

    UserDao(const UserDao&) = delete;
    UserDao& operator=(const UserDao&) = delete;

    // ==================== 初始化 (Phase 2) ====================
    // Phase 2: 初始化 MySQL 连接池
    bool InitMySql(const std::string& addr, int port,
                   const std::string& user, const std::string& passwd,
                   const std::string& db, int pool_size = 8);

    // ==================== 用户 CRUD ====================

    // 创建用户, 返回新 user_id (Phase 2: 改由 Snowflake 预生成后传入)
    std::optional<UserRecord> CreateUser(const std::string& username,
                                         const std::string& password_hash,
                                         const std::string& first_name,
                                         const std::string& last_name,
                                         const std::string& phone,
                                         int64_t user_id,
                                         int64_t created_at);

    // 按 ID 查找用户
    std::optional<UserRecord> FindById(int64_t user_id);

    // 按 username 查找用户
    std::optional<UserRecord> FindByUsername(const std::string& username);

    // 更新用户资料 (只更新非空字段)
    bool UpdateProfile(int64_t user_id,
                       const std::string& first_name,
                       const std::string& last_name,
                       const std::string& bio,
                       const std::string& avatar_photo_id,
                       int64_t updated_at);

    // 修改用户名
    bool ChangeUsername(int64_t user_id, const std::string& new_username,
                        int64_t updated_at);

    // 修改密码
    bool ChangePassword(int64_t user_id, const std::string& new_password_hash,
                        int64_t updated_at);

    // 删除用户 (软删除)
    bool DeleteUser(int64_t user_id);

    // 检查用户名是否已存在
    bool UsernameExists(const std::string& username);

    // 搜索用户 (前缀匹配 username 或 first_name)
    std::vector<UserRecord> SearchUsers(const std::string& query,
                                        int32_t limit, int64_t offset_id);

    // 批量获取用户
    std::vector<UserRecord> GetUsersByIds(const std::vector<int64_t>& user_ids);

    // ==================== 工具 ====================

    // Phase 2: MySQL 连接是否就绪
    bool IsStorageReady() const { return mysql_ != nullptr; }

    // 当前存储模式
    std::string StorageMode() const {
        return IsStorageReady() ? "mysql" : "in-memory (Phase 1)";
    }

private:
    // Phase 1: 内存存储
    std::unordered_map<int64_t, UserRecord>    users_by_id_;
    std::unordered_map<std::string, int64_t>   users_by_username_;  // username → user_id
    std::mutex mu_;

    int64_t next_user_id_ = 1000;  // Phase 1 简单自增 (Phase 2 由 Snowflake 替代)

    // Phase 2: 持久化存储 (unique_ptr for optional ownership)
    std::unique_ptr<nova::MySqlPool>  mysql_;
};

}  // namespace user
}  // namespace nova
