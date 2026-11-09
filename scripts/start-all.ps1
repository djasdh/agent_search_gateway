# agent_search_gateway 前台 supervisor 的 Windows 薄包装
# 由登录计划任务调用，也可手动运行：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-all.ps1
# 参数会原样传给 start-all.mjs，例如 --check / --help。
$ErrorActionPreference = "Stop"

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$Root = Split-Path -Parent $PSScriptRoot
$StartAll = Join-Path $Root "scripts\start-all.mjs"

function Find-NodeJs {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) {
        if ($cmd.Path) { return $cmd.Path }
        if ($cmd.Source) { return $cmd.Source }
    }
    $toolDir = Join-Path $Root "data\toolchain\node"
    if (Test-Path $toolDir) {
        $exe = Get-ChildItem -Path $toolDir -Filter node.exe -Recurse -File -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($exe) { return $exe.FullName }
    }
    return $null
}

if (-not (Test-Path $StartAll)) {
    Write-Host "[start-all] 未找到 $StartAll"
    exit 1
}

$Node = Find-NodeJs
if (-not $Node) {
    Write-Host "[start-all] PATH 中未找到 node，请先安装 Node.js LTS：https://nodejs.org/zh-cn/download"
    exit 1
}

& $Node $StartAll @args
exit $LASTEXITCODE
