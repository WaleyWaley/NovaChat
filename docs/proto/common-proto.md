# common.proto — NovaChat 公共协议定义

## 技术说明

`common.proto` 是 NovaChat 所有服务的协议基础文件，定义了整个系统中共享的核心数据类型、枚举和消息结构。文件位于 `proto/nova/common/` 包下，采用 Protocol Buffers 3 语法。

### 核心枚举

**ErrorCode（错误码）**：参考 Telegram MTProto 的精确错误码体系设计，按功能模块分段编号：
- 1000–1099：认证相关（密钥无效、会话过期、验证码错误等）
- 1100–1199：用户相关（用户不存在、用户名被占用等）
- 1200–1299：对话/群组相关
- 1300–1399：消息相关
- 1400–1499：媒体文件相关
- 1500–1599：频率限制（Flood Wait）
- 5000–5099：服务端内部错误

**PeerType / Peer（对话抽象）**：借鉴 Telegram 的核心设计理念，用 `Peer` 统一表示"用户"（单聊）、"群组"和"频道"三种对话类型。客户端和服务端基于 `Peer` 进行消息路由，而非区分 `chat_id` 或 `user_id`。`access_hash` 字段用于防止 ID 被枚举遍历。

**MessageType / MessageStatus**：定义了 12 种消息类型（文本、图片、视频、语音、投票、服务消息等）和 5 种消息状态（未发送、已发送、已送达、已读、失败）。

### 核心消息结构

**Message（消息信封）**：消息的核心载体，包含发送者 Peer、接收者 Peer、消息类型、富文本实体、媒体附件、回复引用、转发来源、自毁计时等 20+ 个字段，覆盖即时通讯的完整消息场景。

**Update / UpdateType（实时事件）**：参考 Telegram 的更新机制，所有服务端下发的实时事件统一为 `Update` 类型。客户端通过单条 WebSocket 通道接收包括新消息、编辑、删除、已读回执、用户状态变化、输入中指示器等所有事件。

**PageRequest / PageResponse（分页）**：基于 ID 和时间偏移的向下翻页模型，单页上限 100 条。

**SyncState（同步状态）**：参考 Telegram 的 PTS/QTS 模型，客户端维护单调递增的更新序列号用于增量拉取变更。

### 其他类型

- `UserProfile`：用户资料（含 @username、头像引用、在线状态等）
- `ChatInfo / ChatMember`：群组信息和成员角色
- `MessageEntity`：富文本格式实体（加粗、斜体、@提及、URL、代码块等）
- `FileReference`：媒体文件引用（含尺寸、时长、缩略图）
- `Poll / PollOption`：投票消息
- `GeoPoint`：地理位置
- `RequestMeta / Response`：通用的请求元数据和响应包装

## 业务角色

`common.proto` 相当于 NovaChat 系统的"通用字典"——所有微服务之间的数据交换都依赖此文件中的类型定义。它将即时通讯的领域模型（用户、消息、群组、媒体、事件）抽象为结构化的 Protocol Buffers 消息，确保 C++ 后端服务与 TypeScript BFF 网关在处理业务逻辑时共享同一套数据契约。这种设计降低了跨语言通信的歧义性，为后续协议演进提供了向后兼容的扩展空间。
