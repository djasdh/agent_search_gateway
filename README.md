# agent_search_gateway

统一搜索/抓取网关：一个 **MCP server（HTTP transport）**，把搜索、网页抓取、浏览器交互封装成稳定的 agent 工具。

面向 3.8GB 小服务器，全自托管，轻量。

## 架构

```
Agent（hermes / OpenCode / my-agent-core / 其它 MCP client）
  │  MCP over HTTP
  ▼
gateway (本服务, :3000/mcp)
  ├─ search → searxng (:8888) → 清洗/广告过滤/缓存 → 纯 md
  ├─ fetch  → 按 Content-Type 分派：
  │     网页 HTML→md；文本类直出/轻转换（JSON/CSV/XML）
  │     PDF → 抽正文（unpdf）
  │     图片等二进制 → 落盘 data/downloads + /files/<id> 链接
  │     网页自动路由 direct → FlareSolverr (:8192) → playwright
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
| `search` | 搜索网页，返回纯 md（直接回答/纠正/建议/infobox 置顶 + 结果列表）。参数：query/language/safesearch/categories/engines/min_score/num_results；`categories=images` 时返回图片直链，`academic` 时走科研/知网，`search_by_image` 时以图搜图（query 给图片 URL） |
| `fetch` | 抓取 URL：网页→md；纯文本/JSON/CSV/XML 直接返回；PDF 抽正文；图片等二进制落盘并返回路径与 `/files/<id>` 链接。参数：url/max_chars |
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
| `FETCH_NOT_HTML` | 非网页内容（历史错误码；现已按类型分派，不再返回） | 放弃 |
| `FETCH_UNSUPPORTED_TYPE` | 产物无法处理（如未启用落盘又拿到二进制） | 放弃 |
| `FETCH_TOO_LARGE` | 文件超过 `fetch.max_download_bytes`（默认 1GB） | 调大上限或放弃 |
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

## Docker 部署（推荐）

一条命令起全栈（gateway + searxng + flaresolverr）：

```bash
cd docker
cp .env.example .env       # 填入 EXA / TAVILY / ZHIHU / EMBEDDING 等密钥
docker compose up -d        # 本地构建；或改用下方已推送的 ghcr 镜像
docker compose ps
```

默认暴露 `127.0.0.1:3000/mcp`（仅本机）。公网部署：

```bash
GATEWAY_BIND=0.0.0.0 GATEWAY_TOKEN=<strong-token> docker compose up -d
```

镜像来源：

| 镜像 | 来源 |
|---|---|
| `ghcr.io/<owner>/agent-search-gateway` | 本仓库 `Dockerfile`，由 `.github/workflows/docker.yml` 在 CI 构建推送（本地也可 `docker compose build`） |
| `ghcr.io/<owner>/agent-search-searxng` | 本仓库 `docker/searxng/Dockerfile`（官方 searxng 基镜像 + `searxng-ext/` 引擎/插件） |
| `ghcr.io/flaresolverr/flaresolverr` | 上游官方镜像 |
| `mcr.microsoft.com/playwright:*` | 网关基镜像（自带 Node + Playwright 浏览器） |

约定：

- **密钥只经 `.env` → 环境变量注入，不进镜像**。searxng 的 `settings.yml` 由容器启动时从 `docker/searxng/settings.template.yml` 渲染。
- **配额台账共享**：`quota` 卷同时挂进 searxng 与 gateway（同一路径 `/quota/quota.json`）。
- 语料库 + 广告过滤缓存在 `corpus` 卷（容器内 `/data`）。
- **fetch 产物**（图片/PDF 等非文本文件）落在 `corpus` 卷的 `/data/downloads`（`docker/gateway.docker.yaml` 已指向该路径），容器重建不丢。
- 容器内网关配置为只读挂载的 `docker/gateway.docker.yaml`；改搜索/重排策略改它即可。
- **出口不经任何代理**：免费 API 引擎直连可达，内置通用爬虫已整体 disabled。
- **知网学术检索**（`categories=academic`）：检索匿名可用；**摘要与取件需要容器出口在机构网段**（会话票据 `LID`），否则只返回标题、取件报 `CNKI_NO_SESSION`。

### 更新

```bash
cd docker
git pull                 # 更新 compose 与 gateway.docker.yaml（配置不在镜像里）
docker compose pull      # 拉取最新 ghcr 镜像（CI 在 master 推送后自动构建）
docker compose up -d     # 重建容器；quota / corpus 卷保留
```

- 本地构建：`docker compose build && docker compose up -d`。
- 只改 `docker/gateway.docker.yaml` 时不必重建镜像，`docker compose up -d` 即可（文件挂载进容器）。
- searxng 的引擎清单来自镜像内的 `settings.template.yml`，改动需重新构建/拉取 searxng 镜像。
- `corpus` 卷内含 `fetch` 产物（`/data/downloads`），容器重建不丢。

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
fetch:          # timeout_ms/max_bytes/user_agent/block_private_ips/structural/max_output_chars/cache_ttl_ms/cache_max_entries/max_download_bytes/download_dir/download_ttl_ms/download_max_total_bytes/files_route
ad_filter:      # enabled/level(off|ads|ads+tracking|full)/extra_domains/hosts_file/allowlist
browser:        # enabled/headless/pool_size/idle_ttl_ms/engine(chromium|camoufox预留)/proxy_*/wait_for_selector/screenshot
embedding:      # enabled/provider(openai|ollama)/base_url/api_key/model/dim/timeout_ms/batch_size/max_input_chars/query_prefix/passage_prefix
corpus:         # enabled/store_path/ttl_ms/recall_k/sweep_interval_ms
```

