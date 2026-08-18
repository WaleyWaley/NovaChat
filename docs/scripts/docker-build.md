# docker-build.sh — NovaChat C++ 微服务 Docker 构建脚本

## 技术说明

`docker-build.sh` 是 NovaChat 项目中用于构建 C++ 微服务 Docker 镜像的脚本，位于 `scripts/` 目录。执行后构建一个共享镜像 `novachat:latest`，user-service 和 message-service 共用同一镜像，通过不同 entrypoint 启动。

### 执行流程

1. **目录定位**：`cd "$(dirname "$0")/.."` 将工作目录切换到项目根目录（`D:\NovaChat`），确保 Docker build context 正确指向包含 `Dockerfile` 的项目根目录。
2. **Docker 构建**：`docker build -t novachat:latest .` 使用项目根目录下的 `Dockerfile` 构建 Docker 镜像。镜像包含 user-service（:8001）和 message-service（:8002）两个 C++ 微服务。
3. **错误处理**：`set -e` 确保任何步骤失败时脚本立即退出，避免构建不完整的镜像被误用。
4. **输出重定向**：`2>&1` 将 stderr 合并到 stdout，在 CI 日志中统一查看构建输出。

### 当前的局限

脚本目前构建单一共享镜像 `novachat:latest`，user-service 和 message-service 共用。Docker Compose 中通过不同 `command` 和 `entrypoint` 启动两个服务。项目规模扩大后，预期可能拆分为独立的 Dockerfile 或使用 BuildKit 多阶段构建。

## 业务角色

此脚本将 NovaChat 的 C++ 微服务打包为 Docker 镜像，实现了服务的容器化部署。容器化带来的收益包括：

- **环境一致性**：开发、测试、生产环境使用同一镜像，消除"在我机器上能跑"的问题。
- **CI/CD 集成**：在持续集成流水线中，代码合并后自动触发构建，生成可部署的镜像。
- **水平扩展**：Docker 镜像可以快速部署到 Kubernetes 或 Docker Swarm 集群中，通过增加副本数来支撑更多在线用户。
- **快速迭代**：镜像构建速度直接影响开发反馈周期，精简的脚本设计符合微服务快速迭代的需求。

作为 NovaChat 基础设施工具链的一部分，此脚本配合 Dockerfile 定义了 C++ 微服务的交付物标准格式，是 CI/CD 流水线的起点。
