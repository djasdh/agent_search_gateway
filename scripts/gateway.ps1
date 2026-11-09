# agent_search_gateway Windows 管理脚本（PowerShell 5.1 兼容）
# 用法: gateway.ps1 {start|stop|restart|status|logs}
# 只管理 gateway 本体；searxng / flaresolverr 建议用 Docker 或 WSL 运行。

param(
  [string]$Command = "status"
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $Root "data\gateway.pid"
$OutLog = Join-Path $Root "gateway.out.log"
$ErrLog = Join-Path $Root "gateway.err.log"

function Get-GatewayPort {
  $yaml = Join-Path $Root "gateway.yaml"
  if (Test-Path $yaml) {
    $m = Select-String -Path $yaml -Pattern '^\s{2}port:\s*(\d+)' | Select-Object -First 1
    if ($m) { return [int]$m.Matches[0].Groups[1].Value }
  }
  return 3000
}

# 查找 node：优先自更新下载的便携 Node，其次系统 PATH。
function Get-NodePath {
  $local = Join-Path $Root "data\toolchain\node\node.exe"
  if (Test-Path $local) { return $local }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

# 当前 release 入口：data\current 目录优先，其次 data\current.json。
function Get-CurrentEntry {
  $link = Join-Path $Root "data\current\dist\index.js"
  if (Test-Path $link) { return $link }
  $json = Join-Path $Root "data\current.json"
  if (Test-Path $json) {
    try {
      $d = Get-Content $json -Raw | ConvertFrom-Json
      if ($d.dir) {
        $p = Join-Path $d.dir "dist\index.js"
        if (Test-Path $p) { return $p }
      }
    } catch {
      # 损坏的 current.json 当作没有 release
    }
  }
  return $null
}

function Test-GatewayHealth([int]$Port) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 2
    return ($r.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Start-Gateway {
  $port = Get-GatewayPort
  if (Test-GatewayHealth $port) {
    Write-Host "gateway 已在运行 (:$port)"
    return
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $Root "data") | Out-Null
  $entry = Get-CurrentEntry
  $node = Get-NodePath
  if (-not $entry -or -not $node) {
    Write-Host "未找到可运行的 release 或 node；请先跑 scripts\self-update\windows.cmd 或安装 Node 22+"
    exit 1
  }
  $p = Start-Process -FilePath $node `
    -ArgumentList @("`"$entry`"") `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $OutLog `
    -RedirectStandardError $ErrLog `
    -PassThru
  $p.Id | Set-Content -Path $PidFile -Encoding ASCII
  Write-Host "gateway 已启动（release: $entry，PID $($p.Id)），日志: $OutLog"
  Start-Sleep -Seconds 4
}

function Stop-Gateway {
  $stopped = $false
  if (Test-Path $PidFile) {
    $procId = 0
    $text = (Get-Content $PidFile -Raw).Trim()
    if ([int]::TryParse($text, [ref]$procId)) {
      $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
      if ($p) {
        Stop-Process -Id $procId -Force
        $stopped = $true
      }
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  }
  # 兜底：按命令行匹配网关进程
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'dist[\\/]index\.js|src[\\/]index\.ts' } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      $stopped = $true
    }
  Get-Process chrome-headless-shell -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
  if ($stopped) { Write-Host "gateway 已停止" } else { Write-Host "gateway 未在运行" }
}

function Show-Status {
  $port = Get-GatewayPort
  $code = "down"
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -UseBasicParsing -TimeoutSec 2
    $code = [string]$r.StatusCode
  } catch {
    $code = "down"
  }
  Write-Host "组件状态:"
  Write-Host ("  {0,-14} {1}" -f "gateway:$port", $code)
}

function Show-Logs {
  if (-not (Test-Path $OutLog)) {
    Write-Host "暂无日志: $OutLog"
    return
  }
  Get-Content $OutLog -Wait -Tail 50
}

switch ($Command.ToLower()) {
  "start" { Start-Gateway }
  "stop" { Stop-Gateway }
  "restart" { Stop-Gateway; Start-Sleep -Seconds 1; Start-Gateway }
  "status" { Show-Status }
  "logs" { Show-Logs }
  default {
    Write-Host "用法: gateway.ps1 {start|stop|restart|status|logs}"
    exit 1
  }
}
