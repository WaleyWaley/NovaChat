# message-service 与 user-service 详解

> 本文按"信息流动的方向"讲解 NovaChat 两个 C++ bRPC 核心服务:每个服务先讲**作用**,再用**真实数据例子**走一遍数据在该层的完整变形,最后汇总横向对比与待修问题清单。
>
> 基于 2026-09-09 ~ 09-11 的工作区代码(Phase 4.2 状态)。代码更新较快,行号可能漂移,以文件内容为准。

---

## 目录

- [0. 两个服务在架构中的位置](#0-两个服务在架构中的位置)
- [第一部分:message-service](#第一部分message-service)
  - [1.1 这一层干什么](#11-这一层干什么)
  - [1.2 文件地图](#12-文件地图)
  - [1.3 真实例子:A 给 B 发一条 TEXT 消息的完整变形](#13-真实例子a-给-b-发一条-text-消息的完整变形)
  - [1.4 关键机制](#14-关键机制)
- [第二部分:user-service](#第二部分user-service)
  - [2.1 这一层干什么](#21-这一层干什么)
  - [2.2 文件地图](#22-文件地图)
  - [2.3 真实例子:注册 zhangsan 的完整变形](#23-真实例子注册-zhangsan-的完整变形)
  - [2.4 关键机制](#24-关键机制)
- [第三部分:两个服务的横向对比](#第三部分两个服务的横向对比)
- [附录 A:通用知识点](#附录-a通用知识点)
- [附录 B:待修问题清单](#附录-b待修问题清单)

---

## 0. 两个服务在架构中的位置

```
浏览器(A) ──WS(JSON)──▶ 网关(Fastify) ──HTTP(JSON, proto 契约)──▶ message-service (:8002, worker_id=2)
浏览器(B) ◀─WS(JSON)── 网关 ◀─HTTP(JSON)─────────────────────────┘ (PushDispatcher 反向推送)

浏览器 ──HTTP/WS──▶ 网关 ──HTTP(JSON)──▶ user-service (:8001, worker_id=1)
```

- **浏览器 ↔ 网关**:永远走 WebSocket(消息收发)或 HTTP(REST 场景);载荷是 JSON。
- **网关 ↔ C++ 服务**:永远走 HTTP;载荷是字段名对齐 proto 的 JSON("http+pb 端点",详见附录 A)。
- **C++ 内部**:bRPC 自动把 JSON 翻译成强类型 protobuf 对象,业务代码只面对 pb 和 C++ struct。

---

# 第一部分:message-service

## 1.1 这一层干什么

message-service 是 NovaChat 的**消息中枢**,每个 `SendMessage` 进来,依次做五件事:

1. **接收**:bRPC 按 `message.proto` 契约把网关的 HTTP JSON 自动转成强类型 `SendMessageReq`
2. **生成 ID**:雪花算法补上全局唯一 `message_id`(worker_id=2)
3. **去重落库**:`idempotency_key` 查重后存储(Phase 4 双模:MySQL 就绪写库、失败回退内存)
4. **回包**:把补全后的消息填回 `SendMessageResp` 给发送者 A
5. **推送**:非静默且收件人是 USER 时,组装 `Update` 事件信封经 HTTP 推回网关,由网关投递给 B 的 WebSocket

一句话:**进来的是一条"发送意图"(protobuf),出去的是一个"已完成的通知事件"(Update),中间夹着一道"补全信息"的加工(MessageRecord)——服务端补齐 ID、时间戳、状态。**

## 1.2 文件地图

| 文件 | 角色 |
|---|---|
| `services/message-service/server.cc` | 启动与装配:读 gflags(端口 8002、worker_id=2),创建雪花/DAO/推送器,注册服务;MySQL 失败指数退避重试 20 次再回退内存 |
| `services/message-service/message_service_impl.h/.cc` | **业务编排层**:6 个 RPC 的实现,校验 → 调依赖 → 填响应 |
| `services/message-service/message_dao.h/.cc` | 数据访问层:`MessageRecord` 结构、存储与去重、ACK、同步状态、会话列表 |
| `services/message-service/push_dispatcher.h/.cc` | 出站推送:把 `Update` 包装成 `PushUpdateReq`,HTTP POST 到网关 |
| `proto/nova/message/message.proto` | RPC 契约:SendMessage / GetMessages / AckMessage / GetSyncState / GetDialogs / GetConversation |

## 1.3 真实例子:A 给 B 发一条 TEXT 消息的完整变形

> 场景:2026-09-08 21:00:00,用户 A (user_id=1001) 给用户 B (user_id=2002) 发 TEXT "晚上一起吃饭吗?",幂等键 `c8f2a9e1-4b3d-4f7a-9c21-3a5b7d9e0f01`
> (时间戳为示意,雪花 ID 按代码真实公式手算)

### 第 0 站:进站 —— 网关发来的 HTTP 请求

```json
POST /nova.message.MessageService/SendMessage
{
  "from_peer":       { "type": 1, "id": 1001 },
  "to_peer":         { "type": 1, "id": 2002 },
  "msg_type":        0,
  "text":            "晚上一起吃饭吗?",
  "idempotency_key": "c8f2a9e1-4b3d-4f7a-9c21-3a5b7d9e0f01"
}
```

数值依据 `common.proto`:`PEER_TYPE_USER = 1`、`MESSAGE_TYPE_TEXT = 0`。`reply_to_msg_id=0`、`is_silent=false` 是 proto3 默认值,JSON 里可省略。

> **from_peer 说明**:浏览器发往网关的 WS 帧是
> `{"type":"send_msg","seq":101,"payload":{"peer_type":1,"peer_id":2002,"msg_type":0,"text":"...","idempotency_key":"<uuid>"}}`
> —— 帧里**没有 from_peer**(由网关登录态补上);`idempotency_key` 由客户端生成(每条消息一个 UUID,重试同一消息时复用),网关原样透传给 message-service。

### 第 1 站:校验(通过)

`ValidateSendRequest`(`message_service_impl.cc:20-40`):from/to 存在 ✓;to 的 type=1 不是 `PEER_TYPE_UNKNOWN(0)` ✓;TEXT 正文非空 ✓;长度 ≤ `kMaxMessageLen` ✓。

### 第 2 站:变形① —— protobuf 变成 MessageRecord(服务端补料)

`message_service_impl.cc:65-74` 组装 `MessageRecord`。雪花 `message_id` 手算:

```
ts            = 1,788,872,400,000          ← 21:00:00.000 的毫秒时间戳
ts - epoch    =    84,805,200,000          ← epoch = 2024-01-01
时间戳部分     =    84,805,200,000 << 22    = 355,698,789,580,800,000
worker 部分    =         2 << 12            =                   8,192   ← worker_id=2
序列号         =         0                                       0     ← 这一毫秒第 1 条
────────────────────────────────────────────────────────────────
message_id    =                             = 355,698,789,580,808,192
```

| MessageRecord 字段 | 值 | 来源 |
|---|---|---|
| `message_id` | **355698789580808192** | 雪花 `NextId()`,**服务端补** |
| `from_peer` | (1, 1001) | 请求拷贝 |
| `to_peer` | (1, 2002) | 请求拷贝 |
| `msg_type` | 0 (TEXT) | 请求拷贝 |
| `text` | "晚上一起吃饭吗?" | 请求拷贝 |
| `created_at` | **1788872400000** | `SaveMessage` 里补 |
| `status` | **1 (SENT)** | `SaveMessage` 里补 |

ID 自带信息:用 snowflake.cpp 的反解工具,`id>>22` 加回 epoch 还原时刻,`(id>>12)&1023` 得到 worker=2,`id&4095` 得到 seq=0。

### 第 3 站:变形② —— 去重 + 落库

`SaveMessage`(`message_dao.cc:82-189`)双模:

- **MySQL 路径**(`mysql_` 就绪时):`INSERT IGNORE` + `idempotency_key` 唯一索引 = **数据库层原子去重**,`affected==0` 即重复,直接 `return std::nullopt`
- **内存回退路径**:`idempotency_keys_`(unordered_set)查重,重复拦截;通过则插入 set 登记,再按 `message_id` 降序插入 `messages_` vector

```cpp
// messages_ (降序, 新消息在最前):
// [0] {id=355698789580808192, from=(1,1001), to=(1,2002), type=TEXT,
//      text="晚上一起吃饭吗?", created_at=1788872400000, status=SENT}

// idempotency_keys_ (新增一条):
// { "c8f2a9e1-4b3d-4f7a-9c21-3a5b7d9e0f01", ... }
```

### 第 4 站:回程 —— 响应给 A

```json
{
  "error_code": 0,
  "message": {
    "message_id": 355698789580808192,
    "from_peer": { "type": 1, "id": 1001 },
    "to_peer":   { "type": 1, "id": 2002 },
    "type": 0,
    "text": "晚上一起吃饭吗?",
    "created_at": 1788872400000
  },
  "is_new": true
}
```

A 拿到的 `message_id` 是服务端发的,之后 ACK、排序全靠它。

### 第 5 站:变形③ —— 消息变成"事件"推给 B

`message_service_impl.cc:117-129`:仅当 `is_silent=false` 且 `to_peer.type==PEER_TYPE_USER` 时触发。`Update` 信封**只带最小字段**(注释:"客户端据此拉取完整消息"):

```json
POST http://gateway:3000/nova.gateway.PushService/PushUpdate
{
  "target_user_id": 2002,
  "update": {
    "type": 0,                       // UPDATE_NEW_MESSAGE
    "new_message": {
      "message_id": 355698789580808192,
      "from_peer": { "type": 1, "id": 1001 },
      "to_peer":   { "type": 1, "id": 2002 },
      "text": "晚上一起吃饭吗?",
      "created_at": 1788872400000
    }
  }
}
```

网关收到后包成 WS 帧投给 B(帧形如 `{"type":"update","payload":{"update_type":0,"data":{...}}}`,**没有 seq**——服务端主动推送不回应请求)。

### 彩蛋:客户端超时重试(同一个 key 再来一遍)

一模一样的请求再进一次:`count(key) > 0`(或 `affected==0`)→ 不落库、不推送,响应变成:

```json
{ "error_code": 0, "is_new": false }   // 成功, 但告诉客户端"这条你发过了"
```

### 全程对照表

| 位置 | 形态 | 这次变形做了什么 |
|---|---|---|
| 进站 | `SendMessageReq` (JSON/protobuf) | 原始发送意图,7 个字段 |
| 业务层 | `MessageRecord` (C++ struct) | **补上** message_id / created_at / status |
| 存储层 | `vector` + `set` / MySQL 行 | 降序插入 + 幂等键登记 |
| 回 A | `SendMessageResp` (JSON) | 把补全后的消息还回去 |
| 出站 | `Update{UPDATE_NEW_MESSAGE}` | 换成"事件信封",只带最小字段 |
| 到网关 | HTTP JSON → WS 帧 | 投递给 B |

## 1.4 关键机制

### 幂等去重

- **key**:客户端/调用方提供的 `idempotency_key` 字符串,**不是** message_id(雪花每次重试都不同,认不出重发),也不是内容 hash。
- **内存版**:`unordered_set`,存在即拦截;超过 10000 条直接 `clear()`(粗暴,老 key 一起失效)。
- **MySQL 版**:`INSERT IGNORE` + 唯一索引,数据库层原子去重,天然跨进程、跨实例。
- ✅ **全链路已接线**(2026-09-11):客户端在 `web/src/api/ws.ts` 生成 UUID → WS payload(`protocol.ts`)→ 网关透传(`main.ts` / `message_client.ts`)→ message-service 按 key 去重。

### 消息状态机

`SENT(1) → DELIVERED(2) → READ(3)`,由 **`AckMessage` RPC** 推进(`message_service_impl.cc:270-321`):

- 入库时只置 SENT;DELIVERED/READ 是 B 的客户端发 ACK 后批量推进(`message_id <= max_ack_msg_id` 的所有消息)。
- Phase 4:ACK 的是 READ 时,找出被读消息的**发送者**,给每人推 `UPDATE_MESSAGE_READ` 已读回执——A 界面上"双勾 ✓✓"的来源。

### 每个 RPC 的统一套路(bRPC 模板)

```cpp
void ...(controller, request, response, done) {
    brpc::ClosureGuard done_guard(done);   // ① 保证一定回包
    NOVA_LOG_INFO << "...";                // ② 记日志
    if (非法参数) { response->set_error_code(...); return; }  // ③ 校验失败=正常返回+错误码
    auto result = dao_->XXX(...);          // ④ 调依赖干活
    response->set_error_code(OK);          // ⑤ 结果翻译回响应 pb
}
```

错误处理靠错误码字段,不靠异常。impl 不解析 JSON(bRPC 做)、不写 SQL(DAO 做)、不发 HTTP(dispatcher 做)、不实现 ID 算法(雪花做)——它是薄薄的流程编排层。

---

# 第二部分:user-service

## 2.1 这一层干什么

user-service 是 NovaChat 的**身份与资料中心**,12 个 RPC 分三大块(`user.proto:189-211`):

| 类别 | RPC |
|---|---|
| **认证**(身份的签发与销毁) | `Register` / `Login` / `RefreshToken` / `Logout` |
| **资料**(用户数据 CRUD) | `GetUserProfile` / `GetUsers` / `UpdateProfile` / `ChangeUsername` / `CheckUsername` / `ChangePassword` |
| **搜索与账户** | `SearchUsers` / `DeleteAccount` |

## 2.2 文件地图

| 文件 | 角色 |
|---|---|
| `services/user-service/server.cc` | 启动与装配:端口 8001、worker_id=1;雪花 + UserDao(MySQL + Redis)注入 |
| `services/user-service/user_service_impl.h/.cc` | **业务编排层**:12 个 RPC 实现、校验(用户名/密码规则)、Token 生成 |
| `services/user-service/user_dao.h/.cc` | 数据访问层:`UserRecord`/`SessionRecord` 结构、用户 CRUD、Session 管理 |
| `proto/nova/user/user.proto` | RPC 契约(12 个) |
| `services/common/src/password.cpp` | PBKDF2-HMAC-SHA256 密码哈希与校验 |

## 2.3 真实例子:注册 zhangsan 的完整变形

> 场景:2026-09-11 10:00:00,新用户注册 username=`zhangsan`,密码=`Passw0rd!`,first_name=`张三`(worker_id=1)

### 变形① 进站 —— 网关发来的 JSON

```json
POST /nova.user.UserService/Register
{ "username": "zhangsan", "password": "Passw0rd!", "first_name": "张三", "phone": "13800138000" }
```

**明文密码此刻还活着**,只在这一个 JSON 里。

### 变形② 校验 + 查重(`user_service_impl.cc:113-140`)

- `ValidateUsername`:长度 3-32、必须字母开头、只允许字母数字下划线 → "zhangsan" ✓
- `ValidatePassword`:长度达标 ✓;`first_name` 非空 ✓
- `UsernameExists("zhangsan")` → 不存在 ✓(存在则回 `USERNAME_OCCUPIED=1102`)

### 变形③ 密码:明文 → 哈希(最关键的一步)

`HashPassword`(`password.cpp:81-112`)实际算法是 **PBKDF2-HMAC-SHA256**:

```
"Passw0rd!"  +  16 字节随机盐(OpenSSL RAND_bytes)
      │  PBKDF2 迭代 100,000 次
      ▼
"$pbkdf2-sha256$100000$<32位hex盐>$<64位hex哈希>"
```

从此**明文密码在服务端彻底消失**。登录时 `CheckPassword` 用同盐重派生,再**常数时间比较**(逐字节 XOR,防时序攻击)。Phase 1 老账号存的是 `"hash:" + 明文`,登录检测到会警告并提示升级。

> ⚠️ 注释过时:`user.proto:16` 与 `user_service_impl.cc:5` 都写"bcrypt",实际是 PBKDF2(附录 B 问题 3)。

### 变形④ 雪花 user_id 出生(`user_service_impl.cc:145`)

```
ts - epoch   = 85,024,800,000
时间戳部分    = 85,024,800,000 << 22 = 356,619,858,739,200,000
worker 部分   = 1 << 12             =                 4,096
user_id      = 356,619,858,739,204,096
```

从这一刻起这个 ID 是 zhangsan 的"出生证明",**终身不变**:登录、改资料、改名都只引用它,从不改写。

### 变形⑤ 组装 UserRecord → 落库(`user_service_impl.cc:149-152`)

```cpp
UserRecord {
  user_id       = 356619858739204096,   // 出生证明
  username      = "zhangsan",
  password_hash = "$pbkdf2-sha256$100000$...",   // 明文已不存在
  first_name    = "张三",
  phone         = "13800138000",
  created_at    = 1789092000000,        // 补时间戳
  updated_at    = 1789092000000,
}
```

经 `CreateUser` 进 MySQL `users` 表(内存 map 兜底;username 唯一索引兜底防重名)。

### 变形⑥ 注册即登录:签发凭证(`user_service_impl.cc:160-175`)

```cpp
access_token  = GenerateToken(user_id)        // "tok_<hex user_id>_<ts>_<雪花seq>"
refresh_token = GenerateRefreshToken(user_id) // "rt_<hex user_id>_<ts>_<雪花seq>"
expires_at    = now + kAccessTokenTTL * 1000
```

`SessionRecord{user_id, refresh_token, ...}` 存进 session 存储(Redis/内存),**refresh_token 是 session 的键**——RefreshToken 轮转、Logout、多端互踢都靠它定位。

> ⚠️ Token 目前是 Phase 1 简化字符串,**不是**注释里说的 JWT RS256;网关侧 `gateway/src/auth/jwt.ts` 才是真 JWT 实现,两者如何衔接值得确认(附录 B 问题 7)。

### 变形⑦ 出站 —— 响应给客户端

```json
{ "error_code": 0,
  "user_id": 356619858739204096,
  "access_token": "tok_...", "refresh_token": "rt_...",
  "expires_at": 1789178400000,
  "user": { "user_id": 356619858739204096, "username": "zhangsan",
            "first_name": "张三", "created_at": 1789092000000 } }
```

`FillUserProfile`(`user_service_impl.cc:85-97`)把 UserRecord 翻译成 proto `UserProfile`,注释写明"phone 仅本用户可见,调用方自行过滤"——隐私过滤责任推给上层。

### 全程对照表

| 位置 | 形态 | 这次变形做了什么 |
|---|---|---|
| 进站 | `RegisterReq` (JSON) | 明文密码 + 基本资料 |
| 校验层 | — | 三条格式规则 + 查重 |
| 业务层 | `password_hash` + `user_id` | **明文→PBKDF2 哈希;雪花 ID 出生** |
| 存储层 | `UserRecord` → MySQL 行 | 补 created_at / updated_at |
| 凭证 | `tok_/rt_` + Session | 注册即登录,签发双 token |
| 出站 | `RegisterResp` (JSON) | 完整资料 + 凭证 |

**登录(Login)是注册的镜像**:明文 → `CheckPassword` 重新派生比对 → 命中则只签发新 token,**不重新生成 user_id**(ID 只在创建时生成一次,之后永远只读)。

## 2.4 关键机制

### PBKDF2 密码哈希(`password.cpp`)

| 参数 | 值 |
|---|---|
| 算法 | PBKDF2-HMAC-SHA256(OpenSSL EVP) |
| 迭代次数 | 100,000(OWASP 2023 推荐最小值) |
| 盐 | 16 字节,RAND_bytes 加密随机 |
| 输出 | 32 字节 |
| 存储格式 | `$pbkdf2-sha256$<iterations>$<hex盐>$<hex哈希>` |
| 校验 | 同盐重派生 + 常数时间比较(防时序攻击) |

### Session 与 Token

- Session 以 refresh_token 为键,含 user_id/设备信息/过期时间。
- Token 轮转:RefreshToken 换新时旧 refresh_token 立即失效(proto 注释:"旧 refresh_token 立即失效")。
- 多端互踢 / 账户注销:`DeleteAllSessions(user_id)`。

---

# 第三部分:两个服务的横向对比

| 维度 | message-service | user-service |
|---|---|---|
| 端口 / worker_id | 8002 / 2 | 8001 / 1 |
| 职责 | 消息中枢 | 身份与资料中心 |
| RPC 数量 | 6 | 12 |
| 核心数据结构 | `MessageRecord` | `UserRecord` + `SessionRecord` |
| 雪花 ID | `message_id`(发送时生成) | `user_id`(注册时生成),token 里也有雪花 seq |
| 存储(Phase 4) | 双模:MySQL 就绪写库,失败回退内存 | MySQL + Redis(session)双就绪才算 ready |
| 特有机制 | 幂等去重、ACK 状态机、Update 推送 | 密码哈希、Token/Session 生命周期 |
| 依赖 | Snowflake + MessageDao + PushDispatcher | Snowflake + UserDao |

**相同点(值得背的套路)**:

1. 每个 RPC 同一个模板:`ClosureGuard` → 日志 → 校验 → 调依赖 → 填响应
2. 依赖注入:构造函数只存指针,类本身零状态
3. 错误处理靠 error_code 字段,不抛异常
4. 双模存储 + 失败回退,`StorageMode()` 可查当前模式
5. 雪花 ID 生成一次、终身不变;唯一性 = worker_id 唯一分配 + 时钟回拨防护(≤5ms 自旋,>5ms FATAL)+ 数据库主键兜底

**共享设施**(`services/common/`):`snowflake.cpp`(ID)、`mysql_pool.cpp`(连接池)、`redis_client.cpp`(缓存/在线路由)、`password.cpp`(哈希)、`logger.cpp`、`config.cpp`。

---

# 附录 A:通用知识点

## A.1 "http+pb 端点"怎么理解

- **http** = 传输方式:bRPC 注册服务后,自动把每个方法暴露为 `包名.服务名/方法名` 的 HTTP URL(如 `/nova.message.MessageService/SendMessage`)。
- **pb** = 契约来源:请求/响应结构由 .proto 定义。
- **普通 HTTP POST** = 不需要 bRPC 客户端库,`fetch`/`curl` 就能调;body 接受 `application/json`(网关的选择)和 `application/proto`(二进制)两种格式。

```bash
curl -X POST http://localhost:8002/nova.message.MessageService/SendMessage \
  -H "Content-Type: application/json" \
  -d '{"from_peer":{"type":1,"id":1001},"to_peer":{"type":1,"id":2002},"msg_type":0,"text":"Hello"}'
```

## A.2 JSON 是怎么变成 pb 的

不是手写解析代码,而是"**通用转换器 + 每类自带说明书**":

1. **编译期**:protoc 生成 C++ 类 + 反射元数据(Descriptor)——每个字段的"名字/序号/类型"都登记在案。
2. **运行期**:请求到达 → 按 URL 找到"本方法请求类型" → `new` 空对象 → 看 Content-Type 是 JSON → 调内置 json2pb 转换器。
3. **翻译**:转换器对着 Descriptor 逐字段翻译(嵌套消息递归),JSON 里没有的字段保持默认值。回程对称:填好的 pb 对象按同一份元数据反着翻成 JSON 写回 HTTP body。

加新 RPC 不用写一行 JSON 解析代码——protoc 重新生成后,bRPC 自动具备新转换能力。

**int64 精度**:雪花 ID 是 64 位,超出 JS `Number` 安全整数(2^53),所以项目里 int64 字段在 JSON 中用字符串传递(见 `protocol.ts` 注释),bRPC 认识字符串形式的 int64。

## A.3 雪花 ID 的全局唯一前提

| 规则 | 说明 |
|---|---|
| worker_id 全局唯一分配 | 每个生成 ID 的进程一个号(0-1023);扩容实例时必须分新号 |
| 时钟不回拨 | ≤5ms 自旋等待;>5ms FATAL 自杀——宁可死也不发可能重复的 ID |
| 数据库主键兜底 | 就算理论撞了,INSERT 撞主键直接报错,不会静默重复 |

---

# 附录 B:待修问题清单

| # | 问题 | 位置 | 状态 |
|---|---|---|---|
| 1 | `msg_type` 注释过时(TEXT=1,实际 proto 里 TEXT=0) | `message_dao.h:28` | ✅ 已修复 |
| 2 | 头注释停留在 Phase 2.4(实际已到 Phase 4.2) | `message_service_impl.h:6-7` | ✅ 已修复 (2026-09-11) |
| 3 | "bcrypt" 注释与实际 PBKDF2 不符 | `user.proto:16`、`user_service_impl.cc:5` | ✅ 已修复 (2026-09-11) |
| 4 | **idempotency_key 全链路未接通**:网关 `message_client.ts` 的 `SendMessageReq` 无此字段 → 去重死代码 | `web/src/api/ws.ts`、`web/src/types/index.ts`、`gateway/src/ws/protocol.ts`、`gateway/src/main.ts`、`gateway/src/clients/message_client.ts` | ✅ 已修复 (2026-09-11):客户端生成 UUID,逐层透传 |
| 5 | **push_id 未生成**:`push_dispatcher.cc` 不 set push_id → 网关 `isDuplicatePush` 去重永不触发 | `push_dispatcher.h/.cc`、`server.cc`、`routes/push.ts` | ✅ 已修复 (2026-09-11):共享服务 Snowflake,每次推送 `NextId()` |
| 6 | gateway `WORKER_ID=1` 与 user-service 撞号(网关目前无雪花生成器,潜在雷) | `docker-compose.yml` | ⚠️ 建议网关改 3 |
| 7 | user-service 的 token 是 `tok_` 自拼字符串,非注释所述 JWT;与网关 `auth/jwt.ts` 的衔接待确认 | `user_service_impl.cc:29-45` | ✅ 已处理 (2026-09-11): 登录/注册/刷新全部网关自签自验 JWT 闭环;user-service 的 `tok_`/RefreshToken RPC 在 web 链路中不再使用(保留给直连调用方) |
| 8 | `GetSyncState` 复用 proto 字段:`pts` 存 peer_id、`seq` 存 unread、`date` 存 last_ack,语义不符 | `message_service_impl.cc:334-347` | 💡 技术债,建议加注释或改 proto |
| 9 | REST 401 无处理:token 过期后搜索/拉历史全部静默失败(WS 长连接仍在线,界面看似正常) | `web/src/api/rest.ts`、`ws.ts`、`gateway/src/main.ts`、`routes/user.ts` | ✅ 已修复 (2026-09-11): rest.ts 401 拦截 + 单飞静默续期 + 彻底失败强制登出;网关 WS 到期主动断开 (4003) 逼前端续期重连 |

> 问题 4、5 属同一类:"机制齐全,无人喂数据",均已接线。注意:去重生效的前提是**重试时复用同一 key**——客户端目前没有自动重试逻辑,以后加重试时,同一条逻辑消息必须带上首次发送时的 `idempotency_key`(见 `web/src/api/ws.ts` 注释)。
