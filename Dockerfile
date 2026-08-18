# =============================================================================
# NovaChat — C++ User Service Dockerfile (Multi-stage)
#
# Stage 1: Build bRPC + protoc-gen-brpc + NovaChat user-service
# Stage 2: Minimal runtime
#
# Build:
#   docker build -t novachat-user-service .
#   # or: docker build -t novachat-user-service --build-arg ENABLE_MYSQL=ON .
#
# Run:
#   docker run -p 8001:8001 novachat-user-service
# =============================================================================

# =========================== Stage 1: Builder ================================
FROM ubuntu:22.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC

# --- System build dependencies ---
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    cmake \
    curl \
    g++-12 \
    gcc-12 \
    git \
    libgflags-dev \
    libgoogle-glog-dev \
    libleveldb-dev \
    libmysqlclient-dev \
    libprotobuf-dev \
    libprotoc-dev \
    libsnappy-dev \
    libssl-dev \
    make \
    pkg-config \
    protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

# Set g++-12 as default compiler
RUN update-alternatives --install /usr/bin/g++ g++ /usr/bin/g++-12 100 \
    && update-alternatives --install /usr/bin/gcc gcc /usr/bin/gcc-12 100 \
    && update-alternatives --install /usr/bin/cc cc /usr/bin/gcc-12 100 \
    && update-alternatives --install /usr/bin/c++ c++ /usr/bin/g++-12 100

# Verify compiler
RUN g++ --version && cmake --version

# --- Build bRPC from source ---
ARG BRPC_VERSION=1.11.0
WORKDIR /tmp/brpc-build
RUN git clone --depth 1 --branch ${BRPC_VERSION} https://github.com/apache/brpc.git . \
    && cmake -B build \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX=/usr/local \
        -DBUILD_SHARED_LIBS=OFF \
        -DWITH_GLOG=ON \
    && cmake --build build -j$(nproc) \
    && cmake --install build \
    && rm -rf /tmp/brpc-build

# Verify bRPC installation
RUN test -f /usr/local/include/brpc/server.h \
    && test -f /usr/local/lib/libbrpc.a \
    && echo "bRPC installed successfully"

# --- Build protoc-gen-brpc (if available in bRPC tools) ---
# bRPC's protoc plugin is at tools/rpc_press or tools/ in the source.
# For Phase 2, we write minimal hand-written brpc stubs instead.
# This is because protoc-gen-brpc is not always built by bRPC's default cmake.

# --- Build NovaChat ---
WORKDIR /novachat-build

# Copy source files
COPY CMakeLists.txt .
COPY cmake/ cmake/
COPY proto/ proto/
COPY services/ services/

# --- Generate proto C++ code ---
# Proto files are at proto/nova/{common,user,gateway}/*.proto
# With --proto_path=proto, they generate to gen/cpp/nova/{common,user,gateway}/*.pb.h
RUN mkdir -p build/gen/cpp \
    && protoc \
        --proto_path=proto \
        --cpp_out=build/gen/cpp \
        proto/nova/common/common.proto \
        proto/nova/user/user.proto \
        proto/nova/gateway/push.proto \
        proto/nova/message/message.proto \
    && echo "=== Proto C++ code generated ===" \
    && find build/gen/cpp -type f | sort

# --- Create hand-written bRPC service stubs ---
# When protoc-gen-brpc is not available, we create minimal brpc service
# base classes manually. These have the same interface as the generated code.
RUN mkdir -p build/gen/cpp/nova/user build/gen/cpp/nova/gateway \
    && cat > build/gen/cpp/nova/user/user.brpc.h << 'BREOF'
#pragma once
#include "nova/user/user.pb.h"
#include <brpc/server.h>

namespace nova {
namespace user {

class UserServiceBase : public ::google::protobuf::Service {
public:
    virtual ~UserServiceBase();

    // 12 RPCs — Phase 2 implementation delegates to UserServiceImpl
    virtual void Register(::google::protobuf::RpcController*,
                          const ::nova::user::RegisterReq*,
                          ::nova::user::RegisterResp*,
                          ::google::protobuf::Closure*) {}
    virtual void Login(::google::protobuf::RpcController*,
                       const ::nova::user::LoginReq*,
                       ::nova::user::LoginResp*,
                       ::google::protobuf::Closure*) {}
    virtual void RefreshToken(::google::protobuf::RpcController*,
                              const ::nova::user::RefreshTokenReq*,
                              ::nova::user::RefreshTokenResp*,
                              ::google::protobuf::Closure*) {}
    virtual void Logout(::google::protobuf::RpcController*,
                        const ::nova::user::LogoutReq*,
                        ::nova::user::LogoutResp*,
                        ::google::protobuf::Closure*) {}
    virtual void GetUserProfile(::google::protobuf::RpcController*,
                                const ::nova::user::GetUserProfileReq*,
                                ::nova::user::GetUserProfileResp*,
                                ::google::protobuf::Closure*) {}
    virtual void GetUsers(::google::protobuf::RpcController*,
                          const ::nova::user::GetUsersReq*,
                          ::nova::user::GetUsersResp*,
                          ::google::protobuf::Closure*) {}
    virtual void UpdateProfile(::google::protobuf::RpcController*,
                               const ::nova::user::UpdateProfileReq*,
                               ::nova::user::UpdateProfileResp*,
                               ::google::protobuf::Closure*) {}
    virtual void ChangeUsername(::google::protobuf::RpcController*,
                                const ::nova::user::ChangeUsernameReq*,
                                ::nova::user::ChangeUsernameResp*,
                                ::google::protobuf::Closure*) {}
    virtual void CheckUsername(::google::protobuf::RpcController*,
                               const ::nova::user::CheckUsernameReq*,
                               ::nova::user::CheckUsernameResp*,
                               ::google::protobuf::Closure*) {}
    virtual void ChangePassword(::google::protobuf::RpcController*,
                                const ::nova::user::ChangePasswordReq*,
                                ::nova::user::ChangePasswordResp*,
                                ::google::protobuf::Closure*) {}
    virtual void SearchUsers(::google::protobuf::RpcController*,
                             const ::nova::user::SearchUsersReq*,
                             ::nova::user::SearchUsersResp*,
                             ::google::protobuf::Closure*) {}
    virtual void DeleteAccount(::google::protobuf::RpcController*,
                               const ::nova::user::DeleteAccountReq*,
                               ::nova::user::DeleteAccountResp*,
                               ::google::protobuf::Closure*) {}

