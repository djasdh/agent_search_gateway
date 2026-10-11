#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""§10 评测集执行器：走网关 MCP 的 `search` 工具，逐条查询、计时、算指标。

用法（一般由 eval/run.sh 调用）：
    python3 eval/run_eval.py --url http://127.0.0.1:3100/mcp \
        --cases eval/cases.jsonl --k 10 \
        --out-md eval/report.md --out-json eval/report.json

指标：
  - 命中率 hit-rate@k：期望来源（域名）出现在 top-k 的 query 占比
  - precision@k：top-k 结果中命中期望来源的比例（分母=实际返回条数，上限 k）
  - 平均延迟：单次 search 的墙钟耗时均值
  - 每查询消耗额度：跑前跑后读取 quota 台账的 used 差值 / query 数

只依赖 Python 标准库。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import sys
import time
import urllib.request
from collections import OrderedDict

SESSION_ID = None
BASE_URL = None
HTTP_TIMEOUT = 60.0
_NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def log(msg: str) -> None:
    print(f"[eval] {msg}", flush=True)


# --------------------------------------------------------------------------- #
# MCP over Streamable HTTP
# --------------------------------------------------------------------------- #
def _post(body: dict, timeout: float = HTTP_TIMEOUT) -> tuple[int, dict, str]:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(BASE_URL, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json, text/event-stream")
    if SESSION_ID:
        req.add_header("Mcp-Session-Id", SESSION_ID)
    with _NO_PROXY.open(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", "replace")
        headers = {k.lower(): v for k, v in resp.headers.items()}
        return resp.status, headers, raw


def _parse_message(raw: str) -> dict | None:
    """响应可能是纯 JSON，也可能是 SSE（`data: {...}` 行）。"""
    raw = raw.strip()
    if not raw:
        return None
    if raw.startswith("{"):
        try:
            return json.loads(raw)
        except ValueError:
            pass
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            payload = line[5:].strip()
            try:
                return json.loads(payload)
            except ValueError:
                continue
    return None


def mcp_handshake() -> None:
    global SESSION_ID
    body = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "gateway-eval", "version": "1"},
        },
    }
    status, headers, raw = _post(body)
    if status != 200:
        raise SystemExit(f"initialize 失败: HTTP {status} {raw[:200]}")
    SESSION_ID = headers.get("mcp-session-id")
    if not SESSION_ID:
        raise SystemExit("initialize 未返回 mcp-session-id")
    # 通知（无响应）；服务器若返回 202/204 均忽略
    try:
        _post({"jsonrpc": "2.0", "method": "notifications/initialized"})
    except Exception:  # noqa: BLE001 - 部分实现不需要
        pass
    log(f"MCP session: {SESSION_ID}")


_RID = [1000]


def mcp_search(arguments: dict, timeout: float = HTTP_TIMEOUT) -> tuple[str, int, bool]:
    """调用 search 工具；返回 (text, wall_ms, ok)。"""
    _RID[0] += 1
    body = {
        "jsonrpc": "2.0",
        "id": _RID[0],
        "method": "tools/call",
        "params": {"name": "search", "arguments": arguments},
    }
    t0 = time.perf_counter()
    status, _headers, raw = _post(body, timeout=timeout)
    wall_ms = int((time.perf_counter() - t0) * 1000)
    if status != 200:
        return f"[HTTP {status}] {raw[:200]}", wall_ms, False
    msg = _parse_message(raw)
    if not msg:
        return "[empty response]", wall_ms, False
    if "error" in msg:
        return f"[jsonrpc error] {msg['error']}", wall_ms, False
    result = msg.get("result", {})
    if result.get("isError"):
        texts = [c.get("text", "") for c in result.get("content", []) if c.get("type") == "text"]
        return " ".join(texts), wall_ms, False
    texts = [c.get("text", "") for c in result.get("content", []) if c.get("type") == "text"]
    return "\n".join(texts), wall_ms, True


# --------------------------------------------------------------------------- #
# 结果解析 / 匹配
# --------------------------------------------------------------------------- #
RESULT_RE = re.compile(r"^\s*\d+\.\s+\[[^\]]*\]\((https?://[^)\s]+)\)", re.MULTILINE)


def extract_domains(markdown: str, limit: int) -> list[str]:
    urls = RESULT_RE.findall(markdown)
    hosts: list[str] = []
    for u in urls[:limit]:
        m = re.match(r"https?://([^/]+)", u)
        if not m:
            continue
        host = m.group(1).split("@")[-1].split(":")[0].lower()
        if host.startswith("www."):
            host = host[4:]
        hosts.append(host)
    return hosts


