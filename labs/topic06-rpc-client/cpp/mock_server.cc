#include "mock_server.h"

#include <chrono>
#include <thread>

#include "json.hpp"

namespace lab {

namespace {
using json = nlohmann::json;

// 超过 JS 安全整数范围 (2^53 = 9007199254740992) 的 int64
constexpr long long kBigUserId = 9007199254740993LL;  // 2^53 + 1

json make_user(long long user_id, const std::string& username,
               const std::string& first_name) {
    return json{
        {"user_id", user_id},
        {"username", username},
        {"first_name", first_name},
        {"last_name", ""},
        {"bio", ""},
        {"avatar_photo_id", ""},
        {"status", 1},
        {"last_seen_at", 0},
        {"is_verified", false},
        {"phone", ""},
        {"created_at", 0},
        {"updated_at", 0},
    };
}

std::string body_username(const httplib::Request& req, const std::string& fallback) {
    json body = json::parse(req.body, nullptr, false);  // 解析失败不抛异常
    if (body.is_object() && body.contains("username") && body["username"].is_string()) {
        return body["username"].get<std::string>();
    }
    return fallback;
}

}  // namespace

MockBrpcServer::MockBrpcServer(int port) : port_(port) {
    // ---- Register ----
    svr_.Post("/nova.user.UserService/Register",
              [](const httplib::Request& req, httplib::Response& res) {
                  const std::string username = body_username(req, "user");
                  json resp = {
                      {"error_code", 0},
                      {"error_message", ""},
                      {"user_id", kBigUserId},
                      {"user", make_user(kBigUserId, username, username)},
                  };
                  res.set_content(resp.dump(), "application/json");
              });

    // ---- Login ----
    svr_.Post("/nova.user.UserService/Login",
              [](const httplib::Request& req, httplib::Response& res) {
                  const std::string username = body_username(req, "user");
                  json resp = {
                      {"error_code", 0},
                      {"error_message", ""},
                      {"user", make_user(42, username, username)},
                  };
                  res.set_content(resp.dump(), "application/json");
              });

    // ---- GetUserProfile ----
    svr_.Post("/nova.user.UserService/GetUserProfile",
              [](const httplib::Request& req, httplib::Response& res) {
                  json body = json::parse(req.body, nullptr, false);
                  long long uid = 0;
                  std::string username = "unknown";
                  if (body.is_object()) {
                      if (body.contains("user_id")) {
                          if (body["user_id"].is_number()) {
                              uid = body["user_id"].get<long long>();
                          } else if (body["user_id"].is_string()) {
                              uid = std::stoll(body["user_id"].get<std::string>());
                          }
                      }
                      if (body.contains("username") && body["username"].is_string()) {
                          username = body["username"].get<std::string>();
                      }
                  }
                  json resp = {
                      {"error_code", 0},
                      {"error_message", ""},
                      {"user", make_user(uid, username, "Test")},
                  };
                  res.set_content(resp.dump(), "application/json");
              });

    // ---- SlowMethod: 测超时 ----
    svr_.Post("/nova.user.UserService/SlowMethod",
              [](const httplib::Request&, httplib::Response& res) {
                  std::this_thread::sleep_for(std::chrono::milliseconds(2000));
                  res.set_content(json{{"error_code", 0}, {"error_message", ""}}.dump(),
                                  "application/json");
              });

    // ---- Boom: 测错误分类 (HTTP 500) ----
    svr_.Post("/nova.user.UserService/Boom",
              [](const httplib::Request&, httplib::Response& res) {
                  res.status = 500;
                  res.set_content("internal boom", "text/plain");
              });
}

MockBrpcServer::~MockBrpcServer() { stop(); }

bool MockBrpcServer::start() {
    if (started_) {
        return true;
    }
    if (!svr_.bind_to_port("127.0.0.1", port_)) {
        return false;
    }
    thread_ = std::thread([this]() { svr_.listen_after_bind(); });
    svr_.wait_until_ready();
    started_ = true;
    return true;
}

void MockBrpcServer::stop() {
    if (!started_) {
        return;
    }
    svr_.stop();
    if (thread_.joinable()) {
        thread_.join();
    }
    started_ = false;
}

}  // namespace lab
