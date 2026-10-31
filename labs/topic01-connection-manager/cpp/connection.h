#pragma once

#include <cstdint>
#include <memory>
#include <mutex>
#include <string>

// 只需前置声明, 避免在头文件里引入巨大的 httplib.h
namespace httplib {
namespace ws {
class WebSocket;
}  // namespace ws
}  // namespace httplib

namespace lab {

/**
 * 对 httplib::ws::WebSocket 的轻量封装 (真实 WebSocket 连接)。
 *
 * 生命周期与线程安全 (重要):
 *  - WebSocket 对象由 cpp-httplib 在 handler 线程内持有, 只在 handler 存活期间有效。
 *  - 但 Connection 可能被"别的线程"调用 send()/close()/ready() (例如心跳线程、
 *    管理器的广播方法), 所以用 mu_ 保护 ws_ 指针。
 *  - handler 线程在退出 (WebSocket 即将销毁) 前, 必须先 unregister 再调用 detach(),
 *    把 ws_ 置空。之后任何 send()/close() 都直接安全返回, 不会访问已销毁的 ws。
 *
 * 对象用 std::shared_ptr 管理 (见 ConnectionPtr), 这样"正在发送"的线程可以持有
 * 一份引用, 保证连接对象不会在发送过程中被销毁。
 */
class Connection {
 public:
  Connection(httplib::ws::WebSocket* ws, int id);
  ~Connection();

  Connection(const Connection&) = delete;
  Connection& operator=(const Connection&) = delete;

  int id() const { return id_; }

  /** 连接是否仍然可写 */
  bool ready() const;

  /** 发送一条文本消息; 失败 (连接已关闭) 返回 false */
  bool send(const std::string& message);

  /** 关闭连接 (code 为 WebSocket close code, 如 4001/4002) */
  void close(int code, const std::string& reason);

  /** handler 线程在 WebSocket 销毁前调用, 之后就不要再访问 ws 了 */
  void detach();

 private:
  int id_;
  mutable std::mutex mu_;
  httplib::ws::WebSocket* ws_;  // 由 mu_ 保护
};

using ConnectionPtr = std::shared_ptr<Connection>;

/** 工厂: 创建一个 Connection */
ConnectionPtr make_connection(httplib::ws::WebSocket* ws);

}  // namespace lab
