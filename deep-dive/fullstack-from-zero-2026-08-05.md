# 从零开始学全栈 — 用 NovaChat 当教材

> 写给不懂全栈的小白。每一章都是"概念 → 类比 → NovaChat 里的对应物"。
> 建议每天学一章，每章 20-30 分钟，学完做课后练习。

---

## 第 1 章：什么是"全栈"？你在做什么项目？

### 1.1 一个餐馆的比喻

想象你开了一家餐馆。要服务顾客，你需要：

```
顾客 (坐在餐桌前)          ←→        餐馆内部
                                       ├── 前台接待 (点菜、传菜)
                                       ├── 厨房 (做菜)
                                       ├── 账本 (记录今天卖了什么)
                                       └── 白板 (记着"3号桌要加辣")
```

一个网站/App 和餐馆一模一样：

| 餐馆 | 网站/App | 在 NovaChat 里 |
|------|---------|---------------|
| 顾客坐的地方 | **前端 (Frontend)** — 浏览器里运行的 HTML/CSS/JS | `web/` 文件夹 |
| 前台接待 | **后端 (Backend)** — 服务器上运行的程序 | `gateway/` (TS) + `services/` (C++) |
| 账本 | **数据库 (Database)** — 长期保存数据 | MySQL |
| 白板 | **缓存 (Cache)** — 短期快速记忆 | Redis |

**"全栈" = 前端 + 后端 + 数据库你都会。** 你的 NovaChat 就是一个完整的全栈项目。

### 1.2 NovaChat 简化成 3 层

不用管 C++ 还是 TypeScript，先把项目看成三层：

```
┌─────────────────────────────┐
│ 第 1 层: 前端                 │   web/index.html + js/app.js
│ 顾客看到的界面 (浏览器里跑)     │   "聊天窗口、发送按钮、消息气泡"
├─────────────────────────────┤
│ 第 2 层: 后端                 │   gateway (TS) + services (C++)
│ 处理逻辑 (服务器上跑)          │   "验证身份、存消息、转发消息"
├─────────────────────────────┤
│ 第 3 层: 存储                 │   MySQL + Redis
│ 记住数据 (数据库里存)          │   "用户表、消息表、在线名单"
└─────────────────────────────┘
```

**本章要点**：
- 前端 = 顾客看到和操作的部分
- 后端 = 看不见的逻辑处理
- 数据库 = 数据睡觉的地方
- NovaChat 这三层都有，所以是全栈项目

**课后练习**：打开 NovaChat 的 `web/index.html`，随便看几行。你会发现按钮（`<button>`）、输入框（`<input>`）——这些就是"顾客的餐桌"。

---

## 第 2 章：浏览器怎么和服务器说话？（HTTP 基础）

### 2.1 打电话 vs 写信

- **HTTP** 像写信：你寄一封信（请求），对方回一封信（响应），然后通信结束。
- **WebSocket** 像打电话：拨通后两边一直连着，随时说话。

NovaChat 两种都用：
- 登录、注册、搜索用户 → **HTTP**（问一句答一句）
- 聊天消息 → **WebSocket**（保持连接，消息随时来）

### 2.2 HTTP 请求长什么样？

你在浏览器输入网址，浏览器就发了一个 HTTP 请求：

```
GET /api/users/1000 HTTP/1.1          ← 请求行: 方法 + 路径
Host: novachat.com                     ← 请求头: 附加信息
Authorization: Bearer eyJhbGci...      ← 你是谁 (token)

                                      ← 空行

(如果是 POST，这里还有请求体 body)
```

服务器收到后回复一个 HTTP 响应：

```
HTTP/1.1 200 OK                        ← 状态码: 200=成功, 401=没登录, 404=找不到
Content-Type: application/json         ← 响应头: 内容类型

{"user_id":1000,"username":"alice"}    ← 响应体: 数据
```

### 2.3 两个最重要的概念：方法 + 路径

| HTTP 方法 | 意思 | 类比 |
|-----------|------|------|
| GET | 要东西 | "菜单给我看下" |
| POST | 交东西 | "点菜：宫保鸡丁" |

路径就是"地址"：

```
POST /api/auth/register    ← "注册"这个服务
POST /api/auth/login       ← "登录"这个服务
GET  /api/users/1000       ← "查 1000 号用户"这个服务
```

