// =============================================================================
// C++ Lab 03 — 消息 ACK + 已读回执
//
// 前置: 先运行 start_mysql.ps1 启动本地 MySQL (127.0.0.1:3307, root 免密)
// 运行: .\topic03_message_ack.exe
// =============================================================================

#include <iostream>
#include <string>
#include <vector>

#include "mini_message_dao.h"
#include "mini_mysql_pool.h"

using namespace lab;

namespace {

int g_pass = 0;
int g_fail = 0;

void check(const std::string& name, bool ok, const std::string& detail = "") {
    if (ok) {
        ++g_pass;
        std::cout << "  [PASS] " << name << "\n";
    } else {
        ++g_fail;
        std::cout << "  [FAIL] " << name;
        if (!detail.empty()) std::cout << "  (" << detail << ")";
        std::cout << "\n";
    }
}

}  // namespace

int main() {
    MiniMySqlPool pool;
    if (!pool.init("127.0.0.1", 3307, "root", "", "novachat_lab", 4)) {
        std::cerr << "[ERROR] MySQL 连接失败 —— 请先运行 start_mysql.ps1\n";
        return 1;
    }

    MiniMessageDao dao(&pool);

    // ---- 1. 建表 ----
    std::cout << "=== 1. 建表 ===\n";
    check("DROP TABLE", pool.execute("DROP TABLE IF EXISTS messages"));
    check("CREATE TABLE",
          pool.execute(
              "CREATE TABLE messages ("
              "message_id BIGINT PRIMARY KEY,"
              "from_peer_type INT, from_peer_id BIGINT,"
              "to_peer_type INT, to_peer_id BIGINT,"
              "text VARCHAR(1024), status INT, created_at BIGINT)"));

    // ---- 2. 发消息 (alice=1 -> bob=2 5条; bob=2 -> alice=1 3条, 全部 SENT) ----
    std::cout << "\n=== 2. 发消息 ===\n";
    std::vector<int64_t> ab;  // alice->bob
    for (int i = 0; i < 5; ++i) {
        ab.push_back(dao.save_message(1, 2, "hello " + std::to_string(i)));
    }
    std::vector<int64_t> ba;  // bob->alice
    for (int i = 0; i < 3; ++i) {
        ba.push_back(dao.save_message(2, 1, "reply " + std::to_string(i)));
    }
    check("save_message 返回递增 id", ab.size() == 5 && ba.size() == 3 &&
              ab[0] > 0 && ab[4] > ab[0] && ba[0] > ab[4]);

    // ---- 3. bob 初始同步状态 ----
    std::cout << "\n=== 3. bob 初始同步状态 ===\n";
    {
        auto s = dao.get_sync_state(2);
        check("latest == ab[4]", s.latest_msg_id == ab[4],
              "got " + std::to_string(s.latest_msg_id));
        check("last_ack == 0", s.last_ack_msg_id == 0);
        check("unread == 5", s.unread_count == 5,
              "got " + std::to_string(s.unread_count));
    }

    // ---- 4. bob 已读到 ab[2] (第3条) ----
    std::cout << "\n=== 4. bob ACK 到 ab[2] (READ) ===\n";
    {
        int n = dao.ack_messages(2, ab[2], MsgStatus::READ);
        check("更新了 3 条", n == 3, "got " + std::to_string(n));

        auto s = dao.get_sync_state(2);
        check("last_ack == ab[2]", s.last_ack_msg_id == ab[2],
              "got " + std::to_string(s.last_ack_msg_id));
        check("unread == 2", s.unread_count == 2,
              "got " + std::to_string(s.unread_count));
    }

    // ---- 5. 幂等: 重复 ACK ----
    std::cout << "\n=== 5. 幂等 (重复 ACK) ===\n";
    {
        int n = dao.ack_messages(2, ab[2], MsgStatus::READ);
        check("重复 ACK 返回 0", n == 0, "got " + std::to_string(n));
    }

    // ---- 6. 反向通知发送者 ----
    std::cout << "\n=== 6. get_acked_senders ===\n";
    {
        auto senders = dao.get_acked_senders(2, ab[2]);
        check("通知集合 == {alice}", senders.size() == 1 && senders[0] == 1,
              "size=" + std::to_string(senders.size()));
    }

    // ---- 7. 只升不降: 用 DELIVERED 去 ACK 已 READ 的消息 ----
    std::cout << "\n=== 7. 只升不降 ===\n";
    {
        int n = dao.ack_messages(2, ab[2], MsgStatus::DELIVERED);
        check("DELIVERED 不覆盖 READ", n == 0, "got " + std::to_string(n));
    }

    // ---- 8. bob 读完剩余 ----
    std::cout << "\n=== 8. bob ACK 到 ab[4] ===\n";
    {
        int n = dao.ack_messages(2, ab[4], MsgStatus::READ);
        check("再更新 2 条", n == 2, "got " + std::to_string(n));
        auto s = dao.get_sync_state(2);
        check("last_ack == ab[4]", s.last_ack_msg_id == ab[4]);
        check("unread == 0", s.unread_count == 0);
    }

    // ---- 9. alice 读 bob 的消息 ----
    std::cout << "\n=== 9. alice ACK bob 的消息 ===\n";
    {
        int n = dao.ack_messages(1, ba[2], MsgStatus::READ);
        check("更新了 3 条", n == 3, "got " + std::to_string(n));
        auto s = dao.get_sync_state(1);
        check("alice last_ack == ba[2]", s.last_ack_msg_id == ba[2]);
        check("alice unread == 0", s.unread_count == 0);
    }

    std::cout << "\n=== 结果: " << g_pass << " passed, " << g_fail << " failed ===\n";
    return g_fail == 0 ? 0 : 1;
}
