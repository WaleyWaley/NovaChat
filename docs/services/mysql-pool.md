# NovaChat MySQL 连接池 (`mysql_pool.h` / `mysql_pool.cpp`)

## 技术职责

`MySqlPool` 类是对 **bRPC MySQL 协议** (`brpc::PROTOCOL_MYSQL`) 的连接池封装，为 NovaChat 的 C++ 微服务提供关系型数据库访问能力。采用多个 `brpc::Channel` 实例组成连接池、Round-Robin 轮询分发请求的设计。

核心设计：

- **`Init(addr, port, user, passwd, db, pool_size)`**：初始化连接池，创建指定数量的 `brpc::Channel` 实例（默认 8 个），每个 Channel 通过 bRPC 原生 MySQL 协议与 MySQL 服务端通信。
- **`Execute(sql)`**：执行写操作（INSERT / UPDATE / DELETE），返回 `butil::Status` 表示成功或携带错误信息。
- **`Query(sql, row_cb)`**：执行 SELECT 查询，每行结果通过回调 `row_cb` 返回（回调在 bthread 上下文中执行，需注意线程安全）。
- **`QueryAll(sql, rows)`**：便捷方法，一次性收集所有查询结果行到 `std::vector<Row>` 中。
- **`Row` 类型**：定义为 `std::map<std::string, std::string>`，列名到列值的映射，简化结果处理。
- **协议优势**：bRPC 的 MySQL 协议支持非阻塞 I/O，查询 I/O 自动挂载到 bthread，不阻塞 pthread，充分利用 CPU 资源。

**当前状态：Phase 1 桩实现**。`Init()` 仅记录日志并标记就绪，`Execute` / `Query` / `QueryAll` 均返回"MySQL 不可用"错误。Phase 2 将实现完整的 bRPC MySQL 协议通信。

## 业务角色

在 NovaChat 系统中，MySQL 用于持久化存储**关系型数据**：

- **用户数据**：用户账号、个人资料（用户名、头像、Bio 等）。
- **消息记录**：聊天消息的持久化存储，支持历史消息查询。
- **对话管理**：群组/频道的创建、成员列表、权限设置。
- **关系链**：好友关系、联系人列表、黑名单等。

连接池是数据库访问的基础设施层，没有它，每个业务请求都需要独立创建/销毁 MySQL 连接，带来的开销在高并发 IM 场景下不可接受。

## 系统连接

- **依赖于 `logger` 模块**：`Init()` 中记录初始化日志。
- **依赖于 bRPC 框架**：使用 `brpc::Channel` 和 `brpc::PROTOCOL_MYSQL`，未来实际通信依赖 bRPC 的 MySQL 协议支持。
- **被业务 DAO 层使用**：如 `user_dao` 用于读写用户表，`message_dao` 用于读写消息表。DAO 层依赖 `MySqlPool` 作为连接来源，但不感知连接池内部实现。
- **与 Snowflake 配合**：Snowflake 生成的 ID 作为 MySQL 表的自增主键。消息 ID、用户 ID 等先由 Snowflake 生成，再由 DAO 层写入 MySQL。