### 2.4 NovaChat 里的对应物

`web/js/api.js` 第 23-33 行，前端发 HTTP 请求的代码：

```javascript
async _post(path, body) {
    // path = "/api/auth/login" (路径)
    const res = await fetch(`${this._baseUrl}${path}`, {
        method: "POST",                    // 方法
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),        // 请求体
    });
    return res.json();                     // 解析响应体
}
```

**本章要点**：
- HTTP = 一问一答，问完就断
- 请求 = 方法(GET/POST) + 路径(/api/xxx) + 头 + 体
- 响应 = 状态码(200/401/404) + 数据(JSON)
- NovaChat 的登录/注册/搜索都用 HTTP

**课后练习**：打开浏览器按 F12 → Network 标签 → 访问任何网站，点开每个请求，找到它的 Method（GET/POST）、Status（200/404）、Response（响应体）。

---

## 第 3 章：什么是 JSON？数据是怎么打包的？

### 3.1 寄快递需要箱子

程序之间传输数据，需要把数据"打包"。JSON 就是最常用的包装箱格式：

```json
{
  "username": "alice",        ← 键值对，像填写表格
  "password": "12345678",
  "first_name": "Alice",
  "age": 22,
  "hobbies": ["coding", "guitar"]   ← 还可以放数组
}
```

**为什么叫 JSON？** JavaScript Object Notation = JavaScript 对象记法。它长得就像 JS 里的对象，浏览器天生会读。

### 3.2 为什么需要打包？

电脑内存里的数据是"活"的（JS 对象、C++ 对象），但网络传输只能传字节流（一串 0101）。所以：

```
发送方:   JS 对象 → JSON.stringify() → 字符串 → 网络传输
接收方:   字符串 → JSON.parse() → JS 对象
```

### 3.3 NovaChat 里的对应物

`web/js/api.js` 第 75-76 行：

```javascript
// 发送时打包
this._send({ type: 'auth', seq: 1, payload: { access_token: '...' } });
// 内部: this._ws.send(JSON.stringify(msg))
//       JS 对象 → '{"type":"auth","seq":1,...}' 字符串 → 发出去

// 接收时拆包
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);   // 字符串 → JS 对象
};
```

**本章要点**：
- JSON = 数据的通用打包格式
- 发送 = stringify（打包），接收 = parse（拆包）
- 前后端、不同语言之间都用 JSON 交流

**课后练习**：在浏览器控制台（F12 → Console）执行：
```javascript
const obj = {name: "alice", age: 22};
const str = JSON.stringify(obj);   // 打包
console.log(str);                  // 看字符串长什么样
const obj2 = JSON.parse(str);      // 拆包
console.log(obj2.name);            // "alice"
```

---

## 第 4 章：什么是数据库？数据存在哪里？

### 4.1 账本比喻

数据库就是餐馆的账本——**关了服务器数据也不丢**的地方。

- **MySQL**：纸质账本，写下来永久保存，查询稍慢
- **Redis**：白板，写在上面很快但会擦掉（可以设置自动擦除时间）

### 4.2 MySQL：表格

MySQL 里数据存在"表"里，表就是 Excel 表格：

```
表: users (用户表)
┌─────────┬──────────┬──────────────────┬────────────┬───────────────┐
│ user_id │ username │ password_hash    │ first_name │ created_at    │
├─────────┼──────────┼──────────────────┼────────────┼───────────────┤
│ 1000    │ alice    │ $pbkdf2$100000$..│ Alice      │ 1718360000000 │
│ 1001    │ bob      │ $pbkdf2$100000$..│ Bob        │ 1718360100000 │
└─────────┴──────────┴──────────────────┴────────────┴───────────────┘

表: messages (消息表)
┌────────────┬──────────┬────────┬──────────┬──────────────┐
│ message_id │ from_id  │ to_id  │ text     │ created_at   │
├────────────┼──────────┼────────┼──────────┼──────────────┤
│ 333...5708 │ 1000     │ 1001   │ Hello Bob│ 1718360120000│
└────────────┴──────────┴────────┴──────────┴──────────────┘
```

### 4.3 Redis：带倒计时的白板

Redis 存的是"马上要用的、临时性的"数据：

