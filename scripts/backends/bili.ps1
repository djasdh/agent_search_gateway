# bili 后端薄包装：kukemc/bili-cli（PyPI 包 bili-agent，B 站详情/评论）
# 用法: .\bili.ps1 [install|update|status|uninstall]（默认 install）
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Cli = Join-Path $Root "scripts\backends\cli.mjs"
$ToolDir = Join-Path $Root "data\toolchain\node"

function Find-NodeJs {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) {
        if ($cmd.Path) { return $cmd.Path }
        if ($cmd.Source) { return $cmd.Source }
    }
    if (Test-Path $ToolDir) {
        $exe = Get-ChildItem -Path $ToolDir -Filter node.exe -Recurse -File -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($exe) { return $exe.FullName }
    }
    return $null
}

function Fail-NodeJs {
    param([string]$Message)
    Write-Host "[bili] $Message"
    Write-Host "[bili] 请手动安装 Node.js LTS：https://nodejs.org/zh-cn/download"
    exit 1
}

$Node = Find-NodeJs
if (-not $Node) {
    Write-Host "[bili] PATH 中未找到 node，正在下载官方 Node.js LTS 到 $ToolDir ..."
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $Index = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json" -UseBasicParsing -TimeoutSec 60
        $Lts = $Index | Where-Object { $_.lts } | Select-Object -First 1
        if (-not $Lts) { throw "无法从 nodejs.org 解析 Node.js LTS 版本" }

        $Version = $Lts.version
        $Arch = "x64"
        if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { $Arch = "arm64" }

        $FileName = "node-$Version-win-$Arch.zip"
        $Url = "https://nodejs.org/dist/$Version/$FileName"
        New-Item -ItemType Directory -Force -Path $ToolDir | Out-Null
        $Zip = Join-Path $ToolDir $FileName

        Write-Host "[bili] 下载 $FileName ..."
        Invoke-WebRequest -Uri $Url -OutFile $Zip -UseBasicParsing -TimeoutSec 600
        Expand-Archive -Path $Zip -DestinationPath $ToolDir -Force
        Remove-Item -Path $Zip -Force -ErrorAction SilentlyContinue

        $Node = Find-NodeJs
        if (-not $Node) { throw "解压后未找到 node.exe" }
    } catch {
        Fail-NodeJs "自动下载 Node.js 失败：$($_.Exception.Message)"
    }
}

& $Node $Cli "bili" @args
exit $LASTEXITCODE
