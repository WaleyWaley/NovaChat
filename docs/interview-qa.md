# NovaChat 面试问答准备

> 基于简历中的项目经历，覆盖面试官可能追问的技术点。

---

## 一、架构设计

### Q1：为什么选择 BFF 架构？直接用 C++ 做网关不行吗？

Node.js 的事件驱动 + 异步非阻塞模型天然适合 I/O 密集型场景（维护海量 WebSocket 长连接），而 C++ 适合 CPU 密集型的业务逻辑（消息编解码、存储、推流）。把它们拆开，各司其职。

如果直接用 C++ 做网关，也能做，但开发效率不如 Node.js 高。而且 bRPC 刚好提供了 `http+pb` 协议，网关不需要引入 Protobuf 依赖就能调后端，团队分工上前后端解耦也更清晰。

### Q2：网关和后端服务之间怎么通信？数据流是怎样的？

网关发标准 HTTP POST，URL 路径就是 RPC 方法标识（如 `/nova.user.UserService/Register`），Body 是 JSON。bRPC 收到后，根据 URL 找到对应的 Service 方法，再用 `Content-Type: application/json` 触发 JSON → Protobuf 反序列化。C++ 侧拿到的是强类型的 Protobuf 对象，业务逻辑完成后，响应再序列化为 JSON 返回。

服务间内部调用走 `baidu_std` 二进制协议，没有 HTTP 头部和 JSON 文本膨胀开销。

### Q3：多网关节点下，用户 A 发消息给用户 B 怎么知道 B 连在哪台网关上？

B 上线时，网关把 B 的 userId 和当前网关地址写到 Redis（`SET user:online:<user_id> <gateway_addr> EX 30`，带 TTL 续期）。A 发消息给 B 时，message-service 查 Redis 拿到 B 所在的网关地址，通过 HTTP 调那台网关的 PushService 接口，网关再通过 WebSocket 推给 B。

---

## 二、bRPC 与 bthread 协程

### Q4：bthread 是什么？和 Go 的 goroutine 有什么区别？

bthread 是 bRPC 内置的用户态协程（M:N 调度），和 goroutine 的核心思路类似——用少量内核线程跑大量协程。区别：

- goroutine 栈是动态增长的（初始 2KB），bthread 栈固定 32KB
- goroutine 是 Go 语言级支持（`go` 关键字），bthread 是 C++ 库级实现（`bthread_start_background`）
- bthread 是专门为 RPC 框架设计的，和 bRPC 的 Channel、epoll 深度绑定

### Q5：bthread 怎么做到"同步写法、异步执行"？

关键在 `bthread_fd_wait(fd, events)`。当你的代码调 `redis_->Get()` 时，底层走到 `channel_.CallMethod()`，要等 socket 可读。这时候：

1. bthread 把自己的状态设为 SUSPENDED
2. 把当前 fd 注册到 epoll
3. 保存当前栈和寄存器上下文
4. yield，调度器切到下一个 READY 的 bthread
5. 等 epoll 通知这个 fd 就绪了，调度器把 bthread 标为 READY，重新调度执行
6. bthread 从 `CallMethod` 的下一行继续跑，对业务代码来说就像"阻塞了一下"

整个过程中 pthread 没有真的阻塞，一直在跑不同的 bthread。

### Q6：bthread 栈只有 32KB，够用吗？会不会栈溢出？

bthread 只在等 I/O 时才挂起，挂起时调用栈很浅（通常几层函数调用）。大部分 CPU 计算在挂起之前就跑完了。

如果真的需要大栈（比如递归处理），可以用 `bthread_start_background` 时指定更大的栈，或者把重计算逻辑放到外面用 pthread 跑。实际业务中 32KB 基本够用。

### Q7：Redis 客户端怎么基于 brpc::Channel 实现的？

`brpc::Channel` 有个 `PROTOCOL_REDIS` 模式。初始化时设 `options.protocol = brpc::PROTOCOL_REDIS`，发送命令时把 Redis 命令字符串放到 `cntl.http_request().uri()`（比如 `"SET key value EX 30"`），bRPC 内部自动转成 RESP 协议二进制格式发送给 Redis。响应从 `cntl.response_attachment()` 中拿，用 `brpc::RedisReply` 解析。

好处是所有 I/O 都挂在 bthread 上，同步写代码但异步执行。

### Q8：MySQL 连接池为什么用多个 Channel 而不是一个？

MySQL 连接是有状态的（事务、临时表、字符集设置等），一个连接同一时刻只能跑一条 SQL。所以用多个 Channel 做连接池，Round-Robin 分发请求，避免单连接成为瓶颈。

Redis 一个 Channel 就够了，因为它是无状态的，而且 bRPC 内部对 Redis 模式的 Channel 已经做了连接复用。

---

## 三、用户服务与安全

### Q9：Token 轮转（RefreshToken）为什么要一次一换？

防止 RefreshToken 被截获后长期滥用。每次刷新时：

1. 验证旧 RefreshToken 合法性
2. 删除旧 Session
3. 生成新的 AccessToken + RefreshToken
4. 返回新 Token 对

这样即使旧 Token 泄露，攻击者和合法用户会竞争使用同一个 RefreshToken。一旦合法用户先刷新了，攻击者手里的旧 Token 就失效了。如果攻击者先刷新，合法用户下次用旧 Token 时发现失效，就知道可能被攻击了。

### Q10：用户修改密码后为什么要清除所有 Session？