def domain_matches(host: str, expected: str) -> bool:
    expected = expected.lower().lstrip(".")
    if expected.startswith("www."):
        expected = expected[4:]
    return host == expected or host.endswith("." + expected)


def match_count(hosts: list[str], expects: list[str]) -> int:
    n = 0
    for h in hosts:
        if any(domain_matches(h, e) for e in expects):
            n += 1
    return n


# --------------------------------------------------------------------------- #
# 配额台账
# --------------------------------------------------------------------------- #
def read_ledger(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data.get("engines", {}) if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def ledger_used(ledger: dict) -> dict:
    out = {}
    for name, e in ledger.items():
        if isinstance(e, dict):
            try:
                out[name] = int(e.get("used", 0))
            except (TypeError, ValueError):
                out[name] = 0
    return out


# --------------------------------------------------------------------------- #
def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True, help="网关 MCP 地址，如 http://127.0.0.1:3100/mcp")
    ap.add_argument("--cases", default="eval/cases.jsonl")
    ap.add_argument("--k", type=int, default=10)
    ap.add_argument("--num-results", type=int, default=10)
    ap.add_argument("--quota", default=os.path.expanduser("~/.config/agent-search/quota.json"))
    ap.add_argument("--out-md", default="eval/report.md")
    ap.add_argument("--out-json", default="eval/report.json")
    ap.add_argument("--sleep", type=float, default=0.3, help="查询间隔秒（降低瞬时并发）")
    args = ap.parse_args()

    global BASE_URL
    BASE_URL = args.url

    with open(args.cases, "r", encoding="utf-8") as fh:
        cases = [json.loads(line) for line in fh if line.strip()]
    log(f"载入 {len(cases)} 条用例，k={args.k}")

    mcp_handshake()

    before = ledger_used(read_ledger(args.quota))

    rows = []
    for i, case in enumerate(cases, 1):
        params = case.get("params", {})
        arguments = {"query": case["query"], "num_results": args.num_results}
        arguments.update(params)
        text, wall_ms, ok = mcp_search(arguments)
        hosts = extract_domains(text, args.k)
        expects = case.get("expect", [])
        hits = match_count(hosts, expects)
        precision = (hits / len(hosts)) if hosts else 0.0
        topk_hit = hits > 0
        rows.append(
            {
                "id": case["id"],
                "category": case["category"],
                "query": case["query"],
                "expect": expects,
                "params": params,
                "ok": ok,
                "latency_ms": wall_ms,
                "result_count": len(hosts),
                "domains": hosts,
                "hits": hits,
                "precision": precision,
                "hit": topk_hit,
            }
        )
        flag = "HIT " if topk_hit else "miss"
        log(f"[{i:>2}/{len(cases)}] {flag} {wall_ms:>6}ms  {case['id']:<7} {case['query'][:40]}")

    after = ledger_used(read_ledger(args.quota))
    deltas = OrderedDict()
    for name in sorted(set(before) | set(after)):
        d = after.get(name, 0) - before.get(name, 0)
        if d != 0:
            deltas[name] = d
    total_calls = sum(deltas.values())

    # ---------------- 汇总 ----------------
    def agg(subset: list[dict]) -> dict:
        n = len(subset)
        if n == 0:
            return {"n": 0, "hit_rate": 0.0, "precision": 0.0, "avg_latency_ms": 0, "avg_results": 0.0}
        return {
            "n": n,
            "hit_rate": sum(1 for r in subset if r["hit"]) / n,
            "precision": sum(r["precision"] for r in subset) / n,
            "avg_latency_ms": round(statistics.mean(r["latency_ms"] for r in subset)),
            "avg_results": round(statistics.mean(r["result_count"] for r in subset), 1),
        }

    categories = ["zh-authority", "zh-ugc", "en-tech", "news"]
    overall = agg(rows)
    cat_agg = OrderedDict((c, agg([r for r in rows if r["category"] == c])) for c in categories)

    quota_per_query = (total_calls / len(rows)) if rows else 0.0

    summary = {
        "k": args.k,
        "num_results": args.num_results,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "url": args.url,
        "cases": len(rows),
        "overall": overall,
        "by_category": cat_agg,
        "quota": {
            "before": before,
            "after": after,
            "deltas": deltas,
            "total_calls": total_calls,
            "per_query": round(quota_per_query, 3),
        },
        "rows": rows,
    }

    with open(args.out_json, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=2)

    # ---------------- 报告（markdown） ----------------
    def pct(x: float) -> str:
        return f"{x * 100:.1f}%"

    lines: list[str] = []
    lines.append("# §10 搜索评测报告")
    lines.append("")
    lines.append(f"- 生成时间：{summary['generated_at']}")
    lines.append(f"- 网关：`{args.url}`　·　用例数：{len(rows)}　·　k={args.k}")
    lines.append("- 引擎策略：默认轮换（`fanout=1`），无结果静默降级")
    lines.append("")
    lines.append("## 总体")
    lines.append("")
    lines.append("| 指标 | 值 |")
    lines.append("|---|---|")
    lines.append(f"| 命中率 hit-rate@{args.k} | **{pct(overall['hit_rate'])}** ({sum(1 for r in rows if r['hit'])}/{overall['n']}) |")
    lines.append(f"| precision@{args.k} | **{pct(overall['precision'])}** |")
    lines.append(f"| 平均延迟 | **{overall['avg_latency_ms']} ms** |")
    lines.append(f"| 平均返回条数 | {overall['avg_results']} |")
    lines.append(f"| 每查询消耗额度 | **{quota_per_query:.2f} 次 API 调用** |")
    lines.append("")
    lines.append("## 分类细分")
    lines.append("")
    lines.append(f"| 类别 | 条数 | 命中率@{args.k} | precision@{args.k} | 平均延迟 | 平均条数 |")
    lines.append("|---|---|---|---|---|---|")
    cat_label = {
        "zh-authority": "中文权威",
        "zh-ugc": "中文 UGC",
        "en-tech": "英文技术",
        "news": "时效新闻",
    }
    for c in categories:
        a = cat_agg[c]
        lines.append(
            f"| {cat_label.get(c, c)} (`{c}`) | {a['n']} | {pct(a['hit_rate'])} | "
            f"{pct(a['precision'])} | {a['avg_latency_ms']} ms | {a['avg_results']} |"
        )
    lines.append("")
    lines.append("## 额度消耗（台账 used 差值）")
    lines.append("")
    lines.append("| 引擎 | 调用数 |")
    lines.append("|---|---|")
    if deltas:
        for name, d in deltas.items():
            lines.append(f"| {name} | {d} |")
    else:
        lines.append("| （无变化） | 0 |")
    lines.append(f"| **合计** | **{total_calls}**（{quota_per_query:.2f}/query） |")
    lines.append("")

    misses = [r for r in rows if not r["hit"]]
    lines.append(f"## 未命中样例（{len(misses)}/{len(rows)}）")
    lines.append("")
    for r in misses[:5]:
        doms = ", ".join(r["domains"]) if r["domains"] else "（无结果返回）"
        lines.append(f"- **[{r['id']}]** `{r['query']}`")
        lines.append(f"  - 期望：{', '.join(r['expect'])}")
        lines.append(f"  - 实际：{doms}")
    lines.append("")
    lines.append("## 全部用例明细")
    lines.append("")
    lines.append("| # | id | 类别 | hit | P | 延迟 | 期望 | 实际域名 |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for i, r in enumerate(rows, 1):
        doms = ", ".join(r["domains"][:6]) or "—"
        lines.append(
            f"| {i} | {r['id']} | {r['category']} | {'✅' if r['hit'] else '❌'} | "
            f"{r['precision']:.2f} | {r['latency_ms']}ms | {', '.join(r['expect'])} | {doms} |"
        )
    lines.append("")

    with open(args.out_md, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))

    # ---------------- 控制台总结 ----------------
    print()
    print("===== 评测结果 =====")
    print(f"总体  命中率 {pct(overall['hit_rate'])}   precision {pct(overall['precision'])}   "
          f"平均延迟 {overall['avg_latency_ms']}ms   每查询额度 {quota_per_query:.2f}")
    for c in categories:
        a = cat_agg[c]
        print(f"  {cat_label.get(c, c):<8} 命中率 {pct(a['hit_rate']):>6}   precision {pct(a['precision']):>6}   "
              f"平均延迟 {a['avg_latency_ms']:>5}ms   n={a['n']}")
    print(f"额度消耗: {total_calls} 次调用 {dict(deltas) if deltas else '(无变化)'}")
    print(f"报告: {args.out_md} / {args.out_json}")
    print()
    if misses:
        print("未命中样例:")
        for r in misses[:5]:
            print(f"  - [{r['id']}] {r['query']}  期望={r['expect']}  实际={r['domains']}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
