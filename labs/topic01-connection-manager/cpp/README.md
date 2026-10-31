# 实验 01：WebSocket 连接管理器（C++ 版 / 真实 WebSocket）

## 目标

用 C++ 实现和 TS 版**同构**的连接管理器，但基于**真实的 WebSocket 服务端**。重点学习：

1. `std::map` 做双向索引
2. `std::mutex` 保护共享状态
3. `std::thread` 跑心跳扫描
4. **C++ 工程铁律：持锁时不做 IO（send/close）**
5. 用 `std::shared_ptr` 管理连接对象的生命周期

## 用到的真实库

| 库 | 用途 | 形式 |
|---|---|---|
| **cpp-httplib** (`httplib.h`) | 真实 WebSocket 服务端（TCP + RFC6455 握手/帧） | 单头文件，零依赖 |
| **nlohmann/json** (`json.hpp`) | JSON 解析/构造 | 单头文件 |

它们由 `fetch_deps.ps1` 下载到 `third_party/`（该目录已 gitignore）。

## 文件结构

```
cpp/
├── fetch_deps.ps1                 # 下载 third_party 头文件库
├── build.ps1                      # g++ 构建脚本
├── connection.h / connection.cc   # 对 httplib::ws::WebSocket 的封装（已实现）
├── mini_connection_manager.h      # 管理器接口
├── mini_connection_manager.cc     # ★ 你要实现的地方（13 个 TODO）
├── main.cc                        # 真实 WS 服务器入口（已实现）
└── README.md
```

## 第一步：下载依赖 + 编译

```powershell
cd labs/topic01-connection-manager/cpp
powershell -ExecutionPolicy Bypass -File fetch_deps.ps1   # 首次
powershell -ExecutionPolicy Bypass -File build.ps1
.\topic01_conn_mgr.exe 3001
```

## 第二步：理解基础设施（已给你实现）

### `Connection`（connection.h/.cc）

对 `httplib::ws::WebSocket` 的轻量封装，要点：

- WebSocket 对象由 cpp-httplib 在 **handler 线程内**持有，只在 handler 存活期间有效。
- 但 `Connection` 会被**别的线程**调用 `send()`/`close()`（心跳线程、广播），所以用 `mu_` 保护 `ws_` 指针。
- handler 退出前必须：`unregister()` 再 `detach()`（把 `ws_` 置空），保证之后不会访问已销毁的 ws。
- 用 `ConnectionPtr`（`shared_ptr`）持有，保证"正在发送"的线程不会用到已销毁的对象。

### `main.cc`

- 用 `httplib::Server` 注册 `/ws` 的 WebSocket handler。
- handler 里：`make_connection(&ws)` → 发 welcome → `while (ws.read(msg))` 循环处理消息 → 退出时 `unregister` + `detach`。
- 已实现 `auth` / `ping` 的处理骨架，调用你的管理器方法。

## 第三步：实现 mini_connection_manager.cc

按 `TODO` 顺序实现（和 TS 逻辑一一对应，但**必须加锁**）：

1. `register_user`
2. `unregister`
3. `get_by_user_id`
4. `is_online`
5. `online_count`
6. `online_user_ids`
7. `send_to_user`
8. `send_to_users`
9. `kick_user`
10. `refresh_heartbeat`
11. `start_heartbeat`
12. `stop_heartbeat`
13. `disconnect_all`

## 第四步：验证

### 用 TS 客户端联调（推荐）

TS 版自带的客户端能直接连 C++ 服务器（协议一致）。开两个终端：

```powershell
# 终端 1：启动 C++ 服务器
.\topic01_conn_mgr.exe 3001

# 终端 2：用 TS 客户端连
cd ..\ts
node_modules\.bin\tsx.cmd src\test-client.ts alice 3001
```

### 一键端到端测试

`ts/src/e2e-cpp-server.ts` 会自动启动 C++ 服务器并测试互踢、心跳超时：

```powershell
cd ..\ts
node_modules\.bin\tsx.cmd src\e2e-cpp-server.ts
```

### 验证清单

- [ ] 编译通过
- [ ] 客户端能 auth 成功（收到 `auth_ok`）
- [ ] `ping` 能收到 `pong`，且不会被心跳断开
- [ ] 同用户登录两次，旧连接被 `close(4001)`
- [ ] 停止 ping 后，~15 秒内被 `close(4002)`
- [ ] `send_to_users` 返回正确的 delivered/missed

## 第五步：体会 C++ 和 TS 的关键差异

| 问题 | TS | C++ |
|---|---|---|
| 双向索引 | `Map` | `std::map` |
| 并发安全 | 单线程事件循环，天然安全 | 必须 `std::mutex` |
| 心跳定时 | `setInterval` | `std::thread` + `sleep_for` |
| 持锁做 IO | 无此约束 | **禁止**：send/close 必须在锁外 |
| 对象生命周期 | GC 管理 | `shared_ptr` + `detach()` |

## 思考题（面试 Q&A）

1. `send_to_user` 里为什么"先在锁内复制 `ConnectionPtr`，解锁后再 `send`"？如果持锁 send 会怎样？
2. `unregister` 里为什么检查 `by_user_id_[user_id].conn.get() != conn`？
3. `start_heartbeat` 扫描时也要"先收集、解锁、再 close"，和 `send_to_user` 是同一个道理，请解释。
4. handler 退出前为什么要先 `unregister` 再 `detach`？顺序反了会怎样？
5. `shared_ptr` 在这里解决了什么生命周期问题？

## 参考答案

对比 NovaChat 真实代码：

- `gateway/src/ws/connection.ts`（TS 版，你已完成）
- `services/common/include/nova/mysql_pool.h`（同样是 pthread + 任务队列思想）
