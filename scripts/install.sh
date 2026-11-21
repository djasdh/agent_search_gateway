#!/usr/bin/env bash
# agent_search_gateway 一键安装器（Linux / macOS）
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/djasdh/agent_search_gateway/master/scripts/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --dir ~/agent_search_gateway
#
# 引导脚本负责：准备 Node、下载 Release 完整包、校验、解压，然后运行包内
# scripts/install/cli.mjs 做配置/依赖/浏览器/自启，全部成功后才切换 current。
set -euo pipefail

REPO_DEFAULT="djasdh/agent_search_gateway"
ROOT_DEFAULT="$HOME/agent_search_gateway"
MIN_NODE_MAJOR=20
REPO="$REPO_DEFAULT"
ROOT="$ROOT_DEFAULT"
VERSION=""
PASSTHRU=()

log() { printf '[install] %s\n' "$*" >&2; }
die() { printf '[install] 错误: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法: install.sh [引导选项] [cli 选项]

引导选项:
  --dir <目录>        安装目录（默认 ~/agent_search_gateway）
  --repo <owner/name> 发布仓库（默认 djasdh/agent_search_gateway）
  --version <v>       指定版本（默认最新正式版）
  -h, --help          显示帮助

其余选项原样传给 scripts/install/cli.mjs（--no-browser、--no-service、--no-start 等）。
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)
      [ $# -ge 2 ] || die "--dir 需要一个目录"
      ROOT="$2"; shift 2 ;;
    --repo)
      [ $# -ge 2 ] || die "--repo 需要 owner/name"
      REPO="$2"; shift 2 ;;
    --version)
      [ $# -ge 2 ] || die "--version 需要一个版本号"
      VERSION="$2"; shift 2 ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      PASSTHRU+=("$1"); shift ;;
  esac
done

# ---------- 规范化安装根目录 ----------
# current.json 里必须写绝对路径；先建目录再 cd + pwd -P，避免 --dir 为相对路径
# 或软链接时状态文件依赖调用者的 cwd。
if ! mkdir -p "$ROOT" 2>/dev/null; then
  die "无法创建安装目录: $ROOT"
fi
ROOT_ABS="$(cd "$ROOT" 2>/dev/null && pwd -P)" || die "无法解析安装目录: $ROOT"
ROOT="$ROOT_ABS"

case "$(uname -s 2>/dev/null || echo unknown)" in
  Linux) OS="linux" ;;
  Darwin) OS="darwin" ;;
  *) die "不支持的操作系统: $(uname -s 2>/dev/null || echo unknown)" ;;
esac
case "$(uname -m 2>/dev/null || echo unknown)" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) die "不支持的架构: $(uname -m 2>/dev/null || echo unknown)" ;;
esac
PLATFORM="$OS-$ARCH"
case "$PLATFORM" in
  linux-x64|linux-arm64|darwin-x64|darwin-arm64) ;;
  *) die "不支持的平台: $PLATFORM" ;;
esac
log "平台: $PLATFORM"

# ---------- 下载工具 ----------
download() {
  local url="$1" dest="$2"
  case "$url" in https://*) ;; *) die "只允许 https 下载: $url" ;; esac
  mkdir -p "$(dirname "$dest")"
  if command -v curl >/dev/null 2>&1; then
    if curl -fsSL --retry 2 --connect-timeout 20 -o "$dest" "$url"; then
      return 0
    fi
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -q --https-only -O "$dest" "$url"
    return 0
  fi
  die "下载失败: $url"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "需要 sha256sum 或 shasum"
  fi
}

node_major() {
  "$1" -v 2>/dev/null | sed 's/^v//' | cut -d. -f1
}

# ---------- 准备 Node ----------
NODE_BIN=""
TOOLCHAIN="$ROOT/data/toolchain/node"
if [ -x "$TOOLCHAIN/bin/node" ] && [ "$(node_major "$TOOLCHAIN/bin/node")" -ge "$MIN_NODE_MAJOR" ]; then
  NODE_BIN="$TOOLCHAIN/bin/node"
elif command -v node >/dev/null 2>&1 && [ "$(node_major "$(command -v node)")" -ge "$MIN_NODE_MAJOR" ]; then
  NODE_BIN="$(command -v node)"
fi

if [ -z "$NODE_BIN" ]; then
  log "未找到 Node.js >= ${MIN_NODE_MAJOR}，下载官方 LTS ..."
  TMP_NODE="$(mktemp -d)"
  trap 'rm -rf "$TMP_NODE"' EXIT
  SUMS_URL="https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt"
  download "$SUMS_URL" "$TMP_NODE/SHASUMS256.txt"
  NODE_FILE="$(grep -o "node-v[0-9.]*-${PLATFORM}\.tar\.gz" "$TMP_NODE/SHASUMS256.txt" | head -1 || true)"
  [ -n "$NODE_FILE" ] || die "无法确定 Node.js 包名（${PLATFORM}）"
  NODE_URL="https://nodejs.org/dist/latest-v22.x/$NODE_FILE"
  download "$NODE_URL" "$TMP_NODE/$NODE_FILE"
  EXPECTED="$(grep " $NODE_FILE$" "$TMP_NODE/SHASUMS256.txt" | awk '{print $1}' | head -1)"
  ACTUAL="$(sha256_of "$TMP_NODE/$NODE_FILE")"
  [ "$EXPECTED" = "$ACTUAL" ] || die "Node.js 包 SHA256 校验失败"
  mkdir -p "$ROOT/data/toolchain"
  rm -rf "$TOOLCHAIN"
  mkdir -p "$TOOLCHAIN"
  tar -xzf "$TMP_NODE/$NODE_FILE" -C "$TOOLCHAIN" --strip-components=1
  NODE_BIN="$TOOLCHAIN/bin/node"
  log "Node.js 已安装: $("$NODE_BIN" -v)"
