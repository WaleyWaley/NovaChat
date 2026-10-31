// =============================================================================
// C++ Lab 01 — 真实 WebSocket 连接管理器 (cpp-httplib)
//
// 运行: .\topic01_conn_mgr.exe [port]     (默认 3001)
//
// 协议与 TS 版一致:
//   client -> { type: "auth", seq, payload: { username, user_id } }
//   server -> { type: "auth_ok", seq, payload: { user_id, username } }
//   client -> { type: "ping", seq }
//   server -> { type: "pong", seq }
//   server -> { type: "update", payload: {...} }   (管理器的广播)
//   server -> { type: "kicked", payload: { reason } }
//
// 可用 TS 端的客户端联调:
//   node_modules\.bin\tsx.cmd ..\ts\src\test-client.ts alice 3001
// =============================================================================

#include <cstdlib>
#include <iostream>
#include <string>

#include "connection.h"
#include "httplib.h"
#include "json.hpp"
#include "mini_connection_manager.h"

using json = nlohmann::json;
using lab::ConnectionPtr;
using lab::MiniConnectionManager;

namespace {

MiniConnectionManager g_manager;

std::string dump(const json& j) { return j.dump(); }

json make_error(long seq, int code, const std::string& message) {
    return json{{"type", "error"},
                {"seq", seq},
                {"payload", {{"code", code}, {"message", message}}}};
}

std::string payload_string(const json& payload, const std::string& key,
                           const std::string& fallback) {
    if (!payload.contains(key)) {
        return fallback;
    }
    const json& v = payload[key];
    if (v.is_string()) {
        return v.get<std::string>();
    }
    if (v.is_number()) {
        return std::to_string(v.get<long long>());
    }
    return fallback;
}

void handle_message(const ConnectionPtr& conn, const std::string& raw) {
    json j;
    try {
        j = json::parse(raw);
    } catch (...) {
        conn->send(dump(make_error(0, 1302, "Invalid JSON")));
        return;
    }

    const std::string type = j.value("type", std::string(""));
    const long seq = j.value("seq", 0L);

    if (type == "auth") {
        const json payload = j.value("payload", json::object());
        const std::string username = payload_string(payload, "username", "user");
        const std::string user_id = payload_string(payload, "user_id", username);

        if (!g_manager.register_user(user_id, username, conn)) {
            conn->send(dump(make_error(seq, 5002, "Server busy")));
            return;
        }

        conn->send(dump(json{{"type", "auth_ok"},
                             {"seq", seq},
                             {"payload", {{"user_id", user_id}, {"username", username}}}}));
        std::cout << "[server] user " << user_id << " (" << username << ") authenticated"
                  << std::endl;
    } else if (type == "ping") {
        g_manager.refresh_heartbeat(conn.get());
        conn->send(dump(json{{"type", "pong"}, {"seq", seq}}));
    } else {
        conn->send(dump(make_error(seq, 1302, "Unknown message type: " + type)));
    }
}

}  // namespace

int main(int argc, char** argv) {
    int port = 3001;
    int heartbeat_interval = 5;
    int heartbeat_timeout = 15;
    if (argc > 1) {
        port = std::atoi(argv[1]);
    }
    if (argc > 2) {
        heartbeat_interval = std::atoi(argv[2]);
    }
    if (argc > 3) {
        heartbeat_timeout = std::atoi(argv[3]);
    }

    httplib::Server svr;

    svr.WebSocket("/ws", [](const httplib::Request&, httplib::ws::WebSocket& ws) {
        ConnectionPtr conn = lab::make_connection(&ws);
        std::cout << "[server] new connection (id=" << conn->id() << ")" << std::endl;

        // welcome 帧, 提示客户端发 auth
        conn->send(dump(json{{"type", "welcome"},
                             {"payload", {{"message", "C++ Lab WS Server"}}}}));

        // 阻塞读取循环: handler 线程独占这条连接的读取
        std::string msg;
        httplib::ws::ReadResult r;
        while ((r = ws.read(msg)) != httplib::ws::ReadResult::Fail) {
            if (r == httplib::ws::ReadResult::Text) {
                handle_message(conn, msg);
            }
        }

        // 连接结束: 先注销, 再 detach, 最后 handler 返回销毁 ws
        g_manager.unregister(conn.get());
        conn->detach();
        std::cout << "[server] connection closed (id=" << conn->id() << ")" << std::endl;
    });

    // 启动心跳扫描 (默认 5 秒扫一次, 15 秒无 ping 断开)
    g_manager.start_heartbeat(heartbeat_interval, heartbeat_timeout);

    std::cout << "[server] listening on ws://localhost:" << port << " (path /ws)"
              << std::endl;

    const bool ok = svr.listen("0.0.0.0", port);

    g_manager.stop_heartbeat();
    g_manager.disconnect_all("Server stopping");
    return ok ? 0 : 1;
}
