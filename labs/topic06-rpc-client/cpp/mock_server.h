#pragma once

#include <string>
#include <thread>

#include "httplib.h"

namespace lab {

/**
 * 模拟 bRPC 的 http+pb 服务端 (用 cpp-httplib 实现)。
 *
 * 它接收 HTTP POST + JSON body, 返回 JSON —— 和 bRPC 的
 * "http body 自动反序列化为 protobuf" 模式对外表现一致。
 *
 * 端点 (字段照 proto/nova/user/user.proto):
 *   POST /nova.user.UserService/Register       -> { error_code, user_id, user }
 *   POST /nova.user.UserService/Login          -> { error_code, user }
 *   POST /nova.user.UserService/GetUserProfile -> { error_code, user }
 *   POST /nova.user.UserService/SlowMethod     -> 睡 2 秒后返回 (测超时)
 *   POST /nova.user.UserService/Boom           -> HTTP 500 (测错误分类)
 */
class MockBrpcServer {
 public:
    explicit MockBrpcServer(int port);
    ~MockBrpcServer();

    MockBrpcServer(const MockBrpcServer&) = delete;
    MockBrpcServer& operator=(const MockBrpcServer&) = delete;

    /** 绑定端口并启动后台线程; 返回是否成功 */
    bool start();
    void stop();

 private:
    int port_;
    httplib::Server svr_;
    std::thread thread_;
    bool started_ = false;
};

}  // namespace lab
