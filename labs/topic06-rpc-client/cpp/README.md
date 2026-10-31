# 实验 06：bRPC HTTP 客户端 + 服务注册表（C++ 版）

## 目标

用 C++ + `httplib::Client` 实现一个和网关 `gateway/src/clients/` **同构**的 HTTP RPC 客户端，理解：

1. `{baseUrl}/{serviceName}/{method}` → bRPC HTTP 端点的拼接规则
2. HTTP POST + JSON body 的收发
3. **超时**处理（对照 TS 的 `AbortController`）
4. **错误分类**（网络错 503 / 超时 408 / HTTP 错透传状态码）
5. 服务注册表（服务名 → URL + 完整服务名）
6. **int64 精度对比**：TS 需要正则 hack，C++ 的 nlohmann 直接精确解析

## 用到的库

| 库 | 用途 | 形式 |
|---|---|---|
| **cpp-httplib** (`httplib.h`) | HTTP 客户端（`httplib::Client`）+ 模拟服务端 | 单头文件 |
| **nlohmann/json** (`json.hpp`) | JSON 构造/解析 | 单头文件 |

由 `fetch_deps.ps1` 下载到 `third_party/`（已 gitignore）。

## 文件结构

```
cpp/
├── fetch_deps.ps1                     # 下载依赖
├── build.ps1                          # g++ 编译
├── mock_server.h / .cc                # ★ 提供：模拟 bRPC http+pb 端点
├── mini_service_registry.h / .cc      # ☆ 你实现（服务注册表）
├── mini_brpc_client.h / .cc           # ☆ 你实现（HTTP RPC 传输层）
├── mini_user_client.h / .cc           # ☆ 你实现（UserService 业务方法）
└── main.cc                            # ★ 提供：起 mock server + 跑测试
```

★ = 已实现，☆ = 你需要实现的 TODO。

## 第一步：编译运行

```powershell
cd labs/topic06-rpc-client/cpp
powershell -ExecutionPolicy Bypass -File fetch_deps.ps1   # 首次
powershell -ExecutionPolicy Bypass -File build.ps1
.\topic06_rpc_client.exe
```

当前骨架会跑出大量失败（因为 TODO 未实现）。实现后应变成 `11 passed, 0 failed`。

## 第二步：实现三个模块

### 1. `mini_service_registry.cc`

按 `gateway/src/clients/service_registry.ts` 注册两个服务：

| 服务名 | URL | 完整服务名 |
|---|---|---|
| `user-service` | `http://127.0.0.1:8001` | `nova.user.UserService` |
| `message-service` | `http://127.0.0.1:8002` | `nova.message.MessageService` |

`get_url` / `get_full_service_name` 找不到时抛 `std::runtime_error`。

### 2. `mini_brpc_client.cc`（核心）

`call` 的步骤（文件里有详细 TODO）：

1. 拼路径 `/{service_name}/{method}`
2. `httplib::Client cli(base_url_)`，用 `set_connection_timeout` / `set_read_timeout` / `set_write_timeout` 设超时
3. 组装请求头（`Content-Type: application/json` + 额外头）
4. `cli.Post(path, headers, body.dump(), "application/json")`
5. 判断返回值：
   - `!res` → 网络错：超时（`ConnectionTimeout` / `Timeout` / `Read`）→ 408，其他 → 503
   - `res->status` 非 2xx → 抛 `MiniBrpcError(res->status, ...)`
   - 否则 `nlohmann::json::parse(res->body)`

> **超时语义（重要）**：`CallOptions::timeout_ms` 默认是 `0`，表示"使用 `MiniBrpcClient` 构造时的默认超时"；`>0` 才覆盖本次调用。所以 `call` 里是
> `timeout_ms = opts.timeout_ms > 0 ? opts.timeout_ms : default_timeout_ms_;`

### 3. `mini_user_client.cc`

按 `user.proto` 构造请求 JSON，调用对应 RPC：

| 方法 | RPC | 请求字段 |
|---|---|---|
| `register_user` | `Register` | `username, password, first_name, last_name` |
| `login` | `Login` | `username, password, device_type` |
| `get_user_profile_by_id` | `GetUserProfile` | `user_id` |
| `get_user_profile_by_username` | `GetUserProfile` | `username` |

## 测试覆盖（main.cc）

| 用例 | 验证点 |
|---|---|
| 1. register_user | `error_code==0`；**`user_id == 9007199254740993`（2^53+1）精确解析**；username |
| 2. login | `user.username` |
| 3. get_user_profile_by_id | `user.user_id` |
| 4. get_user_profile_by_username | `user.username` |
| 5. 超时 | 500ms 超时调 SlowMethod（睡 2s）→ 抛 `MiniBrpcError`（408/503） |
| 6. HTTP 错误 | Boom 返回 500 → 抛 `MiniBrpcError`（status 500） |

## 关键对照：TS vs C++

| TS（网关） | C++（本 lab） |
|---|---|
| `fetch(url, {...})` | `httplib::Client.Post(...)` |
| `AbortController` + `setTimeout` | `set_connection_timeout` / `set_read_timeout` |
| `parseBrpcJson`（正则给大整数加引号再 parse） | **不需要**：nlohmann 精确解析 int64 |
| `BrpcCallError(408/503)` | `MiniBrpcError(408/503)` |
| 泛型 `<TReq, TResp>` | `nlohmann::json` |
| `service_registry.ts` 硬编码 | `mini_service_registry` 硬编码 |

### 为什么 int64 在 C++ 不需要 hack？

- **JS**：`JSON.parse` 把所有数字解析成 IEEE-754 double，`2^53+1` 会被舍入 —— 所以网关必须先把大整数字面量用引号包成字符串再 parse。
- **C++**：nlohmann 的 JSON 数字默认存成 `int64_t`，`9007199254740993` 原样保留。测试用例 1 专门验证这一点。

## 思考题（面试 Q&A）

1. 为什么 bRPC 的 HTTP 端点长这样 `/{full_service_name}/{method}`？网关为什么不用引入 Protobuf 库？
2. `httplib::Client` 的 `set_read_timeout` 和 TS 的 `AbortController` 在语义上有什么异同？（提示：一个取消整个请求，一个只控制单次 socket 读）
3. 超时应该归类为 408 还是 503？为什么网关要区分"超时"和"传输错误"？
4. 为什么 `CallOptions::timeout_ms` 用 `0` 当"未设置"的哨兵值？如果默认写成 `5000` 会出什么问题？（这正是本次踩过的坑）
5. 服务注册表现在是硬编码，如果改成 Consul/Etcd 动态发现，接口要怎么变？

## 完成后对比

- `gateway/src/clients/base.ts`
- `gateway/src/clients/service_registry.ts`
- `gateway/src/clients/user_client.ts`