```
白板内容:
  user:online:1000  → {"gateway_addr":"10.0.1.5:3000"}  (30秒后自动擦除!)
  sess:eyJhbGci...  → "1000|1718360000|desktop"          (7天后自动擦除)
```

**为什么在线状态 30 秒擦除？** 网关每 15 秒心跳刷新一次。如果用户断网了，不刷新了，30 秒后自动消失 = 自动下线。不用手动清理。

### 4.4 NovaChat 里的对应物

- `scripts/docker/init.sql` — 建表语句（定义 MySQL 表格结构）
- `gateway/src/redis/client.ts` — 网关操作 Redis 白板
- `services/common/src/redis_client.cpp` — C++ 服务操作 Redis 白板

**本章要点**：
- MySQL = 永久账本（用户、消息），慢但可靠
- Redis = 临时白板（在线状态、Session），快但会过期
- 数据库独立运行，和服务器是分开的程序

**课后练习**：看 `scripts/docker/init.sql` 的开头部分，找到 `CREATE TABLE users`，理解每个列名是什么含义。

---

## 第 5 章：什么是"服务"？为什么拆成多个？

### 5.1 一个人 vs 一个团队

**单体架构**：一个程序干所有事。

```
┌──────────────────────────┐
│ 一个巨大的程序             │
│ 注册+登录+发消息+推送+...   │
└──────────────────────────┘
```

**微服务架构**：拆成多个小团队，各自负责一块：

```
┌────────────┐  ┌──────────────┐  ┌─────────────────┐
│ user-service│  │message-service│  │ gateway         │
│ 只管用户     │  │ 只管消息      │  │ 只管接待+转发    │
│ 注册/登录    │  │ 存储/推送     │  │ 连接/鉴权        │
│ :8001       │  │ :8002        │  │ :3000           │
└────────────┘  └──────────────┘  └─────────────────┘
```

### 5.2 为什么拆？三个理由

1. **各干各的**：改用户功能不影响消息功能
2. **独立扩容**：消息服务忙就多开几个消息服务，用户服务不用动
3. **用对技术**：网关用 Node.js（适合管连接），核心逻辑用 C++（适合高性能）

### 5.3 服务之间怎么沟通？RPC

微服务之间要交流，就像团队之间发邮件。这个"邮件系统"叫 **RPC (Remote Procedure Call，远程过程调用)**：

```
网关说: "帮我注册个用户，名字 alice"  →  HTTP POST http://user-service:8001/...
用户服务回: "注册好了，user_id 是 1000"
```

**NovaChat 用了 bRPC 这个 RPC 框架**，它有个超能力：网关发 JSON 文本，C++ 服务自动翻译成自己的语言（Protobuf 对象）——就像对方自动把你的中文邮件翻译成英文。

### 5.4 NovaChat 里的对应物

`gateway/src/clients/service_registry.ts` 就是"通讯录"：

```typescript
const registry = {
  "user-service":    { url: "http://user-service:8001", ... },
  "message-service": { url: "http://message-service:8002", ... },
  "media-service":   { url: "http://127.0.0.1:8003", ... },
};
```

网关要找谁，查通讯录拿地址，发 HTTP 请求。

**本章要点**：
- 微服务 = 把大程序拆成小团队
- 服务之间用 RPC（HTTP 请求）沟通
- 网关是"前台"，C++ 服务是"后台部门"

**课后练习**：画出 NovaChat 的三个服务（gateway、user-service、message-service），给每个服务写一句话说明它干什么。

---

## 第 6 章：什么是 WebSocket？为什么聊天要用它？

### 6.1 信 vs 电话

**HTTP（信）**：
```
Bob: "有新消息吗？"         ← 每 5 秒寄一封信问
Server: "没有。"
Bob: "有新消息吗？"
Server: "没有。"
Bob: "有新消息吗？"
Server: "有！Alice 说 Hello"  ← 平均延迟 2.5 秒 + 大量浪费
```

**WebSocket（电话）**：
```
Bob 拨通电话 (连接建立)
...
Alice 发消息的那一刻:
Server 立刻说: "Alice 说 Hello!"   ← 延迟 0.1 秒，零浪费
```

聊天要"实时"，HTTP 轮询又慢又浪费，所以 IM 系统都用 WebSocket。

