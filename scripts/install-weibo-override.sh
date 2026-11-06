#!/usr/bin/env bash
# 安装/更新微博 post adapter override（不 patch npm 包）。
# 只覆盖 weibo/post（+ 它依赖的 utils.js），其他 weibo 命令仍用官方版本。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v opencli >/dev/null 2>&1; then
  echo "opencli 未安装：npm install -g @jackwener/opencli" >&2
  exit 1
fi

# 清掉整站 eject 留下的副本，避免所有 weibo 命令都被 shadow。
opencli adapter reset weibo >/dev/null 2>&1 || true

mkdir -p "$HOME/.opencli/clis/weibo"
cp "$ROOT/opencli-overrides/weibo/post.js" "$HOME/.opencli/clis/weibo/post.js"
cp "$ROOT/opencli-overrides/weibo/utils.js" "$HOME/.opencli/clis/weibo/utils.js"

echo "已安装微博 post override：$HOME/.opencli/clis/weibo/post.js"
echo "恢复官方版本：opencli adapter reset weibo"
