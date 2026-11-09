# agent_search_gateway 一键安装器（Windows，PowerShell 5.1+）
#
# 用法：
#   irm https://raw.githubusercontent.com/djasdh/agent_search_gateway/master/scripts/install.ps1 | iex
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Dir C:\Users\me\agent_search_gateway
#
# 引导脚本只负责：准备 Node、下载 Release 完整包、校验、解压、切换 current；
# 配置/依赖/浏览器/自启交给包内的 scripts/install/cli.mjs。

param(
  [string]$Dir = "$env:USERPROFILE\agent_search_gateway",
  [string]$Repo = "djasdh/agent_search_gateway",
  [string]$Version = "",
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)

$ErrorActionPreference = "Stop"
$MinNodeMajor = 20
$Platform = "win32-x64"

function Write-Log([string]$Message) {
  Write-Host "[install] $Message"
}

function Fail([string]$Message) {
  Write-Host "[install] 错误: $Message" -ForegroundColor Red
  exit 1
}

function Download-File([string]$Url, [string]$Dest) {
  if ($Url -notmatch '^https://') { throw "只允许 https 下载: $Url" }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Dest) | Out-Null
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    $proxy = $env:HTTPS_PROXY
    if (-not $proxy) { $proxy = $env:HTTP_PROXY }
    $curlArgs = @('-fsSL', '--retry', '2', '--connect-timeout', '20', '-o', $Dest, $Url)
    if ($proxy) {
      $curlArgs = @('-fsSL', '--retry', '2', '--connect-timeout', '20', '--proxy', $proxy, '-o', $Dest, $Url)
    }
    & $curl.Source @curlArgs
    if ($LASTEXITCODE -eq 0) { return }
  }
  Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing
}

function Get-Sha256([string]$File) {
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $File).Hash.ToLower()
}

function Get-NodeMajor([string]$Node) {
  $raw = & $Node -v 2>$null
  if ($LASTEXITCODE -ne 0) { return 0 }
  return [int](($raw -replace '^v', '') -split '\.')[0]
}

$Root = [System.IO.Path]::GetFullPath($Dir)
$Toolchain = Join-Path $Root "data\toolchain\node"
$NodeBin = $null

if ((Test-Path (Join-Path $Toolchain "node.exe")) -and (Get-NodeMajor (Join-Path $Toolchain "node.exe")) -ge $MinNodeMajor) {
  $NodeBin = Join-Path $Toolchain "node.exe"
} else {
  $cmdNode = Get-Command node -ErrorAction SilentlyContinue
  if ($cmdNode -and (Get-NodeMajor $cmdNode.Source) -ge $MinNodeMajor) {
    $NodeBin = $cmdNode.Source
  }
}

if (-not $NodeBin) {
  Write-Log "未找到 Node.js >= $MinNodeMajor，下载官方 LTS ..."
  $tmpNode = Join-Path $env:TEMP ("asg-node-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $tmpNode | Out-Null
  try {
    $sumsUrl = "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt"
    $sumsFile = Join-Path $tmpNode "SHASUMS256.txt"
    Download-File $sumsUrl $sumsFile
    $line = Select-String -LiteralPath $sumsFile -Pattern 'node-v[\d.]+-win-x64\.zip' | Select-Object -First 1
    if (-not $line) { throw "无法确定 Node.js 包名" }
    $nodeFile = ($line.Line -split '\s+')[-1]
    $expected = ($line.Line -split '\s+')[0].ToLower()
    $nodeZip = Join-Path $tmpNode $nodeFile
    Download-File "https://nodejs.org/dist/latest-v22.x/$nodeFile" $nodeZip
    if ((Get-Sha256 $nodeZip) -ne $expected) { throw "Node.js 包 SHA256 校验失败" }
    $extract = Join-Path $tmpNode "extract"
    Expand-Archive -LiteralPath $nodeZip -DestinationPath $extract -Force
    $inner = Get-ChildItem -LiteralPath $extract -Directory | Select-Object -First 1
    if (-not $inner) { throw "Node.js 压缩包结构异常" }
    if (Test-Path $Toolchain) { Remove-Item -LiteralPath $Toolchain -Recurse -Force }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Toolchain) | Out-Null
    Move-Item -LiteralPath $inner.FullName -Destination $Toolchain
    $NodeBin = Join-Path $Toolchain "node.exe"
    Write-Log "Node.js 已安装: $(& $NodeBin -v)"
  } finally {
    Remove-Item -LiteralPath $tmpNode -Recurse -Force -ErrorAction SilentlyContinue
  }
}

