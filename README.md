# agent_search_gateway

统一搜索/抓取网关：一个 **MCP server（HTTP transport）**，把搜索、网页抓取、浏览器交互封装成稳定的 agent 工具。

面向 3.8GB 小服务器，全自托管，轻量。

## 架构

```
Agent（hermes / OpenCode / my-agent-core / 其它 MCP client）
  │  MCP over HTTP
  ▼
gateway (本服务, :3000/mcp)
  ├─ search → searxng (:8890) → 清洗/广告过滤/缓存 → 纯 md
  ├─ fetch  → 智能路由：
  │     ① direct（普通站，HTML→md）
  │     ② FlareSolverr (:8191)（CF 挑战/JS 站渲染）
  │     ③ playwright（复杂 SPA 渲染）
  │     fetch 缓存按渲染方式隔离
  ├─ browser_* → 内嵌 playwright（agent 交互：navigate/click/type/scroll/find/screenshot）
  └─ health → 各后端连通状态
```

组件内存（空闲/工作）：
- searxng ~110MB、FlareSolverr ~85MB、gateway(node) ~180-250MB
- playwright 浏览器：**按需拉起**，空闲 0MB，工作 ~550MB，空闲 360s 或 `browser_close` 自动释放
- 空闲总量 ~450MB；浏览器工作时峰值 ~1GB；3.8GB 预算富余充足

## MCP 工具

| 工具 | 说明 |
|---|---|
| `search` | 搜索网页，返回纯 md（直接回答/纠正/建议/infobox 置顶 + 结果列表）。参数：query/language/time_range/safesearch/categories/engines/min_score/num_results |
| `fetch` | 抓取 URL → md。自动路由 direct/FlareSolverr/playwright。参数：url/max_chars |
| `browser_navigate` | 浏览器打开 URL，返回无障碍树快照（省 token） |
| `browser_snapshot` | 当前页无障碍树快照，可选 target 限定 |
| `browser_take_screenshot` | 截图返回 base64（开关/尺寸可配） |
| `browser_click` / `browser_type` | 点击/输入，返回无障碍树 |
| `browser_scroll` / `browser_find` | 滚动 / 搜索页面文本 |
| `browser_close` | 关闭浏览器释放资源 |
| `health` | 各后端连通状态 |

## 错误码

错误返回 text 以 `[CODE]` 前缀开头（agent 可 grep 判断重试/放弃）：

| 错误码 | 含义 | 建议 |
|---|---|---|
| `SEARCH_TIMEOUT` | searxng 超时 | 可重试 |
| `SEARCH_UPSTREAM` | searxng 不可达 | 稍后重试 |
| `SEARCH_INVALID` | searxng 返回异常 | 放弃 |
| `FETCH_TIMEOUT` | 目标站超时 | 可重试 |
| `FETCH_BLOCKED` | 反爬/SSRF 阻断 | 放弃或换源 |
| `FETCH_NOT_HTML` | 非网页内容 | 放弃 |
| `FETCH_RENDER_FAIL` | 浏览器渲染失败 | 可重试 |
| `FETCH_NETWORK` | 网络错误 | 可重试 |
| `FETCH_INVALID_URL` | 非法 URL | 放弃 |
| `BROWSER_UNAVAILABLE` | 浏览器未启用 | 检查配置 |
| `BROWSER_ERROR` | 浏览器操作失败 | 可重试 |

## 快速开始

```bash
git clone https://github.com/djasdh/agent_search_gateway.git
cd agent_search_gateway
npm ci                             # 有 package-lock.json，用 ci 可复现
npx playwright install chromium    # 首次安装浏览器
cp gateway.yaml.example gateway.yaml
./scripts/gateway.sh start           # 启动三件套（searxng/flaresolverr/gateway）
./scripts/gateway.sh status
```

开发模式单独跑网关：

```bash
npm run dev            # tsx 直接跑
npm run build && npm start   # 编译后跑
npm test               # vitest
```

## 接入 MCP 客户端

网关地址：`http://<host>:3000/mcp`

### 无认证

```json
{
  "mcpServers": {
    "search-gateway": {
      "url": "http://127.0.0.1:3000/mcp",
      "type": "http"
    }
  }
}
```

### 带 token（gateway.yaml 的 gateway.token，或 env GATEWAY_TOKEN）

```json
{
  "mcpServers": {
    "search-gateway": {
      "url": "http://127.0.0.1:3000/mcp",
      "type": "http",
      "headers": { "Authorization": "Bearer <你的token>" }
    }
  }
}
```

> 注：不同 MCP 客户端配置字段略有差异（`type`/`headers` 等），按客户端规范调整。

## 配置（gateway.yaml）

完整示例见 `gateway.yaml.example`。关键项：

