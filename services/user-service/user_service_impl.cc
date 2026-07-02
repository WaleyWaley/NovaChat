// =============================================================================
// NovaChat — UserServiceImpl 实现 (12 RPCs)
//
// Phase 1: 功能性桩实现, 使用内存存储
// Phase 2: MySQL + Redis 持久化, bcrypt 密码哈希, JWT Token
// =============================================================================

#include "user_service_impl.h"

#include <brpc/controller.h>
#include <sstream>
#include <iomanip>
#include <cstring>

#include "nova/logger.h"

namespace nova {
namespace user {

// ============================= 构造 / 工具 ====================================

UserServiceImpl::UserServiceImpl(nova::Snowflake* snowflake, UserDao* user_dao)
    : snowflake_(snowflake), user_dao_(user_dao) {
    NOVA_LOG_INFO << "UserServiceImpl created (storage: "
                  << user_dao_->StorageMode() << ")";
}

std::string UserServiceImpl::GenerateToken(int64_t user_id,
                                           const std::string& device_type) {
    // Phase 1: 简化 Token (Phase 2: 替换为完整 JWT RS256)
    int64_t ts = nova::NowMs();
    int64_t seq = snowflake_->NextId();
    std::ostringstream oss;
    oss << "tok_" << std::hex << user_id << "_" << ts << "_" << seq;
    return oss.str();
}

std::string UserServiceImpl::GenerateRefreshToken(int64_t user_id) {
    // Phase 1: 简化 Refresh Token
    int64_t seq = snowflake_->NextId();
    std::ostringstream oss;
    oss << "rt_" << std::hex << user_id << "_" << nova::NowMs() << "_" << seq;
    return oss.str();
}

bool UserServiceImpl::ValidateUsername(const std::string& username,
                                       std::string* error) {
    if (username.size() < static_cast<size_t>(nova::kMinUsernameLen) ||
        username.size() > static_cast<size_t>(nova::kMaxUsernameLen)) {
        *error = "Username must be " + std::to_string(nova::kMinUsernameLen) +
                 "-" + std::to_string(nova::kMaxUsernameLen) + " characters";
        return false;
    }
    // 只允许字母、数字、下划线, 且必须以字母开头
    if (!std::isalpha(static_cast<unsigned char>(username[0]))) {
        *error = "Username must start with a letter";
        return false;
    }
    for (char c : username) {
        if (!std::isalnum(static_cast<unsigned char>(c)) && c != '_') {
            *error = "Username can only contain letters, digits, and underscores";
            return false;
        }
    }
    return true;
}

bool UserServiceImpl::ValidatePassword(const std::string& password,
                                       std::string* error) {
    if (password.size() < static_cast<size_t>(nova::kMinPasswordLen) ||
        password.size() > static_cast<size_t>(nova::kMaxPasswordLen)) {
        *error = "Password must be " + std::to_string(nova::kMinPasswordLen) +
                 "-" + std::to_string(nova::kMaxPasswordLen) + " characters";
        return false;
    }
    return true;
}

// ============================= 辅助函数 =======================================

namespace {

// 将 UserRecord 转换为 proto UserProfile
void FillUserProfile(const UserRecord& record,
                     ::nova::common::UserProfile* profile) {
    profile->set_user_id(record.user_id);
    profile->set_username(record.username);
    profile->set_first_name(record.first_name);
    profile->set_last_name(record.last_name);
    profile->set_bio(record.bio);
    profile->set_avatar_photo_id(record.avatar_photo_id);
    profile->set_phone(record.phone);  // 仅本用户可见, 调用方自行过滤
    profile->set_created_at(record.created_at);
    profile->set_updated_at(record.updated_at);
    profile->set_is_verified(false);  // Phase 3+
}

// 简单密码哈希 (Phase 1: 明文 + 前缀; Phase 2: bcrypt)
std::string HashPassword(const std::string& password) {
    // TODO(Phase 2): bcrypt::generateHash(password, 12)
    return "hash:" + password;
}

// 验证密码
bool CheckPassword(const std::string& password, const std::string& hash) {
    // TODO(Phase 2): bcrypt::validatePassword(password, hash)
    return hash == "hash:" + password;
}

}  // anonymous namespace

// ============================= 1. Register ====================================

void UserServiceImpl::Register(::google::protobuf::RpcController* controller,
                               const ::nova::user::RegisterReq* request,
                               ::nova::user::RegisterResp* response,
                               ::google::protobuf::Closure* done) {
    brpc::ClosureGuard done_guard(done);
    auto* cntl = static_cast<brpc::Controller*>(controller);

    NOVA_LOG_INFO << "Register request from " << cntl->remote_side()
                  << " username=" << request->username();

    // --- 参数校验 ---
    std::string error;
    if (!ValidateUsername(request->username(), &error)) {
        response->set_error_code(::nova::common::USERNAME_INVALID);
        response->set_error_message(error);
        return;
    }
    if (!ValidatePassword(request->password(), &error)) {
        response->set_error_code(::nova::common::PASSWORD_INVALID);
        response->set_error_message(error);
        return;
    }
    if (request->first_name().empty()) {
        response->set_error_code(::nova::common::FIRSTNAME_INVALID);
        response->set_error_message("First name is required");
        return;
    }
    if (request->first_name().size() > static_cast<size_t>(nova::kMaxFirstNameLen)) {
        response->set_error_code(::nova::common::FIRSTNAME_INVALID);
        response->set_error_message("First name too long (max " +
            std::to_string(nova::kMaxFirstNameLen) + " chars)");
        return;
    }

    // --- 检查用户名是否已存在 ---
    if (user_dao_->UsernameExists(request->username())) {
        response->set_error_code(::nova::common::USERNAME_OCCUPIED);
        response->set_error_message("Username already taken: " + request->username());
        return;
    }

    // --- 创建用户 ---
    int64_t user_id = snowflake_->NextId();
    int64_t now = nova::NowMs();
    std::string password_hash = HashPassword(request->password());

    auto record = user_dao_->CreateUser(
        request->username(), password_hash,
        request->first_name(), request->last_name(),
        request->phone(), user_id, now);

    if (!record) {
        response->set_error_code(::nova::common::INTERNAL_ERROR);
        response->set_error_message("Failed to create user");
        return;
    }

    // --- 生成 Token (注册即登录) ---
    std::string access_token = GenerateToken(user_id, "");
    std::string refresh_token = GenerateRefreshToken(user_id);

    int64_t expires_at = now + nova::kAccessTokenTTL * 1000;

    // 保存 Session
    SessionRecord session;
    session.user_id       = user_id;
    session.refresh_token = refresh_token;
    session.created_at    = now;
    session.expires_at    = now + nova::kRefreshTokenTTL * 1000;
    user_dao_->CreateSession(session);

    // --- 填充响应 ---
    response->set_error_code(::nova::common::OK);
    response->set_user_id(user_id);
    response->set_access_token(access_token);
    response->set_refresh_token(refresh_token);
    response->set_expires_at(expires_at);
    FillUserProfile(*record, response->mutable_user());

    NOVA_LOG_INFO << "User registered: id=" << user_id
                  << " username=" << request->username();
}

// ============================= 2. Login =======================================

void UserServiceImpl::Login(::google::protobuf::RpcController* controller,
                            const ::nova::user::LoginReq* request,
                            ::nova::user::LoginResp* response,
                            ::google::protobuf::Closure* done) {
    brpc::ClosureGuard done_guard(done);
    auto* cntl = static_cast<brpc::Controller*>(controller);

    NOVA_LOG_INFO << "Login request from " << cntl->remote_side()
                  << " username=" << request->username()
                  << " device=" << request->device_type();

    // --- 查找用户 ---
    auto record = user_dao_->FindByUsername(request->username());
    if (!record) {
        response->set_error_code(::nova::common::USER_NOT_FOUND);
        response->set_error_message("User not found: " + request->username());
        return;
    }

    // --- 验证密码 ---
    if (!CheckPassword(request->password(), record->password_hash)) {
        response->set_error_code(::nova::common::PASSWORD_INVALID);
        response->set_error_message("Invalid password");
        return;
    }

    // --- 生成 Token ---
    int64_t now = nova::NowMs();
    std::string access_token = GenerateToken(record->user_id, request->device_type());
    std::string refresh_token = GenerateRefreshToken(record->user_id);

    int64_t expires_at = now + nova::kAccessTokenTTL * 1000;

    // 保存 Session
    SessionRecord session;
    session.user_id       = record->user_id;
    session.refresh_token = refresh_token;
    session.device_type   = request->device_type();
    session.device_name   = request->device_name();
    session.created_at    = now;
    session.expires_at    = now + nova::kRefreshTokenTTL * 1000;
    user_dao_->CreateSession(session);

    // --- 填充响应 ---
    response->set_error_code(::nova::common::OK);
    response->set_access_token(access_token);
    response->set_refresh_token(refresh_token);
    response->set_expires_at(expires_at);
    FillUserProfile(*record, response->mutable_user());

    NOVA_LOG_INFO << "User logged in: id=" << record->user_id
                  << " device=" << request->device_type();
}

// ============================= 3. RefreshToken ================================

void UserServiceImpl::RefreshToken(::google::protobuf::RpcController* controller,
                                   const ::nova::user::RefreshTokenReq* request,
                                   ::nova::user::RefreshTokenResp* response,
                                   ::google::protobuf::Closure* done) {
    brpc::ClosureGuard done_guard(done);

    NOVA_LOG_INFO << "RefreshToken request";

    // --- 查找 Session ---
    auto session = user_dao_->FindSession(request->refresh_token());
    if (!session) {
        response->set_error_code(::nova::common::TOKEN_INVALID);
        response->set_error_message("Invalid or expired refresh token");
        return;
    }

    // --- 检查是否过期 ---
    int64_t now = nova::NowMs();
    if (session->expires_at < now) {
        user_dao_->DeleteSession(request->refresh_token());
        response->set_error_code(::nova::common::SESSION_EXPIRED);
        response->set_error_message("Refresh token expired");
        return;
    }

    // --- Token 轮转: 删除旧 token, 生成新 token ---
    user_dao_->DeleteSession(request->refresh_token());

    std::string new_access_token = GenerateToken(session->user_id, session->device_type);
    std::string new_refresh_token = GenerateRefreshToken(session->user_id);

    SessionRecord new_session;
    new_session.user_id       = session->user_id;
    new_session.refresh_token = new_refresh_token;
    new_session.device_type   = session->device_type;
    new_session.device_name   = session->device_name;
    new_session.created_at    = now;
    new_session.expires_at    = now + nova::kRefreshTokenTTL * 1000;
    user_dao_->CreateSession(new_session);

    // --- 填充响应 ---
    response->set_error_code(::nova::common::OK);
    response->set_access_token(new_access_token);
    response->set_refresh_token(new_refresh_token);
    response->set_expires_at(now + nova::kAccessTokenTTL * 1000);

    NOVA_LOG_INFO << "Token refreshed for user_id=" << session->user_id;
}

// ============================= 4. Logout ======================================

void UserServiceImpl::Logout(::google::protobuf::RpcController* controller,
                             const ::nova::user::LogoutReq* request,
                             ::nova::user::LogoutResp* response,
                             ::google::protobuf::Closure* done) {
    brpc::ClosureGuard done_guard(done);

    NOVA_LOG_INFO << "Logout user_id=" << request->user_id();

    // 删除该用户的所有 Session
    user_dao_->DeleteAllSessions(request->user_id());

    response->set_error_code(::nova::common::OK);

    NOVA_LOG_INFO << "User logged out: id=" << request->user_id();
}

// ============================= 5. GetUserProfile ==============================

void UserServiceImpl::GetUserProfile(::google::protobuf::RpcController* controller,
                                     const ::nova::user::GetUserProfileReq* request,
                                     ::nova::user::GetUserProfileResp* response,
                                     ::google::protobuf::Closure* done) {
    brpc::ClosureGuard done_guard(done);

    // --- 按 ID 或 username 查找 ---
    std::optional<UserRecord> record;
    switch (request->identifier_case()) {
        case ::nova::user::GetUserProfileReq::kUserId:
            record = user_dao_->FindById(request->user_id());
            NOVA_VLOG(1) << "GetUserProfile by user_id=" << request->user_id();
            break;
        case ::nova::user::GetUserProfileReq::kUsername:
            record = user_dao_->FindByUsername(request->username());
            NOVA_VLOG(1) << "GetUserProfile by username=" << request->username();
            break;
        default:
            response->set_error_code(::nova::common::USER_NOT_FOUND);
            response->set_error_message("Must provide user_id or username");
            return;
    }

    if (!record) {
        response->set_error_code(::nova::common::USER_NOT_FOUND);
        response->set_error_message("User not found");
        return;
    }

    // --- 填充响应 ---
    response->set_error_code(::nova::common::OK);
    FillUserProfile(*record, response->mutable_user());
    // 不返回 phone 给其他用户
    response->mutable_user()->clear_phone();
}

// ============================= 6. GetUsers ====================================

void UserServiceImpl::GetUsers(::google::protobuf::RpcController* controller,
                               const ::nova::user::GetUsersReq* request,
                               ::nova::user::GetUsersResp* response,
                               ::google::protobuf::Closure* done) {
    brpc::ClosureGuard done_guard(done);

    int count = request->user_ids_size();
    NOVA_VLOG(1) << "GetUsers: " << count << " user(s) requested";

    // --- 限制批量大小 ---
    if (count > nova::kMaxBatchSize) {
        response->set_error_code(::nova::common::TOO_MANY_REQUESTS);
        response->set_error_message("Max batch size is " +
            std::to_string(nova::kMaxBatchSize));
        return;
    }

    // --- 批量查询 ---
    std::vector<int64_t> user_ids(request->user_ids().begin(),
                                  request->user_ids().end());
    auto records = user_dao_->GetUsersByIds(user_ids);

    // --- 填充响应 ---
    response->set_error_code(::nova::common::OK);
    for (const auto& record : records) {
        auto* profile = response->add_users();
        FillUserProfile(record, profile);
        profile->clear_phone();  // 不泄露手机号
    }
}

// ============================= 7. UpdateProfile ===============================

void UserServiceImpl::UpdateProfile(::google::protobuf::RpcController* controller,
                                    const ::nova::user::UpdateProfileReq* request,
                                    ::nova::user::UpdateProfileResp* response,
                                    ::google::protobuf::Closure* done) {
    brpc::ClosureGuard done_guard(done);

    NOVA_LOG_INFO << "UpdateProfile user_id=" << request->user_id();

    // --- 参数校验 ---
    if (!request->first_name().empty() &&
        request->first_name().size() > static_cast<size_t>(nova::kMaxFirstNameLen)) {
        response->set_error_code(::nova::common::FIRSTNAME_INVALID);
        response->set_error_message("First name too long");
        return;
    }
    if (!request->last_name().empty() &&
        request->last_name().size() > static_cast<size_t>(nova::kMaxLastNameLen)) {
        response->set_error_code(::nova::common::FIRSTNAME_INVALID);
        response->set_error_message("Last name too long");
        return;
    }
    if (!request->bio().empty() &&
        request->bio().size() > static_cast<size_t>(nova::kMaxBioLen)) {
        response->set_error_code(::nova::common::FIRSTNAME_INVALID);
        response->set_error_message("Bio too long");
        return;
    }

    // --- 更新 ---
    int64_t now = nova::NowMs();
    if (!user_dao_->UpdateProfile(request->user_id(),
                                  request->first_name(),
                                  request->last_name(),
                                  request->bio(),
                                  request->avatar_photo_id(),
                                  now)) {
        response->set_error_code(::nova::common::USER_NOT_FOUND);
        response->set_error_message("User not found");
        return;
    }

    // --- 返回更新后的资料 ---
    auto updated = user_dao_->FindById(request->user_id());
    response->set_error_code(::nova::common::OK);
    if (updated) {
        FillUserProfile(*updated, response->mutable_user());
    }
}

// ============================= 8. ChangeUsername ==============================

void UserServiceImpl::ChangeUsername(::google::protobuf::RpcController* controller,
                                     const ::nova::user::ChangeUsernameReq* request,
                                     ::nova::user::ChangeUsernameResp* response,
                                     ::google::protobuf::Closure* done) {
    brpc::ClosureGuard done_guard(done);

    NOVA_LOG_INFO << "ChangeUsername user_id=" << request->user_id()
                  << " new=" << request->new_username();

    // --- 参数校验 ---
    std::string error;
    if (!ValidateUsername(request->new_username(), &error)) {
        response->set_error_code(::nova::common::USERNAME_INVALID);
        response->set_error_message(error);
        return;
    }

    // --- 检查新用户名是否已存在 ---
    if (user_dao_->UsernameExists(request->new_username())) {
        response->set_error_code(::nova::common::USERNAME_OCCUPIED);
        response->set_error_message("Username already taken: " +
                                    request->new_username());
        return;
    }

    // --- 检查修改频率 (Telegram: 15-30 天限制) ---
    auto record = user_dao_->FindById(request->user_id());
    if (!record) {
        response->set_error_code(::nova::common::USER_NOT_FOUND);
        response->set_error_message("User not found");
        return;
    }
    // Phase 1: 简单限制 1 小时内只能改一次
    constexpr int64_t kMinChangeInterval = 3600 * 1000;  // 1 hour
    int64_t now = nova::NowMs();
    if (record->username_changed_at > 0 &&
        now - record->username_changed_at < kMinChangeInterval) {
        response->set_error_code(::nova::common::USERNAME_NOT_MODIFIED);
        response->set_error_message(
            "Username can only be changed once per hour. Last change: " +
            std::to_string(record->username_changed_at));
        return;
    }

    // --- 执行修改 ---
    if (!user_dao_->ChangeUsername(request->user_id(),
                                   request->new_username(), now)) {
        response->set_error_code(::nova::common::INTERNAL_ERROR);
        response->set_error_message("Failed to change username");
        return;
    }

    response->set_error_code(::nova::common::OK);
    response->set_username(request->new_username());
}

// ============================= 9. CheckUsername ===============================

void UserServiceImpl::CheckUsername(::google::protobuf::RpcController* controller,
                                    const ::nova::user::CheckUsernameReq* request,
                                    ::nova::user::CheckUsernameResp* response,
                                    ::google::protobuf::Closure* done) {
    brpc::ClosureGuard done_guard(done);

    // --- 先校验格式 ---
    std::string error;
    if (!ValidateUsername(request->username(), &error)) {
        response->set_error_code(::nova::common::USERNAME_INVALID);
        response->set_error_message(error);
        response->set_is_available(false);
        return;
    }

    // --- 检查是否可注册 ---
    bool available = !user_dao_->UsernameExists(request->username());
    response->set_error_code(::nova::common::OK);
    response->set_is_available(available);
}

// ============================= 10. ChangePassword =============================

void UserServiceImpl::ChangePassword(::google::protobuf::RpcController* controller,
                                     const ::nova::user::ChangePasswordReq* request,
                                     ::nova::user::ChangePasswordResp* response,
                                     ::google::protobuf::Closure* done) {
    brpc::ClosureGuard done_guard(done);

    NOVA_LOG_INFO << "ChangePassword user_id=" << request->user_id();

    // --- 新密码格式校验 ---
    std::string error;
    if (!ValidatePassword(request->new_password(), &error)) {
        response->set_error_code(::nova::common::PASSWORD_INVALID);
        response->set_error_message("New " + error);
        return;
    }

    // --- 查找用户并验证旧密码 ---
    auto record = user_dao_->FindById(request->user_id());
    if (!record) {
        response->set_error_code(::nova::common::USER_NOT_FOUND);
        response->set_error_message("User not found");
        return;
    }
    if (!CheckPassword(request->old_password(), record->password_hash)) {
        response->set_error_code(::nova::common::PASSWORD_INVALID);
        response->set_error_message("Old password is incorrect");
        return;
    }

    // --- 更新密码 ---
    std::string new_hash = HashPassword(request->new_password());
    if (!user_dao_->ChangePassword(request->user_id(), new_hash, nova::NowMs())) {
        response->set_error_code(::nova::common::INTERNAL_ERROR);
        response->set_error_message("Failed to change password");
        return;
    }

    // 安全措施: 清除所有 Session, 强制重新登录
    user_dao_->DeleteAllSessions(request->user_id());

    response->set_error_code(::nova::common::OK);

    NOVA_LOG_INFO << "Password changed for user_id=" << request->user_id()
                  << " (all sessions cleared)";
}

// ============================= 11. SearchUsers ================================

void UserServiceImpl::SearchUsers(::google::protobuf::RpcController* controller,
                                  const ::nova::user::SearchUsersReq* request,
                                  ::nova::user::SearchUsersResp* response,
                                  ::google::protobuf::Closure* done) {
    brpc::ClosureGuard done_guard(done);

    NOVA_VLOG(1) << "SearchUsers query=" << request->query()
                 << " limit=" << request->limit();

    // --- 参数校验 ---
    if (request->query().empty()) {
        response->set_error_code(::nova::common::OK);
        response->set_has_more(false);
        return;  // 空查询返回空结果
    }
    int32_t limit = request->limit();
    if (limit <= 0 || limit > 50) {
        limit = 20;  // 默认值
    }

    // --- 搜索 ---
    auto records = user_dao_->SearchUsers(request->query(), limit,
                                          request->offset_id());

    // --- 填充响应 ---
    response->set_error_code(::nova::common::OK);
    for (const auto& record : records) {
        auto* profile = response->add_users();
        FillUserProfile(record, profile);
        profile->clear_phone();  // 搜索结果不暴露手机号
    }
    response->set_has_more(
        static_cast<int32_t>(records.size()) >= limit);
}

// ============================= 12. DeleteAccount ==============================

void UserServiceImpl::DeleteAccount(::google::protobuf::RpcController* controller,
                                    const ::nova::user::DeleteAccountReq* request,
                                    ::nova::user::DeleteAccountResp* response,
                                    ::google::protobuf::Closure* done) {
    brpc::ClosureGuard done_guard(done);

    NOVA_LOG_INFO << "DeleteAccount user_id=" << request->user_id()
                  << " reason=" << request->reason();

    // --- 密码二次确认 ---
    auto record = user_dao_->FindById(request->user_id());
    if (!record) {
        response->set_error_code(::nova::common::USER_NOT_FOUND);
        response->set_error_message("User not found");
        return;
    }
    if (!CheckPassword(request->password(), record->password_hash)) {
        response->set_error_code(::nova::common::PASSWORD_INVALID);
        response->set_error_message("Password incorrect");
        return;
    }

    // --- 软删除 ---
    if (!user_dao_->DeleteUser(request->user_id())) {
        response->set_error_code(::nova::common::INTERNAL_ERROR);
        response->set_error_message("Failed to delete account");
        return;
    }

    // 清除所有 Session
    user_dao_->DeleteAllSessions(request->user_id());

    response->set_error_code(::nova::common::OK);

    NOVA_LOG_INFO << "Account deleted: user_id=" << request->user_id()
                  << " reason=" << request->reason();
}

}  // namespace user
}  // namespace nova
