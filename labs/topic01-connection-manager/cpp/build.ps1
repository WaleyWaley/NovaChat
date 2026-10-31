# 编译 C++ lab（直接使用系统 g++，无需 cmake/make）
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File fetch_deps.ps1   # 首次: 下载头文件库
#   powershell -ExecutionPolicy Bypass -File build.ps1
#   .\topic01_conn_mgr.exe [port]

$ErrorActionPreference = "Stop"

# 检查依赖头文件
foreach ($h in @("third_party\httplib.h", "third_party\json.hpp")) {
    if (-not (Test-Path -LiteralPath $h)) {
        Write-Host "Missing $h — run: powershell -ExecutionPolicy Bypass -File fetch_deps.ps1" -ForegroundColor Red
        exit 1
    }
}

Write-Host "Compiling topic01-conn-mgr (real WebSocket via cpp-httplib) ..." -ForegroundColor Cyan

g++ -std=c++17 -O2 -Wall -Wextra -Wno-unused-parameter -I. -Ithird_party `
    connection.cc mini_connection_manager.cc main.cc `
    -o topic01_conn_mgr.exe -lws2_32 -pthread

if ($LASTEXITCODE -ne 0) {
    Write-Host "Build FAILED" -ForegroundColor Red
    exit 1
}

Write-Host "Build OK -> topic01_conn_mgr.exe" -ForegroundColor Green
Write-Host "Run it with: .\topic01_conn_mgr.exe 3001"
