# 停止由 start_mysql.ps1 启动的本地 MySQL 实例
#
# 用法: powershell -ExecutionPolicy Bypass -File stop_mysql.ps1

param(
    [int]$Port = 3307,
    [string]$MysqlRoot = "C:\Program Files\MySQL\MySQL Server 8.4"
)

$mysqladmin = Join-Path $MysqlRoot "bin\mysqladmin.exe"
if (Test-Path -LiteralPath $mysqladmin) {
    & $mysqladmin -u root -h 127.0.0.1 -P $Port shutdown 2>$null
    Start-Sleep -Milliseconds 500
}

Get-Process mysqld -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -like "*MySQL*" } |
    Stop-Process -Force -ErrorAction SilentlyContinue

Write-Host "mysqld stopped" -ForegroundColor Green
