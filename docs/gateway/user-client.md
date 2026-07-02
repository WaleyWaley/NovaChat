# 用户服务客户端 (`clients/user_client.ts`)

## 技术职责

`UserClient` 是对 C++ `user-service` 微服务的**全量 RPC 封装**，提供了 12 个业务方法的 TypeScript 接口。每个方法对应 `user.proto` 中 `UserService` 的一个 RPC，网关层通过 `BrpcClient` 基类以 HTTP JSON 方式调用后端。

### 封装的 RPC 方法

**认证 (3 个)**

| 方法 | 功能 | 关键字段 |
|---|---|---|
| `register` | 用户注册 | username, password, first_name, phone |
| `login` | 用户登录 | username, password, device info |
| `refreshToken` | 刷新 access token | refresh_token |
| `logout` | 退出登录 | user_id |

**资料查询 (2 个)**

| 方法 | 功能 |
|---|---|
| `getUserProfile` | 获取单个用户资料（按 user_id 或 username） |
| `getUsers` | 批量获取用户资料 |

**资料修改 (4 个)**

| 方法 | 功能 |
|---|---|
| `updateProfile` | 更新用户资料（姓名、简介、头像等） |
| `changeUsername` | 修改用户名 |
| `checkUsername` | 检查用户名是否可用 |
| `changePassword` | 修改密码 |

**搜索与账户管理 (3 个)**

| 方法 | 功能 |
|---|---|
| `searchUsers` | 搜索用户（分页，支持 `has_more`） |
| `deleteAccount` | 删除账户 |

### 类型对齐

文件中定义了完整的请求/响应 TypeScript 接口（如 `RegisterReq`、`LoginResp`、`UserProfile`），与 `user.proto` 的字段定义一一对齐，在编译期提供类型安全。

### 实现模式

`UserClient` 封装了 `BrpcClient`，通过 `getServiceUrl("user-service")` 和 `getFullServiceName("user-service")` 从服务注册表获取地址和 Protobuf 服务名。每个业务方法内部调用 `this.client.call()`，传入方法名和请求体。

文件末尾导出全局单例 `userClient`。

## 业务角色

`UserClient` 是网关中**用户管理功能的入口**。客户端的注册、登录、资料查看/修改、搜索用户等请求，最终都通过此类转发到 C++ `user-service`。它位于网关路由层的消费端 —— 路由层收到客户端请求后，调用 `userClient.login()` 等方法，然后将结果包装为 ServerMessage 返回给客户端。

## 系统关联

- 继承 `BrpcClient` 基类能力（超时控制、错误处理、user_id 注入）
- 端点信息来自 `service_registry.ts` 注册表的 `user-service` 条目
- 被 WebSocket 路由层（如 `ws/auth` 处理函数）调用，处理客户端的 `auth` 类型消息
- 被 HTTP REST 路由层调用，处理登录/注册等 RESTful 接口
