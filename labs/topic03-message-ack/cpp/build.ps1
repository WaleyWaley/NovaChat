# 编译 C++ lab 03 (消息 ACK + 已读回执)
#
# 复用 lab07 的 mini_mysql_pool (通过 -I 引用并一起编译)
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File start_mysql.ps1    # 先启动 MySQL
#   powershell -ExecutionPolicy Bypass -File build.ps1
#   .\topic03_message_ack.exe

param(
    [string]$MysqlRoot = "C:\Program Files\MySQL\MySQL Server 8.4"
)

$ErrorActionPreference = "Stop"
$inc = Join-Path $MysqlRoot "include"
$lib = Join-Path $MysqlRoot "lib"
$poolDir = Join-Path $PSScriptRoot "..\..\topic07-mysql-pool\cpp"

if (-not (Test-Path -LiteralPath (Join-Path $inc "mysql.h"))) {
    throw "mysql.h not found under $inc"
}
if (-not (Test-Path -LiteralPath (Join-Path $poolDir "mini_mysql_pool.cc"))) {
    throw "mini_mysql_pool.cc not found —— 本 lab 复用 lab07 的连接池, 请先完成 lab07"
}

Write-Host "Compiling topic03-message-ack ..." -ForegroundColor Cyan

g++ -std=c++20 -O2 -Wall -Wextra -Wno-unused-parameter `
    -I. -I"$poolDir" -I"$inc" `
    "$poolDir\mini_mysql_pool.cc" mini_message_dao.cc main.cc `
    -L"$lib" -llibmysql -o topic03_message_ack.exe -lws2_32 -pthread

if ($LASTEXITCODE -ne 0) {
    Write-Host "Build FAILED" -ForegroundColor Red
    exit 1
}

Copy-Item (Join-Path $lib "libmysql.dll") . -Force

Write-Host "Build OK -> topic03_message_ack.exe" -ForegroundColor Green
Write-Host "Run it with: .\topic03_message_ack.exe"
