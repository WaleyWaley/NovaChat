// =============================================================================
// C++ Lab 06 — RPC 客户端 + 服务注册表
//
// 运行: .\topic06_rpc_client.exe
//
// 它会在本机 8001 端口起一个 MockBrpcServer, 然后用 MiniUserClient 做一系列调用,
// 打印每个用例的 pass/fail。
// =============================================================================

#include <iostream>
#include <string>

#include "json.hpp"
#include "mini_brpc_client.h"
#include "mini_user_client.h"
#include "mock_server.h"

using json = nlohmann::json;

namespace {

int g_pass = 0;
int g_fail = 0;

void check(const std::string& name, bool ok, const std::string& detail = "") {
    if (ok) {
        ++g_pass;
        std::cout << "  [PASS] " << name << "\n";
    } else {
        ++g_fail;
        std::cout << "  [FAIL] " << name;
        if (!detail.empty()) std::cout << "  (" << detail << ")";
        std::cout << "\n";
    }
}

}  // namespace

int main() {
    const int kPort = 8001;  // 与 registry 默认的 user-service 地址一致

    lab::MockBrpcServer server(kPort);
    if (!server.start()) {
        std::cerr << "无法在 127.0.0.1:" << kPort
                  << " 启动 mock server (端口被占用?)\n";
        return 1;
    }
    std::cout << "[mock] listening on http://127.0.0.1:" << kPort << "\n";

    lab::MiniUserClient client;

    // ---- 1. register_user ----
    std::cout << "\n=== 1. register_user ===\n";
    try {
        json r = client.register_user("alice", "pw123", "Alice");
        check("error_code == 0", r.value("error_code", -1) == 0,
              "got " + std::to_string(r.value("error_code", -1)));

        // 关键: 9007199254740993 = 2^53+1, JS 的 JSON.parse 会把它舍入成 9007199254740992。
        // C++ 的 nlohmann 精确解析, 不需要 TS 那套正则 hack。
        long long uid = r.value("user_id", 0LL);
        check("user_id 精确解析 (int64)", uid == 9007199254740993LL,
              "got " + std::to_string(uid));

        check("user.username == alice",
              r.value("user", json::object()).value("username", std::string("")) == "alice");
    } catch (const std::exception& e) {
        check("register_user 未抛异常", false, e.what());
    }

    // ---- 2. login ----
    std::cout << "\n=== 2. login ===\n";
    try {
        json r = client.login("bob", "pw123", "desktop");
        check("error_code == 0", r.value("error_code", -1) == 0);
        check("user.username == bob",
              r.value("user", json::object()).value("username", std::string("")) == "bob");
    } catch (const std::exception& e) {
        check("login 未抛异常", false, e.what());
    }

    // ---- 3. get_user_profile_by_id ----
    std::cout << "\n=== 3. get_user_profile_by_id ===\n";
    try {
        json r = client.get_user_profile_by_id(123);
        check("error_code == 0", r.value("error_code", -1) == 0);
        check("user.user_id == 123",
              r.value("user", json::object()).value("user_id", 0LL) == 123LL);
    } catch (const std::exception& e) {
        check("get_user_profile_by_id 未抛异常", false, e.what());
    }

    // ---- 4. get_user_profile_by_username ----
    std::cout << "\n=== 4. get_user_profile_by_username ===\n";
    try {
        json r = client.get_user_profile_by_username("carol");
        check("error_code == 0", r.value("error_code", -1) == 0);
        check("user.username == carol",
              r.value("user", json::object()).value("username", std::string("")) == "carol");
    } catch (const std::exception& e) {
        check("get_user_profile_by_username 未抛异常", false, e.what());
    }

    // ---- 5. 超时 (SlowMethod 睡 2 秒, 客户端只等 500ms) ----
    std::cout << "\n=== 5. 超时处理 ===\n";
    try {
        lab::MiniBrpcClient fast("http://127.0.0.1:8001", 500);
        fast.call("nova.user.UserService", "SlowMethod", json::object());
        check("超时应抛 MiniBrpcError", false, "没有抛异常");
    } catch (const lab::MiniBrpcError& e) {
        check("超时 status ∈ {408, 503}", e.status() == 408 || e.status() == 503,
              "got " + std::to_string(e.status()));
    } catch (const std::exception& e) {
        check("超时应抛 MiniBrpcError", false, e.what());
    }

    // ---- 6. HTTP 错误 (Boom 返回 500) ----
    std::cout << "\n=== 6. HTTP 错误分类 ===\n";
    try {
        lab::MiniBrpcClient c("http://127.0.0.1:8001");
        c.call("nova.user.UserService", "Boom", json::object());
        check("500 应抛 MiniBrpcError", false, "没有抛异常");
    } catch (const lab::MiniBrpcError& e) {
        check("HTTP 500 -> status 500", e.status() == 500,
              "got " + std::to_string(e.status()));
    } catch (const std::exception& e) {
        check("500 应抛 MiniBrpcError", false, e.what());
    }

    std::cout << "\n=== 结果: " << g_pass << " passed, " << g_fail << " failed ===\n";
    server.stop();
    return g_fail == 0 ? 0 : 1;
}
