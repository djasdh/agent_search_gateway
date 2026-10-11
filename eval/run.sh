#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# §10 评测集一键脚本：在临时端口起一个 dist 网关实例（不动真实实例），
# 逐条打网关 MCP 的 `search` 工具，计时、算指标、落 eval/report.{md,json}。
#
# 用法:
#   ./eval/run.sh                  # 默认端口 3100，k=10
#   EVAL_PORT=3123 K=10 ./eval/run.sh
#
# 前提: searxng 在 127.0.0.1:8888 运行；dist 已构建（缺失会自动 npm run build）。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
PORT="${EVAL_PORT:-3100}"
K="${K:-10}"
SEARXNG_URL="${SEARXNG_URL:-http://127.0.0.1:8888}"
QUOTA="${QUOTA_LEDGER_PATH:-$HOME/.config/agent-search/quota.json}"
CASES="${CASES:-$DIR/cases.jsonl}"
mkdir -p /tmp/opencode
RUNDIR="$(mktemp -d /tmp/opencode/eval-gw.XXXXXX)"
GWPID=""

cleanup() {
  if [ -n "$GWPID" ] && kill -0 "$GWPID" 2>/dev/null; then
    kill "$GWPID" 2>/dev/null || true
    wait "$GWPID" 2>/dev/null || true
    kill -9 "$GWPID" 2>/dev/null || true
  fi
  rm -rf "$RUNDIR"
}
trap cleanup EXIT

echo "[eval] 工作目录: $RUNDIR  端口: $PORT  k: $K"

# --- 0. 前置检查 ---
if ! curl --noproxy '*' -s -m 3 -o /dev/null "$SEARXNG_URL/"; then
  echo "[eval] 错误: searxng 不可达 ($SEARXNG_URL)" >&2
  exit 1
fi

if [ ! -f "$ROOT/dist/index.js" ]; then
  echo "[eval] dist 缺失，构建中…"
  (cd "$ROOT" && npm run build)
fi

# --- 1. 临时配置（复制真实配置，改端口 + hosts 绝对路径 + 关掉 adlist 自动拉取） ---
cp "$ROOT/gateway.yaml" "$RUNDIR/gateway.yaml"
sed -i \
  -e "s/^  port: 3000/  port: $PORT/" \
  -e "s|hosts_file: data/adblock/hosts|hosts_file: $ROOT/data/adblock/hosts|" \
  -e "s/^  auto_update: true/  auto_update: false/" \
  "$RUNDIR/gateway.yaml"

# --- 2. 配额快照（跑前） ---
BEFORE="$(cat "$QUOTA" 2>/dev/null || echo '{}')"
echo "[eval] 配额快照（跑前）: $QUOTA"
echo "$BEFORE" | python3 -c "import sys,json;d=json.load(sys.stdin);print({k:v.get('used') for k,v in d.get('engines',{}).items()})" 2>/dev/null || true

# --- 3. 起临时网关实例（node 需以 RUNDIR 为 cwd 读取临时 gateway.yaml） ---
cd "$RUNDIR"
nohup node "$ROOT/dist/index.js" > "$RUNDIR/gateway.log" 2>&1 < /dev/null &
GWPID=$!
echo "$GWPID" > "$RUNDIR/gw.pid"
cd "$ROOT"
echo "[eval] 网关 PID=$GWPID，等待就绪…"

ok=""
for _ in $(seq 1 30); do
  if curl --noproxy '*' -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/health"; then ok=1; break; fi
  sleep 0.5
done
if [ -z "$ok" ]; then
  echo "[eval] 错误: 网关未在 $PORT 就绪，日志：" >&2
  tail -20 "$RUNDIR/gateway.log" >&2 || true
  exit 1
fi
echo "[eval] 网关就绪: http://127.0.0.1:$PORT/mcp"

# --- 4. 跑评测 ---
python3 "$DIR/run_eval.py" \
  --url "http://127.0.0.1:$PORT/mcp" \
  --cases "$CASES" \
  --k "$K" \
  --num-results "$K" \
  --quota "$QUOTA" \
  --out-md "$DIR/report.md" \
  --out-json "$DIR/report.json"

# --- 5. 配额快照（跑后） ---
echo "[eval] 配额快照（跑后）:"
cat "$QUOTA" 2>/dev/null | python3 -c "import sys,json;d=json.load(sys.stdin);print({k:v.get('used') for k,v in d.get('engines',{}).items()})" 2>/dev/null || true

echo "[eval] 完成。报告: $DIR/report.md"
