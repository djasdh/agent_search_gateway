#!/usr/bin/env bash
# agent_search_gateway 自更新入口（Linux）
#
# 职责：仅负责准备 Node.js（缺失或版本过低时自动下载官方 LTS），
# 然后把参数原样交给 scripts/self-update/cli.mjs。
#
# 用法：bash scripts/self-update/linux.sh [选项]
# 选项见：bash scripts/self-update/linux.sh --help
#
# 兼容 macOS 自带的 bash 3.2（不使用 sort -V、关联数组等特性）。

set -euo pipefail

MIN_NODE_VERSION="20.18.1"
FALLBACK_NODE_VERSION="22.11.0"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." >/dev/null 2>&1 && pwd)"
CLI_PATH="$SCRIPT_DIR/cli.mjs"
TOOLCHAIN_ROOT="$ROOT_DIR/data/toolchain/node"

log() { printf '[self-update] %s\n' "$*" >&2; }
die() { printf '[self-update] 错误: %s\n' "$*" >&2; exit 1; }

# 仅允许 https 的下载封装，优先 curl，其次 wget
download() {
  local url="$1"
  local dest="$2"
  case "$url" in
    https://*) ;;
    *) die "安全限制：只允许 https 下载，收到 $url" ;;
  esac
  mkdir -p "$(dirname "$dest")"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 2 --connect-timeout 15 -o "$dest" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$dest" "$url"
  else
    die "需要 curl 或 wget 才能下载 Node.js"
  fi
}

# 比较版本：$1 >= $2 时返回 0（兼容 bash 3.2，不依赖 sort -V）
version_ge() {
  local a="$1"
  local b="$2"
  local IFS='.'
  # shellcheck disable=SC2206
  local av=($a) bv=($b)
  local i ai bi
  i=0
  while [ "$i" -lt 3 ]; do
    ai="${av[$i]:-0}"
    bi="${bv[$i]:-0}"
    # 去掉预发布后缀（如 22.0.0-nightly 的 -nightly）
    ai="${ai%%[!0-9]*}"
    bi="${bi%%[!0-9]*}"
    ai="${ai:-0}"
    bi="${bi:-0}"
    # 10# 前缀避免 08 被当作八进制
    if [ "$((10#$ai))" -gt "$((10#$bi))" ]; then
      return 0
    fi
    if [ "$((10#$ai))" -lt "$((10#$bi))" ]; then
      return 1
    fi
    i=$((i + 1))
  done
  return 0
}

# 输出 linux-x64 / linux-arm64 / darwin-x64 / darwin-arm64
detect_platform() {
  local os arch
  case "$(uname -s 2>/dev/null || echo unknown)" in
    Linux) os="linux" ;;
    Darwin) os="darwin" ;;
    *) die "不支持的操作系统: $(uname -s 2>/dev/null || echo unknown)" ;;
  esac
  case "$(uname -m 2>/dev/null || echo unknown)" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) die "不支持的 CPU 架构: $(uname -m 2>/dev/null || echo unknown)" ;;
  esac
  printf '%s-%s\n' "$os" "$arch"
}

# 计算文件 SHA256，兼容 Linux 与 macOS
sha256_of() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$file" | awk '{print $NF}'
  else
    die "找不到可用的 SHA256 工具（sha256sum / shasum / openssl）"
  fi
}

node_is_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local version
  version="$(node -v 2>/dev/null || true)"
  version="${version#v}"
  [ -n "$version" ] || return 1
  version_ge "$version" "$MIN_NODE_VERSION"
}