### fetch 全类型与产物落盘

`fetch` 按响应的 `Content-Type` 分派，不再只认网页：

| 响应类型 | 处理 |
|---|---|
| `text/html`、`application/xhtml+xml` | 转 markdown（可选清理导航/广告），反爬时自动升级浏览器渲染 |
| `text/*`、`application/json`、`application/xml` 等 | 直接返回；JSON 美化、CSV/TSV 转 markdown 表格、XML 包代码块 |
| `application/pdf` | `unpdf` 抽正文（含页数标注）；扫描件无文本层则落盘 |
| 图片 / 压缩包 / 其它二进制 | 落盘，返回**本地路径 + `/files/<id>` 链接 + 大小 + sha256**，正文不注入上下文 |

站点专用取件走**取件插件**（`src/fetch/plugins/`）：插件按 host 自报匹配、自管会话与逐跳重定向并完成全部下载，`fetch` 只落盘并给出路径/链接（ADR-0007 / 0009）。当前注册 **CNKI**：知网摘要页 → `#pdfDown` → 跟随 302 链取 `%PDF` 落盘（不在机构网段、未订购、或该文献只有 HTML 阅读版都会给出可读错误）。

产物相关配置（`fetch` 块）：

| 配置 | 默认 | 说明 |
|---|---|---|
| `max_download_bytes` | 1073741824（1GB） | 非文本单文件上限；服务端给 `Content-Length` 时**下载前预检**，超出报 `[FETCH_TOO_LARGE]` |
| `download_dir` | `data/downloads` | 落盘目录（Docker 内为 `/data/downloads`） |
| `download_ttl_ms` | 604800000（7 天） | 产物保留时长 |
| `download_max_total_bytes` | 4294967296（4GB） | 总量配额，超出按最旧优先清理 |
| `files_route` | true | 是否提供 `GET /files/<id>` |

- 单文件上限 `fetch.max_download_bytes`（默认 1GB）：服务端返回 `Content-Length` 时在**下载前**预检，超限立即返回 `[FETCH_TOO_LARGE]`（不下载 body、不占用连接）；无该头时读到上限才中止。
- `id` = 文件内容 sha256（同内容幂等去重）；链接公开、不可猜（见 `docs/adr/0009`）。
- 二进制结果**不写** fetch 文本缓存，避免文件被 TTL 清走后链接失效。
- 目录布局：`<download_dir>/<前两位>/<sha256><扩展名>` + 同名 `.json` 侧车。

### 图片搜索（`categories=images`）

`search` 传 `categories=images` 即只走 searxng 的图片引擎（非 general 类别会抑制常驻/轮换源，ADR-0008），返回图片**直链**：

- 结果以 markdown 图片给出：`![标题](图片直链)`，下一行附来源页、分辨率、格式、图片来源与引擎、score；
- 只有缩略图时会标注「缩略图」并沿用缩略图直链；
- 拿到直链后可再调 `fetch` 把原图落盘到 `/data/downloads` 并得到 `/files/<id>` 链接；
- **不走语义层**：不调 embedding、不召回文本语料、不把图片来源页写进语料（图片结果没有正文；图片源页进文本语料会污染后续文本召回）；
- 排序沿用 `rerank`（`score × engine_boost`）；`rerank.diversity` 开启时按同注册域上限去冗余；
- 图片引擎在 searxng 的 `settings.yml` 里配置（默认可用 `bing images`、`duckduckgo images`、`openverse`、`wikicommons.images`；国内出口可再加 `baidu images`、`sogou images`）；
- 图片建议显式传 `safesearch`（searxng 的 `search.safe_search` 默认 1）。

