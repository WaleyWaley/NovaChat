# bRPC 深度解析：从 server.cc 入门到 bthread 协程调度 & Channel 客户端

> 基于 NovaChat 项目实际代码（`services/common/`、`services/user-service/`）
> 配套阅读：[[Dev.md]]、[[ProjectDiscription.md]]

---

## 目录

1. [入门：server.cc 与 user_dao 详解](#1-入门servercc-与-user_dao-详解)
   - [1.1 server.cc — 启动一个 bRPC Server 的标准流程](#11-servercc--启动一个-brpc-server-的标准流程)
   - [1.2 user_dao — 数据访问层](#12-user_dao--数据访问层)
   - [1.3 bRPC RPC 方法的四个参数](#13-brpc-rpc-方法的四个参数)
   - [1.4 ClosureGuard — 为什么不能忘记 done](#14-closureguard--为什么不能忘记-done)
   - [1.5 与 Gateway（TS 侧）的协作关系](#15-与-gatewayts-侧的协作关系)
2. [bthread 协程调度原理](#2-bthread-协程调度原理)
   - [2.1 问题背景：为什么需要 bthread？](#21-问题背景为什么需要-bthread)
   - [2.2 M:N 调度模型](#22-mn-调度模型)
   - [2.3 bthread 的创建与生命周期](#23-bthread-的创建与生命周期)
   - [2.4 RPC 方法被调用时发生了什么](#24-rpc-方法被调用时发生了什么)
   - [2.5 同步写法 → 异步执行：bthread 的自动挂起/唤醒](#25-同步写法--异步执行bthread-的自动挂起唤醒)
   - [2.6 跑完一轮完整调用](#26-跑完一轮完整调用)
3. [brpc::Channel 详解](#3-brpcchannel-详解)
   - [3.1 Channel 是什么](#31-channel-是什么)
   - [3.2 Redis 客户端：PROTOCOL_REDIS 模式](#32-redis-客户端protocol_redis-模式)
   - [3.3 MySQL 连接池：PROTOCOL_MYSQL 模式](#33-mysql-连接池protocol_mysql-模式)
   - [3.4 Channel 的连接复用机制](#34-channel-的连接复用机制)
4. [总结：一张全景图](#4-总结一张全景图)

---

## 1. 入门：server.cc 与 user_dao 详解

> 这一章从最基础的代码讲起。如果你之前没用过 bRPC，从这里开始。

### 1.1 server.cc — 启动一个 bRPC Server 的标准流程

`server.cc` 是 user-service 的入口文件（`services/user-service/server.cc`）。你可以把 bRPC Server 想象成一个"接线板"——它做的事情就是：**监听一个端口 → 收到请求 → 根据 URL 路径分发给对应的 Service 方法 → 返回响应**。

```
客户端 HTTP 请求
POST /nova.user.UserService/Register
       │
       ▼
bRPC Server (监听 :8001)
       │
       ├─ URL 路由: "/nova.user.UserService/Register" → UserServiceImpl::Register()
       │
       ▼
UserServiceImpl::Register(controller, request, response, done)
       │
       ├─ 参数校验
       ├─ UserDao::CreateUser()
       └─ response->set_access_token(...)
       │
       ▼
返回 HTTP 响应给客户端
```

下面是代码的 9 个步骤，逐段讲解。

#### 步骤 1-2：配置 & 日志（和 bRPC 无关）

```cpp
// gflags 定义命令行参数（bRPC 项目标配，Google 出品的命令行解析库）
DEFINE_int32(port, 8001, "User Service listen port");
DEFINE_string(listen_addr, "0.0.0.0", "Listen address");
// ...

int main(int argc, char* argv[]) {
    nova::Config::Init(&argc, &argv, ...);  // 解析 --flagfile=xxx.flags
    nova::InitLogger("user_service");        // 初始化日志
```

`gflags` 是 Google 的命令行参数库，和 bRPC 深度绑定。所有配置都可以通过 `--port=8001` 命令行或 `--flagfile=conf/user_service.flags` 文件传入。`DEFINE_int32` 定义的变量会变成全局的 `FLAGS_port`，你可以在代码任何地方使用。

#### 步骤 3：创建 Snowflake（与 bRPC 无关）

```cpp
nova::Snowflake snowflake(FLAGS_worker_id);
```

#### 步骤 4：创建 DAO 层（与 bRPC 无关）

```cpp
nova::user::UserDao user_dao;  // Phase 1: 内存存储
```

#### 步骤 5：创建 Service 实现 — **这是与 bRPC 挂钩的关键**

```cpp
nova::user::UserServiceImpl service_impl(&snowflake, &user_dao);
```

`UserServiceImpl` 继承自 proto 生成的 `nova::user::UserService` 基类。这个基类是 protoc 根据 `user.proto` 自动生成的，里面定义了 12 个虚函数（Register、Login、Logout...）。

**继承关系链**：

```
user.proto  ──protoc──→  user.pb.h    (消息类: RegisterReq, RegisterResp...)
                      →  user.brpc.h  (Service 基类: UserService, 含 12 个纯虚函数)
                                       ↓
                            UserServiceImpl : public UserService  ← 你写的类
                            实现全部 12 个虚函数
```

#### 步骤 6-7：**这是 bRPC 的核心 —— 创建 Server 并启动**

```cpp
// 6. 创建 bRPC Server 对象
brpc::Server server;
brpc::ServerOptions options;
options.idle_timeout_sec = FLAGS_idle_timeout_sec;

// ★ 关键调用：把 Service 实现 "挂载" 到 Server 上
if (server.AddService(&service_impl,
                      brpc::SERVER_DOESNT_OWN_SERVICE) != 0) {
    // 失败...
}

// 7. 解析监听地址并启动
butil::EndPoint ep;
butil::str2endpoint(FLAGS_listen_addr.c_str(), FLAGS_port, &ep);
server.Start(ep, &options);
```

逐行解释：

| 代码 | 含义 |
|------|------|
| `brpc::Server server` | 创建一个 Server 对象，它管理所有网络 I/O |
| `brpc::ServerOptions options` | 配置项：超时、线程数、最大并发等 |
| `server.AddService(&service_impl, ...)` | **把 Service 注册到 Server**。之后所有发往 `/nova.user.UserService/Register` 的请求，bRPC 都会自动路由到 `service_impl.Register()` |
| `SERVER_DOESNT_OWN_SERVICE` | 告诉 bRPC："这个 service_impl 的内存由我（main）管理，你别 delete 它"。因为 `service_impl` 是栈上变量，bRPC 不应该去 delete |
| `butil::str2endpoint(...)` | 把 `"0.0.0.0"` + `8001` 转成 `butil::EndPoint` 结构体（IP + Port） |
| `server.Start(ep, &options)` | **启动！** 开始监听端口，接收请求 |

#### 步骤 8-9：等待退出信号 + 清理

```cpp
server.RunUntilAskedToQuit();  // 阻塞等待 SIGINT/SIGTERM
// ...清理
```

`RunUntilAskedToQuit()` 是 bRPC 提供的便捷函数，内部等价于：

```cpp
// 伪代码 — bRPC 实际上帮你做的事
sigset_t sigs;
sigaddset(&sigs, SIGINT);
sigaddset(&sigs, SIGTERM);
sigwait(&sigs, &sig);  // 一直等到收到信号
```

#### 总结：bRPC Server 的生命周期

```
main() 启动
  │
  ├─ 1. 解析配置 (gflags)
  ├─ 2. 创建业务对象 (Snowflake, UserDao)
  ├─ 3. 创建 ServiceImpl (你的 RPC 业务逻辑)
  ├─ 4. server.AddService(&service_impl)   ← 注册 RPC 方法
  ├─ 5. server.Start(ep)                   ← 开始监听，事件循环启动
  │      │
  │      └── [bthread 协程池在后台运行，处理请求...]
  │            │
  │            ├── 请求 /nova.user.UserService/Register → service_impl.Register()
  │            ├── 请求 /nova.user.UserService/Login    → service_impl.Login()
  │            └── ...
  │
  └─ 6. server.RunUntilAskedToQuit()       ← 阻塞等待
         │
         └── Ctrl+C → 优雅关闭
```

---

### 1.2 user_dao — 数据访问层

`UserDao`（`services/user-service/user_dao.h` + `user_dao.cc`）是纯业务逻辑，**和 bRPC 没有直接关系**。它做的事情就是 CRUD（增删改查），Phase 1 用内存中的 `std::unordered_map` 模拟数据库。

#### 核心数据结构

```cpp
// 三个 map + 一把锁 = 内存数据库
std::unordered_map<int64_t, UserRecord>    users_by_id_;       // 主索引: user_id → UserRecord
std::unordered_map<std::string, int64_t>   users_by_username_;  // 辅助索引: username → user_id
std::unordered_map<std::string, SessionRecord> sessions_;       // refresh_token → Session
std::mutex mu_;  // 一把大锁保护所有操作（线程安全）
```

设计思路：
- `users_by_id_` 是**主存储**，按 user_id 查
- `users_by_username_` 是**辅助索引**，按 username 查时先找到 user_id，再查主存储
- `sessions_` 独立存储 Session
- 每个 public 方法开头都 `std::lock_guard<std::mutex> lock(mu_)`，保证多线程安全

#### 关键方法举例

**CreateUser — 创建用户**（`user_dao.cc:48-82`）：

```cpp
std::optional<UserRecord> UserDao::CreateUser(...) {
    std::lock_guard<std::mutex> lock(mu_);  // ① 加锁

    if (users_by_username_.count(username)) {
        return std::nullopt;  // ② 用户名已存在 → 返回空
    }

    UserRecord record;
    record.user_id = user_id;  // ③ 填充字段...
    // ...

    users_by_id_[user_id] = record;           // ④ 写主索引
    users_by_username_[username] = user_id;   // ⑤ 写辅助索引
    return record;                            // ⑥ 返回拷贝
}
```

**FindByUsername — 两级查找**（`user_dao.cc:94-106`）：

```cpp
std::optional<UserRecord> UserDao::FindByUsername(const std::string& username) {
    std::lock_guard<std::mutex> lock(mu_);

    auto it = users_by_username_.find(username);  // ① 辅助索引: username → user_id
    if (it == users_by_username_.end()) return std::nullopt;

    auto user_it = users_by_id_.find(it->second); // ② 主索引: user_id → UserRecord
    if (user_it->second.is_deleted) return std::nullopt;  // ③ 过滤已删除

    return user_it->second;
}
```

#### Phase 2 迁移到 MySQL/Redis

注意 `user_dao.h:142-152` 已经预留了 MySQL / Redis 接口：

```cpp
private:
    // Phase 1: 内存存储
    std::unordered_map<...> users_by_id_;  // ← Phase 2 后删掉
    // ...

    // Phase 2: 持久化存储
    std::unique_ptr<nova::MySqlPool>  mysql_;   // ← Phase 2 启用
    std::unique_ptr<nova::RedisClient> redis_;  // ← Phase 2 启用
```

当 Phase 2 接入真实 MySQL 后，对外接口（`CreateUser`、`FindById` 等）**完全不变**——只是内部实现从读写 `unordered_map` 变成了 SQL 查询。这就是 DAO 模式的好处：上层 Service 代码完全不需要改动。

---

### 1.3 bRPC RPC 方法的四个参数

看 `user_service_impl.cc` 中任意一个 RPC 方法，比如 `Login`（`user_service_impl.cc:199-251`）：

```cpp
void UserServiceImpl::Login(
    ::google::protobuf::RpcController* controller,  // ① 控制器
    const ::nova::user::LoginReq* request,          // ② 请求（Protobuf 消息）
    ::nova::user::LoginResp* response,              // ③ 响应（Protobuf 消息）
    ::google::protobuf::Closure* done) {            // ④ 回调
```

| 参数 | 类型 | 作用 |
|------|------|------|
| **controller** | `RpcController*` | 获取连接信息、设置超时、标记失败。代码中 `cntl->remote_side()` 获取客户端 IP |
| **request** | `LoginReq*` | 反序列化后的请求数据。直接读 `request->username()` 即可 |
| **response** | `LoginResp*` | 你需要填充的响应。`response->set_access_token(...)` |
| **done** | `Closure*` | **必须调用！** `brpc::ClosureGuard done_guard(done)` 在函数返回时自动调用，告诉 bRPC "处理完了，可以回响应了" |

**这四个参数是 protoc 自动生成的**。你在 `user.proto` 中定义了：

```protobuf
service UserService {
    rpc Login(LoginReq) returns (LoginResp);
}
```

protoc 生成的 `user.brpc.h` 中就包含了 `UserService` 基类和这个四参数虚函数签名。你只需要继承 `UserService` 并实现 `Login`，bRPC 框架就会自动完成网络 I/O → 反序列化 → 调用你的函数 → 序列化响应 → 发回客户端。

---

### 1.4 ClosureGuard — 为什么不能忘记 done

每个 RPC 方法的第一个动作都是：

```cpp
brpc::ClosureGuard done_guard(done);
```

**`brpc::ClosureGuard` 是最重要的细节**。它是一种 RAII（Resource Acquisition Is Initialization）模式：

```cpp
brpc::ClosureGuard done_guard(done);  // 构造时什么都不做
// ... 你的业务逻辑 ...
return;  // done_guard 析构 → 自动调用 done->Run() → bRPC 把 response 发回客户端
```

如果你直接写 `done->Run()` 而不是用 `ClosureGuard`，会有什么问题？

```cpp
// ❌ 危险写法
void Login(...) {
    if (error) {
        response->set_error_code(...);
        done->Run();  // 手动调用
        return;
    }
    // ... 更多逻辑 ...
    done->Run();  // 容易遗漏！
}
```

一旦某个 `return` 分支忘了调用 `done->Run()`，客户端会一直等到超时。`ClosureGuard` 利用 C++ 的析构机制，确保不管从哪个 `return` 出去，`done` 都会被调用。

**这就是为什么每个 RPC 方法都在第一行写 `brpc::ClosureGuard done_guard(done)`**。

---

### 1.5 与 Gateway（TS 侧）的协作关系

回到整体架构，TS 网关不需要知道 bRPC 的存在。它只需要发一个普通的 HTTP POST：

```typescript
// Gateway 侧代码（项目 1.7 要做的事情）
const resp = await fetch("http://user-service:8001/nova.user.UserService/Register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "alice", password: "secret123", first_name: "Alice" })
});
```

bRPC 的 `http+pb` 模式自动把 JSON 转成 C++ 的 `RegisterReq`，你的 `UserServiceImpl::Register()` 就收到了强类型的数据。对 Gateway 来说，C++ 后端就像一个普通的 HTTP REST API。

**关键好处**：Gateway 不需要引入任何 Protobuf 库，不需要生成 TS 代码，不需要手写编解码。只需要 `fetch()`。

```
客户端 ──WebSocket (JSON)──→  Gateway  ──HTTP (JSON)──→  bRPC/Protobuf  ──→  C++ UserService
                                                              ↑
                                              bRPC 自动 JSON → Protobuf 转换
```

---

## 2. bthread 协程调度原理

### 2.1 问题背景：为什么需要 bthread？

### 传统线程模型的问题

假设 user-service 每秒要处理 10,000 个 Login 请求。每个 Login 需要查一次 MySQL（耗时 ~5ms）和一次 Redis（耗时 ~1ms）。

**方案 A：每请求一个线程（Apache 模型）**

```
10,000 请求/秒 × 每个请求占用线程 6ms = 同时需要 60 个活跃线程
但线程栈默认 8MB → 60 × 8MB = 480MB，这只是"同时活跃"的。
考虑到排队，可能需要 200+ 个线程 → 1.6GB 栈内存
加上内核态调度开销 → CPU 大量时间花在 context switch 上
```

**方案 B：异步回调（Node.js 模型）**

```
Register(req, [](resp) {
    // 回调地狱：查 MySQL → 回调 → 查 Redis → 回调 → 返回
    mysql->Query(sql, [=](rows) {
        redis->Set(key, [=](ok) {
            response->set_token(...);
            done->Run();
        });
    });
});
```

能解决线程爆炸问题，但代码**不可读、难调试**。

### bthread 的方案：同步写法，异步执行

bthread 是 bRPC 内置的**用户态协程**。你写的是同步代码：

```cpp
// 这段代码看起来是同步阻塞的，实际底层是异步非阻塞的
void UserServiceImpl::Login(...) {
    auto record = user_dao_->FindByUsername(request->username());  // 读内存，瞬间返回
    // Phase 2:
    // auto session = redis_->Get("session:" + token);   // ← "阻塞"等待 Redis 响应
    // auto user = mysql_->Query("SELECT ...");           // ← "阻塞"等待 MySQL 响应
    response->set_access_token(token);  // 串行逻辑，清晰直观
}
```

但底层，当代码"等待"Redis/MySQL 时，**当前 bthread 让出 pthread，pthread 去执行其他 bthread**。Redis 回复到达后，bRPC 再把 bthread 唤醒，从下一行继续执行。

---

### 2.2 M:N 调度模型

```
┌─────────────────────────────────────────────────────────┐
│                    用户代码层                             │
│  bthread₁   bthread₂   bthread₃   ...   bthread₂₀₀₀₀   │
│     │          │          │               │              │
│     │    (你写的 Login / Register / GetUserProfile ...)   │
└─────┼──────────┼──────────┼───────────────┼──────────────┘
      │          │          │               │
      └──────────┼──────────┼───────────────┘
                 │          │
┌────────────────┼──────────┼──────────────────────────────┐
│                ▼          ▼                bRPC 调度器    │
│           bthread 调度器 (TaskGroup)                      │
│                                                          │
│   每个 TaskGroup 绑定一个 pthread:                        │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│   │pthread₀  │  │pthread₁  │  │pthread₂  │  ... (通常  │
│   │          │  │          │  │          │   = CPU 核数)│
│   │ b₁ b₅ b₉ │  │ b₂ b₆ ..│  │ b₃ b₇ ..│              │
│   └──────────┘  └──────────┘  └──────────┘              │
│        ▲              ▲              ▲                    │
│        │              │              │                    │
│   ┌────┴──────────────┴──────────────┴────┐              │
│   │         epoll / I/O 事件循环            │              │
│   │   (监听所有 fd 的可读/可写事件)          │              │
│   └────────────────────────────────────────┘              │
└──────────────────────────────────────────────────────────┘
```

**关键数字**：

| 概念 | 数量 | 说明 |
|------|------|------|
| pthread（内核线程） | CPU 核数（通常 4~16） | 真正占 CPU 的线程 |
| bthread（用户态协程） | 可达数万 | 跑在 pthread 上的"任务" |
| bthread 栈大小 | **32KB**（默认） | 远小于 pthread 的 8MB |

**为什么 32KB 够用？** 因为 bthread 只在"等待 I/O"时才挂起，此时它的调用栈很浅（通常只有几层函数调用）。大部分业务逻辑跑完就结束了，不需要 8MB 的栈。

### 2.3 bthread 的创建与生命周期

bRPC Server 收到请求时，自动创建 bthread 来执行 RPC 方法。相当于：

```cpp
// 这是 bRPC 内部做的事情（伪代码，不是 NovaChat 的实际代码）
void brpc::Server::OnRequestArrived(Socket* socket, RequestMessage* req) {
    // 从 bthread 池中取一个空闲 bthread（或新建）
    bthread_t tid;

    // 关键调用：bthread_start_background
    // 把 RPC 方法包装成一个 bthread 任务，丢到调度队列里
    bthread_start_background(
        &tid, nullptr,
        [socket, req]() {
            // 1. 根据 URL 找到对应的 Service 方法
            //    /nova.user.UserService/Login → UserServiceImpl::Login
            auto* method = FindMethod(req->uri());

            // 2. 反序列化请求 (HTTP/JSON → Protobuf)
            auto* request_msg = method->ParseRequest(req->body());

            // 3. 调用你的 RPC 方法
            method->Call(service_impl, controller, request_msg, response_msg, done);

            // 4. done->Run() 被 ClosureGuard 调用 → 序列化响应 → 发回客户端
        }
    );
    // bthread_start_background 立即返回，不阻塞当前 bthread/pthread
}
```

**生命周期状态机**：

```
            创建
             │
             ▼
    ┌──────────────┐
    │   READY      │  在调度队列中排队
    └──────┬───────┘
           │ 调度器选中
           ▼
    ┌──────────────┐
    │   RUNNING    │  正在某个 pthread 上执行
    └──────┬───────┘
           │
      ┌────┴────┐
      │         │
      ▼         ▼
  业务完成   需要等待 I/O
      │         │
      │         ▼
      │   ┌──────────────┐
      │   │  SUSPENDED   │  让出 pthread，pthread 去执行别的 bthread
      │   └──────┬───────┘
      │          │ I/O 完成 (epoll 通知)
      │          ▼
      │   ┌──────────────┐
      │   │   READY      │  重新进入调度队列
      │   └──────┬───────┘
      │          │
      ▼          ▼
    ┌──────────────┐
    │   FINISHED   │  bthread 结束，栈内存回收
    └──────────────┘
```

### 2.4 RPC 方法被调用时发生了什么

以 `UserServiceImpl::Login` 为例。当 HTTP 请求到达时：

```
客户端发送:
  POST /nova.user.UserService/Login
  Content-Type: application/json
  {"username":"alice","password":"secret123"}

bRPC Server 内部处理 (全自动):
  ┌─────────────────────────────────────────────────────────┐
  │ 1. epoll 通知 pthread: fd 可读                            │
  │ 2. pthread 从 fd 读出 HTTP 请求                           │
  │ 3. 创建 bthread (或从池中取) 来处理这个请求                   │
  │ 4. bthread 中: 解析 HTTP → 提取 URL 路径                   │
  │     "/nova.user.UserService/Login"                       │
  │ 5. 查路由表: URL → UserServiceImpl::Login                 │
  │ 6. 解析 JSON Body → nova::user::LoginReq (Protobuf)       │
  │ 7. 调用: service_impl->Login(controller, &req, &resp, done)│
  │     ↑                                                     │
  │     这一行之后，代码进入你写的 UserServiceImpl::Login()       │
  └─────────────────────────────────────────────────────────┘
```

**路由表是怎么建立的？**

回顾 `server.cc:96`：

```cpp
server.AddService(&service_impl, brpc::SERVER_DOESNT_OWN_SERVICE);
```

`AddService` 内部做的事情：

```cpp
// bRPC 源码简化（不是 NovaChat 代码）
int Server::AddService(google::protobuf::Service* service, ...) {
    // 反射拿到 Service 描述符
    auto* descriptor = service->GetDescriptor();

    // 遍历所有 RPC 方法
    for (int i = 0; i < descriptor->method_count(); i++) {
        auto* method = descriptor->method(i);
        // method->full_name() = "/nova.user.UserService/Login"

        // 注册到路由表
        uri_map_[method->full_name()] = {service, method};
        //       ↑                            ↑         ↑
        //   "/nova.user.UserService/Login" → {service_impl, Login函数指针}
    }
}
```

这个路由表就是 bRPC 收到请求后找到对应处理函数的依据。

### 2.5 同步写法 → 异步执行：bthread 的自动挂起/唤醒

这是 bthread 最核心的机制。以 Phase 2 的 `Login` 为例（查 Redis + MySQL）：

```cpp
void UserServiceImpl::Login(...) {
    // ===== 代码段 A =====
    auto record = user_dao_->FindByUsername(request->username());
    // ↑ 纯内存操作，bthread 持续运行，不挂起

    // ===== 代码段 B =====  (Phase 2)
    // std::string session_data;
    // redis_->Get("session:" + token, &session_data);
    // ↑ 底层调 channel_.CallMethod(...)
    //   此时 bthread 被挂起 → pthread 去执行其他 bthread
    //   ... (IO 等待 ~1ms) ...
    //   epoll 通知: fd 可读 → bthread 被唤醒 → 继续执行下一行

    // ===== 代码段 C =====  (Phase 2)
    // auto user = user_dao_->FindByUsername(request->username());
    // ↑ 底层调 channel_.CallMethod(...)
    //   再次挂起 → ... (IO 等待 ~5ms) ... → 唤醒

    // ===== 代码段 D =====
    response->set_access_token(token);
    // done_guard 析构 → done->Run() → 响应发回客户端
}
```

**时间线对比**：

```
传统同步 (每请求一个 pthread):
  pthread: [==执行A==][====等待Redis====][==执行C==][====等待MySQL====][==执行D==]
           0.1ms      1ms 啥也不干         0.1ms      5ms 啥也不干         0.1ms
  总时间: 6.3ms, pthread 实际工作: 0.3ms, 浪费: 6ms (95% 在空等)

bthread (M:N 调度):
  请求1 bthread: [==A==][挂起...Redis...][==C==][挂起...MySQL...][==D==]
  请求2 bthread:    [==A==][挂起...Redis...][==C==][挂起...MySQL...][==D==]
  请求3 bthread:       [==A==][挂起...Redis...][==C==][挂起...MySQL...][==D==]
  ...
  pthread 视角:   [b1_A][b2_A][b3_A][b1_C][b2_C][b3_C][b1_D][b2_D][b3_D]...
                  ↑ 同一段时间内 pthread 处理了多个请求的"有效代码段"
                  bthread 挂起时 pthread 不空等，去执行别的 bthread
```

**挂起/唤醒的具体机制**：

```cpp
// bRPC Channel 内部 (简化)

void Channel::CallMethod(...) {
    // 1. 构造请求包
    SerializeRequest(cntl);

    // 2. 通过 socket 发送请求
    ssize_t n = write(fd, buf, len);

    if (n < len) {
        // 3. socket 发送缓冲区满了 → 需要等待可写
        //    ★ 关键操作：
        //    bthread_fd_wait(fd, EPOLLOUT);
        //
        //    内部做的事：
        //    a. 把当前 bthread 的状态设为 SUSPENDED
        //    b. 把 fd 注册到 epoll (监听 EPOLLOUT 事件)
        //    c. 保存当前 bthread 的执行上下文 (栈 + 寄存器 + 指令指针)
        //    d. yield: 从当前 bthread 的栈切回调度器的栈
        //    e. 调度器选下一个 READY 的 bthread，恢复其上下文，继续执行
    }

    // 4. 发送完毕，等待响应
    //    bthread_fd_wait(fd, EPOLLIN);
    //    同样挂起当前 bthread，直到 epoll 通知此 fd 可读

    // 5. 读取响应
    read(fd, response_buf, ...);

    // 6. 返回给调用方
    //    调用方的代码从 channel_.CallMethod() 的下一行继续执行
}
```

**关键点**：`bthread_fd_wait` 是整个魔法的核心。调用它的 bthread 被暂停，但 pthread 不阻塞——它立即从调度队列中取下一个 READY 的 bthread 继续执行。

### 2.6 跑完一轮完整调用

以 NovaChat `server.cc` 启动的 user-service 为例，一次 `Register` 请求的完整路径：

```
时刻 T0: TCP 连接到达 :8001
  → epoll_wait 返回 → 内核线程 pthread₀ 被唤醒

T0+0.01ms: pthread₀ 创建 bthread₁ 来处理这个请求
  → bthread₁ 开始执行
  → 解析 HTTP → 匹配路由 → 反序列化 → 调用 Register()

T0+0.02ms: bthread₁ 执行 Register() 的业务逻辑
  → 参数校验 (纯内存, 不挂起)
  → user_dao_->UsernameExists() (纯内存, 不挂起)
  → snowflake_->NextId() (纯内存, 不挂起)
  → user_dao_->CreateUser() (纯内存, 不挂起)
  → Phase 2: redis_->Set() → channel_.CallMethod()
      → bthread_fd_wait(fd, EPOLLOUT|EPOLLIN)
      → bthread₁ 挂起，状态 = SUSPENDED
      → pthread₀ 检查调度队列，取出 bthread₂ (处理另一个请求)

T0+0.5ms: pthread₀ 在跑 bthread₂ 的 Login() 业务逻辑
  → bthread₂ 也调了 redis_->Get() → 也挂起了
  → pthread₀ 取出 bthread₃...

T0+1.2ms: Redis 返回响应
  → epoll 通知: fd 可读
  → bRPC 把 bthread₁ 状态从 SUSPENDED → READY
  → 放入调度队列

T0+1.5ms: pthread₁ (另一个内核线程) 从调度队列取出 bthread₁
  → bthread₁ 从 channel_.CallMethod() 的 "读取响应" 步骤恢复执行
  → 解析 Redis 响应
  → 继续执行 Register() 的剩余代码
  → 填充 RegisterResp → ClosureGuard 析构 → done->Run()
  → 响应序列化为 JSON → 通过 HTTP 发回客户端

T0+1.6ms: bthread₁ 执行完毕 → FINISHED
  → bthread 对象回收，栈内存归还池
```

**关键观察**：
- bthread₁ 在 T0+0.02ms 挂起后，在 T0+1.5ms 才恢复。中间 1.48ms 的空窗期，pthread₀ 和 pthread₁ 都在执行其他有用的工作。
- **没有任何一个 pthread 被阻塞**。如果有 4 个 CPU 核心，就有 4 个 pthread 全速运转，处理成千上万个 bthread。

---

## 3. brpc::Channel 详解

### 3.1 Channel 是什么

`brpc::Channel` 是 bRPC 的**通用客户端抽象**。它可以和任何协议的后端通信——不只是 bRPC 协议，还支持 HTTP、Redis、MySQL、甚至直接 TCP。

```
                    ┌─────────────────────────────┐
                    │        brpc::Channel         │
                    │                              │
  调用方代码          │  协议模式 (protocol)           │
  channel_.CallMethod │  ┌──────────────────────┐   │   网络
  ──────────────────→│  │ PROTOCOL_REDIS → Redis│──→ Socket
                      │  │ PROTOCOL_MYSQL → MySQL│──→ Socket
                      │  │ PROTOCOL_HTTP  → HTTP │──→ Socket
                      │  │ PROTOCOL_BRPC  → bRPC │──→ Socket
                      │  └──────────────────────┘   │
                    └─────────────────────────────┘
```

**Channel 的两个核心职责**：

| 职责 | 说明 |
|------|------|
| **协议编解码** | 把 `cntl.set_mysql_sql(sql)` 变成 MySQL 协议的二进制包；把 Redis 响应的 RESP 协议解析成 `RedisReply` |
| **连接管理** | 自动建立 TCP 连接、空闲连接复用、断线重连、连接池管理 |
| **bthread 集成** | 网络 I/O 自动挂起/唤醒 bthread，不阻塞 pthread |

### 3.2 Redis 客户端：PROTOCOL_REDIS 模式

NovaChat 的 Redis 客户端在 `services/common/src/redis_client.cpp`。

#### 初始化

```cpp
// redis_client.cpp:47-73
bool RedisClient::Init(const std::string& addr, int port,
                       const std::string& password) {
    brpc::ChannelOptions opts;
    opts.protocol = brpc::PROTOCOL_REDIS;  // ★ 关键：指定 Redis 协议

    std::string server_addr = addr + ":" + std::to_string(port);
    // Channel::Init 只记录地址，不建立连接
    // TCP 连接在第一次 CallMethod 时才建立 (Lazy Connect)
    channel_.Init(server_addr.c_str(), &opts);

    // 有密码则发 AUTH 命令
    if (!password.empty()) {
        ExecRedis(&channel_, "AUTH " + password, &reply);
    }
    ready_ = true;
}
```

#### 发送命令：`ExecRedis` 是核心

```cpp
// redis_client.cpp:21-43
static butil::Status ExecRedis(brpc::Channel* ch,
                               const std::string& cmd_str,
                               brpc::RedisReply* reply) {
    brpc::Controller cntl;

    // ★ 把 Redis 命令字符串放到 HTTP URI 字段
    //   例如: cmd_str = "SET user:online:123 10.0.1.5:3000 EX 30"
    //   bRPC 内部自动把 URI 转成 RESP 格式:
    //   *3\r\n$3\r\nSET\r\n$15\r\nuser:online:123\r\n$14\r\n10.0.1.5:3000\r\n...
    cntl.http_request().uri() = cmd_str;

    // ★ CallMethod: 发送命令 + 等待响应
    //   5 个参数全是 nullptr 也没关系
    //   bRPC Redis 协议模式不需要标准的 Protobuf Service/Method
    ch->CallMethod(nullptr, &cntl, nullptr, nullptr, nullptr);

    if (cntl.Failed()) {
        return butil::Status(cntl.ErrorCode(), cntl.ErrorText());
    }

    // ★ 从 response_attachment 中解析 Redis 响应
    //   bRPC 已经把 RESP 协议的二进制数据解析成结构化的 RedisReply
    butil::IOBuf& buf = cntl.response_attachment();
    brpc::RedisReply::ParseFromIOBuf(buf, reply);

    if (reply->IsError()) {
        return butil::Status(-1, reply->error_message());
    }
    return butil::Status::OK();
}
```

**`cntl.http_request().uri()` 套 Redis 命令** 是 bRPC 的设计选择。因为 `brpc::Controller` 已经有了完整 HTTP 语义的字段，bRPC 复用了 `uri()` 来承载 Redis 命令字符串。底层自动做协议转换：

```
cntl.http_request().uri() = "SET mykey myvalue EX 30"
          │
          ▼
bRPC 内部 PROTOCOL_REDIS 编码器:
   把空格分隔的命令字符串 → RESP (Redis Serialization Protocol):
   *5\r\n                    (5 个参数)
   $3\r\nSET\r\n             (参数1: 长度3, "SET")
   $5\r\nmykey\r\n           (参数2: 长度5, "mykey")
   $7\r\nmyvalue\r\n         (参数3: 长度7, "myvalue")
   $2\r\nEX\r\n              (参数4: 长度2, "EX")
   $2\r\n30\r\n              (参数5: 长度2, "30")
          │
          ▼
   通过 TCP Socket 发送给 Redis Server
```

#### 上层调用

```cpp
// redis_client.cpp:77-93
butil::Status RedisClient::Set(const std::string& key,
                                const std::string& value, int ttl_sec) {
    // 1. 拼接命令字符串
    std::ostringstream cmd;
    cmd << "SET " << key << " " << value;
    if (ttl_sec > 0) cmd << " EX " << ttl_sec;

    // 2. 发送 + 等待响应
    brpc::RedisReply reply;
    butil::Status st = ExecRedis(&channel_, cmd.str(), &reply);

    // 3. 检查响应
    if (!reply.IsString() || reply.data().to_string() != "OK") {
        return butil::Status(-1, "SET failed");
    }
    return butil::Status::OK();
}
```

**这里体现了 bthread 的威力**：`ExecRedis` → `channel_.CallMethod` 会挂起当前 bthread，但整个 `Set()` 函数**看起来是同步的**——调用方只需要：

```cpp
butil::Status st = redis_->Set("user:online:123", "10.0.1.5:3000", 30);
if (!st.ok()) {
    NOVA_LOG_ERROR << "Redis SET failed: " << st.error_str();
}
```

不用回调、不用 `.then()`、不用 `await`。

### 3.3 MySQL 连接池：PROTOCOL_MYSQL 模式

NovaChat 的 MySQL 客户端在 `services/common/src/mysql_pool.cpp`。

#### 初始化：多个 Channel 组成连接池

```cpp
// mysql_pool.cpp:20-53
bool MySqlPool::Init(const std::string& addr, int port,
                     const std::string& user, const std::string& passwd,
                     const std::string& db, int pool_size) {
    pool_size_ = pool_size;
    channels_.reserve(pool_size);

    for (int i = 0; i < pool_size; ++i) {
        auto ch = std::make_unique<brpc::Channel>();
        brpc::ChannelOptions opts;
        opts.protocol = brpc::PROTOCOL_MYSQL;  // ★ 指定 MySQL 协议

        // ★ MySQL 连接字符串格式: user:passwd@host:port/db
        std::string server_addr = user + ":" + passwd + "@" + addr + ":"
                                + std::to_string(port) + "/" + db;

        ch->Init(server_addr.c_str(), &opts);
        channels_.push_back(std::move(ch));
    }
    ready_ = true;
}
```

**为什么 MySQL 需要连接池而 Redis 不需要？**

| | MySQL | Redis |
|------|-------|------|
| 连接类型 | 有状态（事务、临时表、SET NAMES...） | 无状态（每个命令独立） |
| 并发模型 | 一个连接同一时刻只能执行一条查询 | 单连接也可以交错发送多个命令 |
| 最佳实践 | 池化复用，避免频繁建连/断连 | 一个 Channel 即可，bRPC 自动复用 TCP 连接 |

`brpc::Channel` 的 Redis 模式下自带连接复用（底层 TCP 连接池），所以你不需要手动创建多个 Channel。而 MySQL 模式下，bRPC 也复用连接，但业务层用连接池可以分散负载、避免单连接瓶颈。

#### Round-Robin 分发

```cpp
// mysql_pool.cpp:55-58
brpc::Channel* MySqlPool::PickChannel() {
    // ★ 原子操作 + 取模 = 无锁 Round-Robin
    size_t idx = rr_idx_.fetch_add(1, std::memory_order_relaxed) % pool_size_;
    return channels_[idx].get();
}
```

`fetch_add` 是 CPU 级别的原子操作，不需要锁。每次调用返回不同的 Channel，保证 8 个 Channel 均匀分摊 SQL 请求。

#### 发送 SQL

```cpp
// mysql_pool.cpp:60-76
butil::Status MySqlPool::Execute(const std::string& sql) {
    brpc::Channel* ch = PickChannel();       // ① 选一个 Channel
    brpc::Controller cntl;

    cntl.set_mysql_sql(sql);                 // ② ★ 把 SQL 文本放到 Controller

    ch->CallMethod(nullptr, &cntl, nullptr, nullptr, nullptr);  // ③ 发送

    // ④ bRPC 自动:
    //    - 把 SQL 文本编码为 MySQL 协议二进制包
    //    - 通过 TCP 发送
    //    - 等待 MySQL 响应 (bthread 在此挂起)
    //    - 解析 MySQL 响应
    //    - bthread 被唤醒，继续执行

    if (cntl.Failed()) {
        return butil::Status(cntl.ErrorCode(), cntl.ErrorText());
    }
    return butil::Status::OK();
}
```

和 Redis 一样，`cntl.http_request().uri()` / `cntl.set_mysql_sql()` 都是给 Controller 填充"要发送什么"。bRPC 根据 `protocol` 设置自动选择对应的编码器。

**对比三种协议的使用方式**：

```cpp
// --- bRPC 原生协议 ---
// 需要 Protobuf Service/Method 定义
channel.CallMethod(&method, &cntl, &request, &response, done);

// --- Redis 协议 ---
cntl.http_request().uri() = "SET key value EX 30";
channel.CallMethod(nullptr, &cntl, nullptr, nullptr, nullptr);
// 响应在 cntl.response_attachment() 中，用 RedisReply::ParseFromIOBuf 解析

// --- MySQL 协议 ---
cntl.set_mysql_sql("SELECT * FROM users WHERE id = 1");
channel.CallMethod(nullptr, &cntl, nullptr, nullptr, nullptr);
// 响应在 cntl.response_attachment() 中，按 MySQL 协议解析
```

### 3.4 Channel 的连接复用机制

```
第一次 CallMethod:
  Channel 内部 → 检查连接池 → 没有可用连接 → 建立新 TCP 连接 → 缓存到池中 → 发送请求

第二次 CallMethod:
  Channel 内部 → 检查连接池 → 有空闲连接 → 直接复用 → 发送请求 (省了 TCP 建连的 1.5 RTT)

连接断开:
  Channel 内部 → 自动检测 (write 返回 EPIPE / 心跳超时) → 标记连接失效 → 下次自动重连
```

**NovaChat 项目中的使用总结**：

| 文件 | Channel 协议 | 使用方式 |
|------|-------------|---------|
| `services/common/src/redis_client.cpp` | `PROTOCOL_REDIS` | 单 Channel，15 个命令封装 |
| `services/common/src/mysql_pool.cpp` | `PROTOCOL_MYSQL` | N 个 Channel 组成连接池，Round-Robin 分发 |

两者都共享同一个优势：**代码是同步写法，底层是异步执行，bthread 自动挂起/唤醒，pthread 不阻塞**。

---

## 4. 总结：一张全景图

```
                              ┌─────────────────────────────────────────────┐
                              │              bRPC Server                     │
                              │                                              │
  客户端 ──HTTP/JSON──→       │  epoll 监听 :8001                            │
                              │     │                                        │
                              │     ▼                                        │
                              │  bthread₁ 创建 ←─ 从 bthread 池分配           │
                              │     │                                        │
                              │     ▼                                        │
                              │  URL 路由:                                    │
                              │  /nova.user.UserService/Login                │
                              │     │                                        │
                              │     ▼                                        │
                              │  UserServiceImpl::Login(ctrl, req, resp, done)│
                              │     │                                        │
                              │     ├── user_dao_->FindByUsername()  ← 内存   │
                              │     │                                        │
                              │     ├── redis_->Get() ──────────────┐        │
                              │     │    │                          │        │
                              │     │    ▼                          │        │
                              │     │  channel_.CallMethod()        │        │
                              │     │    │                          │        │
                              │     │    ▼                          │        │
                              │     │  bthread_fd_wait(fd,EPOLLIN)  │        │
                              │     │    │                          │        │
                              │     │    ├─ bthread₁ → SUSPENDED    │ 挂起   │
                              │     │    ├─ fd 注册到 epoll         │        │
                              │     │    ├─ 保存 bthread₁ 上下文    │        │
                              │     │    └─ pthread 去执行 bthread₂ │        │
                              │     │                               │        │
                              │     │  ... Redis 响应到达 ...        │ 等待   │
                              │     │  epoll 通知 → bthread₁ READY │        │
                              │     │    │                          │        │
                              │     │    ▼                          │        │
                              │     │  解析 RedisReply              │        │
                              │     │  继续执行 Login() 剩余代码     │ 恢复   │
                              │     │                               │        │
                              │     ├── response->set_access_token()│        │
                              │     │                               │        │
                              │     └── ClosureGuard 析构           │        │
                              │         → done->Run()               │        │
                              │         → 序列化 LoginResp          │        │
                              │         → 发 HTTP 响应给客户端       │        │
                              │     │                               │        │
                              │     ▼                               │        │
                              │  bthread₁ → FINISHED, 回收          │        │
                              └─────────────────────────────────────────────┘
```

**三个核心结论**：

1. **bthread 是 M:N 协程**：成千上万个 bthread 跑在少数几个 pthread 上。bthread 挂起时 pthread 不空等，去执行其他 bthread。

2. **同步写法，异步执行**：你写的 `redis_->Get()`、`mysql_->Query()` 看起来像同步阻塞调用，但 bRPC 底层自动挂起当前 bthread、切换走 pthread、等 I/O 完成后再唤醒 bthread。

3. **brpc::Channel 屏蔽了协议差异**：不管是 Redis (`PROTOCOL_REDIS`) 还是 MySQL (`PROTOCOL_MYSQL`)，使用方式都是 `cntl.注入命令 → channel.CallMethod → 解析响应`，代码结构一致。

---

> **最后更新**：2026-06-22
> **相关文档**：[[Dev.md]] (开发日志) | [[ProjectDiscription.md]] (数据流转详解) | [[Gateway.md]] (网关详解)