```yaml
gateway:        # host/port/token
logging:        # level/file
searxng:        # url/timeout_ms
flaresolverr:   # url/enabled/timeout_ms/max_concurrent/trigger_status/fallback_on_empty
search:         # max_results/max_result_chars/cache_ttl_ms/cache_max_entries/max_concurrent
fetch:          # timeout_ms/max_bytes/user_agent/block_private_ips/structural/max_output_chars/cache_ttl_ms/cache_max_entries
ad_filter:      # enabled/level(off|ads|ads+tracking|full)/extra_domains/hosts_file/allowlist
browser:        # enabled/headless/pool_size/idle_ttl_ms/engine(chromium|camoufox预留)/proxy_*/wait_for_selector/screenshot
embedding:      # enabled/provider(openai|ollama)/base_url/api_key/model/dim/timeout_ms/batch_size/max_input_chars/query_prefix/passage_prefix
corpus:         # enabled/store_path/ttl_ms/recall_k/sweep_interval_ms
```

### searxng 配置分工（gateway.yaml vs settings.yml）

搜索系统的 searxng 相关配置分两层，**各读各的，不重复**：

| 文件 | 管什么 | 谁读 | 改后生效 |
|---|---|---|---|
| `gateway.yaml` 的 `searxng`/`search` 块 | **怎么调 searxng**：连哪个地址（`searxng.url`）、超时、结果数、缓存 | gateway (node) | 重启 gateway |
| `/etc/agent-search/settings.yml` | **searxng 内部引擎配置**：启哪些引擎（google/bing/ddg/brave）、safesearch、UA | SearXNG 容器启动时 | `docker restart searxng-main` |

要点：

- `gateway.yaml` 的 `searxng.url` 必须指向 searxng 实际端口（本机 `8890`），flaresolverr 同理（`8191`）
- settings.yml 是独立配置文件，**不要放 `/tmp`**（重启会丢）；本机约定在 `/etc/agent-search/settings.yml`
- searxng 容器挂载方式：`-v /etc/agent-search/settings.yml:/etc/searxng/settings.yml:ro`
- 改引擎开关（如启用/禁用某个引擎）只动 settings.yml + 重启 searxng，**不需要动 gateway**

### 广告过滤（StevenBlack hosts）

- 数据源：StevenBlack/hosts（MIT），本地缓存 `data/adblock/hosts`（gitignore，不入库）
- 力度：`off` / `ads`（默认）/ `ads+tracking` / `full`（对应不同 hosts 文件）
- **天级自动拉取**：启动时若 hosts 缺失/过期（`auto_update_interval_ms`，默认 24h）自动拉取；进程内定时器周期检查，到点拉取并自动刷新广告过滤集（无需重启）
- 手动更新：`./scripts/update-adlist.sh [level]`
- 保白名单 `allowlist` 防误杀（wikipedia/github 等）

### 语义召回与本地语料库（可选）

- 开关：`embedding.enabled` + `corpus.enabled`；都关闭时行为与旧版完全一致。
- 来源：外部 embedding API（OpenAI 兼容 `/embeddings` 或 Ollama `/api/embed`），**不内置本地模型**；自托管 embedding 可行但非建议（见 `docs/adr/0005`）。
- 机制：每次搜索把结果写入本地语料库（按 URL 去重、TTL 30 天），并用 query 向量 KNN 召回；召回条目与上游结果按 URL 合并去重后**按纯语义排序**，条目标注「本地缓存 · 抓取于 X」。
- 降级：embedding 不可用或调用失败时回退为 `score × engine_boost` 排序；上游请求失败时返回错误码并尽量附语料召回结果。
- 依赖：`sqlite-vec` 随 npm 安装自带平台二进制，无需手动装扩展。
- 模型切换：命名空间为 `provider:model@dim`；换模型产生新命名空间，旧向量保留但不参与（多命名空间并存，见 `docs/adr/0001`–`0006`）。

## 管理脚本

```bash
./scripts/gateway.sh start|stop|restart|status|logs [searxng|flaresolverr|gateway|all]
./scripts/update-adlist.sh [ads|ads+tracking|full]   # 更新广告过滤列表
./scripts/bench.sh                                    # 本机压测（内存/延迟）
```

`scripts/gateway.sh` 管理三件套，前置期望（脚本内路径可改）：
- searxng 源码在 `$HOME/Projects/searxng`（含 `searxng.sh`）
- FlareSolverr 源码在 `$HOME/Projects/FlareSolverr`（含 .venv，需 conda Xvfb 在 PATH）

> 若你已有自己的 searxng / FlareSolverr（或跑在容器里），不必用 gateway.sh：
> 直接在 `gateway.yaml` 里把 `searxng.url` / `flaresolverr.url` 指向它们，
> 然后 `npm run build && npm start` 只跑网关本身即可。

## 测试与压测

- `npm test`：107 个测试（17 个测试文件）
- `scripts/bench.sh`：测量各组件内存/延迟，验证 3.8GB 预算

实测（本机模拟）：
- 空闲内存 ~450MB；搜索后 ~460MB；浏览器工作时 ~1GB；关闭后回落
- 搜索延迟 0.7-3s；fetch 1.9-6.7s（首次）；browser_navigate 13.6s（冷启动）

---

许可证：[MIT](LICENSE)　·　第三方依赖、外部服务与借鉴来源：[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)
