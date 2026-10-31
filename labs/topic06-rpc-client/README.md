# 实验 06：bRPC HTTP 客户端 + 服务注册表

对应 NovaChat 网关的：

- `gateway/src/clients/base.ts`（BrpcClient）
- `gateway/src/clients/service_registry.ts`
- `gateway/src/clients/user_client.ts`

## 背景

NovaChat 的网关（TypeScript）通过 **HTTP POST** 调用 C++ 的 bRPC 服务：

```
{baseUrl}/{fullServiceName}/{method}
例如 http://127.0.0.1:8001/nova.user.UserService/Register
```

请求体是 JSON，bRPC 用 `http+pb` 模式自动反序列化成 Protobuf 对象。网关因此**不需要引入 Protobuf 依赖**。

本实验让你亲手实现这套客户端的 C++（以及后续的 TS）版本。

## 双语言对照

| 概念 | TS | C++ |
|---|---|---|
| HTTP 发送 | `fetch` | `httplib::Client::Post` |
| 超时 | `AbortController` | `set_read_timeout` |
| JSON | `JSON.parse` / `JSON.stringify` | `nlohmann::json` |
| 大整数 | 需要正则 hack | 原生精确（int64） |
| 错误 | `BrpcCallError` | `MiniBrpcError` |
| 类型 | 泛型 | `nlohmann::json` |

## 目录

- `cpp/` — C++ 版（基于 cpp-httplib 的真实 HTTP 客户端 + 模拟 bRPC 服务端）

（TS 版后续补充）

## 开始学习

进入 `cpp/`，按 `cpp/README.md` 操作。

## 完成后你会掌握

- bRPC HTTP 端点的拼接与调用
- HTTP 客户端超时、错误分类的工程写法
- 服务注册表的抽象
- TS 与 C++ 在处理 int64 精度上的根本差异
