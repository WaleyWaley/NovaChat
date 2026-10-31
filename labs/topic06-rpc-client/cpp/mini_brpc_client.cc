#include "mini_brpc_client.h"

#include "httplib.h"

namespace lab {

MiniBrpcClient::MiniBrpcClient(const std::string& base_url, int default_timeout_ms)
    : base_url_(base_url), default_timeout_ms_(default_timeout_ms) {
    // TODO: 去掉 base_url_ 末尾的 '/'
    //   while (!base_url_.empty() && base_url_.back() == '/') base_url_.pop_back();
    while(not base_url_.empty() and base_url_.back() == '/')
        base_url_.pop_back();
}

nlohmann::json MiniBrpcClient::call(const std::string& service_name,
                                    const std::string& method,
                                    const nlohmann::json& body,
                                    const CallOptions& opts) {
    // TODO: 实现通用 RPC 调用
    //
    //  1. 拼路径:   const std::string path = "/" + service_name + "/" + method;
    //     const std::string url = base_url_ + path;
    //  2. 超时:     int timeout_ms = opts.timeout_ms > 0 ? opts.timeout_ms : default_timeout_ms_;
    //     httplib::Client cli(base_url_);   // 接受 "http://host:port"
    //     cli.set_connection_timeout(timeout_ms / 1000, (timeout_ms % 1000) * 1000); // 秒, 微秒
    //     cli.set_read_timeout(timeout_ms / 1000, (timeout_ms % 1000) * 1000);
    //     cli.set_write_timeout(timeout_ms / 1000, (timeout_ms % 1000) * 1000);
    //  3. 组装头:   httplib::Headers headers = {{"Content-Type", "application/json"}};
    //     for (const auto& [k, v] : opts.headers) headers.emplace(k, v);
    //  4. 发送:     auto res = cli.Post(path, headers, body.dump(), "application/json");
    //  5. 判网络错: if (!res) {
    //         // res.error() 是 httplib::Error
    //         // 超时 (ConnectionTimeout / Timeout / Read) -> 408, 其他 -> 503
    //         throw MiniBrpcError(408 或 503, httplib::to_string(res.error()), url);
    //     }
    //  6. 判 HTTP 错: if (res->status < 200 || res->status >= 300) {
    //         throw MiniBrpcError(res->status, res->body, url);
    //     }
    //  7. 解析:     return nlohmann::json::parse(res->body);

    const std::string path = "/" + service_name + "/" + method;
    const std::string url = base_url_ + path;

    int timeout_ms = opts.timeout_ms > 0 ? opts.timeout_ms : default_timeout_ms_;

    httplib::Client cli(base_url_);
    cli.set_connection_timeout(timeout_ms / 1000, (timeout_ms % 1000) * 1000);
    cli.set_read_timeout(timeout_ms / 1000, (timeout_ms % 1000) * 1000);
    cli.set_write_timeout(timeout_ms / 1000, (timeout_ms % 1000) * 1000);

    httplib::Headers headers = {{"Content-Type","application/json"}};
    for(const auto& [k,v] : opts.headers){
        headers.emplace(k, v);
    }

    auto res = cli.Post(path, headers, body.dump(), "application/json");

    if(not res){
        if(res.error() == httplib::Error::ConnectionTimeout or res.error() == httplib::Error::Timeout or res.error() == httplib::Error::Read){
            throw MiniBrpcError(408, httplib::to_string(res.error()), url);
        }else{
            throw MiniBrpcError(503, httplib::to_string(res.error()), url);
        }
    }

    if(res->status < 200 || res->status >= 300){
        throw MiniBrpcError(res->status, res->body, url);
    }
    return nlohmann::json::parse(res->body);
}
}  // namespace lab
