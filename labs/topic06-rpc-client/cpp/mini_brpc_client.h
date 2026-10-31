#pragma once

#include <map>
#include <stdexcept>
#include <string>

#include "json.hpp"

namespace lab {

/** 单次调用的可选参数 */
struct CallOptions {
    // 0 = 使用 MiniBrpcClient 构造时的默认超时; >0 = 本次调用覆盖
    int timeout_ms = 0;
    std::map<std::string, std::string> headers;  // 额外请求头
};

/**
 * bRPC 调用错误 (对应网关 base.ts 的 BrpcCallError)
 *   status 约定:
 *     408 = 超时
 *     503 = 网络/传输错误
 *     其他 = 原始 HTTP 状态码 (如 500)
 */
class MiniBrpcError : public std::runtime_error {
 public:
    MiniBrpcError(int status, const std::string& message, const std::string& url)
        : std::runtime_error(message), status_(status), url_(url) {}

    int status() const { return status_; }
    const std::string& url() const { return url_; }

 private:
    int status_;
    std::string url_;
};

/**
 * bRPC HTTP 客户端 (对应网关 gateway/src/clients/base.ts)
 *
 * 端点格式: {base_url}/{service_name}/{method}
 *   e.g. http://127.0.0.1:8001/nova.user.UserService/Register
 */
class MiniBrpcClient {
 public:
    explicit MiniBrpcClient(const std::string& base_url, int default_timeout_ms = 5000);

    /**
     * 发一次 RPC 调用。
     * @param service_name 完整服务名, 如 "nova.user.UserService"
     * @param method       RPC 方法名, 如 "Register"
     * @param body         请求体 (会被 dump 成 JSON)
     * @param opts         可选: 超时 / 额外请求头
     * @return             响应体解析后的 JSON
     * @throws MiniBrpcError 网络错误 / 非 2xx 状态 / 超时
     */
    nlohmann::json call(const std::string& service_name,
                        const std::string& method,
                        const nlohmann::json& body,
                        const CallOptions& opts = {});

 private:
    std::string base_url_;
    int default_timeout_ms_;
};

}  // namespace lab
