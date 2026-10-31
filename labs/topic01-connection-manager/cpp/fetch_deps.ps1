# 下载 C++ lab 依赖的单头文件库到 third_party/
#   - httplib.h : cpp-httplib (HTTP/WebSocket 服务端, 单头文件)
#   - json.hpp  : nlohmann/json (单头文件)
#
# 用法: powershell -ExecutionPolicy Bypass -File fetch_deps.ps1

$ErrorActionPreference = "Stop"
$dest = Join-Path $PSScriptRoot "third_party"
New-Item -ItemType Directory -Path $dest -Force | Out-Null

$targets = @(
    @{ Url = "https://raw.githubusercontent.com/yhirose/cpp-httplib/master/httplib.h"; Out = "httplib.h" },
    @{ Url = "https://raw.githubusercontent.com/nlohmann/json/develop/single_include/nlohmann/json.hpp"; Out = "json.hpp" }
)

foreach ($t in $targets) {
    $path = Join-Path $dest $t.Out
    Write-Host "Downloading $($t.Out) ..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $t.Url -OutFile $path -UseBasicParsing
    Write-Host "  -> $path ($((Get-Item $path).Length) bytes)" -ForegroundColor Green
}

Write-Host "Dependencies ready." -ForegroundColor Green
