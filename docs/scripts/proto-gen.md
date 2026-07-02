# proto-gen.sh — NovaChat Proto 代码生成脚本

## 技术说明

`proto-gen.sh` 是 NovaChat 项目的一键协议代码生成脚本，位于 `scripts/` 目录。它读取 `proto/` 目录下的所有 `.proto` 文件，生成对应的 C++ 和 TypeScript 代码，输出到 `gen/` 目录。

### 功能流程

脚本支持三个目标模式：`all`（默认）、`cpp`、`ts`。

**1. 环境检测**
- 自动查找 `protoc` 编译器：先检查 `PATH`，再检查 `BRPC_ROOT` 环境变量指定的路径。
- 自动查找 `protoc-gen-brpc` 插件：按 `PATH` → `BRPC_ROOT` → 常见安装位置依次搜索，用于生成 bRPC 服务桩代码。
- 查找 TypeScript 插件：优先使用 `protoc-gen-ts`（`@protobuf-ts/plugin`），若不存在则降级为 `ts-proto` CLI 工具。

**2. C++ 代码生成**
- 收集 `proto/` 目录下所有 `.proto` 文件。
- 调用 `protoc`，使用 `--cpp_out` 生成 protobuf 消息类（`.pb.h` / `.pb.cc`）。
- 若找到 bRPC 插件，额外使用 `--brpc_out` 生成 bRPC 服务桩代码（`.brpc.h` / `.brpc.cc`）。
- 输出到 `gen/cpp/` 目录，按包路径组织。

**3. TypeScript 代码生成**
- 若系统中安装了 `protoc-gen-ts`，通过 protoc 插件方式生成。
- 否则使用 `npx ts-proto` CLI 生成，指定 `--protoDir` 和 `--outDir`。
- 若无任何 TS 插件，打印警告并跳过。
- 输出到 `gen/ts/` 目录。

### 使用方式

```bash
./scripts/proto-gen.sh          # 生成全部语言
./scripts/proto-gen.sh cpp      # 仅生成 C++
./scripts/proto-gen.sh ts       # 仅生成 TypeScript
BRPC_ROOT=/path/to/brpc ./scripts/proto-gen.sh  # 指定 bRPC 路径
```

### 依赖

- **protoc**：Protocol Buffers 编译器（需安装 protobuf-compiler）
- **protoc-gen-brpc**：bRPC 的 protoc 插件（随 bRPC 框架安装）
- **protoc-gen-ts 或 ts-proto**：TypeScript 代码生成插件（可选）

## 业务角色

在 NovaChat 的跨语言架构（C++ 微服务 + TypeScript BFF 网关）中，proto 文件是数据契约的唯一真相来源（Single Source of Truth）。此脚本将 proto 定义同步转换为 C++ 和 TypeScript 的类型定义和 RPC 桩代码，确保两端使用一致的数据结构，避免手动翻译导致的类型不一致问题。开发者在修改任何 `.proto` 文件后只需运行此脚本即可自动更新所有语言的相关代码，是持续集成和本地开发的关键环节。