    // Service interface — implemented in user.brpc.cc
    static const ::google::protobuf::ServiceDescriptor* GetDescriptorStatic();
    const ::google::protobuf::ServiceDescriptor* GetDescriptor() override;
    void CallMethod(const ::google::protobuf::MethodDescriptor*,
                    ::google::protobuf::RpcController*,
                    const ::google::protobuf::Message*,
                    ::google::protobuf::Message*,
                    ::google::protobuf::Closure*) override;
    const ::google::protobuf::Message& GetRequestPrototype(
        const ::google::protobuf::MethodDescriptor*) const override;
    const ::google::protobuf::Message& GetResponsePrototype(
        const ::google::protobuf::MethodDescriptor*) const override;
};

}  // namespace user
}  // namespace nova
BREOF
# Build a minimal ServiceDescriptor at runtime so bRPC can register the service.
# protoc-gen-brpc is not available, so we construct the descriptor dynamically
# using DescriptorPool::BuildFile. We also define essential message fields so
# that bRPC's JSON-to-Protobuf parser can populate request fields correctly.
RUN cat > build/gen/cpp/nova/user/user.brpc.cc << 'BREOF'
#include "nova/user/user.brpc.h"
#include <google/protobuf/descriptor.h>
#include <google/protobuf/descriptor.pb.h>

namespace nova {
namespace user {

UserServiceBase::~UserServiceBase() = default;

namespace {
    using namespace ::google::protobuf;

    // Helper: add a string field to a message descriptor
    void AddField(DescriptorProto* msg, const char* name, int num,
                  FieldDescriptorProto::Type type, FieldDescriptorProto::Label label) {
        FieldDescriptorProto* f = msg->add_field();
        f->set_name(name);
        f->set_number(num);
        f->set_type(type);
        f->set_label(label);
    }