### 以图搜图（`categories=search_by_image`）

`search` 传 `categories=search_by_image`，并让 **`query` 直接是图片 URL**（http/https），即同时启用两个源（ADR-0010）：

| 源 | 承载方 | 说明 |
|---|---|---|
| searxng 的 `tineye` | searxng 引擎（上游自带） | 需要在 searxng 的 `settings.yml` 里给 tineye 声明 `categories: [search_by_image]`（见 `searxng-ext/settings.example.yml` / `docker/searxng/settings.template.yml`）；网关不点名引擎 |
| `trace.moe` | 网关侧附加源 | 动画截图匹配（AniList 标题/集数/时间点）；免 key、按 IP 限 100 次/日 |

```jsonc
// 示例：以图搜图
{ "query": "https://example.com/some-image.jpg", "categories": "search_by_image" }
```

- **「图就是 query」**：图片 URL 写在 `query` 里（与 searxng 的 `online_url_search` 同形），没有额外的上传字段；query 里没有 http(s) URL 时会附一条提示并只走 searxng（searxng 也不会触发 tineye）。
- 两边候选统一成同一线格式后**按 URL 去重**（同 URL 的引擎归属并写入 `engines[]`），再走与 `categories=images` 完全相同的排序/渲染管线（图片直链 + 不走语义层）。
- 排序：图片查询没有文本 query 向量，故按 `score`（tineye 的匹配分 / trace.moe 的 similarity）× `engine_boost`，`rerank.diversity` 开启时同注册域去冗余。
- **不支持本地图片文件**：TinEye 是服务端拉图，URL 必须公网可达；trace.moe 虽支持上传，但只覆盖一个源（记在 `TODO.md`）。
- 失败不致命：单个源失败/无匹配时返回另一边的结果，并在结果末尾附一条提示（`反向图搜：…`）。
- **部署检查**：searxng 若没声明该类别，请求会被静默过滤、回落成 `general` 搜索（不报错）。验证：`curl -s localhost:8888/config | grep search_by_image`。
- 相关配置在 `gateway.yaml` 的 `search.reverse_image`（开关 / 触发类别 / 附加源清单 / trace.moe 地址与超时）。

### searxng 配置分工（gateway.yaml vs settings.yml）

搜索系统的 searxng 相关配置分两层，**各读各的，不重复**：

| 文件 | 管什么 | 谁读 | 改后生效 |
|---|---|---|---|
| `gateway.yaml` 的 `searxng`/`search` 块 | **怎么调 searxng**：连哪个地址（`searxng.url`）、超时、结果数、缓存 | gateway (node) | 重启 gateway |
| searxng 的 `settings.yml`（源码运行：`~/Projects/searxng/settings.yml`；Docker：`docker/searxng/settings.template.yml`） | **searxng 内部引擎配置**：启哪些引擎、safesearch、UA | SearXNG 启动时 | 重启 searxng |

要点：

- `gateway.yaml` 的 `searxng.url` 必须指向 searxng 实际端口（源码运行 `127.0.0.1:8888`；Docker 内为服务名 `http://searxng:8080`），flaresolverr 同理（`8192`／`http://flaresolverr:8191`）
- settings.yml 是独立配置文件，**不要放 `/tmp`**（重启会丢）
- Docker 下 `settings.yml` 由 `docker/searxng/entrypoint.sh` 用环境变量渲染，**不要手改容器内文件**
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
- 机制：每次搜索把结果写入本地语料库（按 URL 去重、TTL 30 天），并用 query 向量 KNN 召回；召回条目与上游结果按 URL 合并去重后**按纯语义排序**，条目标注「本地缓存 · 抓取于 X」。图片查询（`categories=images`）是例外：不写语料、不召回、不 embedding。
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

- `npm test`：256 个测试（30 个测试文件）
- `scripts/bench.sh`：测量各组件内存/延迟，验证 3.8GB 预算

实测（本机模拟）：
- 空闲内存 ~450MB；搜索后 ~460MB；浏览器工作时 ~1GB；关闭后回落
- 搜索延迟 0.7-3s；fetch 1.9-6.7s（首次）；browser_navigate 13.6s（冷启动）

---

许可证：[MIT](LICENSE)　·　第三方依赖、外部服务与借鉴来源：[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)