find_cached_node() {
  local platform="$1"
  local candidate cached_version
  for candidate in "$TOOLCHAIN_ROOT"/node-v*-"$platform"/bin/node; do
    if [ ! -x "$candidate" ]; then
      continue
    fi
    cached_version="$("$candidate" -v 2>/dev/null || true)"
    cached_version="${cached_version#v}"
    if [ -n "$cached_version" ] && version_ge "$cached_version" "$MIN_NODE_VERSION"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

# 建立稳定入口 data/toolchain/node/bin/node，供 scripts/gateway.sh 使用
link_portable_node() {
  local node_bin="$1"
  local bindir="$TOOLCHAIN_ROOT/bin"
  mkdir -p "$bindir"
  ln -sfn "$(cd "$(dirname "$node_bin")" && pwd)/node" "$bindir/node"
}

# 从 nodejs.org/dist/index.json 取最新 LTS 版本号（无 jq 依赖）
resolve_lts_version() {
  local index="$TOOLCHAIN_ROOT/index.json"
  download "https://nodejs.org/dist/index.json" "$index" || return 1
  local version
  version="$(
    tr '{' '\n' < "$index" \
      | grep -E '"version"[[:space:]]*:[[:space:]]*"v[0-9]' \
      | grep -E '"lts"[[:space:]]*:[[:space:]]*"' \
      | head -n 1 \
      | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"v([^"]+)".*/\1/'
  )"
  [ -n "$version" ] || version="$FALLBACK_NODE_VERSION"
  printf '%s\n' "$version"
}

install_node() {
  local platform version dir tmp archive shasums expected actual
  platform="$(detect_platform)"
  mkdir -p "$TOOLCHAIN_ROOT"

  local cached
  if cached="$(find_cached_node "$platform")" && [ -n "$cached" ]; then
    link_portable_node "$cached"
    printf '%s\n' "$cached"
    return 0
  fi

  version="$(resolve_lts_version)" || die "无法获取 Node.js LTS 版本信息"
  dir="$TOOLCHAIN_ROOT/node-v$version-$platform"
  if [ -x "$dir/bin/node" ]; then
    link_portable_node "$dir/bin/node"
    printf '%s\n' "$dir/bin/node"
    return 0
  fi

  log "未检测到可用的 Node.js（需要 >= $MIN_NODE_VERSION），准备下载 Node.js v$version ($platform) ..."

  tmp="$TOOLCHAIN_ROOT/.tmp.$$"
  rm -rf "$tmp"
  mkdir -p "$tmp"
  # 展开为字面路径，避免函数返回后局部变量失效
  trap 'rm -rf "'"$tmp"'"' EXIT

  archive="$tmp/node.tar.gz"
  shasums="$tmp/SHASUMS256.txt"
  download "https://nodejs.org/dist/v$version/node-v$version-$platform.tar.gz" "$archive"
  download "https://nodejs.org/dist/v$version/SHASUMS256.txt" "$shasums"

  expected="$(grep " node-v$version-$platform.tar.gz\$" "$shasums" | awk '{print $1}' | head -n 1)"
  [ -n "$expected" ] || die "Node.js 校验文件中没有 node-v$version-$platform.tar.gz 的记录"
  actual="$(sha256_of "$archive")"
  if [ "$actual" != "$expected" ]; then
    die "Node.js 安装包 SHA256 校验失败（期望 $expected，实际 $actual）"
  fi

  tar -xzf "$archive" -C "$tmp"
  [ -d "$tmp/node-v$version-$platform" ] || die "Node.js 压缩包结构异常"

  rm -rf "$dir"
  mv "$tmp/node-v$version-$platform" "$dir"
  rm -rf "$tmp"
  trap - EXIT

  [ -x "$dir/bin/node" ] || die "Node.js 安装失败：$dir/bin/node 不存在"
  link_portable_node "$dir/bin/node"
  printf '%s\n' "$dir/bin/node"
}

[ -f "$CLI_PATH" ] || die "找不到 $CLI_PATH"

if node_is_ok; then
  NODE_BIN="node"
else
  NODE_BIN="$(install_node)" || die "准备 Node.js 失败"
fi

exec "$NODE_BIN" "$CLI_PATH" "$@"
