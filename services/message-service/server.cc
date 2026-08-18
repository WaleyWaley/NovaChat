// =============================================================================
// NovaChat — Message Service 入口 (bRPC Server)
// =============================================================================

#include <brpc/server.h>
#include <gflags/gflags.h>

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

    // Phase 2.5: PushDispatcher 直连网关 (HTTP PushService)
    push.Init("gateway:3000");

    NOVA_LOG_INFO << "MessageDao + PushDispatcher initialized";

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