### 6.2 WebSocket 的三个步骤

```
① 握手: 客户端发特殊 HTTP 请求 (Upgrade: websocket)
         → 服务器同意 → 连接建立 (电话拨通)

② 通信: 双方随时互相发消息 (双向，不封断)
         Client → Server: {"type":"send_msg","text":"Hello"}
         Server → Client: {"type":"update","data":{"text":"Hi"}}

③ 关闭: 任一方断开 (挂电话)
```

### 6.3 NovaChat 里的对应物

**连接建立** — `web/js/api.js:70-98`：

```javascript
connect(accessToken) {
    const ws = new WebSocket(this._wsUrl);   // 拨电话: ws://localhost/ws
    ws.onopen = () => {
        // 接通后第一件事: 自报家门 (发 token 证明身份)
        this._send({ type: 'auth', seq: 1, payload: { access_token } });
    };
    ws.onmessage = (e) => { /* 收到消息的处理 */ };
    ws.onclose = () => { /* 断线处理, 自动重连 */ };
}
```

**服务器端接电话** — `gateway/src/main.ts:87-105`：

```typescript
app.get("/ws", { websocket: true }, (socket, req) => {
    // 有人连接进来了
    socket.on("message", (rawData) => { /* 处理消息 */ });
    socket.on("close", () => { /* 挂断处理 */ });
});
```

### 6.4 网关怎么记住谁连着线？

**connection.ts 里有两个 Map（查找表）**：

```typescript
byUserId: Map<string, ConnectionEntry>  // "1000" → {ws: Bob的连接}
bySocket: Map<WebSocket, string>        // Bob的连接 → "1000"
```

就像电话总机的接线板：

```
用户 ID  → 他的电话线
"1000"   → 线 A  (Alice 的连接)
"1001"   → 线 B  (Bob 的连接)
```

要推消息给 Bob，查一下 "1001" → 线 B → 说话。就这么简单。

**本章要点**：
- HTTP 一问一答，WebSocket 保持连接双向实时
- 聊天系统必须用 WebSocket
- 网关用 Map 记住"谁连着哪根线"

**课后练习**：看 `gateway/src/ws/protocol.ts` 第 17-99 行，找出客户端能发的 7 种消息类型（auth、send_msg、ping...），每种写一句话说明用途。

---

## 第 7 章：一次完整消息传递（把前 6 章串起来）

用 Alice 给 Bob 发 "Hello" 为例，把学过的概念全部串起来：

```
① Alice 点发送按钮 (前端 web/js/app.js)
   前端把消息打包成 JSON:
   {"type":"send_msg","seq":10,"payload":{"peer_id":"1001","text":"Hello"}}
   ↓ 通过 WebSocket (电话线) 发出去
   (第3章 JSON + 第6章 WebSocket)

② 网关收到 (后端 gateway/main.ts)
   网关知道这条线是 Alice (登录时记在 Map 里)
   把消息转成 HTTP POST 发给 message-service
   (第5章 微服务通信 + 第2章 HTTP)

③ message-service 处理 (后端 C++)
   - 生成消息 ID (Snowflake 雪花算法)
   - 查重: 这条消息处理过吗?
   - 存储: 写进 MySQL 消息表 (第4章 数据库)
   - 推送: HTTP POST 回网关说 "把这条消息给 Bob"
   (第5章 反向推送)

④ 网关收到推送
   查 Map: "1001" → Bob 的电话线
   通过 WebSocket 把消息发过去 (第6章)

⑤ Bob 的浏览器收到 (前端 web/js/app.js)
   拆包 JSON → 渲染气泡 → 聊天窗口显示 "Hello"
   (第3章 JSON)

⑥ 同时, 网关给 Alice 回确认
   {"type":"rpc_result","seq":10,"data":{"status":"sent"}}
   → Alice 的气泡从 "⋯" 变成 "✓"
   (seq 的作用: 匹配请求和确认!)
```

**全链路一图流**：

```
Alice浏览器 --WS--> 网关 --HTTP--> message-service --HTTP--> 网关 --WS--> Bob浏览器
   (JSON)         (JSON)            (JSON→对象)          (JSON)        (JSON)
```

