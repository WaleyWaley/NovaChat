# 服务注册表 (`clients/service_registry.ts`)

## 技术职责

`ServiceRegistry` 是网关用于管理 C++ 后端微服务地址的**服务发现模块**。它维护了服务名到实际 HTTP 地址的映射关系，为 `BrpcClient` 提供端点路由信息。

### 当前实现 (Phase 1)

Phase 1 采用**配置文件硬编码**方式，适合开发和初期部署：

```typescript
const registry: Record<ServiceName, ServiceInfo> = {
  "user-service": {
    url: config.USER_SERVICE_URL,       // 来自环境变量/配置文件
    fullServiceName: "nova.user.UserService",
  },
  "message-service": {
    url: config.MESSAGE_SERVICE_URL,
    fullServiceName: "nova.message.MessageService",
  },
  "media-service": {
    url: process.env.MEDIA_SERVICE_URL || "http://127.0.0.1:8003",
    fullServiceName: "nova.media.MediaService",
  },
};
```

目前注册了三个服务，每个服务记录两条关键信息：
- `url` — HTTP 访问地址（IP:Port）
- `fullServiceName` — 完整的 Protobuf 服务限定名，用于构造 bRPC HTTP 端点

### 导出 API

| 函数 | 用途 |
|---|---|
| `getService(name)` | 获取服务的完整信息对象 |
| `getServiceUrl(name)` | 快捷获取服务 URL |
| `getFullServiceName(name)` | 快捷获取 Protobuf 服务名 |
| `updateServiceUrl(name, url)` | 运行时动态更新服务地址（Phase 3 预留） |

### 未来演进 (Phase 3)

文件已预留 `updateServiceUrl()` 接口，计划在 Phase 3 接入 Consul/Etcd 实现：
- 动态服务发现（服务实例上下线自动感知）
- 健康检查（剔除不健康实例）
- 负载均衡（在多个实例间分发请求）

## 业务角色

在 NovaChat 微服务架构中，服务注册表是网关的**服务目录**。网关通过它知道"用户服务在哪个地址"、"消息服务在哪个地址"，从而正确转发客户端请求。它将服务名称与具体部署地址解耦：后端迁移或扩缩容时，只需更新注册表，网关代码无需变更。

## 系统关联

- 被 `clients/user_client.ts` 和 `clients/message_client.ts` 等业务客户端引用，用于获取服务端点和 Protobuf 服务名
- 服务 URL 值来自 `config/index.ts` 的配置系统，最终由环境变量驱动
- `ServiceName` 联合类型（`"user-service" | "message-service" | "media-service"`）在 TypeScript 层面提供了编译期类型安全
