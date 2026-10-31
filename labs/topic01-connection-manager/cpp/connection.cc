#include "connection.h"

#include <atomic>

#include "httplib.h"

namespace lab {

namespace {
std::atomic<int> g_next_id{1};
}  // namespace

Connection::Connection(httplib::ws::WebSocket* ws, int id) : id_(id), ws_(ws) {}

Connection::~Connection() = default;

bool Connection::ready() const {
    std::lock_guard<std::mutex> lock(mu_);
    return ws_ != nullptr && ws_->is_open();
}

bool Connection::send(const std::string& message) {
    std::lock_guard<std::mutex> lock(mu_);
    if (ws_ == nullptr || !ws_->is_open()) {
        return false;
    }
    return ws_->send(message);
}

void Connection::close(int code, const std::string& reason) {
    std::lock_guard<std::mutex> lock(mu_);
    if (ws_ == nullptr) {
        return;
    }
    ws_->close(static_cast<httplib::ws::CloseStatus>(code), reason);
}

void Connection::detach() {
    std::lock_guard<std::mutex> lock(mu_);
    ws_ = nullptr;
}

ConnectionPtr make_connection(httplib::ws::WebSocket* ws) {
    return std::make_shared<Connection>(ws, g_next_id++);
}

}  // namespace lab
