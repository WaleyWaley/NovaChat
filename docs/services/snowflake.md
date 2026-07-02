# NovaChat Snowflake 分布式 ID 生成器 (`snowflake.h` / `snowflake.cpp`)

## 技术职责

`Snowflake` 类实现了**雪花算法 (Snowflake)**，为 NovaChat 的分布式架构生成全局唯一的 64 位整数 ID。ID 按位分解为三部分：

- **高 1 位保留**（始终为 0）
- **41 位时间戳差**：相对于纪元 `2024-01-01` 的毫秒数，可用约 69 年（至 2093 年）
- **10 位 Worker ID**：`0–1023`，实例唯一标识
- **12 位序列号**：每毫秒 `0–4095`，单机理论吞吐约 409.6 万 ID/秒

实现细节：

- **线程安全**：序列号 `sequence_` 使用 `std::atomic<int64_t>` 无锁自增，`last_timestamp_` 由 `std::mutex` 互斥保护，确保并发安全。
- **时钟回拨处理**：$\leq$ 5ms 的轻微回拨通过 `WaitNextMs()` spin 等待追平；$>$ 5ms 的严重回拨触发 `NOVA_LOG_FATAL` 终止进程，防止 ID 冲突。
- **序列号溢出保护**：同一毫秒内序列号超过 4095 时，自旋等待至下一毫秒后递归重试。
- **反解工具方法**：`ExtractTimestamp` / `ExtractWorkerId` / `ExtractSequence` / `ToString`，用于从 ID 反推生成时间、Worker 和序列号，便于调试和日志记录。

## 业务角色

在 NovaChat 即时通讯系统中，每个用户账号、每条消息、每个对话都需要一个全局唯一的 ID。传统自增主键在分布式环境下无法使用（多服务写入冲突），UUID 虽然不冲突但长度大、无序、不适合做数据库索引。Snowflake ID 完美解决了这两个问题：

- **全局唯一且有序**：按时间递增，天然适合作为 MySQL InnoDB 主键，插入性能优异。
- **分布式友好**：每个服务实例分配唯一 Worker ID，各自独立生成 ID，无需中心节点协调。
- **信息自包含**：从 ID 即可反推出生成时间和所属实例，故障排查时可直接定位影响范围。

## 系统连接

- **依赖于 `common.h`**：使用 `kSnowflakeEpoch` / `kWorkerIdBits` / `kSequenceBits` / `kMaxWorkerId` / `kMaxSequence` 等常量，并调用 `NowMs()` 获取毫秒时间戳。
- **依赖于 `logger`**：初始化时记录 Worker ID，时钟回拨时输出警告或致命错误。
- **被业务 DAO 层调用**：`user-service` 创建用户时调用 `Snowflake::NextId()` 生成用户 ID；`message-service` 发送消息时生成消息 ID。
- Worker ID 的分配通常集成在**服务注册发现**机制中（如 ZooKeeper / etcd），或通过 static 配置文件指定，确保每个实例的 Worker ID 全局唯一。
