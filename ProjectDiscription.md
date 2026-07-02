# NovaChat — 项目中 HTTP Body 的数据流动详解

> 本文档从"一段数据如何在客户端与服务端之间流转"的视角，逐层剖析 NovaChat 的 BFF 异构微服务架构下的请求-响应全过程。

---

## 目录

1. [整体架构速览](#1-整体架构速览)
2. [请求的起点：TS 网关发起 HTTP 调用](#2-请求的起点ts-网关发起-http-调用)
3. [bRPC 接手：HTTP/JSON → Protobuf 自动转换](#3-brpc-接手httpjson--protobuf-自动转换)
4. [C++ 服务端：从收包到回调的完整链路](#4-c-服务端从收包到回调的完整链路)
5. [响应的回程：Protobuf → JSON → HTTP Response](#5-响应的回程protobuf--json--http-response)
6. [一次完整的注册请求：逐帧回放](#6-一次完整的注册请求逐帧回放)
7. [C++ 内部 RPC：纯二进制模式下的数据流](#7-c-内部-rpc纯二进制模式下的数据流)
8. [反向推送：C++ → TS 网关的数据流](#8-反向推送c--ts-网关的数据流)
9. [关键设计决策与常见疑问](#9-关键设计决策与常见疑问)

---

## 1. 整体架构速览

```
┌──────────────────────────────────────────────────────────────────────┐
│                          NovaChat 架构三层                            │
│                                                                      │
│  ┌──────────┐                                                        │
│  │ Client   │  WebSocket (JSON)  ←→  TS Gateway (Fastify + ws)      │
│  │ (浏览器)  │                                                        │
│  └──────────┘        │  HTTP POST (JSON body)                        │
│                      │  /nova.user.UserService/Register              │
│                      ▼                                               │
│           ┌──────────────────────────────────┐                       │
│           │         bRPC Framework           │                       │
│           │  ┌────────────────────────────┐  │                       │
│           │  │  HTTP/JSON → Protobuf      │  │  ← 自动转换层          │
│           │  │  (无需手写序列化代码)        │  │                       │
│           │  └────────────────────────────┘  │                       │
│           └──────────────────────────────────┘                       │
│                      │                                               │
│                      ▼                                               │
│           ┌──────────────────────────────────┐                       │
│           │  C++ UserService (:8001)         │                       │
│           │  user_service_impl.cc            │                       │
│           │  └─ 拿到强类型 RegisterReq       │                       │
│           │  └─ 执行业务逻辑                  │                       │
│           │  └─ 填充强类型 RegisterResp      │                       │
│           └──────────────────────────────────┘                       │
└──────────────────────────────────────────────────────────────────────┘
```

**核心原则**：TS 网关只需要知道 JSON，C++ 服务只需要知道 Protobuf 结构体，bRPC 负责在中间完成双向翻译。

---

## 2. 请求的起点：TS 网关发起 HTTP 调用

### 2.1 一个真实的 fetch 调用

TS 网关中，调用 C++ user-service 注册接口的代码长这样：

```typescript
// gateway/src/clients/user_client.ts (未来实现)

async function registerUser(username: string, password: string, firstName: string) {
    const response = await fetch(
        "http://127.0.0.1:8001/nova.user.UserService/Register",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                username:   "alice",
                password:   "my_secure_password",
                first_name: "Alice",
                last_name:  "Smith",
                phone:      "+8613800138000"
            })
        }
    );

    const data = await response.json();
    // data = {
    //   error_code:    0,
    //   user_id:       123456789012345,
    //   access_token:  "tok_7b...",
    //   refresh_token: "rt_a3...",
    //   expires_at:    1718360000000,
    //   user:          { user_id: ..., username: "alice", ... }
    // }
    return data;
}
```

### 2.2 这段代码在网络上实际发出的字节

```http
POST /nova.user.UserService/Register HTTP/1.1
Host: 127.0.0.1:8001
Content-Type: application/json
Content-Length: 138

{
    "username":   "alice",
    "password":   "my_secure_password",
    "first_name": "Alice",
    "last_name":  "Smith",
    "phone":      "+8613800138000"
}
```

### 2.3 URL 的含义解析

```
http://127.0.0.1:8001/nova.user.UserService/Register
│                      │                         │
│                      │                         └── RPC 方法名: Register
│                      │                             (对应 proto 中 service UserService
│                      │                              里的 rpc Register)
│                      │
│                      └── bRPC 的 http+pb 协议路由规则:
│                          /<package>.<ServiceName>/<MethodName>
│                          package = nova.user  (来自 proto 文件第 3 行)
│                          ServiceName = UserService  (来自 proto 文件第 189 行)
│                          MethodName = Register  (来自 proto 文件第 191 行)
│
└── bRPC Server 的监听地址和端口
    (server.cc 通过 gflags --port=8001 --listen_addr=0.0.0.0 配置)
```

**关键点**：TS 端不需要引入任何 protobuf 库或生成代码。URL 路径本身就是 RPC 方法的标识符。

---

## 3. bRPC 接手：HTTP/JSON → Protobuf 自动转换

### 3.1 数据到达 bRPC 的第一站

当上面那 138 个字节的 JSON body 通过 TCP 到达 `127.0.0.1:8001` 时，bRPC 框架执行以下步骤：

```
步骤 1: 接收 TCP 数据包
  bRPC 的 EventDispatcher (epoll) 检测到 fd 可读
  └─ 从一个 bthread 中读取完整的 HTTP 请求

步骤 2: 解析 HTTP 请求行和头部
  ├─ Method:  POST
  ├─ URL:     /nova.user.UserService/Register
  ├─ Content-Type: application/json
  └─ Content-Length: 138

步骤 3: 根据 URL 查找目标 Service 和 Method
  ├─ 解析 package:  "nova.user"
  ├─ 解析 service:   "UserService"
  ├─ 解析 method:    "Register"
  └─ 在已注册的 Service 表中查找:
      server.cc 第 60 行: server.AddService(&service_impl, ...);
      → 系统记录: "nova.user.UserService" → UserServiceImpl 对象
      → UserServiceImpl 是继承自自动生成的 UserService 基类的
      → UserService 基类的 Descriptor 中记录了 12 个 MethodDescriptor
      → 找到 Register 对应的 MethodDescriptor

步骤 4: 根据 Content-Type 选择反序列化方式
  因为 Content-Type = "application/json"
  → bRPC 选择 JSON → Protobuf 的反序列化路径
  (如果 Content-Type 是 "application/protobuf"，则走二进制反序列化)
```

### 3.2 JSON → Protobuf 的反序列化过程

这是整个数据流最关键的一步。bRPC 内部做的事情等价于：

```cpp
// bRPC 内部逻辑 (简化版，实际代码在 brpc 源码中):

// 1. 从 MethodDescriptor 得知: Register 方法的请求类型是 RegisterReq
const google::protobuf::Message* request_prototype =
    method_descriptor->input_type()->NewMessage();
// request_prototype 指向一个空的 RegisterReq 对象

// 2. 把收到的 JSON 字符串解析到 RegisterReq 结构体中
std::string json_body = R"({
    "username":   "alice",
    "password":   "my_secure_password",
    "first_name": "Alice",
    "last_name":  "Smith",
    "phone":      "+8613800138000"
})";

RegisterReq request;
google::protobuf::util::JsonStringToMessage(json_body, &request);

// 3. 此时 request 的各个字段已经被填充:
//    request.username()    == "alice"
//    request.password()    == "my_secure_password"
//    request.first_name()  == "Alice"
//    request.last_name()   == "Smith"
//    request.phone()       == "+8613800138000"
```

**JSON 字段名到 Protobuf 字段的映射规则**：

```
JSON 中的 key              proto 中的字段定义                  转换后
────────────              ──────────────────                  ──────
"username"        →       string username = 1;         →      username = "alice"
"password"        →       string password = 2;         →      password = "my_secure_password"
"first_name"      →       string first_name = 3;       →      first_name = "Alice"
"last_name"       →       string last_name = 4;        →      last_name = "Smith"
"phone"           →       string phone = 5;            →      phone = "+8613800138000"
"invite_hash"     →       (JSON 里没有这个字段)         →      保持空字符串 (proto3 default)
```

**proto3 的默认值行为**：
- 字符串字段不传 = 空字符串 `""`
- 整数字段不传 = `0`
- 布尔字段不传 = `false`
- 嵌套消息不传 = 空指针

---

## 4. C++ 服务端：从收包到回调的完整链路

### 4.1 如何找到你的实现类

当 bRPC 反序列化完 `RegisterReq` 后，它需要找到你写的业务代码来执行。这个查找路径是：

```
bRPC 框架
  │
  ├─ 每个 brpc::Server 内部维护一个 ServiceName → ServiceImpl* 的映射表
  │   server.cc 第 60 行: server.AddService(&service_impl, ...)
  │   这行代码把 UserServiceImpl 的指针注册进去
  │
  ├─ 通过 MethodDescriptor 找到 Register 方法在虚函数表中的索引
  │   比如: Register 是第 0 个虚函数
  │
  └─ 调用: service_impl->CallMethod(method_descriptor, &controller,
  │                                   &request, &response, &done_callback)
  │
  └─ 这会路由到 UserService 基类的 CallMethod 实现 (brpc 自动生成)
      └─ 内部有一个 switch(method_index):
          case 0: return this->Register(controller, &request, &response, done);
          case 1: return this->Login(controller, &request, &response, done);
          case 2: return this->RefreshToken(controller, &request, &response, done);
          ...
```

### 4.2 你的业务方法被调用

现在发动机已经启动，CPU 指令指针跳进了你写的 `user_service_impl.cc`：

```cpp
// user_service_impl.cc 第 90 行
void UserServiceImpl::Register(
    google::protobuf::RpcController* controller,   // ①
    const RegisterReq*               request,       // ②
    RegisterResp*                    response,      // ③
    google::protobuf::Closure*       done           // ④
) {
    // ① controller: bRPC 的控制对象，可以获取客户端 IP、设置超时、标记失败等
    //    实际类型是 brpc::Controller，可以 cast:
    auto* cntl = static_cast<brpc::Controller*>(controller);

    // ② request: 已经是完全反序列化好的 RegisterReq，直接读字段即可
    std::string username  = request->username();    // "alice"
    std::string password  = request->password();    // "my_secure_password"
    std::string firstName = request->first_name();  // "Alice"

    // ③ response: 一个空白的 RegisterResp，你需要往里填充数据
    //    所有的 set_xxx 方法都是 proto 自动生成的

    // ④ done: 一个回调函数。当你处理完请求后，必须调用 done->Run()
    //    bRPC 收到 done->Run() 后才会把 response 序列化并发送回客户端
```

### 4.3 ClosureGuard — 确保响应一定被发出

```cpp
// 第 93 行
brpc::ClosureGuard done_guard(done);
```

这是 bRPC 的一个 RAII 保护机制：

```cpp
// brpc::ClosureGuard 的简化原理:
class ClosureGuard {
    Closure* done_;
public:
    ClosureGuard(Closure* done) : done_(done) {}
    ~ClosureGuard() {
        if (done_) done_->Run();  // 析构时自动调用
    }
};
```

**为什么需要它？** 因为方法可能有多条返回路径：

```cpp
void Register(...) {
    brpc::ClosureGuard done_guard(done);  // 无论怎么退出，done 都会被调用

    if (username 不合法) {
        response->set_error_code(USERNAME_INVALID);
        return;  // ← 这里退出，done_guard 析构 → done->Run()
    }

    if (用户名已存在) {
        response->set_error_code(USERNAME_OCCUPIED);
        return;  // ← 这里退出，done_guard 析构 → done->Run()
    }

    // 正常路径
    response->set_error_code(OK);
    response->set_user_id(new_id);
    // ← 这里退出，done_guard 析构 → done->Run()
}
```

### 4.4 业务逻辑的数据流

```
request (RegisterReq)                    response (RegisterResp)
─────────────────────                    ───────────────────────
                                                                  ← 初始为空
username  = "alice"
password  = "my_secure_password"
first_name = "Alice"                          业务逻辑:
last_name  = "Smith"          ───────────→    user_dao_->CreateUser(...)
phone      = "+86138..."                      snowflake_->NextId()
                                              GenerateToken()
                                                                  ← 填充完成
                                         error_code     = OK
                                         user_id        = 123456789012345
                                         access_token   = "tok_7b..."
                                         refresh_token  = "rt_a3..."
                                         expires_at     = 1718360000000
                                         user.user_id   = 123456789012345
                                         user.username  = "alice"
                                         user.first_name = "Alice"
                                         ...
```

---

## 5. 响应的回程：Protobuf → JSON → HTTP Response

### 5.1 done->Run() 触发响应发送

当 `done_guard` 析构时，`done->Run()` 被调用，bRPC 开始了发回响应的流程：

```
步骤 1: done->Run() 被调用
  └─ bRPC 内部知道: "Register 这个 RPC 已经处理完了"

步骤 2: 从 MethodDescriptor 获取响应的序列化方式
  └─ Register 方法的 output_type = RegisterResp

步骤 3: 检查原始请求的 Content-Type
  ├─ 如果请求是 application/json → 响应也用 JSON
  └─ 如果请求是 application/protobuf → 响应也用二进制 Protobuf

步骤 4: Protobuf → JSON 序列化
  └─ 把 response 对象转成 JSON 字符串
```

### 5.2 Protobuf → JSON 的序列化过程

bRPC 内部做的事情等价于：

```cpp
// bRPC 内部逻辑 (简化版):

RegisterResp response;  // 这是你填充好的 response 对象

// 转换为 JSON
std::string json_output;
google::protobuf::util::MessageToJsonString(response, &json_output);

// json_output 的内容:
// {
//   "error_code":    0,
//   "error_message": "",
//   "user_id":       "123456789012345",
//   "access_token":  "tok_7b...",
//   "refresh_token": "rt_a3...",
//   "expires_at":    "1718360000000",
//   "user": {
//     "user_id":     "123456789012345",
//     "username":    "alice",
//     "first_name":  "Alice",
//     "last_name":   "Smith",
//     "bio":         "",
//     "phone":       "+8613800138000",
//     "created_at":  "1718356400000",
//     "updated_at":  "1718356400000"
//   }
// }
```

**proto3 的 JSON 映射规则**：

| proto 类型 | JSON 类型 | 示例 |
|-----------|----------|------|
| `int32`, `int64` | number (int64 为 string) | `123` / `"123456789012345"` |
| `string` | string | `"alice"` |
| `bool` | boolean | `true` / `false` |
| `enum` | string (枚举名) | `"OK"` 而非 `0` |
| `repeated T` | array | `["a", "b"]` |
| `message` | object | `{"user_id": ...}` |
| `bytes` | base64 string | `"YWJj"` |
| 未设置的字段 | 不出现在 JSON 中 | `bio: ""` → 整个字段省略 |

**注意**：proto3 默认值（空字符串、0、false）在 JSON 中**默认不输出**，这就是为什么 `bio`, `error_message` 等空值字段不会出现在响应 JSON 中。

### 5.3 组装 HTTP Response

bRPC 把序列化好的 JSON 字符串包装成 HTTP 响应：

```http
HTTP/1.1 200 OK
Content-Type: application/json
Content-Length: 312

{
    "error_code": 0,
    "user_id": "123456789012345",
    "access_token": "tok_7b...",
    "refresh_token": "rt_a3...",
    "expires_at": "1718360000000",
    "user": {
        "user_id": "123456789012345",
        "username": "alice",
        "first_name": "Alice"
    }
}
```

**TS 网关收到的就是上面这段文本**，用 `response.json()` 解析后就变成了普通的 JavaScript 对象。

---

## 6. 一次完整的注册请求：逐帧回放

下面以时间线方式，展示一次 `Register` 请求中，数据在每一层的样子。

### 帧 1: TS 网关 — 准备发送

```typescript
// TypeScript 侧 — 数据是一个普通 JS 对象
const requestBody = {
    username:   "alice",
    password:   "my_secure_password",
    first_name: "Alice",
    last_name:  "Smith"
};

// JSON.stringify 之后变成字符串:
// '{"username":"alice","password":"my_secure_password","first_name":"Alice","last_name":"Smith"}'
```

### 帧 2: 网络层 — TCP 字节流

```
十六进制 (前 50 字节):
50 4F 53 54 20 2F 6E 6F 76 61 2E 75 73 65 72 2E   POST /nova.user.
55 73 65 72 53 65 72 76 69 63 65 2F 52 65 67 69   UserService/Regi
73 74 65 72 20 48 54 54 50 2F 31 2E 31 0D 0A ...   ster HTTP/1.1..
                  ↑                                  ↑
              HTTP 请求行                          CRLF 换行
```

### 帧 3: bRPC 入口 — 解析 HTTP

```
bRPC 内部状态:
  method:  POST
  uri:     /nova.user.UserService/Register
  content_type: application/json
  body (raw): {"username":"alice","password":"...","first_name":"Alice","last_name":"Smith"}
```

### 帧 4: bRPC 中间层 — JSON → Protobuf

```
反序列化后的 RegisterReq C++ 对象 (内存布局):
┌─────────────────────────────────┐
│ RegisterReq                     │
│  username_  = "alice"           │  ← std::string, 堆上分配
│  password_  = "my_secure_p..."  │
│  first_name_= "Alice"           │
│  last_name_ = "Smith"           │
│  phone_     = ""                │  ← 没传，空字符串
│  invite_hash_= ""               │  ← 没传，空字符串
└─────────────────────────────────┘
```

### 帧 5: C++ 业务层 — 执行逻辑

```cpp
// user_service_impl.cc Register() 方法内部
Snowflake snowflake(1);
int64_t user_id = snowflake.NextId();  // → 123456789012345
//                              └── 41bit timestamp + 10bit worker + 12bit sequence

UserDao user_dao;
user_dao.CreateUser("alice", "hash:my_secure_password", "Alice", "Smith", "", user_id, now);
//                         └── 存入内存 map (Phase 1)

std::string token = GenerateToken(user_id);
// → "tok_7b1a3c..."
```

### 帧 6: C++ 业务层 — 填充响应

```
填充后的 RegisterResp C++ 对象 (内存布局):
┌──────────────────────────────────┐
│ RegisterResp                     │
│  error_code_     = OK (0)        │  ← enum, 4 字节
│  error_message_  = ""            │
│  user_id_        = 123456789...  │  ← int64, 8 字节
│  access_token_   = "tok_7b..."   │  ← std::string
│  refresh_token_  = "rt_a3..."    │
│  expires_at_     = 17183600...   │
│  user_ (嵌套消息):               │
│   └─ user_id_    = 123456789...  │
│   └─ username_   = "alice"       │
│   └─ first_name_ = "Alice"       │
│   └─ ...                         │
└──────────────────────────────────┘
```

### 帧 7: bRPC 出口 — Protobuf → JSON

```
序列化后的 JSON 字符串:
{"error_code":0,"user_id":"123456789012345","access_token":"tok_7b...","refresh_token":"rt_a3...","expires_at":"1718360000000","user":{"user_id":"123456789012345","username":"alice","first_name":"Alice"}}
```

### 帧 8: 网络层 — HTTP Response

```
HTTP/1.1 200 OK
Content-Type: application/json
Content-Length: 248

{"error_code":0,"user_id":"123456789012345","access_token":"tok_7b...","refresh_token":"rt_a3...","expires_at":"1718360000000","user":{"user_id":"123456789012345","username":"alice","first_name":"Alice"}}
```

### 帧 9: TS 网关 — 收到响应

```typescript
const data = await response.json();
// data = {
//   error_code: 0,
//   user_id: "123456789012345",     ← int64 在 JSON 中表现为字符串
//   access_token: "tok_7b...",
//   refresh_token: "rt_a3...",
//   expires_at: "1718360000000",
//   user: {
//     user_id: "123456789012345",
//     username: "alice",
//     first_name: "Alice"
//   }
// }
```

---

## 7. C++ 内部 RPC：纯二进制模式下的数据流

当两个 C++ 服务之间通信时（如 message-service 调 user-service），走的是 bRPC 的 **baidu_std 二进制协议**，完全绕开 HTTP 和 JSON。

### 7.1 调用方代码 (message-service)

```cpp
// 1. 创建到 user-service 的长连接
brpc::Channel channel;
brpc::ChannelOptions options;
options.protocol = "baidu_std";  // 二进制协议，非 HTTP
channel.Init("user-service:8001", &options);

// 2. 创建 Stub (客户端代理)
nova::user::UserService_Stub stub(&channel);

// 3. 发起 RPC
nova::user::GetUserProfileReq req;
req.set_user_id(123456789012345);

nova::user::GetUserProfileResp resp;
brpc::Controller cntl;

stub.GetUserProfile(&cntl, &req, &resp, NULL);  // NULL = 同步等待

// 4. 使用响应
if (!cntl.Failed()) {
    std::string username = resp.user().username();
}
```

### 7.2 数据流的差异对比

```
                    TS → C++ (HTTP 模式)          C++ → C++ (二进制模式)
                    ─────────────────────         ──────────────────────
序列化前 (调用方):    JS 对象                       RegisterReq C++ 对象
                      ↓ JSON.stringify             ↓ protobuf SerializeToArray()
线上格式:             {"username":"alice"}          \x0a\x05\x61\x6c\x69\x63\x65
                                                    ↑
                                                    纯二进制: field_number=1 (0x0a)
                                                    长度=5 (0x05)
                                                    内容="alice" (5 字节)
HTTP 开销:            有 (header + 文本膨胀)        无 (纯二进制帧)
反序列化后 (服务方):  RegisterReq C++ 对象          RegisterReq C++ 对象
                      (bRPC JSON→PB 自动转换)       (protobuf ParseFromArray())
```

**关键数据**：同一条 `{"username":"alice"}` 消息：
- HTTP/JSON 模式：~20 字节 (含引号大括号)
- 二进制 Protobuf 模式：~7 字节 (field tag + length + value)

---

## 8. 反向推送：C++ → TS 网关的数据流

### 8.1 场景：消息推送

```
用户 A 发消息给用户 B:

message-service (C++)                    gateway-node-2 (TS)
───────────────────                      ───────────────────
│ 1. 收到 A 的消息                        │
│ 2. 存储到 MySQL                        │
│ 3. 查 Redis: B 在线, 在 node-2        │
│ 4. 需要通知 B                          │
│                                        │
│ bRPC Channel (HTTP 模式)               │
│ POST /nova.gateway.PushService/       │
│      PushUpdate                        │
│ Body: {                          ───→  │ Fastify 路由处理
│   "target_user_id": 67890,             │ ├─ 解析 JSON body
│   "update": {                          │ ├─ 查本地 WebSocket 连接表
│     "type": "NEW_MESSAGE",             │ ├─ ws.send(B的socket, JSON.stringify(update))
│     "new_message": {                   │ └─ return {delivered: true}
│       "message_id": ...,               │
│       "from_peer": ...,                │
│       "text": "Hello B!"               │
│     }                                  │
│   }                                    │
│ }                                      │
│                                        │
│ ← HTTP 200 { delivered: true } ────────┘
```

### 8.2 这里 bRPC 的角色

C++ message-service 使用 `brpc::Channel` 以 HTTP 模式连接到 TS 网关。**此时 bRPC 作为一个 HTTP 客户端**，把 Protobuf 结构体自动序列化为 JSON 发出去。

TS 网关**不需要理解 bRPC 协议**，它只看到一个普通的 HTTP POST 请求。只要注册对应的路由即可：

```typescript
// TS 网关侧 — 就是一个普通 HTTP 端点
app.post('/nova.gateway.PushService/PushUpdate', async (request, reply) => {
    const { target_user_id, update } = request.body as PushUpdateReq;
    const ws = onlineUsers.get(target_user_id);
    if (ws) {
        ws.send(JSON.stringify(update));
        return { delivered: true, push_id: request.body.push_id };
    }
    return { delivered: false, push_id: request.body.push_id };
});
```

---

## 9. 关键设计决策与常见疑问

### 9.1 为什么 TS 网关不直接用 Protobuf？

**如果用 Protobuf**：
```typescript
// 需要在 TS 端引入 protobuf 库，手写二进制编解码
import { RegisterReq } from '../gen/ts/user.pb';
const buf = RegisterReq.encode({ username: "alice", ... }).finish();
fetch(url, { body: buf, headers: { 'Content-Type': 'application/protobuf' } });
```

**问题**：
- 需要在 TS 端也引入 Protobuf 编译工具链（增加构建复杂度）
- 浏览器端调试困难（二进制不可读）
- 需要维护两套代码生成（C++ 生成 + TS 生成）

**用 JSON**：
```typescript
// 原生 API，零依赖，直接可调
fetch(url, { body: JSON.stringify({ username: "alice" }) })
```

bRPC 的 `http+pb` 协议正是为这个场景设计的：TS 端享受 JSON 的便利，C++ 端享受 Protobuf 的高性能。

### 9.2 int64 在 JSON 中的处理

Protobuf 的 `int64` 类型在 JSON 中默认序列化为**字符串**（防止 JavaScript 的 Number 类型精度丢失）：

```json
// proto 中: int64 user_id = 1;
// JSON 中变为:
{ "user_id": "1234567890123456789" }   // 字符串，安全

// 而不是:
{ "user_id": 1234567890123456789 }     // JS Number 会损失精度!
```

### 9.3 bRPC 如何处理并发？

```
同时有 1000 个 Register 请求到达 :8001
  │
  ├─ bRPC 的 EventDispatcher (epoll) 检测到 1000 个 fd 可读
  │
  ├─ 创建 1000 个 bthread (用户态协程, 不是 pthread)
  │   每个 bthread 处理一个请求, 栈大小只有 8KB
  │   1000 × 8KB = 8MB (而 1000 个 pthread 需要 8GB 栈空间!)
  │
  ├─ M:N 调度: 假设有 8 个 CPU 核心
  │   bRPC 创建 8 个 worker pthread
  │   1000 个 bthread 在这 8 个 pthread 上轮转执行
  │
  └─ 当某个 bthread 需要等待 I/O (如调用 DAO) 时:
      该 bthread 自动挂起 → worker pthread 去执行另一个 bthread
      等待的 I/O 完成 → 被挂起的 bthread 恢复执行
      
      这就是 "同步代码 + 异步执行" 的魔法
```

### 9.4 我们代码中的同步调用为什么不会阻塞？

```cpp
// user_service_impl.cc 中的代码看起来是同步的:
auto record = user_dao_->FindByUsername(request->username());
//  ↑ 如果这是阻塞的数据库查询，不会卡死整个服务吗？

// 答案：在 bRPC 框架内，这段代码运行在 bthread 上。
//      如果 DAO 层使用了 brpc::Channel (如 Redis/MySQL 客户端),
//      底层 I/O 操作会让出当前 bthread，worker pthread 去处理其他请求。
//      等 I/O 返回，当前 bthread 恢复执行。

// Phase 1 中的 DAO 是内存操作 (加锁访问 std::map)，不会阻塞，
// 所以这个问题在当前阶段不存在。
// Phase 2 接入 MySQL/Redis 后，只要通过 brpc::Channel 访问，
// 就自动获得非阻塞特性。
```

---

## 附录：代码与本文档的对应关系

| 本文档讲述的概念 | 对应的项目文件 | 关键行号 |
|----------------|--------------|---------|
| proto "合同" 定义 | `proto/user/user.proto` | 第 3 行 (package), 第 189 行 (service) |
| RegisterReq 结构 | `proto/user/user.proto` | 第 14-21 行 |
| RegisterResp 结构 | `proto/user/user.proto` | 第 23-31 行 |
| bRPC Server 启动 | `services/user-service/server.cc` | 第 60 行 (AddService), 第 71 行 (Start) |
| Register RPC 实现 | `services/user-service/user_service_impl.cc` | 第 90-145 行 |
| 继承 bRPC 基类 | `services/user-service/user_service_impl.h` | 第 24 行 |
| DAO 内存存储 | `services/user-service/user_dao.cc` | 第 36-58 行 |
| PushService 定义 | `proto/gateway/push.proto` | 第 136-154 行 |
| Proto 代码生成脚本 | `scripts/proto-gen.sh` | 全文 |
| CMake Proto 自动化 | `cmake/ProtoGen.cmake` | 全文 |

---

> **最后更新**: 2026-06-21
> **适用范围**: Phase 1 全部 + Phase 2 规划
