#!/usr/bin/env bash
# agent_search_gateway 自更新入口（macOS）
#
# 仅做平台标注与转发：Node.js 准备、下载、校验、切换、回滚等逻辑
# 全部复用 linux.sh（其通过 uname 检测平台，macOS 同样适用）。
#
# 用法：bash scripts/self-update/macos.sh [选项]
# 选项见：bash scripts/self-update/macos.sh --help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"

case "$(uname -s 2>/dev/null || echo unknown)" in
  Darwin) ;;
  *)
    printf '[self-update] 警告: macos.sh 当前运行在 %s 上，仍按本机平台继续执行。\n' \
      "$(uname -s 2>/dev/null || echo unknown)" >&2
    ;;
esac

exec bash "$SCRIPT_DIR/linux.sh" "$@"
