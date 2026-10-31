// =============================================================================
// C++ Lab 07 — MySQL 连接池 + 专用工作线程
//
// 前置: 先运行 start_mysql.ps1 启动本地 MySQL (127.0.0.1:3307, root 免密)
// 运行: .\topic07_mysql_pool.exe
// =============================================================================

#include <atomic>
#include <chrono>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

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

long long ms_since(std::chrono::steady_clock::time_point t0) {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now() - t0)
        .count();
}

}  // namespace

int main() {
    const std::string host = "127.0.0.1";
    const int port = 3307;
    const std::string user = "root";
    const std::string pass = "";
    const std::string db = "novachat_lab";

    std::cout << "[lab] connecting to MySQL " << host << ":" << port << "\n";

    MiniMySqlPool pool;
    if (!pool.init(host, port, user, pass, db, 4)) {
        std::cerr << "[ERROR] pool init 失败 —— 请先运行: "
                     "powershell -ExecutionPolicy Bypass -File start_mysql.ps1\n";
        return 1;
    }

    // ---- 1. 初始化 ----
    std::cout << "\n=== 1. 初始化 ===\n";
    check("is_ready", pool.is_ready());
    check("pool_size == 4", pool.pool_size() == 4,
          "got " + std::to_string(pool.pool_size()));

    // ---- 2. 准备表 ----
    std::cout << "\n=== 2. 建表 ===\n";
    check("DROP TABLE", pool.execute("DROP TABLE IF EXISTS lab_messages"));
    check("CREATE TABLE",
          pool.execute("CREATE TABLE lab_messages ("
                       "id INT PRIMARY KEY AUTO_INCREMENT, body VARCHAR(255))"));

    // ---- 3. 并发插入: 20 线程 x 10 条 ----
    std::cout << "\n=== 3. 并发插入 (20 线程 x 10 条) ===\n";
    {
        std::atomic<int> ok_count{0};
        std::vector<std::thread> ts;
        for (int t = 0; t < 20; ++t) {
            ts.emplace_back([&pool, &ok_count, t]() {
                for (int i = 0; i < 10; ++i) {
                    const std::string body =
                        "m-" + std::to_string(t) + "-" + std::to_string(i);
                    if (pool.execute("INSERT INTO lab_messages(body) VALUES('" +
                                     body + "')")) {
                        ok_count.fetch_add(1);
                    }
                }
            });
        }
        for (auto& th : ts) th.join();
        check("200 条插入成功", ok_count.load() == 200,
              "ok=" + std::to_string(ok_count.load()));
    }

    // ---- 4. 校验行数 ----
    std::cout << "\n=== 4. 校验行数 ===\n";
    {
        Rows rows = pool.query("SELECT COUNT(*) AS c FROM lab_messages");
        long long c = rows.empty() ? -1 : std::stoll(rows[0]["c"]);
        check("COUNT == 200", c == 200, "count=" + std::to_string(c));
    }

    // ---- 5. 并发查询: 40 线程 ----
    std::cout << "\n=== 5. 并发查询 (40 线程) ===\n";
    {
        std::atomic<int> ok_count{0};
        std::vector<std::thread> ts;
        for (int t = 0; t < 40; ++t) {
            ts.emplace_back([&pool, &ok_count]() {
                Rows rows = pool.query("SELECT COUNT(*) AS c FROM lab_messages");
                if (!rows.empty() && rows[0]["c"] == "200") ok_count.fetch_add(1);
            });
        }
        for (auto& th : ts) th.join();
        check("40 个查询全部返回正确结果", ok_count.load() == 40,
              "ok=" + std::to_string(ok_count.load()));
    }

    // ---- 6. 并发上限演示: pool_size=4 ----
    std::cout << "\n=== 6. 并发上限 (pool_size=4, 20 x SELECT SLEEP(0.2)) ===\n";
    {
        auto t0 = std::chrono::steady_clock::now();
        std::vector<std::thread> ts;
        for (int t = 0; t < 20; ++t) {
            ts.emplace_back([&pool]() { pool.query("SELECT SLEEP(0.2)"); });
        }
        for (auto& th : ts) th.join();
        const long long ms = ms_since(t0);
        std::cout << "  [info] 用时 " << ms << "ms (理论 ~1000ms = 20/4*0.2s)\n";
        check("受 pool_size 限制 (>= 800ms)", ms >= 800, std::to_string(ms) + "ms");
    }

    // ---- 7. 对比: pool_size=20 ----
    std::cout << "\n=== 7. 对比 (pool_size=20, 20 x SELECT SLEEP(0.2)) ===\n";
    {
        MiniMySqlPool big;
        if (!big.init(host, port, user, pass, db, 20)) {
            check("大池 init", false);
        } else {
            auto t0 = std::chrono::steady_clock::now();
            std::vector<std::thread> ts;
            for (int t = 0; t < 20; ++t) {
                ts.emplace_back([&big]() { big.query("SELECT SLEEP(0.2)"); });
            }
            for (auto& th : ts) th.join();
            const long long ms = ms_since(t0);
            std::cout << "  [info] 用时 " << ms << "ms (理论 ~200ms)\n";
            check("并发更高 (<= 600ms)", ms <= 600, std::to_string(ms) + "ms");
        }
    }

    std::cout << "\n=== 结果: " << g_pass << " passed, " << g_fail << " failed ===\n";
    return g_fail == 0 ? 0 : 1;
}
