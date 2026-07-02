// =============================================================================
// NovaChat — MySQL 连接池实现 (Phase 1 stub)
//
// Phase 1: 桩实现 — user-service 使用内存存储
// Phase 2: 完整实现, 基于 brpc::Channel PROTOCOL_MYSQL
// =============================================================================

#include "nova/mysql_pool.h"
#include "nova/logger.h"

namespace nova {

bool MySqlPool::Init(const std::string& addr, int port,
                     const std::string& user, const std::string& passwd,
                     const std::string& db, int pool_size) {
    (void)addr; (void)port; (void)user; (void)passwd; (void)db; (void)pool_size;
    NOVA_LOG_INFO << "MySqlPool stub initialized (Phase 2 will connect to " << addr << ":" << port << "/" << db << ")";
    ready_ = true;
    return true;
}

brpc::Channel* MySqlPool::PickChannel() {
    return nullptr;
}

butil::Status MySqlPool::Execute(const std::string& sql) {
    (void)sql;
    return butil::Status(-1, "MySQL not available in Phase 1");
}

butil::Status MySqlPool::Query(const std::string& sql,
                               std::function<void(const Row&)> row_cb) {
    (void)sql; (void)row_cb;
    return butil::Status(-1, "MySQL not available in Phase 1");
}

butil::Status MySqlPool::QueryAll(const std::string& sql, std::vector<Row>* rows) {
    (void)sql; (void)rows;
    return butil::Status(-1, "MySQL not available in Phase 1");
}

}  // namespace nova