    const ServiceDescriptor* BuildServiceDescriptor() {
        FileDescriptorProto file_proto;
        file_proto.set_name("nova/user/user.proto");
        file_proto.set_package("nova.user");

        // ---- RegisterReq ----
        DescriptorProto* reg_req = file_proto.add_message_type();
        reg_req->set_name("RegisterReq");
        AddField(reg_req, "username",   1, FieldDescriptorProto::TYPE_STRING, FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(reg_req, "password",   2, FieldDescriptorProto::TYPE_STRING, FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(reg_req, "first_name", 3, FieldDescriptorProto::TYPE_STRING, FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(reg_req, "last_name",  4, FieldDescriptorProto::TYPE_STRING, FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(reg_req, "phone",      5, FieldDescriptorProto::TYPE_STRING, FieldDescriptorProto::LABEL_OPTIONAL);

        // ---- RegisterResp ----
        DescriptorProto* reg_resp = file_proto.add_message_type();
        reg_resp->set_name("RegisterResp");
        AddField(reg_resp, "user_id",       3, FieldDescriptorProto::TYPE_INT64,  FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(reg_resp, "access_token",  4, FieldDescriptorProto::TYPE_STRING, FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(reg_resp, "refresh_token", 5, FieldDescriptorProto::TYPE_STRING, FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(reg_resp, "expires_at",    6, FieldDescriptorProto::TYPE_INT64,  FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(reg_resp, "error_code",    1, FieldDescriptorProto::TYPE_INT32,  FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(reg_resp, "error_message", 2, FieldDescriptorProto::TYPE_STRING, FieldDescriptorProto::LABEL_OPTIONAL);

        // ---- LoginReq ----
        DescriptorProto* login_req = file_proto.add_message_type();
        login_req->set_name("LoginReq");
        AddField(login_req, "username",    1, FieldDescriptorProto::TYPE_STRING, FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(login_req, "password",    2, FieldDescriptorProto::TYPE_STRING, FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(login_req, "device_name", 3, FieldDescriptorProto::TYPE_STRING, FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(login_req, "device_type", 4, FieldDescriptorProto::TYPE_STRING, FieldDescriptorProto::LABEL_OPTIONAL);

        // ---- LoginResp ----
        DescriptorProto* login_resp = file_proto.add_message_type();
        login_resp->set_name("LoginResp");
        AddField(login_resp, "error_code",    1, FieldDescriptorProto::TYPE_INT32,  FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(login_resp, "error_message", 2, FieldDescriptorProto::TYPE_STRING, FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(login_resp, "access_token",  3, FieldDescriptorProto::TYPE_STRING, FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(login_resp, "refresh_token", 4, FieldDescriptorProto::TYPE_STRING, FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(login_resp, "expires_at",    5, FieldDescriptorProto::TYPE_INT64,  FieldDescriptorProto::LABEL_OPTIONAL);

        // ---- GetUserProfileReq (has oneof identifier) ----
        DescriptorProto* gup_req = file_proto.add_message_type();
        gup_req->set_name("GetUserProfileReq");
        // define the oneof
        OneofDescriptorProto* gup_oneof = gup_req->add_oneof_decl();
        gup_oneof->set_name("identifier");
        // field 1: user_id (belongs to oneof at index 0)
        FieldDescriptorProto* gup_f1 = gup_req->add_field();
        gup_f1->set_name("user_id"); gup_f1->set_number(1);
        gup_f1->set_type(FieldDescriptorProto::TYPE_INT64);
        gup_f1->set_label(FieldDescriptorProto::LABEL_OPTIONAL);
        gup_f1->set_oneof_index(0);
        // field 2: username (belongs to same oneof at index 0)
        FieldDescriptorProto* gup_f2 = gup_req->add_field();
        gup_f2->set_name("username"); gup_f2->set_number(2);
        gup_f2->set_type(FieldDescriptorProto::TYPE_STRING);
        gup_f2->set_label(FieldDescriptorProto::LABEL_OPTIONAL);
        gup_f2->set_oneof_index(0);

        // ---- GetUserProfileResp ----
        file_proto.add_message_type()->set_name("GetUserProfileResp");

        // ---- GetUsersReq ----
        DescriptorProto* gus_req = file_proto.add_message_type();
        gus_req->set_name("GetUsersReq");
        AddField(gus_req, "user_ids", 1, FieldDescriptorProto::TYPE_INT64, FieldDescriptorProto::LABEL_REPEATED);

        // ---- GetUsersResp ----
        file_proto.add_message_type()->set_name("GetUsersResp");

        // ---- RefreshTokenReq ----
        DescriptorProto* rt_req = file_proto.add_message_type();
        rt_req->set_name("RefreshTokenReq");
        AddField(rt_req, "refresh_token", 1, FieldDescriptorProto::TYPE_STRING, FieldDescriptorProto::LABEL_OPTIONAL);

        // ---- RefreshTokenResp ----
        DescriptorProto* rt_resp = file_proto.add_message_type();
        rt_resp->set_name("RefreshTokenResp");
        AddField(rt_resp, "access_token",  3, FieldDescriptorProto::TYPE_STRING, FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(rt_resp, "refresh_token", 4, FieldDescriptorProto::TYPE_STRING, FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(rt_resp, "expires_at",    5, FieldDescriptorProto::TYPE_INT64,  FieldDescriptorProto::LABEL_OPTIONAL);

        // ---- LogoutReq ----
        DescriptorProto* lo_req = file_proto.add_message_type();
        lo_req->set_name("LogoutReq");
        AddField(lo_req, "user_id", 1, FieldDescriptorProto::TYPE_INT64, FieldDescriptorProto::LABEL_OPTIONAL);

        // ---- CheckUsernameReq ----
        DescriptorProto* cu_req = file_proto.add_message_type();
        cu_req->set_name("CheckUsernameReq");
        AddField(cu_req, "username", 1, FieldDescriptorProto::TYPE_STRING, FieldDescriptorProto::LABEL_OPTIONAL);

        // ---- CheckUsernameResp ----
        DescriptorProto* cu_resp = file_proto.add_message_type();
        cu_resp->set_name("CheckUsernameResp");
        AddField(cu_resp, "is_available", 3, FieldDescriptorProto::TYPE_BOOL, FieldDescriptorProto::LABEL_OPTIONAL);

        // ---- SearchUsersReq ----
        DescriptorProto* su_req = file_proto.add_message_type();
        su_req->set_name("SearchUsersReq");
        AddField(su_req, "query",     1, FieldDescriptorProto::TYPE_STRING, FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(su_req, "limit",     2, FieldDescriptorProto::TYPE_INT32,  FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(su_req, "offset_id", 3, FieldDescriptorProto::TYPE_INT64,  FieldDescriptorProto::LABEL_OPTIONAL);

        // ---- UpdateProfileReq ----
        DescriptorProto* up_req = file_proto.add_message_type();
        up_req->set_name("UpdateProfileReq");
        AddField(up_req, "user_id",    1, FieldDescriptorProto::TYPE_INT64,  FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(up_req, "first_name", 2, FieldDescriptorProto::TYPE_STRING, FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(up_req, "last_name",  3, FieldDescriptorProto::TYPE_STRING, FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(up_req, "bio",        4, FieldDescriptorProto::TYPE_STRING, FieldDescriptorProto::LABEL_OPTIONAL);

        // ---- ChangePasswordReq ----
        DescriptorProto* cp_req = file_proto.add_message_type();
        cp_req->set_name("ChangePasswordReq");
        AddField(cp_req, "user_id",      1, FieldDescriptorProto::TYPE_INT64,  FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(cp_req, "old_password", 2, FieldDescriptorProto::TYPE_STRING, FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(cp_req, "new_password", 3, FieldDescriptorProto::TYPE_STRING, FieldDescriptorProto::LABEL_OPTIONAL);

        // ---- DeleteAccountReq ----
        DescriptorProto* da_req = file_proto.add_message_type();
        da_req->set_name("DeleteAccountReq");
        AddField(da_req, "user_id",  1, FieldDescriptorProto::TYPE_INT64,  FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(da_req, "password", 2, FieldDescriptorProto::TYPE_STRING, FieldDescriptorProto::LABEL_OPTIONAL);

        // ---- ChangeUsernameReq ----
        DescriptorProto* cun_req = file_proto.add_message_type();
        cun_req->set_name("ChangeUsernameReq");
        AddField(cun_req, "user_id",       1, FieldDescriptorProto::TYPE_INT64,  FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(cun_req, "new_username",  2, FieldDescriptorProto::TYPE_STRING, FieldDescriptorProto::LABEL_OPTIONAL);

        // ---- UserProfile (简化版, 用于搜索结果显示) ----
        DescriptorProto* upro = file_proto.add_message_type();
        upro->set_name("UserProfile");
        AddField(upro, "user_id",    1, FieldDescriptorProto::TYPE_INT64,  FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(upro, "username",   2, FieldDescriptorProto::TYPE_STRING, FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(upro, "first_name", 3, FieldDescriptorProto::TYPE_STRING, FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(upro, "last_name",  4, FieldDescriptorProto::TYPE_STRING, FieldDescriptorProto::LABEL_OPTIONAL);

        // ---- SearchUsersResp ----
        DescriptorProto* su_resp = file_proto.add_message_type();
        su_resp->set_name("SearchUsersResp");
        AddField(su_resp, "has_more", 4, FieldDescriptorProto::TYPE_BOOL, FieldDescriptorProto::LABEL_OPTIONAL);
        // users: repeated UserProfile (field 3, TYPE_MESSAGE, type_name="nova.user.UserProfile")
        {
            FieldDescriptorProto* f = su_resp->add_field();
            f->set_name("users"); f->set_number(3);
            f->set_type(FieldDescriptorProto::TYPE_MESSAGE);
            f->set_label(FieldDescriptorProto::LABEL_REPEATED);
            f->set_type_name("nova.user.UserProfile");
        }

        // ---- Remaining stubs ----
        const char* remaining[] = {
            "LogoutResp",
            "UpdateProfileResp","ChangeUsernameResp","ChangePasswordResp",
            "DeleteAccountResp"
        };
        for (const char* m : remaining) {
            file_proto.add_message_type()->set_name(m);
        }

        // Define the service with all 12 RPCs
        ServiceDescriptorProto* svc = file_proto.add_service();
        svc->set_name("UserService");

        const char* methods[] = {
            "Register","Login","RefreshToken","Logout",
            "GetUserProfile","GetUsers","UpdateProfile","ChangeUsername",
            "CheckUsername","ChangePassword","SearchUsers","DeleteAccount"
        };
        for (const char* m : methods) {
            MethodDescriptorProto* method = svc->add_method();
            method->set_name(m);
            method->set_input_type("nova.user." + std::string(m) + "Req");
            method->set_output_type("nova.user." + std::string(m) + "Resp");
        }

        static DescriptorPool pool;
        const FileDescriptor* fd = pool.BuildFile(file_proto);
        if (!fd) return nullptr;
        return fd->FindServiceByName("UserService");
    }
}

const ::google::protobuf::ServiceDescriptor* UserServiceBase::GetDescriptorStatic() {
    static const auto* desc = BuildServiceDescriptor();
    return desc;
}

const ::google::protobuf::ServiceDescriptor* UserServiceBase::GetDescriptor() {
    return GetDescriptorStatic();
}

void UserServiceBase::CallMethod(
    const ::google::protobuf::MethodDescriptor* method,
    ::google::protobuf::RpcController* controller,
    const ::google::protobuf::Message* request,
    ::google::protobuf::Message* response,
    ::google::protobuf::Closure* done) {
    // Dispatch to the correct RPC method based on method name
    // Each RPC method calls done->Run() via ClosureGuard
    const std::string& name = method->name();
    if (name == "Register") {
        Register(controller,
                 static_cast<const ::nova::user::RegisterReq*>(request),
                 static_cast<::nova::user::RegisterResp*>(response), done);
    } else if (name == "Login") {
        Login(controller,
              static_cast<const ::nova::user::LoginReq*>(request),
              static_cast<::nova::user::LoginResp*>(response), done);
    } else if (name == "RefreshToken") {
        RefreshToken(controller,
                     static_cast<const ::nova::user::RefreshTokenReq*>(request),
                     static_cast<::nova::user::RefreshTokenResp*>(response), done);
    } else if (name == "Logout") {
        Logout(controller,
               static_cast<const ::nova::user::LogoutReq*>(request),
               static_cast<::nova::user::LogoutResp*>(response), done);
    } else if (name == "GetUserProfile") {
        GetUserProfile(controller,
                       static_cast<const ::nova::user::GetUserProfileReq*>(request),
                       static_cast<::nova::user::GetUserProfileResp*>(response), done);
    } else if (name == "GetUsers") {
        GetUsers(controller,
                 static_cast<const ::nova::user::GetUsersReq*>(request),
                 static_cast<::nova::user::GetUsersResp*>(response), done);
    } else if (name == "UpdateProfile") {
        UpdateProfile(controller,
                      static_cast<const ::nova::user::UpdateProfileReq*>(request),
                      static_cast<::nova::user::UpdateProfileResp*>(response), done);
    } else if (name == "ChangeUsername") {
        ChangeUsername(controller,
                       static_cast<const ::nova::user::ChangeUsernameReq*>(request),
                       static_cast<::nova::user::ChangeUsernameResp*>(response), done);
    } else if (name == "CheckUsername") {
        CheckUsername(controller,
                      static_cast<const ::nova::user::CheckUsernameReq*>(request),
                      static_cast<::nova::user::CheckUsernameResp*>(response), done);
    } else if (name == "ChangePassword") {
        ChangePassword(controller,
                       static_cast<const ::nova::user::ChangePasswordReq*>(request),
                       static_cast<::nova::user::ChangePasswordResp*>(response), done);
    } else if (name == "SearchUsers") {
        SearchUsers(controller,
                    static_cast<const ::nova::user::SearchUsersReq*>(request),
                    static_cast<::nova::user::SearchUsersResp*>(response), done);
    } else if (name == "DeleteAccount") {
        DeleteAccount(controller,
                      static_cast<const ::nova::user::DeleteAccountReq*>(request),
                      static_cast<::nova::user::DeleteAccountResp*>(response), done);
    }
    // Each RPC method above calls done->Run() via brpc::ClosureGuard
}

const ::google::protobuf::Message& UserServiceBase::GetRequestPrototype(
    const ::google::protobuf::MethodDescriptor* method) const {
    const std::string& n = method->name();
    if (n == "Register")        return ::nova::user::RegisterReq::default_instance();
    if (n == "Login")           return ::nova::user::LoginReq::default_instance();
    if (n == "GetUserProfile")  return ::nova::user::GetUserProfileReq::default_instance();
    if (n == "GetUsers")        return ::nova::user::GetUsersReq::default_instance();
    if (n == "RefreshToken")    return ::nova::user::RefreshTokenReq::default_instance();
    if (n == "Logout")          return ::nova::user::LogoutReq::default_instance();
    if (n == "CheckUsername")   return ::nova::user::CheckUsernameReq::default_instance();
    if (n == "SearchUsers")     return ::nova::user::SearchUsersReq::default_instance();
    if (n == "UpdateProfile")   return ::nova::user::UpdateProfileReq::default_instance();
    if (n == "ChangePassword")  return ::nova::user::ChangePasswordReq::default_instance();
    if (n == "DeleteAccount")   return ::nova::user::DeleteAccountReq::default_instance();
    if (n == "ChangeUsername")  return ::nova::user::ChangeUsernameReq::default_instance();
    return ::nova::user::RegisterReq::default_instance();
}

const ::google::protobuf::Message& UserServiceBase::GetResponsePrototype(
    const ::google::protobuf::MethodDescriptor* method) const {
    const std::string& n = method->name();
    if (n == "Register")        return ::nova::user::RegisterResp::default_instance();
    if (n == "Login")           return ::nova::user::LoginResp::default_instance();
    if (n == "GetUserProfile")  return ::nova::user::GetUserProfileResp::default_instance();
    if (n == "GetUsers")        return ::nova::user::GetUsersResp::default_instance();
    if (n == "RefreshToken")    return ::nova::user::RefreshTokenResp::default_instance();
    if (n == "Logout")          return ::nova::user::LogoutResp::default_instance();
    if (n == "CheckUsername")   return ::nova::user::CheckUsernameResp::default_instance();
    if (n == "SearchUsers")     return ::nova::user::SearchUsersResp::default_instance();
    if (n == "UpdateProfile")   return ::nova::user::UpdateProfileResp::default_instance();
    if (n == "ChangePassword")  return ::nova::user::ChangePasswordResp::default_instance();
    if (n == "DeleteAccount")   return ::nova::user::DeleteAccountResp::default_instance();
    if (n == "ChangeUsername")  return ::nova::user::ChangeUsernameResp::default_instance();
    return ::nova::user::RegisterResp::default_instance();
}

}  // namespace user
}  // namespace nova
BREOF
RUN echo "bRPC user service stubs created" \
    && cat > build/gen/cpp/nova/gateway/push.brpc.h << 'BREOF'
#pragma once
#include "nova/gateway/push.pb.h"
#include <brpc/server.h>

namespace nova {
namespace gateway {

class PushService : public ::google::protobuf::Service {
public:
    virtual ~PushService();

    virtual void PushUpdate(::google::protobuf::RpcController*,
                            const ::nova::gateway::PushUpdateReq*,
                            ::nova::gateway::PushUpdateResp*,
                            ::google::protobuf::Closure*) {}
    virtual void PushToUsers(::google::protobuf::RpcController*,
                             const ::nova::gateway::PushToUsersReq*,
                             ::nova::gateway::PushToUsersResp*,
                             ::google::protobuf::Closure*) {}
    virtual void KickUser(::google::protobuf::RpcController*,
                          const ::nova::gateway::KickUserReq*,
                          ::nova::gateway::KickUserResp*,
                          ::google::protobuf::Closure*) {}
    virtual void IsUserOnline(::google::protobuf::RpcController*,
                              const ::nova::gateway::IsUserOnlineReq*,
                              ::nova::gateway::IsUserOnlineResp*,
                              ::google::protobuf::Closure*) {}
    virtual void BatchOnlineCheck(::google::protobuf::RpcController*,
                                  const ::nova::gateway::BatchOnlineCheckReq*,
                                  ::nova::gateway::BatchOnlineCheckResp*,
                                  ::google::protobuf::Closure*) {}
    virtual void NotifyGateway(::google::protobuf::RpcController*,
                               const ::nova::gateway::NotifyGatewayReq*,
                               ::nova::gateway::NotifyGatewayResp*,
                               ::google::protobuf::Closure*) {}

    // Service interface — implemented in push.brpc.cc
    static const ::google::protobuf::ServiceDescriptor* GetDescriptorStatic();
    const ::google::protobuf::ServiceDescriptor* GetDescriptor() override;
    void CallMethod(const ::google::protobuf::MethodDescriptor*,
                    ::google::protobuf::RpcController*,
                    const ::google::protobuf::Message*,
                    ::google::protobuf::Message*,
                    ::google::protobuf::Closure*) override;
    const ::google::protobuf::Message& GetRequestPrototype(
        const ::google::protobuf::MethodDescriptor*) const override;
    const ::google::protobuf::Message& GetResponsePrototype(
        const ::google::protobuf::MethodDescriptor*) const override;
};

}  // namespace gateway
}  // namespace nova
BREOF
RUN cat > build/gen/cpp/nova/gateway/push.brpc.cc << 'BREOF'
#include "nova/gateway/push.brpc.h"
#include <google/protobuf/descriptor.h>
#include <google/protobuf/descriptor.pb.h>

namespace nova {
namespace gateway {

PushService::~PushService() = default;

namespace {
    const ::google::protobuf::ServiceDescriptor* BuildServiceDescriptor() {
        using namespace ::google::protobuf;
        FileDescriptorProto file_proto;
        file_proto.set_name("nova/gateway/push.proto");
        file_proto.set_package("nova.gateway");

        // Declare message stubs
        const char* messages[] = {
            "PushUpdateReq","PushUpdateResp","PushToUsersReq","PushToUsersResp",
            "KickUserReq","KickUserResp","IsUserOnlineReq","IsUserOnlineResp",
            "BatchOnlineCheckReq","BatchOnlineCheckResp","NotifyGatewayReq","NotifyGatewayResp"
        };
        for (const char* m : messages) {
            file_proto.add_message_type()->set_name(m);
        }

        ServiceDescriptorProto* svc = file_proto.add_service();
        svc->set_name("PushService");

        const char* methods[] = {
            "PushUpdate","PushToUsers","KickUser",
            "IsUserOnline","BatchOnlineCheck","NotifyGateway"
        };
        for (const char* m : methods) {
            MethodDescriptorProto* method = svc->add_method();
            method->set_name(m);
            method->set_input_type("nova.gateway." + std::string(m) + "Req");
            method->set_output_type("nova.gateway." + std::string(m) + "Resp");
        }

        static DescriptorPool pool;
        const FileDescriptor* fd = pool.BuildFile(file_proto);
        if (!fd) return nullptr;
        return fd->FindServiceByName("PushService");
    }
}

const ::google::protobuf::ServiceDescriptor* PushService::GetDescriptorStatic() {
    static const auto* desc = BuildServiceDescriptor();
    return desc;
}

const ::google::protobuf::ServiceDescriptor* PushService::GetDescriptor() {
    return GetDescriptorStatic();
}

void PushService::CallMethod(
    const ::google::protobuf::MethodDescriptor*,
    ::google::protobuf::RpcController*,
    const ::google::protobuf::Message*,
    ::google::protobuf::Message*,
    ::google::protobuf::Closure*) {}

const ::google::protobuf::Message& PushService::GetRequestPrototype(
    const ::google::protobuf::MethodDescriptor*) const {
    return ::nova::gateway::PushUpdateReq::default_instance();
}

const ::google::protobuf::Message& PushService::GetResponsePrototype(
    const ::google::protobuf::MethodDescriptor*) const {
    return ::nova::gateway::PushUpdateResp::default_instance();
}

}  // namespace gateway
}  // namespace nova
BREOF
# ---- MessageService brpc stubs ----
RUN mkdir -p build/gen/cpp/nova/message \
    && cat > build/gen/cpp/nova/message/message.brpc.h << 'BREOF'
#pragma once
#include "nova/message/message.pb.h"
#include <brpc/server.h>

namespace nova {
namespace message {

class MessageServiceBase : public ::google::protobuf::Service {
public:
    virtual ~MessageServiceBase();

    virtual void SendMessage(::google::protobuf::RpcController*,
                             const ::nova::message::SendMessageReq*,
                             ::nova::message::SendMessageResp*,
                             ::google::protobuf::Closure*) {}
    virtual void GetMessages(::google::protobuf::RpcController*,
                             const ::nova::message::GetMessagesReq*,
                             ::nova::message::GetMessagesResp*,
                             ::google::protobuf::Closure*) {}
    virtual void AckMessage(::google::protobuf::RpcController*,
                            const ::nova::message::AckMessageReq*,
                            ::nova::message::AckMessageResp*,
                            ::google::protobuf::Closure*) {}
    virtual void GetSyncState(::google::protobuf::RpcController*,
                              const ::nova::message::GetSyncStateReq*,
                              ::nova::message::GetSyncStateResp*,
                              ::google::protobuf::Closure*) {}

    static const ::google::protobuf::ServiceDescriptor* GetDescriptorStatic();
    const ::google::protobuf::ServiceDescriptor* GetDescriptor() override;
    void CallMethod(const ::google::protobuf::MethodDescriptor*,
                    ::google::protobuf::RpcController*,
                    const ::google::protobuf::Message*,
                    ::google::protobuf::Message*,
                    ::google::protobuf::Closure*) override;
    const ::google::protobuf::Message& GetRequestPrototype(
        const ::google::protobuf::MethodDescriptor*) const override;
    const ::google::protobuf::Message& GetResponsePrototype(
        const ::google::protobuf::MethodDescriptor*) const override;
};

}  // namespace message
}  // namespace nova
BREOF
RUN cat > build/gen/cpp/nova/message/message.brpc.cc << 'BREOF'
#include "nova/message/message.brpc.h"
#include <google/protobuf/descriptor.h>
#include <google/protobuf/descriptor.pb.h>

namespace nova {
namespace message {

MessageServiceBase::~MessageServiceBase() = default;

namespace {
    using namespace ::google::protobuf;
    void AddField(DescriptorProto* msg, const char* name, int num,
                  FieldDescriptorProto::Type type, FieldDescriptorProto::Label label) {
        FieldDescriptorProto* f = msg->add_field();
        f->set_name(name); f->set_number(num); f->set_type(type); f->set_label(label);
    }

    const ServiceDescriptor* BuildServiceDescriptor() {
        FileDescriptorProto file_proto;
        file_proto.set_name("nova/message/message.proto");
        file_proto.set_package("nova.message");

        // SendMessageReq
        DescriptorProto* sm_req = file_proto.add_message_type();
        sm_req->set_name("SendMessageReq");
        AddField(sm_req, "text",            4, FieldDescriptorProto::TYPE_STRING, FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(sm_req, "reply_to_msg_id", 5, FieldDescriptorProto::TYPE_INT64,  FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(sm_req, "is_silent",       6, FieldDescriptorProto::TYPE_BOOL,   FieldDescriptorProto::LABEL_OPTIONAL);

        // SendMessageResp
        DescriptorProto* sm_resp = file_proto.add_message_type();
        sm_resp->set_name("SendMessageResp");
        AddField(sm_resp, "error_code",    1, FieldDescriptorProto::TYPE_INT32,  FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(sm_resp, "error_message", 2, FieldDescriptorProto::TYPE_STRING, FieldDescriptorProto::LABEL_OPTIONAL);

        // GetMessagesReq
        DescriptorProto* gm_req = file_proto.add_message_type();
        gm_req->set_name("GetMessagesReq");
        AddField(gm_req, "limit",     2, FieldDescriptorProto::TYPE_INT32, FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(gm_req, "offset_id", 3, FieldDescriptorProto::TYPE_INT64, FieldDescriptorProto::LABEL_OPTIONAL);

        // GetMessagesResp
        DescriptorProto* gm_resp = file_proto.add_message_type();
        gm_resp->set_name("GetMessagesResp");
        AddField(gm_resp, "has_more",       4, FieldDescriptorProto::TYPE_BOOL,  FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(gm_resp, "next_offset_id", 5, FieldDescriptorProto::TYPE_INT64, FieldDescriptorProto::LABEL_OPTIONAL);

        // AckMessageReq + AckMessageResp (Phase 3)
        DescriptorProto* am_req = file_proto.add_message_type();
        am_req->set_name("AckMessageReq");
        AddField(am_req, "user_id", 1, FieldDescriptorProto::TYPE_INT64, FieldDescriptorProto::LABEL_OPTIONAL);
        AddField(am_req, "max_ack_msg_id", 3, FieldDescriptorProto::TYPE_INT64, FieldDescriptorProto::LABEL_OPTIONAL);
        DescriptorProto* am_resp = file_proto.add_message_type();
        am_resp->set_name("AckMessageResp");

        // GetSyncStateReq + GetSyncStateResp (Phase 3)
        DescriptorProto* gs_req = file_proto.add_message_type();
        gs_req->set_name("GetSyncStateReq");
        AddField(gs_req, "user_id", 1, FieldDescriptorProto::TYPE_INT64, FieldDescriptorProto::LABEL_OPTIONAL);
        DescriptorProto* gs_resp = file_proto.add_message_type();
        gs_resp->set_name("GetSyncStateResp");

        ServiceDescriptorProto* svc = file_proto.add_service();
        svc->set_name("MessageService");
        const char* methods[] = {"SendMessage", "GetMessages", "AckMessage", "GetSyncState"};
        for (const char* m : methods) {
            MethodDescriptorProto* method = svc->add_method();
            method->set_name(m);
            method->set_input_type("nova.message." + std::string(m) + "Req");
            method->set_output_type("nova.message." + std::string(m) + "Resp");
        }

        static DescriptorPool pool;
        const FileDescriptor* fd = pool.BuildFile(file_proto);
        return fd ? fd->FindServiceByName("MessageService") : nullptr;
    }
}

const ServiceDescriptor* MessageServiceBase::GetDescriptorStatic() {
    static const auto* desc = BuildServiceDescriptor();
    return desc;
}
const ServiceDescriptor* MessageServiceBase::GetDescriptor() {
    return GetDescriptorStatic();
}
void MessageServiceBase::CallMethod(
    const MethodDescriptor* method, RpcController* controller,
    const Message* request, Message* response, Closure* done) {
    const std::string& name = method->name();
    if (name == "SendMessage") {
        SendMessage(controller,
                    static_cast<const ::nova::message::SendMessageReq*>(request),
                    static_cast<::nova::message::SendMessageResp*>(response), done);
    } else if (name == "GetMessages") {
        GetMessages(controller,
                    static_cast<const ::nova::message::GetMessagesReq*>(request),
                    static_cast<::nova::message::GetMessagesResp*>(response), done);
    } else if (name == "AckMessage") {
        AckMessage(controller,
                   static_cast<const ::nova::message::AckMessageReq*>(request),
                   static_cast<::nova::message::AckMessageResp*>(response), done);
    } else if (name == "GetSyncState") {
        GetSyncState(controller,
                     static_cast<const ::nova::message::GetSyncStateReq*>(request),
                     static_cast<::nova::message::GetSyncStateResp*>(response), done);
    }
}
const Message& MessageServiceBase::GetRequestPrototype(
    const MethodDescriptor* method) const {
    const std::string& n = method->name();
    if (n == "SendMessage") return ::nova::message::SendMessageReq::default_instance();
    if (n == "GetMessages") return ::nova::message::GetMessagesReq::default_instance();
    if (n == "AckMessage") return ::nova::message::AckMessageReq::default_instance();
    return ::nova::message::GetSyncStateReq::default_instance();
}
const Message& MessageServiceBase::GetResponsePrototype(
    const MethodDescriptor* method) const {
    const std::string& n = method->name();
    if (n == "SendMessage") return ::nova::message::SendMessageResp::default_instance();
    if (n == "GetMessages") return ::nova::message::GetMessagesResp::default_instance();
    if (n == "AckMessage") return ::nova::message::AckMessageResp::default_instance();
    return ::nova::message::GetSyncStateResp::default_instance();
}

}  // namespace message
}  // namespace nova
BREOF
RUN echo "bRPC stubs created"

# --- Replace CMakeLists.txt with Docker-specific version ---
# The top-level CMakeLists.txt uses include(cmake/ProtoGen.cmake) which
# requires protoc-gen-brpc. In Docker we use pre-generated proto + hand-written
# brpc stubs, so we replace the CMakeLists.txt entirely.
RUN cat > CMakeLists.txt << 'CMEOF'
cmake_minimum_required(VERSION 3.16)

project(NovaChat VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Debug CACHE STRING "Build type" FORCE)
endif()

find_path(BRPC_INCLUDE_DIR brpc/server.h
    HINTS /usr/local/include /usr/include)
find_library(BRPC_LIBRARY brpc
    HINTS /usr/local/lib /usr/lib)

# bRPC depends on protobuf + openssl + z + pthread + dl + gflags + glog
find_package(Protobuf REQUIRED)
find_package(OpenSSL REQUIRED)
find_library(ZLIB_LIBRARY z REQUIRED)
find_library(DL_LIBRARY dl REQUIRED)
find_library(GFLAGS_LIBRARY gflags REQUIRED)
find_library(GLOG_LIBRARY glog REQUIRED)
find_library(LEVELDB_LIBRARY leveldb REQUIRED)
find_path(MYSQL_INCLUDE_DIR mysql/mysql.h REQUIRED)
find_library(MYSQL_LIBRARY mysqlclient REQUIRED)

message(STATUS "NovaChat build type: ${CMAKE_BUILD_TYPE}")
message(STATUS "Found bRPC include: ${BRPC_INCLUDE_DIR}")
message(STATUS "Found bRPC library: ${BRPC_LIBRARY}")
message(STATUS "Found Protobuf: ${Protobuf_LIBRARIES}")
message(STATUS "Found OpenSSL: ${OPENSSL_LIBRARIES}")

# Pre-generated proto code
add_library(nova_proto STATIC
  build/gen/cpp/nova/common/common.pb.cc
  build/gen/cpp/nova/gateway/push.pb.cc
  build/gen/cpp/nova/user/user.pb.cc
  build/gen/cpp/nova/message/message.pb.cc
  build/gen/cpp/nova/user/user.brpc.cc
  build/gen/cpp/nova/gateway/push.brpc.cc
  build/gen/cpp/nova/message/message.brpc.cc
)
target_include_directories(nova_proto PUBLIC
  build/gen/cpp
  ${BRPC_INCLUDE_DIR}
  ${Protobuf_INCLUDE_DIRS}
)
target_link_libraries(nova_proto PUBLIC
  ${BRPC_LIBRARY}
  ${Protobuf_LIBRARIES}
  ${OPENSSL_LIBRARIES}
  ${ZLIB_LIBRARY}
  ${DL_LIBRARY}
  ${GFLAGS_LIBRARY}
  ${GLOG_LIBRARY}
  ${LEVELDB_LIBRARY}
  ${MYSQL_LIBRARY}
  pthread
)
target_compile_features(nova_proto PUBLIC cxx_std_20)
target_compile_options(nova_proto PRIVATE -Wno-unused-parameter -Wno-sign-compare)

# Subdirectories
add_subdirectory(services/common)
add_subdirectory(services/user-service)
add_subdirectory(services/message-service)
CMEOF

# --- Build NovaChat ---
RUN cmake -B build \
        -DCMAKE_BUILD_TYPE=Release \
        -DBRPC_ROOT=/usr/local \
    && cmake --build build -j$(nproc)

# Verify
RUN test -f build/services/user-service/nova_user_service \
    && echo "=== NovaChat user-service built successfully ===" \
    && ldd build/services/user-service/nova_user_service || true

# =========================== Stage 2: Runtime ================================
FROM ubuntu:22.04 AS runtime

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    libgflags2.2 \
    libgoogle-glog0v5 \
    libleveldb1d \
    libmysqlclient21 \
    libprotobuf23 \
    libsnappy1v5 \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

# Copy bRPC library
COPY --from=builder /usr/local/lib/libbrpc.a /usr/local/lib/

# Copy NovaChat binaries
COPY --from=builder /novachat-build/build/services/user-service/nova_user_service /app/nova_user_service
COPY --from=builder /novachat-build/build/services/message-service/nova_message_service /app/nova_message_service

# Copy config files
COPY services/user-service/conf/ /app/conf/
COPY services/message-service/conf/ /app/conf/

WORKDIR /app

EXPOSE 8001

HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
    CMD curl -sf http://localhost:8001/status || exit 1

ENTRYPOINT ["./nova_user_service"]
CMD ["--flagfile=conf/user_service.flags"]