用户改密码意味着"之前的登录可能不是本人在操作"，所以把所有设备的 Session 全部清除，强制重新登录。这是一个安全设计，防止密码泄露后攻击者继续使用已登录的 Session。

### Q11：用户名修改为什么要限制频率？

Telegram 的设计：防止恶意用户频繁更换用户名（骚扰、冒充他人）。实际限制是 1 小时内只能改一次，存在 `UserRecord` 的 `username_changed_at` 字段里。这个值可以配置得更严（比如 15 天），取决于产品需求。

### Q12：密码存储怎么处理的？

最终版用 bcrypt 做哈希，工作因子 12。注册和改密码时 `bcrypt::generateHash()`，登录和验证时 `bcrypt::validatePassword()`。bcrypt 自带 salt，不用额外处理。

---

## 四、分布式 ID 与消息系统

### Q13：Snowflake 的时钟回拨怎么处理？

两种策略：

- **短期回拨（≤ 5ms）**：自旋等待，等时钟追上。因为 NTP 同步一般几毫秒内能修正。
- **长期回拨（> 5ms）**：直接 FATAL 退出。因为这种级别的回拨说明系统时钟有严重问题，继续运行会产生重复 ID，不如挂掉让外部监控拉起。

其他方案比如美团 Leaf 使用 ZooKeeper 持久化时间戳，彻底绕开时钟回拨问题，但需要额外组件的运维成本。

### Q14：消息有序性怎么保证？

- **单聊**：每条消息分配递增的 msg_id（Snowflake 生成），接收端按 msg_id 排序。如果有乱序到达（网络原因），客户端按 msg_id 重排即可。
- **群聊**：同一群的 msg_id 由单台 message-service 节点生成，保证全局递增。
- **ACK 机制**：客户端收到消息后回复 ACK（携带已确认的最大 msg_id），服务端据此判断哪些消息已经送达，未 ACK 的消息下次拉取时重新下发。

### Q15：消息 Timeline 拉取模型怎么工作的？

客户端本地记录已收到的最大 msg_id。下次拉取时传这个 msg_id 作为 offset，服务端返回 `msg_id > offset` 的消息，按 msg_id 升序排列，带上 `has_more` 标志表示是否还有更多。这比传统分页（page/limit）更适合 IM 场景，因为在不断有新消息插入的情况下游标分页不会重复或遗漏。

---

## 五、网关

### Q16：令牌桶限流怎么实现的？

经典令牌桶算法：每个桶有最大容量（maxTokens），令牌以固定速率恢复（每秒恢复 maxTokens 个）。请求来时尝试消费 1 个令牌，有就放行，没有就拒绝（429）。按用户 ID 和 IP 分别限流，互不影响。

最终版升级为 Redis 令牌桶（支持多网关共享限流状态），用 Lua 脚本保证令牌消费的原子性。

### Q17：网关的 PushService 为什么不做鉴权？

PushService 是给 C++ 服务内部调用的，不面向客户端。安全保证靠：

- 网络层隔离（部署在内网，不暴露公网端口）
- push_id 幂等去重（防止重放攻击）
- 共享密钥 / IP 白名单（最终版可加入）

这本质上是"边界鉴权"模型的延伸——网关对外（客户端）做严格鉴权，对内（后端服务）信任。

### Q18：push_id 去重是怎么做的？

网关维护一个 push_id 的 Set，收到推送时先查这个 Set，如果 push_id 已存在就跳过。Set 设置大小上限（比如 10000），满了就清掉最旧的一半。因为 push_id 用时间戳，过期后重复的概率极低，LRU 策略足够。

---

## 六、流媒体

### Q19：SFU 模式和 P2P 有什么区别？

- **P2P（Mesh）**：每个参会者互相建立连接，N 个人需要 N×(N-1) 条上行链路。带宽和编码压力全在客户端，移动端根本扛不住。
- **SFU**：参会者都只向服务端推一路流，服务端负责转发给其他人。客户端只需 1 路上行 + (N-1) 路下行。带宽压力在服务端，所以用 C++ 做 SFU 来榨取性能。

### Q20：SFU 做了哪些优化？

基础实现：接收 RTP 包 → 查路由表确定哪些参与者需要这路流 → 转发 RTP 包。不转码（只转发，不重新编码），降低服务端 CPU 开销。

进阶优化方向：Simulcast（客户端推多档码率，SFU 按需选择转发哪档）、SVC 可伸缩视频编码、丢包重传（NACK）、带宽自适应。

---

## 七、可追问的基础知识

面试官还可能从项目中引申出一些基础知识：

- **Protobuf vs JSON**：二进制 vs 文本、有 schema vs 无 schema、varint 编码原理、字段编号的作用
- **TCP 长连接 vs HTTP 短连接**：连接建立的 RTT 开销、Keep-Alive、WebSocket 握手过程
- **Redis 数据结构**：String/Hash/Set/ZSet/List 分别适合什么场景
- **MySQL 索引**：`SELECT * FROM messages WHERE user_id = ? ORDER BY msg_id DESC LIMIT 20` 怎么建索引？联合索引最左前缀原则
- **C++ RAII**：除了 `ClosureGuard`，还有什么场景用过 RAII？（锁管理 `lock_guard`、智能指针 `unique_ptr`、文件句柄管理）
- **无锁编程**：Snowflake 的 `atomic` sequence 怎么保证并发安全？CAS 和 fetch_add 的区别