if ($Version) {
  $tag = "v" + ($Version -replace '^v', '')
  $runtimeUrl = "https://github.com/$Repo/releases/download/$tag/runtime.json"
} else {
  $tag = "latest"
  $runtimeUrl = "https://github.com/$Repo/releases/latest/download/runtime.json"
}

New-Item -ItemType Directory -Force -Path (Join-Path $Root "data") | Out-Null
$runtimeFile = Join-Path $Root ("data\.runtime-" + [guid]::NewGuid().ToString("N") + ".json")
try {
  Download-File $runtimeUrl $runtimeFile
  $runtime = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
  $asset = $runtime.assets.$Platform
  if (-not $asset) { Fail "runtime.json 中没有 $Platform 资产" }
  $runtimeVersion = [string]$runtime.version
  $assetName = [string]$asset.name
  $assetSha = ([string]$asset.sha256).ToLower()
  if (-not $runtimeVersion -or -not $assetName) { Fail "runtime.json 解析失败" }
  if ($tag -eq "latest") { $tag = "v" + ($runtimeVersion -replace '^v', '') }
} finally {
  Remove-Item -LiteralPath $runtimeFile -Force -ErrorAction SilentlyContinue
}

Write-Log "安装版本: $runtimeVersion（$Platform）"
$releases = Join-Path $Root "data\releases"
$target = Join-Path $releases "$runtimeVersion-$Platform"
$cache = Join-Path $Root "data\download-cache"
New-Item -ItemType Directory -Force -Path $releases, $cache | Out-Null
$archive = Join-Path $cache $assetName
Write-Log "下载 $assetName ..."
Download-File "https://github.com/$Repo/releases/download/$tag/$assetName" $archive
$actualSha = Get-Sha256 $archive
if ($assetSha -and $assetSha -ne $actualSha) { Fail "安装包 SHA256 校验失败" }
Write-Log "SHA256 校验通过"

$tmpExtract = Join-Path $env:TEMP ("asg-extract-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tmpExtract | Out-Null
try {
  Expand-Archive -LiteralPath $archive -DestinationPath $tmpExtract -Force
  $pkg = Get-ChildItem -LiteralPath $tmpExtract -Directory |
    Where-Object { (Test-Path (Join-Path $_.FullName "dist")) -or (Test-Path (Join-Path $_.FullName "version.json")) } |
    Select-Object -First 1
  if (-not $pkg) { $pkg = Get-ChildItem -LiteralPath $tmpExtract -Directory | Select-Object -First 1 }
  if (-not $pkg) { Fail "安装包结构不符合约定" }
  if (Test-Path $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  Move-Item -LiteralPath $pkg.FullName -Destination $target
} finally {
  Remove-Item -LiteralPath $tmpExtract -Recurse -Force -ErrorAction SilentlyContinue
}

# 切换 current（Windows 只用 current.json，不依赖符号链接）
$currentJson = @{
  dir = $target
  version = $runtimeVersion
  previousDir = $null
  previousVersion = $null
  updatedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
} | ConvertTo-Json
Set-Content -LiteralPath (Join-Path $Root "data\current.json") -Value $currentJson -Encoding UTF8

# 稳定 scripts
$scriptsDir = Join-Path $Root "scripts"
New-Item -ItemType Directory -Force -Path $scriptsDir | Out-Null
foreach ($name in @("start-all.mjs", "start-all.ps1", "gateway.sh", "gateway.ps1")) {
  $source = Join-Path $target "scripts\$name"
  $dest = Join-Path $scriptsDir $name
  if ((Test-Path $source) -and -not (Test-Path $dest)) {
    Copy-Item -LiteralPath $source -Destination $dest
  }
}

Write-Log "运行安装配置 ..."
$cli = Join-Path $target "scripts\install\cli.mjs"
if ($Rest -and $Rest.Count -gt 0) {
  & $NodeBin $cli --install-root $Root @Rest
} else {
  & $NodeBin $cli --install-root $Root
}
exit $LASTEXITCODE