fi

# ---------- 读取 runtime.json ----------
if [ -n "$VERSION" ]; then
  TAG="v${VERSION#v}"
  RUNTIME_URL="https://github.com/$REPO/releases/download/$TAG/runtime.json"
else
  TAG="latest"
  RUNTIME_URL="https://github.com/$REPO/releases/latest/download/runtime.json"
fi
mkdir -p "$ROOT/data"
RUNTIME_FILE="$ROOT/data/.runtime-$$.json"
download "$RUNTIME_URL" "$RUNTIME_FILE"
trap 'rm -f "$RUNTIME_FILE"; [ -n "${TMP_NODE:-}" ] && rm -rf "$TMP_NODE"' EXIT

read -r RUNTIME_VERSION ASSET_NAME ASSET_SHA <<EOF
$("$NODE_BIN" -e '
const fs = require("node:fs");
const p = process.argv[1];
const data = JSON.parse(fs.readFileSync(p, "utf8"));
const platform = process.argv[2];
const asset = data.assets && data.assets[platform];
if (!asset) { console.error("runtime.json 中没有 " + platform + " 资产"); process.exit(1); }
console.log([data.version, asset.name, asset.sha256].join(" "));
' "$RUNTIME_FILE" "$PLATFORM")
EOF
[ -n "$RUNTIME_VERSION" ] && [ -n "$ASSET_NAME" ] || die "runtime.json 解析失败"

if [ "$TAG" = "latest" ]; then
  TAG="v${RUNTIME_VERSION#v}"
fi
ASSET_URL="https://github.com/$REPO/releases/download/$TAG/$ASSET_NAME"
log "安装版本: ${RUNTIME_VERSION}（${PLATFORM}）"

# 下载安装包：能复用缓存就复用，能续传就续传，校验失败再整包重下一次。
# 弱网/代理环境下反复重跑不会每次都从 0 开始。
download_asset() {
  local url="$1" dest="$2" expected="$3"
  if [ -z "$expected" ]; then
    log "下载 $(basename "$dest") ..."
    download "$url" "$dest"
    return 0
  fi

  if [ -f "$dest" ] && [ "$(sha256_of "$dest")" = "$expected" ]; then
    log "复用已缓存安装包: $(basename "$dest")"
    return 0
  fi

  if [ -f "$dest" ]; then
    log "发现未完成的下载，尝试续传: $(basename "$dest")"
    if command -v curl >/dev/null 2>&1 &&
       curl -fsSL -C - --retry 2 --connect-timeout 20 -o "$dest" "$url" &&
       [ "$(sha256_of "$dest")" = "$expected" ]; then
      return 0
    fi
  fi

  log "下载 $(basename "$dest") ..."
  rm -f "$dest"
  download "$url" "$dest"
}

# ---------- 下载并解压完整包 ----------
RELEASES="$ROOT/data/releases"
TARGET="$RELEASES/${RUNTIME_VERSION}-${PLATFORM}"
mkdir -p "$RELEASES" "$ROOT/data/download-cache"
ARCHIVE="$ROOT/data/download-cache/$ASSET_NAME"
download_asset "$ASSET_URL" "$ARCHIVE" "$ASSET_SHA"
ACTUAL_SHA="$(sha256_of "$ARCHIVE")"
[ -z "$ASSET_SHA" ] || [ "$ASSET_SHA" = "$ACTUAL_SHA" ] || die "安装包 SHA256 校验失败"
log "SHA256 校验通过"

TMP_EXTRACT="$(mktemp -d)"
trap 'rm -rf "$TMP_EXTRACT"; rm -f "$RUNTIME_FILE"; [ -n "${TMP_NODE:-}" ] && rm -rf "$TMP_NODE"' EXIT
tar -xzf "$ARCHIVE" -C "$TMP_EXTRACT"
VERSION_FILE="$(find "$TMP_EXTRACT" -maxdepth 2 -name version.json -type f | head -1)"
PKG_ROOT=""
if [ -n "$VERSION_FILE" ]; then
  PKG_ROOT="$(dirname "$VERSION_FILE")"
else
  DIST_DIR="$(find "$TMP_EXTRACT" -maxdepth 2 -name dist -type d | head -1)"
  [ -n "$DIST_DIR" ] && PKG_ROOT="$(dirname "$DIST_DIR")"
fi
[ -n "$PKG_ROOT" ] || die "安装包结构不符合约定（未找到 dist/ 或 version.json）"
rm -rf "$TARGET"
mv "$PKG_ROOT" "$TARGET"

# ---------- 交给 cli.mjs ----------
# 先配置、后切换：cli 在配置/deps/launch 成功后才切换 data/current；
# cli 失败时旧 current / current.json 保持不变。
log "运行安装配置 ..."
if [ ${#PASSTHRU[@]} -gt 0 ]; then
  ASG_REPO="$REPO" "$NODE_BIN" "$TARGET/scripts/install/cli.mjs" \
    --install-root "$ROOT" --switch-current "${PASSTHRU[@]}"
else
  ASG_REPO="$REPO" "$NODE_BIN" "$TARGET/scripts/install/cli.mjs" \
    --install-root "$ROOT" --switch-current
fi

# ---------- 稳定入口 ----------
mkdir -p "$ROOT/bin"
if [ -f "$TARGET/bin/asg.mjs" ]; then
  cp "$TARGET/bin/asg.mjs" "$ROOT/bin/asg.mjs"
  chmod +x "$ROOT/bin/asg.mjs" 2>/dev/null || true
fi
