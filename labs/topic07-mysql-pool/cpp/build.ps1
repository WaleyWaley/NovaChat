# 编译 C++ lab 07 (MySQL 连接池 + 工作线程)
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File start_mysql.ps1    # 先启动 MySQL
#   powershell -ExecutionPolicy Bypass -File build.ps1
#   .\topic07_mysql_pool.exe

param(
    [string]$MysqlRoot = "C:\Program Files\MySQL\MySQL Server 8.4"
)

$ErrorActionPreference = "Stop"
$inc = Join-Path $MysqlRoot "include"
$lib = Join-Path $MysqlRoot "lib"

if (-not (Test-Path -LiteralPath (Join-Path $inc "mysql.h"))) {
    throw "mysql.h not found under $inc (用 -MysqlRoot 指定 MySQL 安装目录)"
}

Write-Host "Compiling topic07-mysql-pool ..." -ForegroundColor Cyan

g++ -std=c++20 -O2 -Wall -Wextra -Wno-unused-parameter -I. -I"$inc" `
    mini_mysql_pool.cc main.cc `
    -L"$lib" -llibmysql -o topic07_mysql_pool.exe -lws2_32 -pthread

if ($LASTEXITCODE -ne 0) {
    Write-Host "Build FAILED" -ForegroundColor Red
    exit 1
}

# 复制 libmysql.dll 到本地, 运行时无需改 PATH
Copy-Item (Join-Path $lib "libmysql.dll") . -Force

Write-Host "Build OK -> topic07_mysql_pool.exe" -ForegroundColor Green
Write-Host "Run it with: .\topic07_mysql_pool.exe"
