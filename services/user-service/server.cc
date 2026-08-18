// =============================================================================
// NovaChat — User Service 入口 (bRPC Server)
//
// 启动流程:
//   1. 解析命令行参数和配置文件
//   2. 初始化日志系统和 Snowflake ID 生成器
//   3. (Phase 2) 初始化 MySQL 连接池和 Redis 客户端
//   4. 创建 DAO 层和服务实现
//   5. 添加服务到 bRPC Server 并启动
//   6. RunUntilAskedToQuit() 等待信号
//
// 构建: 由 services/user-service/CMakeLists.txt 管理
//
// 开发模式 (无需外部依赖):
//   ./nova_user_service --flagfile=conf/user_service.flags
//
// 完整模式 (MySQL + Redis):
//   ./nova_user_service --flagfile=conf/user_service.flags \
//       --enable_mysql --enable_redis
// =============================================================================

#include <brpc/server.h>
#include <gflags/gflags.h>
#include <thread>
#include <chrono>

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

// MySQL 配置
DEFINE_string(mysql_addr, "127.0.0.1", "MySQL address");
DEFINE_int32(mysql_port, 3306, "MySQL port");
DEFINE_string(mysql_user, "root", "MySQL user");
DEFINE_string(mysql_passwd, "", "MySQL password");
DEFINE_string(mysql_db, "novachat", "MySQL database name");
DEFINE_int32(mysql_pool_size, 8, "MySQL connection pool size");
DEFINE_bool(enable_mysql, false, "Enable MySQL for persistent user storage");

// Redis 配置
DEFINE_string(redis_addr, "127.0.0.1", "Redis address");
DEFINE_int32(redis_port, 6379, "Redis port");
DEFINE_string(redis_passwd, "", "Redis password");
DEFINE_bool(enable_redis, false, "Enable Redis for session caching");

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

    // --- 4. 创建 DAO 层并初始化存储后端 ---
    nova::user::UserDao user_dao;

    // MySQL: 持久化用户数据 (指数退避重试, 最多等 2 分钟)
    if (FLAGS_enable_mysql) {
        NOVA_LOG_INFO << "Initializing MySQL at " << FLAGS_mysql_addr
                      << ":" << FLAGS_mysql_port << "/" << FLAGS_mysql_db;
        bool mysql_ok = false;
        int delay = 1;
        for (int retry = 0; retry < 20; retry++) {
            if (retry > 0) {
                NOVA_LOG_INFO << "MySQL connection retry " << retry
                              << "/20 (waiting " << delay << "s)...";
                std::this_thread::sleep_for(std::chrono::seconds(delay));
                if (delay < 30) delay *= 2;  // 指数退避: 1,2,4,8,16,30,30...
            }
            if (user_dao.InitMySql(FLAGS_mysql_addr, FLAGS_mysql_port,
                                   FLAGS_mysql_user, FLAGS_mysql_passwd,
                                   FLAGS_mysql_db, FLAGS_mysql_pool_size)) {
                mysql_ok = true;
                break;
            }
        }
        if (!mysql_ok) {
            NOVA_LOG_WARN << "MySQL initialization failed after 20 retries, "
                          << "falling back to in-memory storage for users";
        }
    }

    // Redis: Session 缓存
    if (FLAGS_enable_redis) {
        NOVA_LOG_INFO << "Initializing Redis at " << FLAGS_redis_addr
                      << ":" << FLAGS_redis_port;
        if (!user_dao.InitRedis(FLAGS_redis_addr, FLAGS_redis_port,
                                FLAGS_redis_passwd)) {
            NOVA_LOG_WARN << "Redis initialization failed, "
                          << "falling back to in-memory storage for sessions";
        }
    }

    NOVA_LOG_INFO << "UserDao initialized (user storage: "
                  << (FLAGS_enable_mysql && user_dao.IsStorageReady() ?
                      "MySQL" : "in-memory")
                  << ", session storage: "
                  << (FLAGS_enable_redis ? "Redis" : "in-memory")
                  << ", password: PBKDF2-SHA256)";

    // --- 5. 创建服务实现 ---
    nova::user::UserServiceImpl service_impl(&snowflake, &user_dao);

    // --- 6. 配置 bRPC Server ---
    brpc::Server server;
    brpc::ServerOptions options;

    options.idle_timeout_sec = FLAGS_idle_timeout_sec;

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

    // --- 9. Phase 3.4: 优雅关闭 ---
    NOVA_LOG_INFO << "User Service: draining connections...";
    // bRPC 自动停止接受新连接, 等待现有请求完成 (最多 5 秒)
    server.Stop(5000);
    NOVA_LOG_INFO << "User Service shutting down...";
    nova::ShutdownLogger();
    return 0;
}
