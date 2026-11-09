#!/usr/bin/env bash
# bili 后端薄包装：kukemc/bili-cli（PyPI 包 bili-agent，B 站详情/评论）
# 用法: ./bili.sh [install|update|status|uninstall]（默认 install）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI="$ROOT/scripts/backends/cli.mjs"
TOOLCHAIN="$ROOT/data/toolchain/node"

die() {
  echo "[bili] $*" >&2
  exit 1
}

# 下载到指定文件：优先 curl，其次 wget
download() {
  local url="$1" out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --connect-timeout 20 "$url" -o "$out"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --tries=3 --timeout=20 -O "$out" "$url"
  else
    die "未找到 curl 或 wget，无法下载 Node.js。请手动安装 Node.js LTS：https://nodejs.org/zh-cn/download"
  fi
}

# 查找可用的 node：优先 PATH，其次 data/toolchain/node 下已下载版本
find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  local candidate
  for candidate in "$TOOLCHAIN"/node-v*/bin/node; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(find_node || true)"

if [ -z "$NODE_BIN" ]; then
  echo "[bili] PATH 中未找到 node，正在下载官方 Node.js LTS 到 $TOOLCHAIN ..."

  case "$(uname -s)" in
    Linux) NODE_OS="linux" ;;
    Darwin) NODE_OS="darwin" ;;
    *) die "不支持的平台：$(uname -s)。请手动安装 Node.js LTS：https://nodejs.org/zh-cn/download" ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64) NODE_ARCH="x64" ;;
    aarch64|arm64) NODE_ARCH="arm64" ;;
    armv7l) NODE_ARCH="armv7l" ;;
    i386|i686) NODE_ARCH="x86" ;;
    *) die "不支持的 CPU 架构：$(uname -m)。请手动安装 Node.js LTS：https://nodejs.org/zh-cn/download" ;;
  esac

  INDEX_TMP="$(mktemp "${TMPDIR:-/tmp}/node-index.XXXXXX")"
  ARCHIVE_TMP="$(mktemp "${TMPDIR:-/tmp}/node-dist.XXXXXX")"
  cleanup() { rm -f "$INDEX_TMP" "$ARCHIVE_TMP"; }
  trap cleanup EXIT

  download "https://nodejs.org/dist/index.json" "$INDEX_TMP" \
    || die "下载 Node.js 版本列表失败。请检查网络，或手动安装 Node.js LTS：https://nodejs.org/zh-cn/download"

  NODE_VERSION="$(grep '"lts":"' "$INDEX_TMP" 2>/dev/null | head -n 1 | sed -E 's/.*"version":"(v[0-9]+\.[0-9]+\.[0-9]+)".*/\1/' || true)"
  if [ -z "$NODE_VERSION" ]; then
    die "无法从 nodejs.org 解析 Node.js LTS 版本。请手动安装 Node.js LTS：https://nodejs.org/zh-cn/download"
  fi

  NODE_DIR_NAME="node-$NODE_VERSION-$NODE_OS-$NODE_ARCH"
  echo "[bili] 下载 $NODE_DIR_NAME ..."
  download "https://nodejs.org/dist/$NODE_VERSION/$NODE_DIR_NAME.tar.gz" "$ARCHIVE_TMP" \
    || die "下载 Node.js 失败。请手动安装 Node.js LTS：https://nodejs.org/zh-cn/download"

  mkdir -p "$TOOLCHAIN"
  tar -xzf "$ARCHIVE_TMP" -C "$TOOLCHAIN" \
    || die "解压 Node.js 失败。请手动安装 Node.js LTS：https://nodejs.org/zh-cn/download"

  NODE_BIN="$TOOLCHAIN/$NODE_DIR_NAME/bin/node"
  if [ ! -x "$NODE_BIN" ]; then
    die "Node.js 解压后未找到可执行文件：$NODE_BIN。请手动安装 Node.js LTS：https://nodejs.org/zh-cn/download"
  fi
fi

exec "$NODE_BIN" "$CLI" "bili" "$@"
