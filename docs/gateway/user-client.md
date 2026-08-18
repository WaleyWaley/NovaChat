# 用户服务客户端 (`clients/user_client.ts`)

## 技术职责

`UserClient` 是对 C++ `user-service` 微服务的**全量 RPC 封装**，提供了 12 个业务方法的 TypeScript 接口。每个方法对应 `user.proto` 中 `UserService` 的一个 RPC，继承自 `BrpcClient` 基类，以 HTTP JSON 方式调用后端。

### 封装的 12 个 RPC 方法

#### 认证（4 个）

| 方法 | 功能 | 关键参数 |
|---|---|---|
| `register` | 用户注册（注册即登录，返回 Token 对） | username, password, first_name, last_name, phone |
| `login` | 用户名 + 密码登录 | username, password, device_name, device_type |
| `refreshToken` | 刷新 access_token（Token 轮转） | refresh_token |
| `logout` | 退出登录 | user_id（自动注入） |

#### 资料查询（2 个）

| 方法 | 功能 |
|---|---|
| `getUserProfile` | 获取单个用户资料（`oneof identifier`：按 user_id 或 @username） |
| `getUsers` | 批量获取用户资料（`oneof user_ids`，上限 100 个） |

#### 资料修改（4 个）

| 方法 | 功能 |
|---|---|
| `updateProfile` | 更新用户资料（first_name, last_name, bio, avatar_photo_id） |
| `changeUsername` | 修改用户名（需验证 `new_username`） |
| `checkUsername` | 检查用户名是否可用 |
| `changePassword` | 修改密码（需验证旧密码 + 新密码） |

#### 搜索与账户管理（2 个）

| 方法 | 功能 |
|---|---|
| `searchUsers` | 按 username/first_name 前缀搜索（offset_id 分页，上限 50） |
| `deleteAccount` | 删除账户（需验证密码） |

### 类型对齐

文件中定义了完整的请求/响应 TypeScript 接口（如 `RegisterReq`、`LoginResp`、`UserProfile`），与 `user.proto` 的字段定义一一对齐，在编译期提供类型安全。

### 实现模式

`UserClient` 封装了 `BrpcClient`，通过 `getServiceUrl("user-service")` 和 `getFullServiceName("user-service")` 从服务注册表获取地址和 Protobuf 服务名。每个业务方法内部调用 `this.client.call()`，传入方法名和请求体。

支持 `CallOptions` 中的 `injectUserId` 选项：网关鉴权后自动在请求体中注入当前用户 ID（`request._user_id`），C++ 后端信任此值不再重复鉴权。

### 调用链路

```
userClient.register({username, password, ...})
  → BrpcClient.call(serviceUrl, "Register", reqBody)
  → POST http://user-service:8001/nova.user.UserService/Register
  → bRPC 自动 JSON → Protobuf 转换
  → user_service_impl.cc Register() 处理
  → 返回 RegisterResp (JSON)
```

文件末尾导出全局单例 `userClient`。

## 业务角色

`UserClient` 是网关中**用户管理功能的入口**。客户端的注册、登录、资料查看/修改、搜索用户等请求，最终都通过此类转发到 C++ `user-service`。它位于网关路由层的消费端 —— 路由层收到客户端请求后，调用 `userClient.login()` 等方法，然后将结果包装为 ServerMessage 返回给客户端。

## 系统关联

- 继承 `BrpcClient` 基类能力（超时控制、错误处理、user_id 注入）
- 端点信息来自 `service_registry.ts` 注册表的 `user-service` 条目（`nova.user.UserService`）
- 被 `main.ts` 中的 `handleAuth` 和 `proxyUserService()` 调用，处理 WebSocket 的 `auth` 和 `rpc` 消息
- 被 HTTP REST 路由层（`routes/user.ts`）调用，处理 `/api/auth/*` 和 `/api/users/*` 端点
- C++ 后端通过 `user_service_impl.cc` 的 12 个 RPC 方法处理实际业务
