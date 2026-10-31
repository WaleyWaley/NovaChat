# 启动一个本地 MySQL 实例用于 lab (默认端口 3307, root 免密)
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File start_mysql.ps1
#   powershell -ExecutionPolicy Bypass -File start_mysql.ps1 -Port 3308
#
# 特性:
#   - 独立数据目录 (不碰系统 MySQL 的数据)
#   - 首次自动初始化 (root 空密码)
#   - 通过 WMI 分离启动, 不占用当前终端

param(
    [int]$Port = 3307,
    [string]$MysqlRoot = "C:\Program Files\MySQL\MySQL Server 8.4",
    [string]$DataDir = "$env:LOCALAPPDATA\Temp\opencode\mysql-lab-data",
    [string]$LogFile = "$env:LOCALAPPDATA\Temp\opencode\mysqld-lab.log"
)

$ErrorActionPreference = "Stop"
$mysqld = Join-Path $MysqlRoot "bin\mysqld.exe"
if (-not (Test-Path -LiteralPath $mysqld)) {
    throw "mysqld not found at $mysqld (用 -MysqlRoot 指定 MySQL 安装目录)"
}

# 1. 初始化数据目录 (仅第一次)
if (-not (Test-Path -LiteralPath (Join-Path $DataDir "mysql"))) {
    Write-Host "Initializing MySQL data dir (insecure root)..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
    & $mysqld --initialize-insecure --basedir="$MysqlRoot" --datadir="$DataDir" --console
    if ($LASTEXITCODE -ne 0) { throw "initialize failed" }
}

$mysqlCli = Join-Path $MysqlRoot "bin\mysql.exe"

# 2. 已运行则直接返回
if ((Test-NetConnection -ComputerName 127.0.0.1 -Port $Port -WarningAction SilentlyContinue).TcpTestSucceeded) {
    & $mysqlCli -u root -h 127.0.0.1 -P $Port -e "CREATE DATABASE IF NOT EXISTS novachat_lab;" 2>$null
    Write-Host "MySQL already running on 127.0.0.1:$Port" -ForegroundColor Green
    return
}

# 3. 分离启动
$cmd = "`"$mysqld`" --basedir=`"$MysqlRoot`" --datadir=`"$DataDir`" --port=$Port --log-error=`"$LogFile`""
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
if ($r.ReturnValue -ne 0) { throw "failed to start mysqld (code $($r.ReturnValue))" }
Write-Host "mysqld started (PID $($r.ProcessId)), waiting for port $Port ..." -ForegroundColor Cyan

# 4. 等待就绪
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    if ((Test-NetConnection -ComputerName 127.0.0.1 -Port $Port -WarningAction SilentlyContinue).TcpTestSucceeded) {
        & $mysqlCli -u root -h 127.0.0.1 -P $Port -e "CREATE DATABASE IF NOT EXISTS novachat_lab;" 2>$null
        Write-Host "MySQL is ready on 127.0.0.1:$Port (user=root, no password)" -ForegroundColor Green
        return
    }
}
throw "MySQL did not become ready; see $LogFile"
