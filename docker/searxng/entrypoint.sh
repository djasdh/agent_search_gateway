# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 定制 searxng 容器的启动包装：
#   1) 用环境变量渲染 settings.yml（密钥由此注入，不进镜像/仓库）
#   2) 准备与 gateway 共享的配额台账目录/种子
#   3) 交给 searxng 官方入口
set -eu

TEMPLATE="${SEARXNG_SETTINGS_TEMPLATE:-/opt/agent-search/settings.template.yml}"
SETTINGS="${SEARXNG_SETTINGS_PATH:-/etc/searxng/settings.yml}"

# server.secret_key：未提供则随机生成（每次重建会变，仅影响会话签名）
if [ -z "${SEARXNG_SECRET_KEY:-}" ]; then
  SEARXNG_SECRET_KEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  export SEARXNG_SECRET_KEY
fi

# 配额台账（与 gateway 共享卷）：确保目录存在，并落地种子配置
LEDGER="${QUOTA_LEDGER_PATH:-/quota/quota.json}"
mkdir -p "$(dirname "$LEDGER")"
CONF="${QUOTA_CONFIG_PATH:-/quota/quota.config.json}"
if [ ! -f "$CONF" ]; then
  cp /opt/agent-search/quota.config.json "$CONF" 2>/dev/null || true
fi

python3 - "$TEMPLATE" "$SETTINGS" <<'PY'
import os, re, sys

src, dst = sys.argv[1], sys.argv[2]
text = open(src, encoding="utf-8").read()
missing = []


def _sub(match):
    name = match.group(1)
    if name in os.environ:
        return os.environ[name]
    missing.append(name)
    return ""


text = re.sub(r"\$\{([A-Z0-9_]+)\}", _sub, text)
os.makedirs(os.path.dirname(dst), exist_ok=True)
with open(dst, "w", encoding="utf-8") as fh:
    fh.write(text)
if missing:
    sys.stderr.write(
        "[entrypoint] 未设置的环境变量(已置空): %s\n" % ", ".join(sorted(set(missing)))
    )
PY

exec /usr/local/searxng/entrypoint.sh "$@"
