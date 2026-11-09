# agent_search_gateway 自更新入口（Windows）
#
# 职责：仅负责准备 Node.js（缺失或版本过低时自动下载官方 LTS），
# 然后把参数原样交给 scripts\self-update\cli.mjs。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\self-update\windows.ps1 [选项]
# 选项见：... windows.ps1 --help
#
# 兼容 Windows PowerShell 5.1。

param(
    [Alias('h')]
    [switch]$Help,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# 让中文提示在控制台正常显示
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch {
    # 输出被重定向时可能失败，忽略
}

# Windows PowerShell 5.1 默认可能未启用 TLS 1.2
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
    # 老系统不支持时忽略，后续下载会给出明确错误
}

$MinNodeVersion = [version]'20.18.1'
$FallbackNodeVersion = '22.11.0'

$ScriptDir = $PSScriptRoot
$RootDir = Split-Path -Parent (Split-Path -Parent $ScriptDir)
$CliPath = Join-Path $ScriptDir 'cli.mjs'
$ToolchainRoot = Join-Path $RootDir 'data\toolchain\node'

function Write-Info([string]$Message) {
    Write-Host "[self-update] $Message"
}

function Write-Warn([string]$Message) {
    Write-Host "[self-update] 警告: $Message" -ForegroundColor Yellow
}

# 仅允许 https 下载
function Download-File([string]$Url, [string]$Dest) {
    if ($Url -notmatch '^https://') {
        throw "安全限制：只允许 https 下载，收到 $Url"
    }
    $dir = Split-Path -Parent $Dest
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    Write-Info "下载 $Url"
    Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing
}

function Get-NodeVersion([string]$Exe) {
    try {
        $raw = & $Exe -v 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
        $text = ([string]$raw).Trim()
        if ($text.StartsWith('v')) { $text = $text.Substring(1) }
        return [version]$text
    } catch {
        return $null
    }
}

function Test-NodeOk([string]$Exe) {
    $version = Get-NodeVersion $Exe
    if (-not $version) { return $false }
    return ($version -ge $MinNodeVersion)
}

function Find-CachedNode {
    if (-not (Test-Path -LiteralPath $ToolchainRoot)) { return $null }
    $dirs = Get-ChildItem -LiteralPath $ToolchainRoot -Directory -Filter 'node-v*-win-x64' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending
    foreach ($item in $dirs) {
        $candidate = Join-Path $item.FullName 'node.exe'
        if ((Test-Path -LiteralPath $candidate) -and (Test-NodeOk $candidate)) {
            return $candidate
        }
    }
    return $null
}

try {
    if (-not (Test-Path -LiteralPath $CliPath)) {
        throw "找不到 $CliPath"
    }

    $NodeExe = $null

    # 优先使用 PATH 中足够新的 Node.js
    $command = Get-Command node -ErrorAction SilentlyContinue
    if ($command -and $command.Source -and (Test-NodeOk $command.Source)) {
        $NodeExe = $command.Source
    }

    # 其次使用此前下载到 data/toolchain/node 的版本
    if (-not $NodeExe) {
        $NodeExe = Find-CachedNode
    }

    # 最后下载官方 Node.js LTS
    if (-not $NodeExe) {
        $platform = 'win-x64'  # 与发布资产的 win32-x64 对应，统一使用 x64 版 Node.js

        if (-not (Test-Path -LiteralPath $ToolchainRoot)) {
            New-Item -ItemType Directory -Path $ToolchainRoot -Force | Out-Null
        }

        $indexPath = Join-Path $ToolchainRoot 'index.json'
        Download-File 'https://nodejs.org/dist/index.json' $indexPath
        $index = Get-Content -LiteralPath $indexPath -Raw | ConvertFrom-Json
        $lts = $index | Where-Object { $_.lts } | Select-Object -First 1
        if ($lts -and $lts.version) {
            $nodeVersion = ([string]$lts.version).TrimStart('v')
        } else {
            $nodeVersion = $FallbackNodeVersion
        }

        $targetDir = Join-Path $ToolchainRoot "node-v$nodeVersion-$platform"
        $targetNode = Join-Path $targetDir 'node.exe'

        if (-not (Test-Path -LiteralPath $targetNode)) {
            Write-Info "未检测到可用的 Node.js（需要 >= $MinNodeVersion），准备下载 Node.js v$nodeVersion ($platform) ..."
            $tmp = Join-Path $ToolchainRoot ('.tmp-' + [Guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $tmp -Force | Out-Null

            try {
                $archiveName = "node-v$nodeVersion-$platform.zip"
                $zipPath = Join-Path $tmp $archiveName
                $shasumsPath = Join-Path $tmp 'SHASUMS256.txt'

                Download-File "https://nodejs.org/dist/v$nodeVersion/$archiveName" $zipPath
                Download-File "https://nodejs.org/dist/v$nodeVersion/SHASUMS256.txt" $shasumsPath

                $line = Get-Content -LiteralPath $shasumsPath |
                    Where-Object { $_ -match ('\s' + [regex]::Escape($archiveName) + '$') } |
                    Select-Object -First 1
                if (-not $line) {
                    throw "Node.js 校验文件中没有 $archiveName 的记录"
                }
                $expected = ($line -split '\s+')[0].ToLower()
                $actual = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLower()
                if ($actual -ne $expected) {
                    throw "Node.js 安装包 SHA256 校验失败（期望 $expected，实际 $actual）"
                }

                $extractDir = Join-Path $tmp 'extract'
                New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
                Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force

                $inner = Join-Path $extractDir "node-v$nodeVersion-$platform"
                if (-not (Test-Path -LiteralPath (Join-Path $inner 'node.exe'))) {
                    throw 'Node.js 压缩包结构异常'
                }

                if (Test-Path -LiteralPath $targetDir) {
                    Remove-Item -LiteralPath $targetDir -Recurse -Force
                }
                Move-Item -LiteralPath $inner -Destination $targetDir
            } finally {
                if (Test-Path -LiteralPath $tmp) {
                    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
                }
            }
        }

        if (-not (Test-Path -LiteralPath $targetNode)) {
            throw 'Node.js 安装失败：node.exe 不存在'
        }
        $NodeExe = $targetNode
        Write-Info "已准备 Node.js v$nodeVersion ($platform)"
    }

    # 建立稳定入口 data\toolchain\node\node.exe，供 scripts\gateway.ps1 使用
    if ($NodeExe -and $NodeExe.ToLower().StartsWith($ToolchainRoot.ToLower())) {
        $stableNode = Join-Path $ToolchainRoot 'node.exe'
        if ($NodeExe -ne $stableNode) {
            $sourceMarker = Join-Path $ToolchainRoot '.node-source'
            $previousSource = ''
            if (Test-Path -LiteralPath $sourceMarker) {
                $previousSource = (Get-Content -LiteralPath $sourceMarker -Raw).Trim()
            }
            if (-not (Test-Path -LiteralPath $stableNode) -or $previousSource -ne $NodeExe) {
                Copy-Item -LiteralPath $NodeExe -Destination $stableNode -Force
                Set-Content -Path $sourceMarker -Value $NodeExe -Encoding ASCII
            }
        }
    }

    if ($null -eq $Rest) { $Rest = @() }
    if ($Help) { $Rest += '--help' }

    # 参数原样转发给共享 CLI
    & $NodeExe $CliPath @Rest
    exit $LASTEXITCODE
} catch {
    Write-Host "[self-update] 错误: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