**本章要点**：
- 一条消息穿过 4 个程序、2 次 WebSocket、2 次 HTTP
- 每次传输都要"打包 JSON → 传输 → 拆包"
- 每个程序只干自己那部分：前端显示、网关转发、C++ 存储推送、数据库保存

**课后练习**：不看文档，自己把 ①-⑥ 的流程图默写一遍。卡住了回去看对应章节。

---

## 第 8 章：面试视角——你要能讲清楚什么？

作为一个自称"不懂全栈的小白"，秋招面试时对方期待的是：

### 8.1 最低要求（必会）

| 问题 | 你的回答要点 |
|------|-------------|
| 你项目用了什么技术栈？ | 前端：HTML/JS/CSS；后端：Node.js(TypeScript) 网关 + C++ 微服务；数据库：MySQL + Redis |
| 前后端怎么通信？ | 普通请求用 HTTP（登录注册），实时消息用 WebSocket |
| 数据用什么格式传？ | JSON，前后端都发字符串，收到后 parse |
| 一条消息从发到收经过什么？ | 浏览器 → WebSocket → 网关 → HTTP → C++ 服务存储 → 反向推回网关 → WebSocket → 对方浏览器 |

### 8.2 进阶要求（加分项）

- 为什么用 WebSocket 不用 HTTP 轮询？（实时性 + 省资源）
- 为什么网关和 C++ 服务分开？（各司其职，网关管连接，C++ 管逻辑）
- 为什么 Redis 和 MySQL 都用了？（一个快一个持久）
- 消息丢了怎么办？（先存再推，推送失败上线拉取）

### 8.3 面试话术模板（60 秒版）

> "我的项目 NovaChat 是一个即时通讯系统。前端是浏览器里的 Web 页面，后端分两层：TypeScript 网关负责管理 WebSocket 长连接和身份验证，C++ 微服务负责消息存储和业务逻辑。数据用 JSON 格式在组件间传输。发消息的流程是：客户端通过 WebSocket 把 JSON 消息发给网关，网关验证身份后转成 HTTP 请求发给 C++ 消息服务，消息服务生成唯一 ID、存储到 MySQL，然后反向通知网关，网关找到接收者的 WebSocket 连接把消息推过去。整个链路在几十毫秒内完成。"

---

## 学习路线图（建议顺序）

```
第 1-2 周: 前端基础
  HTML (按钮、输入框、div)
  → CSS (布局、颜色)
  → JavaScript (变量、函数、事件、fetch)
  → 目标: 能看懂 web/index.html 和 web/js/api.js

第 3-4 周: 后端基础
  HTTP 深入 (方法、状态码、头)
  → Node.js 入门 (写一个 hello world 服务器)
  → 数据库入门 (MySQL 增删改查、Redis 基本命令)
  → 目标: 能看懂 gateway/src/routes/user.ts

第 5-6 周: 通信进阶
  WebSocket 原理
  → JSON 序列化
  → REST API 设计
  → 目标: 能画出"发消息"的完整时序图

第 7-8 周: NovaChat 专项
  读 gateway/src/main.ts 的 WebSocket 处理
  → 读 message_service_impl.cc 的 SendMessage
  → 读 push_dispatcher.cc 的反向推送
  → 目标: 默写整个消息流，说出每个环节的数据形态

持续: 面试模拟
  每周找朋友/对着镜子讲一遍项目
  → 录下来听，找出卡壳的地方
  → 卡壳的地方就是下一周的学习重点
```

## 推荐免费资源

| 主题 | 资源 |
|------|------|
| HTML/CSS/JS 入门 | MDN 中文教程 https://developer.mozilla.org/zh-CN/docs/Learn |
| JavaScript 进阶 | 《JavaScript 高级程序设计》或 现代 JavaScript 教程 https://zh.javascript.info |
| HTTP 入门 | MDN HTTP 概述 https://developer.mozilla.org/zh-CN/docs/Web/HTTP/Overview |
| MySQL 入门 | 菜鸟教程 MySQL https://www.runoob.com/mysql/mysql-tutorial.html |
| Redis 入门 | 菜鸟教程 Redis https://www.runoob.com/redis/redis-tutorial.html |
| WebSocket | MDN WebSocket API https://developer.mozilla.org/zh-CN/docs/Web/API/WebSocket |
| Node.js | Node.js 官方入门 https://nodejs.org/zh-cn/learn |
