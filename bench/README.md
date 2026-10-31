# NovaChat 压测工具集

三个维度覆盖面试常问的性能话题：HTTP 接口吞吐（wrk）、长连接容量与内存（自写脚本）、消息收发 QPS 与 P99 延迟（自写脚本）。

```
bench/
├── README.md
├── http/
│   ├── wrk-login.lua      登录接口脚本 (SELECT + PBKDF2 验证)
│   ├── wrk-register.lua   注册接口脚本 (动态用户名 + INSERT)
│   ├── wrk-profile.lua    查资料脚本 (带 JWT)
│   └── run-http.sh        一键入口 (在 Docker 容器里跑 wrk, 直连 compose 网络)
└── ws/
    ├── register-pool.mjs  批量注册压测用户 (输出 tokens.jsonl)
    ├── ws-conns.mjs       WS 连接数压测 (1万/5万) + 内存观察
    └── msg-qps.mjs        消息收发 QPS + P50/P99 延迟
```

## 0. 准备

```bash
# 全栈运行中
docker compose up -d
# 批量注册压测用户 (消息/认证连接压测需要; 1000 个约 1-2 分钟)
cd bench/ws
node register-pool.mjs --count 1000 --out tokens.jsonl
```

## 1. HTTP 接口压测 (wrk)

在 **Git Bash** 下运行（wrk 跑在 Docker 容器里，直连 `novachat-net` 网络的 gateway:3000，绕过 nginx 与宿主网络栈）：

```bash
bench/http/run-http.sh login      # 登录:   8 线程 × 200 连接 × 30s
bench/http/run-http.sh register   # 注册:   动态用户名, 每个请求一次真实 INSERT
bench/http/run-http.sh profile    # 查资料: 带 JWT 的受保护接口
```

输出解读：`Requests/sec` = 吞吐；`Latency` 的 50%/99% 是 wrk 自带分位数。login 打的是"SELECT + PBKDF2 验密"路径，register 打的是"INSERT 写路径"，两者对比可看出读写差异。

## 2. WS 连接数压测（内存占用）

```bash
cd bench/ws

# 1 万连接 (单机单进程即可)
node ws-conns.mjs --conns 10000 --rate 500 --hold-sec 60

# 5 万连接 (需要 4 个 worker 分摊事件循环负载)
node ws-conns.mjs --conns 50000 --rate 2000 --workers 4 --hold-sec 60

# 认证连接 (connectionManager 才会登记, 触发 Redis 在线路由表写入)
node ws-conns.mjs --conns 10000 --auth-file tokens.jsonl --hold-sec 60
```

脚本每 2 秒打印：已建连数、失败数、**客户端进程内存**、**网关容器内存**（`docker stats` 采样）。

**结果解读（面试要点）**：
- 网关 `WS_MAX_CONNECTIONS=50000` 是**认证连接**的上限（`connectionManager.register` 检查）；未认证连接不受此限制
- 单连接内存 ≈（连接建立后-建立前网关内存）/ 连接数，可算出每连接内存成本（预期几十 KB 量级）
- 认证模式额外写 Redis `user:online:*`（每连接一条 30s TTL key）

**⚠️ 客户端端口上限（5 万连接的真正障碍）**：
- Windows 客户端默认动态端口仅 **16384 个**（`netsh int ipv4 show dynamicport tcp`）。5 万连接必须管理员权限扩大：
  `netsh int ipv4 set dynamicport tcp start=1025 num=64510`
- Linux 客户端：`sysctl -w net.ipv4.ip_local_port_range="1024 65535"`
- 或起多个客户端容器（每个容器在 bridge 网络上有独立的端口空间）

## 3. 消息收发 QPS + P99 延迟

```bash
cd bench/ws
node msg-qps.mjs --pairs 50 --duration 30            # 50 对收发, 30 秒
node msg-qps.mjs --pairs 200 --duration 30 --window 4 # 更大压力: 每对 4 条在途
```

每个 pair = 一个发送端 + 一个接收端（2 个用户）。发送端循环发消息（text 内嵌 seq 和时间戳），测量两种延迟：

| 指标 | 含义 | 链路 |
|---|---|---|
| **ack P50/P99** | 发送 → `rpc_result` 确认 | 客户端 → 网关 → bRPC → C++ → **MySQL INSERT** → 返回 |
| **push P50/P99** | 发送 → 对端收到 `update` | 上面全部 + C++ 反向推送 → 网关投递 → 对端 |

**结果解读（面试要点）**：
- QPS 瓶颈大概率在 **MySQL 连接池**（`--mysql_pool_size=8`，每条消息一次 INSERT）——把池子调大 QPS 会线性上升，这是经典的"池子即吞吐上限"案例
- ack 与 push 的 P99 差值 ≈ 推送链路的开销
- 每条消息走一遍"雪花 ID + 参数化 INSERT + 反向推送 + 幂等去重"，是端到端完整链路压测

## 已知限制（如实报告，面试时主动讲）

1. 单客户端端口数限制见上文
2. 客户端事件循环：单进程 `--workers` 分摊；连接数 >5 万建议多客户端容器
3. 压测与业务同机运行（同一台 Docker 宿主机），CPU 会互相争抢，数据是"同机内耗"口径
4. MySQL 未做持久化优化（默认 innodb flush），写 QPS 上限偏低属预期
5. **网关限流会拦截压测流量**：`RATE_LIMIT_PER_IP=200/s`，wrk 默认打到 5000/s 时 96% 会被 429 拒绝（这本身就是限流器生效的证据，可以直接当作演示数据）。要看真实吞吐，先临时放开（docker-compose.yml gateway 环境里已预留注释掉的开关），测完**必须改回**。

## 实测基线（本机 Docker Desktop, 8 线程 × 100 连接 × 10s, 限流已放开）

| 接口 | QPS | 平均延迟 | 瓶颈 |
|---|---|---|---|
| login | 365/s | 248ms | **PBKDF2-SHA256 (10 万次迭代) CPU** — 每个请求一次哈希 |
| register | 448/s | 218ms | 同上 + INSERT |
| profile (GET, 带 JWT) | 1014/s | 117ms | MySQL 连接池 (8) + 网关/C++ 栈 |
| WS 消息 (5 对收发) | 480 msg/s | ack P50=10ms P99=21ms / push P50=9ms P99=20ms | 每条消息一次 INSERT |
| WS 连接 (200 裸连接) | 建立零失败 | 客户端 ~50MB RSS / 网关 31MiB | 见端口上限 |

**解读（面试故事）**：
- login 的瓶颈是**密码哈希成本**——PBKDF2 10 万次迭代是"抗暴力破解 vs 登录吞吐"的经典权衡，每毫秒延迟都是花钱买的安全性；优化方向不是降迭代数，而是验签前置/专用哈希服务
- profile 的 1014/s 是纯读路径的上限，MySQL 池子 8 连接是主要约束——调大 `--mysql_pool_size` 可线性提升
- WS 消息路径 P99=21ms 含一次 MySQL INSERT，ack 与 push 延迟几乎相等说明推送链路开销极小
