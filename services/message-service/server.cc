// =============================================================================
// NovaChat — Message Service 入口 (bRPC Server)
// =============================================================================

#include <brpc/server.h>
#include <gflags/gflags.h>

#include <thread>
#include <chrono>

#include "nova/common.h"
#include "nova/config.h"
#include "nova/logger.h"
#include "nova/snowflake.h"
#include "message_service_impl.h"
#include "message_dao.h"
#include "push_dispatcher.h"

DEFINE_int32(port, 8002, "Message Service listen port");
DEFINE_string(listen_addr, "0.0.0.0", "Listen address");
DEFINE_int32(idle_timeout_sec, -1, "Idle connection timeout");
DEFINE_int32(worker_id, 2, "Snowflake worker ID");

DEFINE_string(mysql_addr, "127.0.0.1", "MySQL address");
DEFINE_int32(mysql_port, 3306, "MySQL port");
DEFINE_string(mysql_user, "root", "MySQL user");
DEFINE_string(mysql_passwd, "", "MySQL password");
DEFINE_string(mysql_db, "novachat", "MySQL database name");
DEFINE_int32(mysql_pool_size, 8, "MySQL pool size");
DEFINE_bool(enable_mysql, false, "Enable MySQL");

DEFINE_string(redis_addr, "127.0.0.1", "Redis address");
DEFINE_int32(redis_port, 6379, "Redis port");
DEFINE_string(redis_passwd, "", "Redis password");
DEFINE_bool(enable_redis, false, "Enable Redis");

int main(int argc, char* argv[]) {
    nova::Config::Init(&argc, &argv,
        "NovaChat Message Service\n"
        "Usage: nova_message_service --flagfile=conf/message_service.flags\n");

    nova::InitLogger("message_service");

    NOVA_LOG_INFO << "================================================";
    NOVA_LOG_INFO << "  NovaChat Message Service starting...";
    NOVA_LOG_INFO << "  Version: " << nova::kVersion;
    NOVA_LOG_INFO << "  Listen:  " << FLAGS_listen_addr << ":" << FLAGS_port;
    NOVA_LOG_INFO << "  Worker:  " << FLAGS_worker_id;
    NOVA_LOG_INFO << "================================================";

    if (FLAGS_worker_id < 0 || FLAGS_worker_id > nova::kMaxWorkerId) {
        NOVA_LOG_FATAL << "Invalid worker_id: " << FLAGS_worker_id;
        return -1;
    }
    nova::Snowflake snowflake(FLAGS_worker_id);
    NOVA_LOG_INFO << "Snowflake initialized (worker_id=" << FLAGS_worker_id << ")";

    nova::message::MessageDao dao;
    nova::message::PushDispatcher push;

    // Phase 4: MySQL 持久化 (指数退避重试, 失败回退内存存储 — 与 user-service 一致)
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
                if (delay < 30) delay *= 2;   // 1,2,4,8,16,30,30...
            }
            if (dao.InitMySql(FLAGS_mysql_addr, FLAGS_mysql_port,
                              FLAGS_mysql_user, FLAGS_mysql_passwd,
                              FLAGS_mysql_db, FLAGS_mysql_pool_size)) {
                mysql_ok = true;
                break;
            }
        }
        if (!mysql_ok) {
            NOVA_LOG_WARN << "MySQL initialization failed after 20 retries, "
                          << "falling back to in-memory message storage";
        }
    }

    // Phase 2.5: PushDispatcher 直连网关 (HTTP PushService)
    // 共享 snowflake 生成 push_id (与 message_id 同一 ID 空间, 互不冲突)
    push.Init("gateway:3000", &snowflake);

    NOVA_LOG_INFO << "MessageDao initialized (storage: " << dao.StorageMode() << ")";

    nova::message::MessageServiceImpl service_impl(&snowflake, &dao, &push);

    brpc::Server server;
    brpc::ServerOptions options;
    options.idle_timeout_sec = FLAGS_idle_timeout_sec;

    if (server.AddService(&service_impl,
                          brpc::SERVER_DOESNT_OWN_SERVICE) != 0) {
        NOVA_LOG_FATAL << "Failed to add MessageService to brpc::Server";
        return -1;
    }

    butil::EndPoint ep;
    if (butil::str2endpoint(FLAGS_listen_addr.c_str(), FLAGS_port, &ep) != 0) {
        NOVA_LOG_FATAL << "Invalid listen address: "
                       << FLAGS_listen_addr << ":" << FLAGS_port;
        return -1;
    }

    if (server.Start(ep, &options) != 0) {
        NOVA_LOG_FATAL << "Failed to start Message Service on "
                       << FLAGS_listen_addr << ":" << FLAGS_port;
        return -1;
    }

    NOVA_LOG_INFO << "Message Service is running on "
                  << butil::endpoint2str(ep).c_str();
    NOVA_LOG_INFO << "  /nova.message.MessageService/SendMessage";
    NOVA_LOG_INFO << "  /nova.message.MessageService/GetMessages";
    NOVA_LOG_INFO << "Health check: http://"
                  << butil::endpoint2str(ep).c_str() << "/status";

    server.RunUntilAskedToQuit();

    // Phase 3.4: 优雅关闭 — 排空连接后退出
    server.Stop(5000);
    NOVA_LOG_INFO << "Message Service shutting down...";
    nova::ShutdownLogger();
    return 0;
}
