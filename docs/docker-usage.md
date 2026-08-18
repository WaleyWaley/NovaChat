# NovaChat — Docker 使用指南 (PowerShell)

> 本文档所有命令使用 PowerShell 原生语法，在 Windows Terminal 或 PowerShell 中直接粘贴运行。

---

## 目录

1. [环境准备](#1-环境准备)
2. [启动与停止](#2-启动与停止)
3. [查看状态与日志](#3-查看状态与日志)
4. [测试 RPC 接口（直连 C++ 服务）](#4-测试-rpc-接口直连-c-服务)
5. [测试 RPC 接口（通过网关）](#5-测试-rpc-接口通过网关)
6. [进入容器调试](#6-进入容器调试)
7. [重建与更新](#7-重建与更新)
8. [一键测试脚本](#8-一键测试脚本)
9. [常见问题](#9-常见问题)

---

## 1. 环境准备

```powershell
# 确认 Docker Desktop 已启动（系统托盘有鲸鱼图标）
docker ps

# 确认在项目根目录
Set-Location D:\NovaChat

# 查看 docker-compose.yml 定义的服务
docker compose config --services
```

---

## 2. 启动与停止

### 首次启动（构建 + 启动全部服务）

```powershell
# 构建镜像并后台启动（首次 10-20 分钟，后续利用缓存很快）
docker compose up -d --build

# 查看启动进度
docker compose logs -f
```

### 日常启动

```powershell
# MySQL + Redis 已在运行，只启动应用层
docker compose up -d

# 只启动某个服务
docker compose up -d mysql
docker compose up -d redis
docker compose up -d user-service
docker compose up -d message-service
docker compose up -d gateway
```

### 停止

```powershell
# 停止所有服务（保留数据卷）
docker compose down

# 停止并删除数据卷（完全重置，下次启动需要重新注册用户）
docker compose down -v
```

### 重启某个服务

```powershell
docker compose restart user-service
docker compose restart gateway
```

---

## 3. 查看状态与日志

### 服务状态

```powershell
# 查看所有容器状态
docker compose ps

# 只看健康状态
docker compose ps --format "table {{.Name}}\t{{.Service}}\t{{.Status}}"

# 查看某个服务的详细信息
docker inspect novachat-user-service
```

### 实时日志

```powershell
# 所有服务日志（Ctrl+C 退出）
docker compose logs -f

# 只看某个服务
docker compose logs -f user-service
docker compose logs -f gateway

# 只看最近 50 行
docker compose logs --tail 50 user-service

# 搜索错误
docker compose logs user-service | Select-String "Error|FATAL|error|WARN"
```

### 资源占用

```powershell
docker stats
```

---

## 4. 测试 RPC 接口（直连 C++ 服务）

C++ user-service 监听 `localhost:8001`，所有 RPC 走 HTTP POST + JSON body。

### 4.1 健康检查

```powershell
Invoke-RestMethod -Uri http://localhost:8001/status
```

### 4.2 注册

```powershell
$body = '{"username":"alice99","password":"test12345","first_name":"Alice"}'
$result = Invoke-RestMethod -Uri http://localhost:8001/nova.user.UserService/Register `
  -Method POST -ContentType "application/json" -Body $body
$result

# 保存返回的 user_id 和 refresh_token
$userId = $result.user_id
$refreshToken = $result.refresh_token
Write-Host "user_id = $userId"
Write-Host "refresh_token = $refreshToken"
```

### 4.3 登录

```powershell
$body = '{"username":"alice99","password":"test12345"}'
$result = Invoke-RestMethod -Uri http://localhost:8001/nova.user.UserService/Login `
  -Method POST -ContentType "application/json" -Body $body
$result

# 保存新 token
$accessToken = $result.access_token
$refreshToken = $result.refresh_token
```

### 4.4 查用户资料

```powershell
# 按 user_id 查
$body = "{`"user_id`":$userId}"
Invoke-RestMethod -Uri http://localhost:8001/nova.user.UserService/GetUserProfile `
  -Method POST -ContentType "application/json" -Body $body

# 按 username 查
$body = '{"username":"alice99"}'
Invoke-RestMethod -Uri http://localhost:8001/nova.user.UserService/GetUserProfile `
  -Method POST -ContentType "application/json" -Body $body
```

### 4.5 检查用户名是否可用

```powershell
$body = '{"username":"bob"}'
Invoke-RestMethod -Uri http://localhost:8001/nova.user.UserService/CheckUsername `
  -Method POST -ContentType "application/json" -Body $body
```

### 4.6 搜索用户

```powershell
$body = '{"query":"ali","limit":10}'
Invoke-RestMethod -Uri http://localhost:8001/nova.user.UserService/SearchUsers `
  -Method POST -ContentType "application/json" -Body $body
```

### 4.7 修改个人资料

```powershell
$body = "{`"user_id`":$userId,`"bio`":`"Hello, NovaChat!`"}"
Invoke-RestMethod -Uri http://localhost:8001/nova.user.UserService/UpdateProfile `
  -Method POST -ContentType "application/json" -Body $body
```

### 4.8 批量查询用户

```powershell
$body = "{`"user_ids`":[$userId]}"
Invoke-RestMethod -Uri http://localhost:8001/nova.user.UserService/GetUsers `
  -Method POST -ContentType "application/json" -Body $body
```

### 4.9 刷新 Token

```powershell
$body = "{`"refresh_token`":`"$refreshToken`"}"
$result = Invoke-RestMethod -Uri http://localhost:8001/nova.user.UserService/RefreshToken `
  -Method POST -ContentType "application/json" -Body $body
$result

# 用新 token 替换旧的
$accessToken = $result.access_token
$refreshToken = $result.refresh_token
```

### 4.10 修改密码

```powershell
$body = "{`"user_id`":$userId,`"old_password`":`"test12345`",`"new_password`":`"newpass67890`"}"
Invoke-RestMethod -Uri http://localhost:8001/nova.user.UserService/ChangePassword `
  -Method POST -ContentType "application/json" -Body $body
# 改密码后所有 Session 被清除，需要重新登录
```

### 4.11 修改用户名

```powershell
$body = "{`"user_id`":$userId,`"new_username`":`"alice_new`"}"
Invoke-RestMethod -Uri http://localhost:8001/nova.user.UserService/ChangeUsername `
  -Method POST -ContentType "application/json" -Body $body
```

### 4.12 登出

```powershell
$body = "{`"user_id`":$userId}"
Invoke-RestMethod -Uri http://localhost:8001/nova.user.UserService/Logout `
  -Method POST -ContentType "application/json" -Body $body
```

### 4.13 注销账户

```powershell
# 需要提供密码做二次确认
$body = "{`"user_id`":$userId,`"password`":`"newpass67890`"}"
Invoke-RestMethod -Uri http://localhost:8001/nova.user.UserService/DeleteAccount `
  -Method POST -ContentType "application/json" -Body $body
```

### 4.14 使用文件传参（避免引号转义问题）

```powershell
# 把 JSON 写到文件
Set-Content -Path D:\req.json -Value '{"username":"alice99","password":"test12345","first_name":"Alice"}'

# 用文件内容发请求
$body = Get-Content D:\req.json -Raw
Invoke-RestMethod -Uri http://localhost:8001/nova.user.UserService/Register `
  -Method POST -ContentType "application/json" -Body $body
```

---

## 5. 测试 RPC 接口（通过网关）

网关监听 `localhost:3000`，提供 HTTP REST API 和 WebSocket。

### 5.1 网关健康检查

```powershell
Invoke-RestMethod -Uri http://localhost:3000/health
```

### 5.2 通过网关注册

```powershell
$body = '{"username":"alice99","password":"test12345","first_name":"Alice"}'
Invoke-RestMethod -Uri http://localhost:3000/api/auth/register `
  -Method POST -ContentType "application/json" -Body $body
```

### 5.3 通过网关登录

```powershell
$body = '{"username":"alice99","password":"test12345"}'
$result = Invoke-RestMethod -Uri http://localhost:3000/api/auth/login `
  -Method POST -ContentType "application/json" -Body $body
$result
```

### 5.4 WebSocket 连接测试 (需要 wscat 或浏览器)

```powershell
# 安装 wscat
npm install -g wscat

# 连接网关 WebSocket
wscat -c ws://localhost:3000/ws
# 连接后发送: {"type":"auth","seq":1,"payload":{"access_token":"<token>"}}
# 发送心跳: {"type":"ping","seq":2}
```

---

## 6. 进入容器调试

### MySQL

```powershell
# 进入 MySQL 命令行
docker exec -it novachat-mysql mysql -uroot -pnovachat_dev novachat

# 在 MySQL 里:
#   SHOW TABLES;
#   SELECT user_id, username, first_name, created_at FROM users;
#   SELECT COUNT(*) FROM users;
#   EXIT;
```

### Redis

```powershell
# 进入 Redis 命令行
docker exec -it novachat-redis redis-cli

# 在 Redis 里:
#   KEYS *                    -- 查看所有 key
#   KEYS sess:*               -- Session 缓存
#   KEYS user:online:*        -- 在线路由表
#   GET sess:<token>          -- 查看某个 session
#   TTL sess:<token>          -- 查看过期时间
#   EXIT
```

### user-service

```powershell
# 进入 C++ 服务的容器
docker exec -it novachat-user-service bash

# 在容器里:
#   ls /app/                   -- 看文件结构
#   cat /app/conf/user_service.flags  -- 看配置
#   curl localhost:8001/status        -- 健康检查
#   exit
```

### gateway

```powershell
# 进入网关容器
docker exec -it novachat-gateway sh

# 在容器里:
#   ls /app/
#   cat /app/package.json
#   wget -qO- localhost:3000/health
#   exit
```

---

## 7. 重建与更新

### 只改 C++ 代码后重建

```powershell
docker compose up -d --build user-service
```

### 只改 gateway 代码后重建

```powershell
docker compose up -d --build gateway
```

### 改了 proto 文件后重建

```powershell
docker compose up -d --build user-service
```

### 完全从头重建

```powershell
docker compose down
docker compose build --no-cache
docker compose up -d
```

### 只更新配置（不用重建）

```powershell
# 改了 docker-compose.yml 后
docker compose up -d

# 改了 conf/user_service.flags 后需要重建（配置文件在镜像内）
docker compose up -d --build user-service
```

---

## 8. 一键测试脚本

把下面内容保存为 `D:\NovaChat\scripts\test-all.ps1`，一键跑全部 RPC 测试：

```powershell
# test-all.ps1 — NovaChat 全部 12 个 RPC 测试脚本
param(
    [string]$Username = "test_user",
    [string]$Password = "test12345",
    [string]$FirstName = "Test"
)

$ErrorActionPreference = "Continue"
$base = "http://localhost:8001/nova.user.UserService"

Write-Host "`n==================== NovaChat RPC 测试 ====================`n" -ForegroundColor Cyan

function Test-RPC($name, $method, $body) {
    Write-Host "[$name]" -NoNewline -ForegroundColor Yellow
    try {
        $result = Invoke-RestMethod -Uri "$base/$method" -Method POST `
            -ContentType "application/json" -Body $body -TimeoutSec 5
        Write-Host " OK" -ForegroundColor Green
        return $result
    } catch {
        Write-Host " FAIL: $_" -ForegroundColor Red
        return $null
    }
}

# 1. 注册
$body = "{`"username`":`"$Username`",`"password`":`"$Password`",`"first_name`":`"$FirstName`"}"
$r = Test-RPC "Register"         "Register"        $body
if ($r) { $uid = $r.user_id; $rt = $r.refresh_token }

# 2. 登录
$body = "{`"username`":`"$Username`",`"password`":`"$Password`"}"
$r = Test-RPC "Login"            "Login"           $body

# 3-4. 查资料
if ($uid) {
    $body = "{`"user_id`":$uid}"
    Test-RPC "GetUserProfile(ID)"  "GetUserProfile"  $body
}
$body = "{`"username`":`"$Username`"}"
Test-RPC "GetUserProfile(name)" "GetUserProfile"  $body

# 5. 检查用户名
$body = '{"username":"nonexistent_user_999"}'
Test-RPC "CheckUsername"        "CheckUsername"   $body

# 6. 搜索
$body = "{`"query`":`"$($Username.Substring(0,[Math]::Min(3,$Username.Length)))`",`"limit`":10}"
Test-RPC "SearchUsers"          "SearchUsers"     $body

# 7. 改资料
if ($uid) {
    $body = "{`"user_id`":$uid,`"bio`":`"Test bio at $(Get-Date -Format 'HH:mm:ss')`"}"
    Test-RPC "UpdateProfile"      "UpdateProfile"   $body
}

# 8. 批量查
if ($uid) {
    $body = "{`"user_ids`":[$uid]}"
    Test-RPC "GetUsers"          "GetUsers"        $body
}

# 9. 刷新 token
if ($rt) {
    $body = "{`"refresh_token`":`"$rt`"}"
    Test-RPC "RefreshToken"      "RefreshToken"    $body
}

# 10. 改密码
if ($uid) {
    $body = "{`"user_id`":$uid,`"old_password`":`"$Password`",`"new_password`":`"newpass99999`"}"
    Test-RPC "ChangePassword"    "ChangePassword"  $body
}

# 11. 登出
if ($uid) {
    $body = "{`"user_id`":$uid}"
    Test-RPC "Logout"            "Logout"          $body
}

# 12. 注销（用新密码）
if ($uid) {
    $body = "{`"user_id`":$uid,`"password`":`"newpass99999`"}"
    Test-RPC "DeleteAccount"     "DeleteAccount"   $body
}

Write-Host "`n==================== 测试完成 ====================`n" -ForegroundColor Cyan
```

运行方式：

```powershell
# 默认参数
D:\NovaChat\scripts\test-all.ps1

# 自定义参数
D:\NovaChat\scripts\test-all.ps1 -Username myuser -Password mypass -FirstName MyName
```

---

## 9. 常见问题

### Docker Desktop 没启动

```powershell
# 症状: "failed to connect to the docker API"
# 解决: 从开始菜单启动 Docker Desktop
```

### Docker 拉取镜像超时

```powershell
# 解决: Docker Desktop → Settings → Docker Engine，添加镜像源:
# "registry-mirrors": ["https://docker.1ms.run"]
# 然后 Apply & Restart
```

### 端口被占用

```powershell
# 查看谁占用了 8001
netstat -ano | findstr 8001

# 关闭占用的进程（替换 PID）
Stop-Process -Id <PID> -Force
```

### user-service 健康检查失败

```powershell
# 看崩溃日志
docker compose logs user-service --tail 30

# 检查是否正常运行
docker compose ps user-service

# 手动重启
docker compose restart user-service
```

### RPC 返回空或连接断开

```powershell
# 1. 确认服务在运行
docker compose ps user-service

# 2. 确认健康检查通过
curl.exe -s http://localhost:8001/status

# 3. 尝试最简单的请求
$body = '{"username":"test123"}'
Invoke-RestMethod -Uri http://localhost:8001/nova.user.UserService/CheckUsername `
  -Method POST -ContentType "application/json" -Body $body -TimeoutSec 5
```

### 清理一切重新开始

```powershell
docker compose down -v          # 停止 + 删除数据卷
docker system prune -a -f       # 清理所有未使用的镜像/容器/网络
docker compose up -d --build    # 重新构建启动
```

---

> **最后更新**: 2026-07-09
> **相关文档**: [[../Gateway.md]] (网关详解) | [[../ProjectDiscription.md]] (数据流) | [[./services/password-and-session.md]] (Phase 2.2) | [[./gateway/online-routing.md]] (Phase 2.3)
