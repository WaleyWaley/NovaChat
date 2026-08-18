// =============================================================================
// NovaChat — UserDao 实现
//
// Phase 2: 双模式存储
//   - MySQL 可用 → 用户数据持久化到 MySQL
//   - Redis 可用 → Session 数据缓存到 Redis (自动过期)
//   - 回退机制 → MySQL/Redis 不可用时使用内存存储 (Phase 1 兼容)
//
// Redis Session 格式:
//   sess:<refresh_token>     → "<user_id>|<expires_at>|<device_type>|<device_name>"
//   user_sess:<user_id>      → Set of <refresh_token>  (用于 DeleteAllSessions)
// =============================================================================

#include "user_dao.h"
#include "nova/logger.h"

#include <algorithm>
#include <cstring>
#include <sstream>
#include <vector>

namespace nova {
namespace user {

// ============================= 初始化 =========================================

bool UserDao::InitMySql(const std::string& addr, int port,
                        const std::string& user, const std::string& passwd,
                        const std::string& db, int pool_size) {
    mysql_ = std::make_unique<nova::MySqlPool>();
    if (!mysql_->Init(addr, port, user, passwd, db, pool_size)) {
        NOVA_LOG_ERROR << "UserDao: Failed to initialize MySQL pool";
        mysql_.reset();
        return false;
    }
    NOVA_LOG_INFO << "UserDao: MySQL pool ready (" << addr << ":" << port
                  << "/" << db << ")";
    return true;
}

bool UserDao::InitRedis(const std::string& addr, int port,
                        const std::string& password) {
    redis_ = std::make_unique<nova::RedisClient>();
    if (!redis_->Init(addr, port, password)) {
        NOVA_LOG_ERROR << "UserDao: Failed to initialize Redis client";
        redis_.reset();
        return false;
    }
    NOVA_LOG_INFO << "UserDao: Redis client ready (" << addr << ":" << port << ")";
    return true;
}

// ============================= Session 序列化 (Redis) =========================

namespace {

// 编码 Session 为 Redis Value 字符串
// 格式: "<user_id>|<expires_at>|<device_type>|<device_name>"
std::string EncodeSession(const SessionRecord& s) {
    std::ostringstream oss;
    oss << s.user_id << "|"
        << s.expires_at << "|"
        << s.device_type << "|"
        << s.device_name << "|"
        << s.created_at;
    return oss.str();
}

// 从 Redis Value 字符串解码 Session
// refresh_token 不在 value 中, 由调用方传入
std::optional<SessionRecord> DecodeSession(const std::string& refresh_token,
                                           const std::string& value) {
    if (value.empty()) return std::nullopt;

    std::vector<std::string> parts;
    std::stringstream ss(value);
    std::string part;
    while (std::getline(ss, part, '|')) {
        parts.push_back(part);
    }
    if (parts.size() < 4) return std::nullopt;

    SessionRecord s;
    s.refresh_token = refresh_token;
    s.user_id       = std::strtoll(parts[0].c_str(), nullptr, 10);
    s.expires_at    = std::strtoll(parts[1].c_str(), nullptr, 10);
    s.device_type   = parts[2];
    s.device_name   = parts.size() > 3 ? parts[3] : "";
    s.created_at    = parts.size() > 4 ? std::strtoll(parts[4].c_str(), nullptr, 10) : 0;
    return s;
}

// Redis key 前缀
constexpr const char* kSessionKeyPrefix  = "sess:";
constexpr const char* kUserSessKeyPrefix = "user_sess:";

std::string SessionKey(const std::string& refresh_token) {
    return kSessionKeyPrefix + refresh_token;
}

std::string UserSessKey(int64_t user_id) {
    return kUserSessKeyPrefix + std::to_string(user_id);
}

}  // anonymous namespace

// ============================= Session → Redis (或内存) =======================

void UserDao::CreateSession(const SessionRecord& session) {
    if (redis_ && redis_->IsReady()) {
        // Redis 模式
        std::string key = SessionKey(session.refresh_token);
        std::string val = EncodeSession(session);

        // TTL: session 过期时间 - 当前时间 (秒)
        int64_t now = std::chrono::duration_cast<std::chrono::seconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();
        int64_t ttl = (session.expires_at / 1000) - now;
        if (ttl < 1) ttl = 1;

        redis_->Set(key, val, static_cast<int>(ttl));
        redis_->SAdd(UserSessKey(session.user_id), session.refresh_token);
        // 用户 session set 也设置过期时间 (最后一次 session 过期后清理)
        redis_->Expire(UserSessKey(session.user_id),
                       static_cast<int>(nova::kRefreshTokenTTL));

        NOVA_VLOG(2) << "UserDao: Session saved to Redis (user="
                     << session.user_id << ", ttl=" << ttl << "s)";
    }

    // 内存回退 (始终保存, 作为 Redis 的本地缓存)
    {
        std::lock_guard<std::mutex> lock(mu_);
        sessions_[session.refresh_token] = session;
    }
}

std::optional<SessionRecord> UserDao::FindSession(
        const std::string& refresh_token) {
    // 优先 Redis
    if (redis_ && redis_->IsReady()) {
        std::string val;
        butil::Status st = redis_->Get(SessionKey(refresh_token), &val);
        if (st.ok() && !val.empty()) {
            auto session = DecodeSession(refresh_token, val);
            if (session) {
                // 检查是否过期
                int64_t now = std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::system_clock::now().time_since_epoch()).count();
                if (session->expires_at >= now) {
                    return session;
                }
                // 过期了, 清理
                DeleteSession(refresh_token);
                return std::nullopt;
            }
        }
    }

