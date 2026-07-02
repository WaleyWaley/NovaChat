# bRPC HTTP 客户端基类 (`clients/base.ts`)

## 技术职责

`BrpcClient` 是网关调用 C++ bRPC 微服务的 **HTTP 客户端抽象基类**。它封装了 bRPC 的 `http+pb` 协议细节，让 TypeScript 网关可以通过标准的 `fetch` API 以 JSON 格式调用后端服务。

### 核心机制

**端点路由规则**

bRPC 的 HTTP 端点格式为 `{baseUrl}/{ProtobufServiceName}/{MethodName}`，例如：

```
http://user-service:8001/nova.user.UserService/Register
```

基类的 `call()` 方法自动拼接该 URL，调用方只需传入 `serviceName`、`methodName` 和请求体。

**请求处理流程**

1. 构建完整 URL
2. 可选的 `user_id` 注入 —— 网关鉴权后在请求体中注入当前用户 ID，C++ 后端信任此字段
3. 通过 `AbortController` 实现超时控制（默认 5s）
4. 发送 HTTP POST 请求，Content-Type 为 `application/json`
5. 解析 JSON 响应并返回

**错误处理**

- HTTP 非 2xx 状态码 → 抛出 `BrpcCallError`（携带 status 和 url）
- `AbortError`（超时）→ 抛出 408 状态码的 `BrpcCallError`
- 网络异常 → 抛出 503 状态码的 `BrpcCallError`
- 完整的结构化日志记录每个调用的耗时、URL 和异常信息

**类型定义**

- `BrpcResponse<T>` — C++ 服务统一响应结构，包含 `error_code`、`error_message` 和可选的 `data`
- `CallOptions` — 可配置超时、额外请求头、注入 `user_id`

### 为什么网关需要这个基类

bRPC 是百度开源的 RPC 框架，其 `http+pb` 模式允许 HTTP 请求体直接映射为 Protobuf 消息。网关无需引入 Protobuf 编译产物，直接发送 JSON 即可，C++ 服务端自动做序列化转换。这大幅降低了 TypeScript ↔ C++ 的集成成本。

## 业务角色

`BrpcClient` 是 **TypeScript 网关与 C++ 微服务之间的桥梁**。它让网关路由层可以用统一的编程模型调用任何后端服务，而不关心底层传输细节。每个业务客户端（如 `UserClient`）都继承自或封装此类。

## 系统关联

- 被 `clients/user_client.ts`、`message_client.ts` 等业务客户端封装使用
- `CallOptions.injectUserId` 实现了网关层面的鉴权注入，C++ 后端信任此值不再重复鉴权
- 端点地址来自 `service_registry.ts` 的服务注册表
- 日志输出对接 `utils/logger.ts`，便于链路追踪
