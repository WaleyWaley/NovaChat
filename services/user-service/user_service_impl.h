#pragma once

// =============================================================================
// NovaChat — UserService 实现 (bRPC Service)
//
// 继承自 proto 生成的 nova::user::UserService 基类
// 12 个 RPC 方法全部实现, Phase 1 为功能性桩代码 (内存存储)
// Phase 2 接入 MySQL + Redis 后, 替换 DAO 层即可
// =============================================================================

#include <string>
#include <memory>

#include "nova/common.h"
#include "nova/snowflake.h"
#include "user_dao.h"

// proto 生成的头文件
#include "nova/user/user.pb.h"
#include "user.brpc.h"  // hand-written service base class

namespace nova {
namespace user {

class UserServiceImpl : public nova::user::UserServiceBase {
public:
    // snowflake: ID 生成器 (非拥有指针, 生命周期由调用方管理)
    // user_dao:  数据访问层 (非拥有指针)
    UserServiceImpl(nova::Snowflake* snowflake, UserDao* user_dao);
    ~UserServiceImpl() override = default;

    UserServiceImpl(const UserServiceImpl&) = delete;
    UserServiceImpl& operator=(const UserServiceImpl&) = delete;

    // ==================== 认证相关 ====================

    void Register(::google::protobuf::RpcController* controller,
                  const ::nova::user::RegisterReq* request,
                  ::nova::user::RegisterResp* response,
                  ::google::protobuf::Closure* done) override;

    void Login(::google::protobuf::RpcController* controller,
               const ::nova::user::LoginReq* request,
               ::nova::user::LoginResp* response,
               ::google::protobuf::Closure* done) override;

    void RefreshToken(::google::protobuf::RpcController* controller,
                      const ::nova::user::RefreshTokenReq* request,
                      ::nova::user::RefreshTokenResp* response,
                      ::google::protobuf::Closure* done) override;

    void Logout(::google::protobuf::RpcController* controller,
                const ::nova::user::LogoutReq* request,
                ::nova::user::LogoutResp* response,
                ::google::protobuf::Closure* done) override;

    // ==================== 资料查询 ====================

    void GetUserProfile(::google::protobuf::RpcController* controller,
                        const ::nova::user::GetUserProfileReq* request,
                        ::nova::user::GetUserProfileResp* response,
                        ::google::protobuf::Closure* done) override;

    void GetUsers(::google::protobuf::RpcController* controller,
                  const ::nova::user::GetUsersReq* request,
                  ::nova::user::GetUsersResp* response,
                  ::google::protobuf::Closure* done) override;

    // ==================== 资料修改 ====================

    void UpdateProfile(::google::protobuf::RpcController* controller,
                       const ::nova::user::UpdateProfileReq* request,
                       ::nova::user::UpdateProfileResp* response,
                       ::google::protobuf::Closure* done) override;

    void ChangeUsername(::google::protobuf::RpcController* controller,
                        const ::nova::user::ChangeUsernameReq* request,
                        ::nova::user::ChangeUsernameResp* response,
                        ::google::protobuf::Closure* done) override;

    void CheckUsername(::google::protobuf::RpcController* controller,
                       const ::nova::user::CheckUsernameReq* request,
                       ::nova::user::CheckUsernameResp* response,
                       ::google::protobuf::Closure* done) override;

    void ChangePassword(::google::protobuf::RpcController* controller,
                        const ::nova::user::ChangePasswordReq* request,
                        ::nova::user::ChangePasswordResp* response,
                        ::google::protobuf::Closure* done) override;

    // ==================== 搜索 ====================

    void SearchUsers(::google::protobuf::RpcController* controller,
                     const ::nova::user::SearchUsersReq* request,
                     const ::nova::user::SearchUsersResp* response,
                     ::google::protobuf::Closure* done) override;

    // ==================== 账户管理 ====================

    void DeleteAccount(::google::protobuf::RpcController* controller,
                       const ::nova::user::DeleteAccountReq* request,
                       const ::nova::user::DeleteAccountResp* response,
                       ::google::protobuf::Closure* done) override;

private:
    // 生成 JWT Token (Phase 1: 简化版; Phase 2: 完整 JWT)
    std::string GenerateToken(int64_t user_id, const std::string& device_type);
    std::string GenerateRefreshToken(int64_t user_id);

    // 校验参数合法性
    bool ValidateUsername(const std::string& username, std::string* error);
    bool ValidatePassword(const std::string& password, std::string* error);

    nova::Snowflake* snowflake_;  // 非拥有
    UserDao*         user_dao_;   // 非拥有
};

}  // namespace user
}  // namespace nova
