# 编译 C++ lab 06 (RPC 客户端 + 服务注册表)
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File fetch_deps.ps1   # 首次
#   powershell -ExecutionPolicy Bypass -File build.ps1
#   .\topic06_rpc_client.exe

$ErrorActionPreference = "Stop"

foreach ($h in @("third_party\httplib.h", "third_party\json.hpp")) {
    if (-not (Test-Path -LiteralPath $h)) {
        Write-Host "Missing $h — run: powershell -ExecutionPolicy Bypass -File fetch_deps.ps1" -ForegroundColor Red
        exit 1
    }
}

Write-Host "Compiling topic06-rpc-client ..." -ForegroundColor Cyan

g++ -std=c++17 -O2 -Wall -Wextra -Wno-unused-parameter -I. -Ithird_party `
    mock_server.cc mini_service_registry.cc mini_brpc_client.cc mini_user_client.cc main.cc `
    -o topic06_rpc_client.exe -lws2_32 -pthread

if ($LASTEXITCODE -ne 0) {
    Write-Host "Build FAILED" -ForegroundColor Red
    exit 1
}

Write-Host "Build OK -> topic06_rpc_client.exe" -ForegroundColor Green
Write-Host "Run it with: .\topic06_rpc_client.exe"
