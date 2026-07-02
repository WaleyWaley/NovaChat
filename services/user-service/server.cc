// =============================================================================
// NovaChat — User Service 入口 (bRPC Server)
//
// 启动流程:
//   1. 解析命令行参数和配置文件
//   2. 初始化日志系统和 Snowflake ID 生成器
//   3. 创建 DAO 层和服务实现
//   4. 添加服务到 bRPC Server 并启动
//   5. RunUntilAskedToQuit() 等待信号
//
// 构建: 由 services/user-service/CMakeLists.txt 管理
// 运行: ./nova_user_service --flagfile=conf/user_service.flags
// =============================================================================

#include <brpc/server.h>
#include <gflags/gflags.h>

#include "nova/common.h"
#include "nova/config.h"
#include "nova/logger.h"
#include "nova/snowflake.h"
#include "user_service_impl.h"
#include "user_dao.h"

// ============================= gflags 定义 ====================================

DEFINE_int32(port, 8001, "User Service listen port");
DEFINE_string(listen_addr, "0.0.0.0", "Listen address");
DEFINE_int32(idle_timeout_sec, -1, "Idle connection timeout (-1 = no timeout)");
DEFINE_int32(worker_id, 1, "Snowflake worker ID (0-1023, must be unique in cluster)");

// MySQL 配置 (Phase 2 启用)
DEFINE_string(mysql_addr, "127.0.0.1", "MySQL address");
DEFINE_int32(mysql_port, 3306, "MySQL port");
DEFINE_string(mysql_user, "root", "MySQL user");
DEFINE_string(mysql_passwd, "", "MySQL password");
DEFINE_string(mysql_db, "novachat", "MySQL database name");
DEFINE_int32(mysql_pool_size, 8, "MySQL connection pool size");

// Redis 配置 (Phase 2 启用)
DEFINE_string(redis_addr, "127.0.0.1", "Redis address");
DEFINE_int32(redis_port, 6379, "Redis port");
DEFINE_string(redis_passwd, "", "Redis password");

// ============================= main ===========================================

int main(int argc, char* argv[]) {
    // --- 1. 初始化配置 ---
    nova::Config::Init(&argc, &argv,
        "NovaChat User Service\n"
        "Usage: nova_user_service --flagfile=conf/user_service.flags\n");

    // --- 2. 初始化日志 ---
    nova::InitLogger("user_service");

    NOVA_LOG_INFO << "================================================";
    NOVA_LOG_INFO << "  NovaChat User Service starting...";
    NOVA_LOG_INFO << "  Version: " << nova::kVersion;
    NOVA_LOG_INFO << "  Listen:  " << FLAGS_listen_addr << ":" << FLAGS_port;
    NOVA_LOG_INFO << "  Worker:  " << FLAGS_worker_id;
    NOVA_LOG_INFO << "================================================";

    // --- 3. 创建 Snowflake ID 生成器 ---
    if (FLAGS_worker_id < 0 || FLAGS_worker_id > nova::kMaxWorkerId) {
        NOVA_LOG_FATAL << "Invalid worker_id: " << FLAGS_worker_id
                       << " (must be 0-" << nova::kMaxWorkerId << ")";
        return -1;
    }
    nova::Snowflake snowflake(FLAGS_worker_id);
    NOVA_LOG_INFO << "Snowflake initialized (worker_id=" << FLAGS_worker_id
                  << ", epoch=" << nova::kSnowflakeEpoch << ")";

    // --- 4. 创建 DAO 层 ---
    // Phase 1: 使用内存模拟存储
    // Phase 2: 改为 MySQL + Redis
    nova::user::UserDao user_dao;

    // Phase 2: 初始化 MySQL 连接池和 Redis 客户端
    // if (!user_dao.InitMySql(...)) { ... }
    // if (!user_dao.InitRedis(...)) { ... }

    NOVA_LOG_INFO << "UserDao initialized (Phase 1: in-memory storage)";

    // --- 5. 创建服务实现 ---
    nova::user::UserServiceImpl service_impl(&snowflake, &user_dao);

    // --- 6. 配置 bRPC Server ---
    brpc::Server server;
    brpc::ServerOptions options;

    options.idle_timeout_sec = FLAGS_idle_timeout_sec;
    // 不设置 max_concurrency, 让 bthread 自动调度
    // options.num_threads = 0;  // 0 = 使用 CPU 核心数

    // 添加 UserService
    if (server.AddService(&service_impl,
                          brpc::SERVER_DOESNT_OWN_SERVICE) != 0) {
        NOVA_LOG_FATAL << "Failed to add UserService to brpc::Server";
        return -1;
    }

    // --- 7. 启动服务 ---
    butil::EndPoint ep;
    if (butil::str2endpoint(FLAGS_listen_addr.c_str(), FLAGS_port, &ep) != 0) {
        NOVA_LOG_FATAL << "Invalid listen address: "
                       << FLAGS_listen_addr << ":" << FLAGS_port;
        return -1;
    }

    if (server.Start(ep, &options) != 0) {
        NOVA_LOG_FATAL << "Failed to start User Service on "
                       << FLAGS_listen_addr << ":" << FLAGS_port;
        return -1;
    }

    NOVA_LOG_INFO << "User Service is running on "
                  << butil::endpoint2str(ep).c_str();
    NOVA_LOG_INFO << "bRPC methods:";
    NOVA_LOG_INFO << "  /nova.user.UserService/Register";
    NOVA_LOG_INFO << "  /nova.user.UserService/Login";
    NOVA_LOG_INFO << "  /nova.user.UserService/GetUserProfile";
    NOVA_LOG_INFO << "  ... (12 RPCs total)";
    NOVA_LOG_INFO << "Health check: http://" << butil::endpoint2str(ep).c_str()
                  << "/status";

    // --- 8. 等待退出信号 ---
    server.RunUntilAskedToQuit();

    // --- 9. 清理 ---
    NOVA_LOG_INFO << "User Service shutting down...";
    nova::ShutdownLogger();
    return 0;
}
