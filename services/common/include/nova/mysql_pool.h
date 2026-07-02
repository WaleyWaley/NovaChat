#pragma once

// =============================================================================
// NovaChat — MySQL 连接池 (基于 brpc::Channel)
//
// 方案: 多个 brpc::Channel 实例组成的连接池, 轮询分发请求
//
// bRPC 的 MySQL 协议支持:
//   brpc::Channel 以 brpc::PROTOCOL_MYSQL 初始化后, 可直接发送 SQL 文本.
//   底层自动复用连接 + bthread 非阻塞 I/O.
//
// Phase 1: 搭建池化框架 + 接口占位
// Phase 2: 在 user_dao / message_dao 中实际写 SQL 交互
// =============================================================================

#include <vector>
#include <atomic>
#include <string>
#include <functional>
#include <memory>

#include <brpc/channel.h>
#include <butil/status.h>

namespace nova {

// 简化的结果行: 列名 → 值 (字符串)
using Row = std::map<std::string, std::string>;

class MySqlPool {
public:
    MySqlPool() = default;
    ~MySqlPool() = default;

    MySqlPool(const MySqlPool&) = delete;
    MySqlPool& operator=(const MySqlPool&) = delete;

    // 初始化连接池
    // addr:       MySQL 地址 (IP 或域名)
    // port:       MySQL 端口 (默认 3306)
    // user:       用户名
    // passwd:     密码
    // db:         数据库名
    // pool_size:  连接池大小 (默认 8)
    bool Init(const std::string& addr, int port,
              const std::string& user, const std::string& passwd,
              const std::string& db, int pool_size = 8);

    // 执行写操作 (INSERT / UPDATE / DELETE)
    // 返回: OK 表示成功, 否则携带错误信息
    butil::Status Execute(const std::string& sql);

    // 执行查询 (SELECT)
    // row_cb: 每行结果回调 (在 bthread 上下文中调用, 注意线程安全)
    butil::Status Query(const std::string& sql,
                        std::function<void(const Row&)> row_cb);

    // 查询并返回所有行
    butil::Status QueryAll(const std::string& sql, std::vector<Row>* rows);

    // 连接池是否已初始化
    bool IsReady() const { return ready_; }

    // 获取数据库名
    const std::string& Database() const { return db_; }

private:
    brpc::Channel* PickChannel();  // Round-robin 选择一个 Channel

    std::vector<std::unique_ptr<brpc::Channel>> channels_;
    size_t pool_size_ = 0;
    std::atomic<size_t> rr_idx_{0};
    std::string db_;
    bool ready_ = false;
};

}  // namespace nova
