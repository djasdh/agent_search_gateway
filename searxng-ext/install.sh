#!/usr/bin/env bash
# 将 searxng-ext 的引擎/插件安装到 searxng 源码树。
# 用法: ./install.sh [/path/to/searxng]    (默认 $HOME/Projects/searxng)
#
# 说明:searxng 只从 searx/engines/ 加载引擎、从 searx/plugins/ 加载插件,
# 没有外部目录机制,所以必须把文件放进它的源码树。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEARXNG_DIR="${1:-$HOME/Projects/searxng}"

if [ ! -d "$SEARXNG_DIR/searx/engines" ] || [ ! -d "$SEARXNG_DIR/searx/plugins" ]; then
  echo "找不到 $SEARXNG_DIR/searx/{engines,plugins};用法: ./install.sh /path/to/searxng" >&2
  exit 1
fi

cp -v "$DIR"/searx/engines/*.py "$SEARXNG_DIR/searx/engines/"
cp -v "$DIR"/searx/plugins/quota.py "$SEARXNG_DIR/searx/plugins/"

echo
echo "完成。下一步:"
echo "  1) 按 settings.example.yml 在你的 settings.yml 里启用对应引擎/插件"
echo "  2) systemctl --user restart searxng.service"
echo
echo "注意:密钥(tavily / zhihu)经环境变量或未跟踪的 settings.yml 注入,勿入库。"
