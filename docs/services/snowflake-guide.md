# NovaChat — Snowflake 分布式 ID 生成器

> Snowflake 是 NovaChat 的全局唯一 ID 生成方案。每次调用 `NextId()` 返回一个 64 位整数，作为 user_id、message_id、push_id 等所有需要全局唯一标识的场景。

---

## 目录

1. [为什么需要 Snowflake](#1-为什么需要-snowflake)
2. [64 位 ID 的组成结构](#2-64-位-id-的组成结构)
3. [在项目中的使用场景](#3-在项目中的使用场景)
4. [关键代码逐行解读](#4-关键代码逐行解读)
5. [时钟回拨保护机制](#5-时钟回拨保护机制)
6. [Docker 集群中的 worker_id 分配](#6-docker-集群中的-worker_id-分配)
7. [相关文件](#7-相关文件)

---

## 1. 为什么需要 Snowflake

### 三种 ID 方案对比

| 方案 | 优点 | 缺点 | NovaChat 的选择 |
|------|------|------|:---:|
| 数据库自增 ID (AUTO_INCREMENT) | 简单, 严格递增 | 分库分表后 ID 冲突; 发消息要等 INSERT 完才知道 ID | ❌ |
| UUID | 随处可生成, 全局唯一 | 128-bit 太长 (36 字符); 随机无序, B+Tree 索引效率极低 | ❌ |
| **Snowflake** | 本地生成 (零网络开销); 趋势递增 (索引友好); 64-bit 紧凑 | 依赖时钟正确性 | ✅ |

### NovaChat 选择 Snowflake 的具体原因

```
用户注册:    需要 user_id, 不能依赖数据库返回 (Phase 1 内存模式)
消息存储:    需要 msg_id, 在 INSERT 前就要确定 (Timeline 排序)
推送去重:    需要 push_id, 防止 bRPC 重试导致重复推送
```

---

## 2. 64 位 ID 的组成结构

```
Snowflake ID 结构 (64 bits = 8 bytes):

┌─┬───────────────────────────┬─────────────────┬─────────────────────┐
│0│    41 bits 时间戳          │ 10 bits worker  │ 12 bits sequence   │
└─┴───────────────────────────┴───────────────┴─────────────────────┘
 ↑  ↑                            ↑                ↑
 │  └─ 毫秒差值                   └─ 机器编号       └─ 同毫秒内递增
 │     (当前时间 - epoch)          (0~1023)          每毫秒至多 4096 个
 └─ 保留位 (始终为 0, 保证 ID 为正数)

拼装公式:
  id = (timestamp_diff << 22) | (worker_id << 12) | sequence
```

### 各字段详解

| 字段 | 位数 | 范围 | 说明 |
|------|------|------|------|
| 保留位 | 1 bit | 固定 0 | 保证 ID 永远为正数 |
| 时间戳 | 41 bits | 0 ~ 2^41-1 毫秒 ≈ 69 年 | 从 epoch (2024-01-01) 开始计数 |
| Worker ID | 10 bits | 0 ~ 1023 | 每个服务实例唯一, 集群最多 1024 个节点 |
| 序列号 | 12 bits | 0 ~ 4095 | 同一毫秒内递增, 每毫秒最多生成 4096 个 ID |

### 性能上限

```
4096 IDs/ms/worker × 1024 workers = 约 4,000,000 IDs/ms (理论上限)
单个 worker: 4096 × 1000 = 约 4,000,000 IDs/s
```

### ID 示例

```
你测试中看到的实际 ID:
  user_id:    333582933703004160
  message_id: 333855523432570880

解码这个 user_id:
  333582933703004160 的二进制:
  01001010 00011111 11101101 01100000 01000000 00000001 00000000 00000000
  ↑                                ↑                  ↑
  timestamp(41bits)                worker(10bits)     seq(12bits)
```

---

## 3. 在项目中的使用场景

### 场景 1: 生成 user_id

```cpp
// services/user-service/user_service_impl.cc — Register()
int64_t user_id = snowflake_->NextId();
// 返回值: 333855473985916928

// 接下来:
//   user_dao_->CreateUser(user_id, ...)
//   → 存进 MySQL 或内存 → 返回给客户端
```

### 场景 2: 生成 message_id

```cpp
// services/message-service/message_service_impl.cc — SendMessage()
record.message_id = snowflake_->NextId();
// 返回值: 333855523432570880

// message_id 作为主键存入数据库
// Timeline 查询按 message_id 降序排列 (越大越新)
```

### 场景 3: 生成 push_id (幂等去重)

```cpp
// 推送消息时, 每条推送带唯一 push_id
int64_t push_id = snowflake_->NextId();

// 网关侧:
//   connectionManager.isDuplicatePush(push_id) → true/false
//   同一个 push_id 不会推送两次 (防止 bRPC 重试重复推送)
```

### 场景 4: 生成 Token (Phase 1 简化 Token 格式)

```cpp
// services/user-service/user_service_impl.cc — GenerateToken()
std::string GenerateToken(int64_t user_id, const std::string& device_type) {
    int64_t ts = nova::NowMs();
    int64_t seq = snowflake_->NextId();    // ← Snowflake 生成的序列号
    std::ostringstream oss;
    oss << "tok_" << std::hex << user_id << "_" << ts << "_" << seq;
    return oss.str();
    // 输出示例: "tok_4a11d0e10801000_19f46c62c52_4a11d0e14801000"
}
```

---

## 4. 关键代码逐行解读

**文件**: `services/common/src/snowflake.cpp`

### 4.1 构造函数

```cpp
Snowflake::Snowflake(int64_t worker_id) : worker_id_(worker_id) {
    if (worker_id > kMaxWorkerId) {     // kMaxWorkerId = 1023
        NOVA_LOG_FATAL << "Worker ID exceeds maximum";
        abort();
    }
    worker_id_shift_ = kSequenceBits;   // 12 bits (序列号位宽)
}
```

### 4.2 NextId() — 核心方法

```cpp
int64_t Snowflake::NextId() {
    std::lock_guard<std::mutex> lock(mu_);  // ① 线程安全

    int64_t now = CurrentMs();               // ② 获取当前毫秒时间

    // ③ 时钟回拨检测
    if (now < last_timestamp_) {
        int64_t diff = last_timestamp_ - now;
        if (diff <= 5) {
            now = WaitNextMs(last_timestamp_); // ≤5ms → 自旋等待
        } else {
            NOVA_LOG_FATAL << "Clock moved backwards!";  // >5ms → 崩溃
            abort();
        }
    }

    // ④ 序列号处理
    if (now == last_timestamp_) {
        sequence_ = (sequence_ + 1) & kMaxSequence;  // 同毫秒内递增, 到 4095 回 0
        if (sequence_ == 0) {
            now = WaitNextMs(last_timestamp_);        // 序列号用尽 → 等下一毫秒
        }
    } else {
        sequence_ = 0;  // 新毫秒 → 序列号重置
    }

    last_timestamp_ = now;

    // ⑤ 拼装三个部分为 64 位整数
    int64_t ts = now - kSnowflakeEpoch;  // 减去 epoch, 压缩到 41 bits
    return (ts << kWorkerIdBits + kSequenceBits)   // timestamp << (10+12) = << 22
         | (worker_id_ << kSequenceBits)           // worker_id << 12
         | sequence_;                               // sequence (低 12 位)
}
```

**拼装示意图**:

```
timestamp_diff (41 bits): 01001010000111111101101101011000000100000
worker_id     (10 bits):                           0000000001
sequence      (12 bits):                                      000000000000

按位 OR 合并:
  timestamp << 22:  01001010000111111101101101011000000100000 000000000000 000000000000
  worker_id << 12:  00000000000000000000000000000000000000000 0000000001 000000000000
  sequence:          00000000000000000000000000000000000000000 0000000000 000000000000
  ───────────────────────────────────────────────────────────────────────────────────
  最终 ID:           01001010000111111101101101011000000100000 0000000001 000000000000
                     ↑                                      ↑          ↑
                  timestamp(41bits)                    worker(10)  seq(12)
```

### 4.3 工具方法 (调试用)

```cpp
// 从 ID 反解时间戳
int64_t Snowflake::ExtractTimestamp(int64_t id) {
    return (id >> 22) + kSnowflakeEpoch;  // 右移 22 位, 加回 epoch
}

// 从 ID 反解 worker_id
int64_t Snowflake::ExtractWorkerId(int64_t id) {
    return (id >> 12) & kMaxWorkerId;     // 右移 12 位, 取低 10 位
}

// 从 ID 反解序列号
int64_t Snowflake::ExtractSequence(int64_t id) {
    return id & kMaxSequence;             // 直接取低 12 位
}
```

---

## 5. 时钟回拨保护机制

### 为什么时钟会回拨？

```
- NTP 时间同步: 系统时钟被向后调整
- 虚拟机迁移: 虚拟化环境的时间跳变
- 手动修改系统时间
```

### NovaChat 的应对策略

```
系统时钟回拨了 N 毫秒
       │
       ├─ N ≤ 5ms → 自旋等待
       │   WaitNextMs(last_timestamp):
       │     while (CurrentMs() <= last_timestamp) {
       │         // busy-wait, 消耗 CPU 但不创建新 ID
       │     }
       │     return CurrentMs();
       │
       └─ N > 5ms → FATAL 崩溃
            NOVA_LOG_FATAL << "Clock moved backwards!";
            abort();
            // 宁愿崩溃让运维发现, 也不产生重复 ID
```

### 为什么 ≤ 5ms 选择自旋？

- 5ms 以内的回拨通常是 NTP 微调, 短暂等待即可恢复
- 5ms 的 CPU 自旋代价极小 (约 20,000 个空循环)
- 超过 5ms 说明时钟出了严重问题, 需要人工介入

### 为什么大于 5ms 选择崩溃？

- Snowflake 的核心保证: **同一 worker_id 下, ID 单调递增不重复**
- 如果时钟回拨 10ms 还继续生成, 可能产生与之前重复的 ID
- 重复 ID 对 IM 系统是灾难性的 (消息丢失、用户混淆)
- 崩溃后 Docker/Systemd 会自动重启, 重启后时钟大概率已修正

---

## 6. Docker 集群中的 worker_id 分配

### 当前配置

```bash
# user-service (docker-compose.yml)
--worker_id=1

# message-service (docker-compose.yml)
--worker_id=2
```

### 多节点扩展

```
单机部署:  worker_id = 1, 2, 3, ...
多机部署:  每台机器的每个服务实例用不同 worker_id
          worker_id 上限 = 1023 (10 bits)

示例:
  机器 1: user-service worker_id=1, message-service worker_id=2
  机器 2: user-service worker_id=3, message-service worker_id=4
  机器 3: user-service worker_id=5, message-service worker_id=6
```

### worker_id 的生命周期

- 服务启动时从配置文件读取 (不可变)
- 在集群中必须唯一 (否则不同节点可能产生相同 ID)
- Phase 3: 可以用 Etcd/Consul 自动分配 worker_id

---

## 7. 相关文件

| 文件 | 内容 |
|------|------|
| `services/common/include/nova/snowflake.h` | Snowflake 类声明 |
| `services/common/src/snowflake.cpp` | 完整实现 (NextId / 时钟回拨 / ID 反解) |
| `services/common/include/nova/common.h` | 常量定义 (epoch / worker bits / sequence bits) |
| `services/user-service/user_service_impl.cc` | 使用 Snowflake 生成 user_id |
| `services/message-service/message_service_impl.cc` | 使用 Snowflake 生成 message_id |

---

> **最后更新**: 2026-07-10
> **相关文档**: [[./code-overview.md]] (代码全景) \| [[./password-and-session.md]] (密码与 Session)