    // 回退内存
    std::lock_guard<std::mutex> lock(mu_);
    auto it = sessions_.find(refresh_token);
    if (it != sessions_.end()) {
        return it->second;
    }
    return std::nullopt;
}

void UserDao::DeleteSession(const std::string& refresh_token) {
    if (redis_ && redis_->IsReady()) {
        // 需要知道 user_id 才能从 Set 中删除
        std::string val;
        butil::Status st = redis_->Get(SessionKey(refresh_token), &val);
        if (st.ok() && !val.empty()) {
            auto session = DecodeSession(refresh_token, val);
            if (session) {
                redis_->SRem(UserSessKey(session->user_id), refresh_token);
            }
        }
        redis_->Del(SessionKey(refresh_token));
    }

    {
        std::lock_guard<std::mutex> lock(mu_);
        sessions_.erase(refresh_token);
    }
}

void UserDao::DeleteAllSessions(int64_t user_id) {
    if (redis_ && redis_->IsReady()) {
        // 获取用户所有 session token
        std::vector<std::string> tokens;
        butil::Status st = redis_->SMembers(UserSessKey(user_id), &tokens);
        if (st.ok()) {
            // 逐个删除 session
            for (const auto& token : tokens) {
                redis_->Del(SessionKey(token));
            }
        }
        // 删除 set 本身
        redis_->Del(UserSessKey(user_id));

        NOVA_VLOG(1) << "UserDao: Deleted " << tokens.size()
                     << " sessions from Redis for user " << user_id;
    }

    // 内存回退
    {
        std::lock_guard<std::mutex> lock(mu_);
        auto it = sessions_.begin();
        while (it != sessions_.end()) {
            if (it->second.user_id == user_id) {
                it = sessions_.erase(it);
            } else {
                ++it;
            }
        }
    }
}

// ============================= 用户 CRUD → MySQL (或内存) =====================

std::optional<UserRecord> UserDao::CreateUser(
        const std::string& username,
        const std::string& password_hash,
        const std::string& first_name,
        const std::string& last_name,
        const std::string& phone,
        int64_t user_id,
        int64_t created_at) {

    // --- MySQL 路径 ---
    if (mysql_ && mysql_->IsReady()) {
        // 先检查 username 唯一性 (MySQL 的 UNIQUE INDEX 也会检查,
        // 但提前查可以给出更友好的错误信息)
        if (UsernameExists(username)) {
            return std::nullopt;
        }

        // 转义单引号 (防 SQL 注入的最基本保护, Phase 3 改用 Prepared Statement)
        auto Escape = [](const std::string& s) -> std::string {
            std::string result;
            result.reserve(s.size() + 2);
            for (char c : s) {
                if (c == '\'') result += "\\'";
                else if (c == '\\') result += "\\\\";
                else result += c;
            }
            return result;
        };

        std::ostringstream sql;
        sql << "INSERT INTO users "
            << "(user_id, username, password_hash, first_name, last_name, "
            << "bio, avatar_photo_id, phone, is_deleted, "
            << "created_at, updated_at, username_changed_at) VALUES ("
            << user_id << ", "
            << "'" << Escape(username) << "', "
            << "'" << Escape(password_hash) << "', "
            << "'" << Escape(first_name) << "', "
            << "'" << Escape(last_name) << "', "
            << "'', '', "
            << "'" << Escape(phone) << "', "
            << "0, "
            << created_at << ", " << created_at << ", " << created_at
            << ")";

        butil::Status st = mysql_->Execute(sql.str());
        if (!st.ok()) {
            NOVA_LOG_ERROR << "UserDao: MySQL INSERT failed: " << st.error_str();
            return std::nullopt;
        }

        NOVA_VLOG(1) << "UserDao: Created user in MySQL id=" << user_id;

        UserRecord record;
        record.user_id       = user_id;
        record.username      = username;
        record.password_hash = password_hash;
        record.first_name    = first_name;
        record.last_name     = last_name;
        record.phone         = phone;
        record.created_at    = created_at;
        record.updated_at    = created_at;
        record.username_changed_at = created_at;
        return record;
    }

    // --- 内存回退 (Phase 1) ---
    {
        std::lock_guard<std::mutex> lock(mu_);

        if (users_by_username_.count(username)) {
            return std::nullopt;
        }

        UserRecord record;
        record.user_id       = user_id;
        record.username      = username;
        record.password_hash = password_hash;
        record.first_name    = first_name;
        record.last_name     = last_name;
        record.phone         = phone;
        record.created_at    = created_at;
        record.updated_at    = created_at;
        record.username_changed_at = created_at;

        users_by_id_[user_id] = record;
        users_by_username_[username] = user_id;

        NOVA_VLOG(1) << "UserDao: Created user in memory id=" << user_id;
        return record;
    }
}

std::optional<UserRecord> UserDao::FindById(int64_t user_id) {
    // --- MySQL 路径 ---
    if (mysql_ && mysql_->IsReady()) {
        std::ostringstream sql;
        sql << "SELECT user_id, username, password_hash, first_name, "
            << "last_name, bio, avatar_photo_id, phone, is_deleted, "
            << "created_at, updated_at, username_changed_at "
            << "FROM users WHERE user_id = " << user_id;

        std::vector<nova::Row> rows;
        butil::Status st = mysql_->QueryAll(sql.str(), &rows);
        if (!st.ok()) {
            NOVA_LOG_ERROR << "UserDao: MySQL FindById failed: " << st.error_str();
            return std::nullopt;
        }

        for (const auto& row : rows) {
            auto it = row.find("is_deleted");
            if (it != row.end() && it->second == "1") continue;

            UserRecord r;
            r.user_id    = user_id;
            r.username   = row.at("username");
            r.password_hash = row.at("password_hash");
            r.first_name = row.at("first_name");
            r.last_name  = row.at("last_name");
            r.bio        = row.count("bio") ? row.at("bio") : "";
            r.avatar_photo_id = row.count("avatar_photo_id") ? row.at("avatar_photo_id") : "";
            r.phone      = row.count("phone") ? row.at("phone") : "";
            r.created_at = std::strtoll(row.at("created_at").c_str(), nullptr, 10);
            r.updated_at = std::strtoll(row.at("updated_at").c_str(), nullptr, 10);
            r.username_changed_at = std::strtoll(
                row.count("username_changed_at") ? row.at("username_changed_at").c_str() : "0",
                nullptr, 10);
            return r;
        }
        return std::nullopt;
    }

    // --- 内存回退 ---
    {
        std::lock_guard<std::mutex> lock(mu_);
        auto it = users_by_id_.find(user_id);
        if (it != users_by_id_.end() && !it->second.is_deleted) {
            return it->second;
        }
        return std::nullopt;
    }
}

std::optional<UserRecord> UserDao::FindByUsername(const std::string& username) {
    if (mysql_ && mysql_->IsReady()) {
        auto Escape = [](const std::string& s) -> std::string {
            std::string r;
            for (char c : s) {
                if (c == '\'') r += "\\'";
                else r += c;
            }
            return r;
        };

        std::ostringstream sql;
        sql << "SELECT user_id, username, password_hash, first_name, "
            << "last_name, bio, avatar_photo_id, phone, is_deleted, "
            << "created_at, updated_at, username_changed_at "
            << "FROM users WHERE username = '" << Escape(username) << "'";

        std::vector<nova::Row> rows;
        mysql_->QueryAll(sql.str(), &rows);

        for (const auto& row : rows) {
            auto it = row.find("is_deleted");
            if (it != row.end() && it->second == "1") continue;

            UserRecord r;
            r.user_id    = std::strtoll(row.at("user_id").c_str(), nullptr, 10);
            r.username   = username;
            r.password_hash = row.at("password_hash");
            r.first_name = row.at("first_name");
            r.last_name  = row.at("last_name");
            r.bio        = row.count("bio") ? row.at("bio") : "";
            r.avatar_photo_id = row.count("avatar_photo_id") ? row.at("avatar_photo_id") : "";
            r.phone      = row.count("phone") ? row.at("phone") : "";
            r.created_at = std::strtoll(row.at("created_at").c_str(), nullptr, 10);
            r.updated_at = std::strtoll(row.at("updated_at").c_str(), nullptr, 10);
            r.username_changed_at = std::strtoll(
                row.count("username_changed_at") ? row.at("username_changed_at").c_str() : "0",
                nullptr, 10);
            return r;
        }
        return std::nullopt;
    }

    {
        std::lock_guard<std::mutex> lock(mu_);
        auto it = users_by_username_.find(username);
        if (it != users_by_username_.end()) {
            auto user_it = users_by_id_.find(it->second);
            if (user_it != users_by_id_.end() && !user_it->second.is_deleted) {
                return user_it->second;
            }
        }
        return std::nullopt;
    }
}

bool UserDao::UpdateProfile(int64_t user_id,
                            const std::string& first_name,
                            const std::string& last_name,
                            const std::string& bio,
                            const std::string& avatar_photo_id,
                            int64_t updated_at) {
    if (mysql_ && mysql_->IsReady()) {
        auto Escape = [](const std::string& s) -> std::string {
            std::string r;
            for (char c : s) {
                if (c == '\'') r += "\\'";
                else r += c;
            }
            return r;
        };

        std::ostringstream sql;
        sql << "UPDATE users SET updated_at = " << updated_at;
        if (!first_name.empty())
            sql << ", first_name = '" << Escape(first_name) << "'";
        if (!last_name.empty())
            sql << ", last_name = '" << Escape(last_name) << "'";
        if (!bio.empty())
            sql << ", bio = '" << Escape(bio) << "'";
        sql << ", avatar_photo_id = '" << Escape(avatar_photo_id) << "'";
        sql << " WHERE user_id = " << user_id;

        butil::Status st = mysql_->Execute(sql.str());
        if (!st.ok()) return false;
        // 检查是否真的更新了行
        return true;
    }

    {
        std::lock_guard<std::mutex> lock(mu_);
        auto it = users_by_id_.find(user_id);
        if (it == users_by_id_.end() || it->second.is_deleted) return false;
        if (!first_name.empty()) it->second.first_name = first_name;
        if (!last_name.empty())  it->second.last_name  = last_name;
        if (!bio.empty())        it->second.bio        = bio;
        it->second.avatar_photo_id = avatar_photo_id;
        it->second.updated_at = updated_at;
        return true;
    }
}

bool UserDao::ChangeUsername(int64_t user_id, const std::string& new_username,
                             int64_t updated_at) {
    if (mysql_ && mysql_->IsReady()) {
        auto Escape = [](const std::string& s) -> std::string {
            std::string r;
            for (char c : s) {
                if (c == '\'') r += "\\'";
                else r += c;
            }
            return r;
        };

        std::ostringstream sql;
        sql << "UPDATE users SET username = '" << Escape(new_username) << "', "
            << "username_changed_at = " << updated_at << ", "
            << "updated_at = " << updated_at << " "
            << "WHERE user_id = " << user_id;
        return mysql_->Execute(sql.str()).ok();
    }

    {
        std::lock_guard<std::mutex> lock(mu_);
        if (users_by_username_.count(new_username)) return false;
        auto it = users_by_id_.find(user_id);
        if (it == users_by_id_.end() || it->second.is_deleted) return false;
        users_by_username_.erase(it->second.username);
        it->second.username = new_username;
        it->second.username_changed_at = updated_at;
        it->second.updated_at = updated_at;
        users_by_username_[new_username] = user_id;
        return true;
    }
}

bool UserDao::ChangePassword(int64_t user_id,
                             const std::string& new_password_hash,
                             int64_t updated_at) {
    if (mysql_ && mysql_->IsReady()) {
        auto Escape = [](const std::string& s) -> std::string {
            std::string r;
            for (char c : s) {
                if (c == '\'') r += "\\'";
                else r += c;
            }
            return r;
        };

        std::ostringstream sql;
        sql << "UPDATE users SET password_hash = '" << Escape(new_password_hash) << "', "
            << "updated_at = " << updated_at << " "
            << "WHERE user_id = " << user_id;
        return mysql_->Execute(sql.str()).ok();
    }

    {
        std::lock_guard<std::mutex> lock(mu_);
        auto it = users_by_id_.find(user_id);
        if (it == users_by_id_.end() || it->second.is_deleted) return false;
        it->second.password_hash = new_password_hash;
        it->second.updated_at = updated_at;
        return true;
    }
}

bool UserDao::DeleteUser(int64_t user_id) {
    if (mysql_ && mysql_->IsReady()) {
        std::string sql = "UPDATE users SET is_deleted = 1 WHERE user_id = " +
                          std::to_string(user_id);
        return mysql_->Execute(sql).ok();
    }

    {
        std::lock_guard<std::mutex> lock(mu_);
        auto it = users_by_id_.find(user_id);
        if (it == users_by_id_.end()) return false;
        it->second.is_deleted = true;
        users_by_username_.erase(it->second.username);
        return true;
    }
}

bool UserDao::UsernameExists(const std::string& username) {
    if (mysql_ && mysql_->IsReady()) {
        std::string sql = "SELECT COUNT(*) as cnt FROM users WHERE username = '" +
                          username + "' AND is_deleted = 0";
        std::vector<nova::Row> rows;
        mysql_->QueryAll(sql, &rows);
        if (!rows.empty()) {
            auto it = rows[0].find("cnt");
            if (it != rows[0].end() && it->second != "0") return true;
        }
        return false;
    }

    {
        std::lock_guard<std::mutex> lock(mu_);
        return users_by_username_.count(username) > 0;
    }
}

std::vector<UserRecord> UserDao::SearchUsers(const std::string& query,
                                             int32_t limit, int64_t offset_id) {
    if (mysql_ && mysql_->IsReady()) {
        auto Escape = [](const std::string& s) -> std::string {
            std::string r;
            for (char c : s) {
                if (c == '\'') r += "\\'";
                else r += c;
            }
            return r;
        };

        std::ostringstream sql;
        sql << "SELECT user_id, username, password_hash, first_name, "
            << "last_name, bio, avatar_photo_id, phone, "
            << "created_at, updated_at, username_changed_at "
            << "FROM users WHERE is_deleted = 0 AND "
            << "(username LIKE '" << Escape(query) << "%' OR "
            << "first_name LIKE '" << Escape(query) << "%') ";
        if (offset_id > 0) {
            sql << "AND user_id < " << offset_id << " ";
        }
        sql << "ORDER BY user_id DESC LIMIT " << limit;

        std::vector<nova::Row> rows;
        mysql_->QueryAll(sql.str(), &rows);

        std::vector<UserRecord> results;
        for (const auto& row : rows) {
            UserRecord r;
            r.user_id    = std::strtoll(row.at("user_id").c_str(), nullptr, 10);
            r.username   = row.at("username");
            r.password_hash = "";
            r.first_name = row.at("first_name");
            r.last_name  = row.at("last_name");
            r.created_at = std::strtoll(row.at("created_at").c_str(), nullptr, 10);
            r.updated_at = std::strtoll(row.at("updated_at").c_str(), nullptr, 10);
            results.push_back(r);
        }
        return results;
    }

    {
        std::lock_guard<std::mutex> lock(mu_);
        std::vector<UserRecord> results;
        if (query.empty() || limit <= 0) return results;

        for (const auto& [id, record] : users_by_id_) {
            if (record.is_deleted) continue;
            if (id >= offset_id) continue;

            bool match = false;
            if (record.username.size() >= query.size() &&
                strncasecmp(record.username.c_str(), query.c_str(), query.size()) == 0) {
                match = true;
            }
            if (!match && record.first_name.size() >= query.size() &&
                strncasecmp(record.first_name.c_str(), query.c_str(), query.size()) == 0) {
                match = true;
            }

            if (match) {
                results.push_back(record);
                if (static_cast<int32_t>(results.size()) >= limit) break;
            }
        }

        std::sort(results.begin(), results.end(),
                  [](const UserRecord& a, const UserRecord& b) {
                      return a.user_id > b.user_id;
                  });
        return results;
    }
}

std::vector<UserRecord> UserDao::GetUsersByIds(
        const std::vector<int64_t>& user_ids) {
    if (mysql_ && mysql_->IsReady()) {
        std::ostringstream sql;
        sql << "SELECT user_id, username, password_hash, first_name, "
            << "last_name, bio, avatar_photo_id, phone, "
            << "created_at, updated_at, username_changed_at "
            << "FROM users WHERE is_deleted = 0 AND user_id IN (";
        for (size_t i = 0; i < user_ids.size(); i++) {
            if (i > 0) sql << ",";
            sql << user_ids[i];
        }
        sql << ")";

        std::vector<nova::Row> rows;
        mysql_->QueryAll(sql.str(), &rows);

        std::vector<UserRecord> results;
        for (const auto& row : rows) {
            UserRecord r;
            r.user_id    = std::strtoll(row.at("user_id").c_str(), nullptr, 10);
            r.username   = row.at("username");
            r.password_hash = "";
            r.first_name = row.at("first_name");
            r.last_name  = row.at("last_name");
            r.created_at = std::strtoll(row.at("created_at").c_str(), nullptr, 10);
            r.updated_at = std::strtoll(row.at("updated_at").c_str(), nullptr, 10);
            results.push_back(r);
        }
        return results;
    }

    {
        std::lock_guard<std::mutex> lock(mu_);
        std::vector<UserRecord> results;
        results.reserve(user_ids.size());
        for (int64_t id : user_ids) {
            auto it = users_by_id_.find(id);
            if (it != users_by_id_.end() && !it->second.is_deleted) {
                results.push_back(it->second);
            }
        }
        return results;
    }
}

}  // namespace user
}  // namespace nova
