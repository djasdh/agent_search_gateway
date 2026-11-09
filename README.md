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
| `search` | 搜索网页，返回纯 md（直接回答/纠正/建议/infobox 置顶 + 结果列表）。参数：query/language/safesearch/categories/engines/min_score/num_results/fanout；`categories=images` 时返回图片直链，`science` 时走学术/知网，`search_by_image` 时以图搜图（query 给图片 URL，或 image_path 给本地图片）。`num_results` 上限由 `search.max_results_cap` 决定，超出按上限截断并在结果末尾说明 |
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
| `BILI_UNAVAILABLE` | B 站后端未启用/未安装/连不上 | 看 `bilibili.routes` 与安装提示 |
| `BILI_AUTH_REQUIRED` | 评论第 2 页或专栏全文需要登录态 | 按提示登录对应后端 |
| `BILI_CAPABILITY_UNSUPPORTED` | 当前没有支持该动作的后端 | 换/加后端 |
| `BILI_RISK_CONTROL` | B 站 403/412 风控 | 降频、换出口，稍后重试 |
| `BILI_INVALID_URL` | 目标不合法 | 检查 URL 是否为视频/专栏页 |

## B 站抓取

全部走 `fetch`，不新增工具；B 站视频/专栏 URL 会被插件自动接管，不需要额外参数。默认关闭，在 `gateway.yaml` 里把 `bilibili.enabled` 设为 `true`。

| 请求 | 说明 |
|---|---|
| `.../video/BVxxx` | 视频摘要 JSON（标题/链接/音频直链/封面/简介/UP/统计/分P/评论区链接） |
| `.../video/BVxxx?p=2` | 同上，当前分P为 2，`pages` 仍然全量 |
| `.../video/BVxxx#reply` | 全量抓取评论并落库，返回统计与前 20 条 |
| `.../video/BVxxx#reply?sort=time` | 按时间抓取评论 |
| `.../video/BVxxx#reply?q=关键词` | 在本地评论库检索 |
| `.../read/cv123456` | 专栏摘要 JSON（正文 + 封面 + 评论区链接） |
| `.../read/cv123456#comment` | 专栏评论全量抓取 / 检索 |

多后端按能力路由（`bilibili.routes`），失败自动换下一个：

- `cli-kukemc`（`bili` CLI）：详情、评论
- `cli-ytdlp`（`yt-dlp`）：详情、音频直链
- `http`：全部能力；`http.command` 非空时由插件拉起/回收，否则连 `base_url`。服务端已拆到独立仓库 [djasdh/bilibili-article-server](https://github.com/djasdh/bilibili-article-server)，可用 `./scripts/backends/article.sh install` 安装。

要点：

- 只有音频直链，不下载文件；视频与音频是分离的 DASH 流，需要时由 agent 自行处理。
- `audio_url` 是带签名的临时直链，过期后重新 fetch 即可；取不到时为 `null`，并带 `audio_error`。
- 登录态由各后端自己持有；网关只探测一次（60s 缓存），缺了直接返回 `BILI_AUTH_REQUIRED`，不静默降级。
- 评论按页抓取直到结束或 60 秒预算；没拉完返回 `complete: false`，再次 fetch 同一 URL 续传，不提供翻页参数。
- 未安装后端或 `bilibili.enabled=false` 时，B 站 URL 会明确返回 `BILI_UNAVAILABLE`，不会静默回退成抓网页。

## 微博抓取

全部走 `fetch`，不新增工具；默认关闭。普通微博页面 URL 带 `?weibo=` 才接管；`sinaimg.cn` 图片 URL 自动接管为附件。

### 前置

1. Node ≥ 20.18.1，安装 OpenCLI（基线版本 `2.0.2`）：

```bash
npm install -g @jackwener/opencli
```

2. 浏览器登录 `weibo.com`。**推荐 CDP 模式**（Chrome 137+ 已移除 `--load-extension`）：

```bash
google-chrome-stable \
  --user-data-dir="$PWD/data/weibo-chrome-profile" \
  --remote-debugging-port=9222 \
  --remote-allow-origins='*' \
  --no-first-run \
  "https://weibo.com/login"
# 扫码登录后，在网关进程环境里设置：
export OPENCLI_CDP_ENDPOINT=http://127.0.0.1:9222
```

旧版 Chrome 也可以改用 Browser Bridge 扩展（`opencli doctor` 显示扩展已连接即可）。

3. 安装 post adapter override（给 `weibo post` 补图片外链字段）：

```bash
./scripts/install-weibo-override.sh
```

4. `gateway.yaml` 里把 `weibo.enabled` 设为 `true`。

### 请求

| 请求 | 说明 |
|---|---|
| `https://weibo.com/{uid}/{mblogid}?weibo=post` | 正文/转发 + 图片外链（默认动作） |
| `https://m.weibo.cn/detail/{id}?weibo=comments&limit=20` | 评论（最多 50） |
| `https://weibo.com/u/{uid}?weibo=user` | 用户信息 |
| `https://weibo.com/u/{uid}?weibo=user-posts&days=30` | 博主最近 30 天微博（Markdown） |
| `https://weibo.com/u/{uid}?weibo=user-posts&start=2026-10-01&end=2026-10-31` | 博主指定时间段微博 |
| `https://wx1.sinaimg.cn/large/xxx.jpg` | 图片附件（自动落盘，返回 `/files/<sha256>`） |
| `https://t.cn/xxxx?weibo=post` | 短链先解析再抓取 |

时间段参数：

| 参数 | 说明 |
|---|---|
| `days=N` | 最近 N 天（1–90），与 `start`/`end` 互斥；默认 7 |
| `start` / `end` | `YYYY-MM-DD`，含边界；只给一端时自动补另一端 |
| `include_retweets=1` | 包含转发 |
| `max_items=N` | 本次返回上限（默认 500） |

抓取策略：先整段拉 100 条；返回满 100 条说明可能被截断，就二分区间继续，直到每段不足 100 条。低频博主通常一次调用即可。单日超过 100 条时会在结果末尾提示（adapter 只支持日期粒度）。图片只有数量 `pic_count`，要图请对单条再 `?weibo=post`。

### 微博搜索 / 热搜

搜索走 `search` 工具，不新增工具：

| 请求 | 说明 |
|---|---|
| `search(query="洛天依", categories="weibo")` | 只搜微博帖子，不查普通网页 |
| `search(query="", categories="weibo_hot")` | 微博热搜榜 |

- 需要同时开启 `weibo.enabled` 和 `search.weibo.enabled`。
- 微博源是网关侧文本源，直接调 OpenCLI，不经过 searxng；自定义类别也不会转发给 searxng。
- 空结果会自动重试一次（搜索页异步加载），结果缓存 60 秒。
- 微博搜索只保留微博候选，不召回本地语料，避免混入普通网页。

`?weibo=search` / `?weibo=hot` 不支持的抓取动作仍会返回 `WEIBO_INVALID`；搜索请用上面的 `categories`。

### 图片

- `post` 的 Markdown 里按实际数量列 `![](url)`；转发帖的图片也列。
- 图片 CDN URL 直接 `fetch`：插件带 `Referer` 下载，走现有 fetch store，返回 `/files/<sha256>`。
- 不做多图 zip；需要多张就分别 fetch 各图片外链。
- `wx*.sinaimg.cn` 失败时自动换 `tvax*` 重试一次。

### 服务器部署

```bash
sudo apt install -y xvfb google-chrome-stable
Xvfb :99 -screen 0 1280x900x24 &
DISPLAY=:99 google-chrome-stable \
  --user-data-dir="$PWD/data/weibo-chrome-profile" \
  --remote-debugging-port=9222 \
  --remote-allow-origins='*' \
  --no-first-run \
  "https://weibo.com/login"
# 通过 VNC/远程桌面扫码登录；保持 Chrome 运行
export OPENCLI_CDP_ENDPOINT=http://127.0.0.1:9222
opencli weibo whoami -f json
```

网关与 Chrome 分离时，把 `OPENCLI_CDP_ENDPOINT` 指向 Chrome 所在机器的 `http://<host>:9222`。

登录完成后可以改用无头模式复用同一 profile，不需要 Xvfb/桌面：

```bash
google-chrome-stable \
  --headless=new \
  --user-data-dir="$PWD/data/weibo-chrome-profile" \
  --remote-debugging-port=9222 \
  --remote-allow-origins='*' \
  --no-first-run \
  about:blank
export OPENCLI_CDP_ENDPOINT=http://127.0.0.1:9222
opencli weibo whoami -f json
```

注意：

- 同一个 `user-data-dir` 同时只能被一个 Chrome 实例使用；切换前先退出有头实例。
- 首次扫码登录仍建议用有头模式（或 Xvfb + VNC）；登录态写入 profile 后，无头模式可直接复用。
- 无头模式的 UA 会带 `HeadlessChrome/...`。当前微博抓取/搜索实测可用；若以后遇到风控，可加 `--user-agent` 覆盖成普通 Chrome UA。

### 错误码

| 错误码 | 含义 | 处理 |
|---|---|---|
| `WEIBO_UNAVAILABLE` | 未启用 / OpenCLI 不存在 | 检查 `weibo.enabled` 与 `opencli` 命令 |
| `WEIBO_AUTH_REQUIRED` | 微博未登录 | 在 Chrome 登录 weibo.com，或 `opencli weibo login` |
| `WEIBO_BRIDGE_DOWN` | Browser Bridge 未连接 | 启动 Chrome/扩展，跑 `opencli doctor` |
| `WEIBO_TIMEOUT` | 浏览器命令超时 | 调大 `weibo.cli.timeout_ms` |
| `WEIBO_EMPTY` | 无结果 | 确认帖子可见/有权限 |
| `WEIBO_IMAGE_FAIL` | 图片下载失败 | 检查 Referer、`max_bytes`、`retry_tvax` |

> `weibo post` 是浏览器操作，单次可能 5–10s。若 Chrome 未连接，OpenCLI 默认会等 45s；把 `OPENCLI_BROWSER_CONNECT_TIMEOUT` 调小（如 20）或把 `weibo.cli.timeout_ms` 设为 45s 以上，才能得到 `WEIBO_BRIDGE_DOWN` 而不是 `WEIBO_TIMEOUT`。

## 一键安装（推荐）

Linux / macOS：

```bash
curl -fsSL https://raw.githubusercontent.com/djasdh/agent_search_gateway/master/scripts/install.sh | bash
```

Windows（PowerShell 5.1+）：

```powershell
irm https://raw.githubusercontent.com/djasdh/agent_search_gateway/master/scripts/install.ps1 | iex
```

默认安装到 `~/agent_search_gateway`（Windows 为 `%USERPROFILE%\agent_search_gateway`），并完成：

- 下载对应平台完整包（含 `dist/` 与生产 `node_modules/`），SHA256 校验
- 生成 `gateway.yaml` / `secrets.yaml`（随机 `gateway.token`）
- 安装 Playwright chromium
- 安装搜索依赖：
  - Linux / macOS：默认用 Docker 起 searxng；没有 Docker 时回退到原生源码 + venv
  - Windows：原生 searxng（自动打 `pwd` 补丁）+ 官方 FlareSolverr x64 二进制
- 注册用户级自启（systemd --user / LaunchAgent / 登录计划任务）
- 启动并做健康检查

常用参数：

```bash
# 指定目录
curl -fsSL .../install.sh | bash -s -- --dir ~/apps/asg
# 不装浏览器 / 不注册自启
curl -fsSL .../install.sh | bash -s -- --no-browser --no-service
# 连接已有 searxng（跳过本地安装）
curl -fsSL .../install.sh | bash -s -- --searxng-url http://192.168.1.10:8888
```

代理环境请设置 `HTTPS_PROXY`（或 `https_proxy`）。安装完成后用 `scripts/start-all.mjs` 或注册的服务启动。

## 快速开始（源码）

```bash
git clone https://github.com/djasdh/agent_search_gateway.git
cd agent_search_gateway
npm ci                             # 有 package-lock.json，用 ci 可复现
npx playwright install chromium    # 首次安装浏览器
cp gateway.yaml.example gateway.yaml
cp secrets.yaml.example secrets.yaml && chmod 600 secrets.yaml   # 填密钥（可留空）
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
cp .env.example .env       # 填入 EXA / TAVILY / ZHIHU / EMBEDDING / GATEWAY 等密钥
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

- **密钥只经 `.env` → 环境变量注入，不进镜像**。searxng 的 `settings.yml` 由容器启动时从 `docker/searxng/settings.template.yml` 渲染。也可改用 `secrets.yaml`（取消 `docker/compose.yaml` 里的注释挂载，并 `chmod 600`）。
- **配额台账共享**：`quota` 卷同时挂进 searxng 与 gateway（同一路径 `/quota/quota.json`）。
- 语料库 + 广告过滤缓存在 `corpus` 卷（容器内 `/data`）。
- **fetch 产物**（图片/PDF 等非文本文件）落在 `corpus` 卷的 `/data/downloads`（`docker/gateway.docker.yaml` 已指向该路径），容器重建不丢。
- 容器内网关配置为只读挂载的 `docker/gateway.docker.yaml`；改搜索/重排策略改它即可。
- **出口不经任何代理**：免费 API 引擎直连可达，内置通用爬虫已整体 disabled。
- **知网学术检索**（`categories=science`）：检索匿名可用；**摘要与取件需要容器出口在机构网段**（会话票据 `LID`），否则只返回标题、取件报 `CNKI_NO_SESSION`。

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

### 带 token（secrets.yaml 的 gateway.token，或 env GATEWAY_TOKEN）

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

## 配置（gateway.yaml + secrets.yaml）

设置与密钥**分开存放**，两者默认同目录（可用 `GATEWAY_CONFIG_FILE` / `GATEWAY_SECRETS_FILE` 覆盖路径）：

- `gateway.yaml`：非敏感设置。完整示例见 `gateway.yaml.example`，**不接受任何密钥字段**。
- `secrets.yaml`：只放密钥。模板见 `secrets.yaml.example`，建议 `chmod 600`。
- 环境变量（`GATEWAY_TOKEN` / `EMBEDDING_API_KEY` / `SAUCENAO_API_KEY` / `BILIBILI_HTTP_TOKEN` / `BROWSER_PROXY_PASSWORD`）优先级最高。

内部实现上，每个组件只接收自己那段设置（如 `search` / `fetch` / `browser`）和需要的密钥，不再拿全量配置。配置在启动时加载一次，修改后需重启。

关键项：

```yaml
gateway:        # host/port（token 在 secrets.yaml）
logging:        # level/file
searxng:        # url/timeout_ms
flaresolverr:   # url/enabled/timeout_ms/max_concurrent/trigger_status/fallback_on_empty
search:         # max_results/max_results_cap/max_result_chars/cache_ttl_ms/cache_max_entries/max_concurrent
fetch:          # timeout_ms/max_bytes/user_agent/block_private_ips/structural/max_output_chars/cache_ttl_ms/cache_max_entries/max_download_bytes/download_dir/download_ttl_ms/download_max_total_bytes/files_route
ad_filter:      # enabled/level(off|ads|ads+tracking|full)/extra_domains/hosts_file/allowlist
browser:        # enabled/headless/pool_size/idle_ttl_ms/engine(chromium|camoufox预留)/proxy_*/wait_for_selector/screenshot
embedding:      # enabled/provider(openai|ollama)/base_url/model/dim/timeout_ms/batch_size/max_input_chars/query_prefix/passage_prefix
corpus:         # enabled/store_path/ttl_ms/recall_k/sweep_interval_ms
```

> 并发作用域：`flaresolverr.max_concurrent` 是**全进程**上限（所有 MCP 会话合计，防止 Chromium 内存线性放大）；`search.max_concurrent` 仍是**每会话**上限（多会话聚合为 N×值，只影响延迟）。

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

`search` 传 `categories=search_by_image`：`query` 给图片 URL，或改用 `image_path` 给本地图片 —— 会**并发**启用四路源（ADR-0010 / ADR-0012）：

| 源 | 承载方 | 覆盖 | 成本 |
|---|---|---|---|
| searxng 的 `tineye` | searxng 引擎（上游自带） | 任意图片的"网络出现处"（近似重复匹配） | 需在 searxng 的 `settings.yml` 里给 tineye 声明 `categories: [search_by_image]`（见 `searxng-ext/settings.example.yml` / `docker/searxng/settings.template.yml`）；网关不点名引擎 |
| `tracemoe` | 网关侧附加源 | 动画截图 → 动画出处（AniList 标题/集数/时间点） | 免费、按 IP 100 次/日 |
| `saucenao` | 网关侧附加源 | **插画 / 同人图出处**（Pixiv / Danbooru / Twitter…） | 免费 key（实测免费账号 100 次/天、4 次/30 秒）；**需在 `secrets.yaml` 填 `search.reverse_image.saucenao.api_key` 才启用** |
| `baidu` | 网关侧附加源 | **中文 / 国内图**（完全相同图 + 相似图） | 免费（抓网页、无 key、有风控） |

```jsonc
// 示例：以图搜图（图 URL 写在 query 里）
{ "query": "https://example.com/some-image.jpg", "categories": "search_by_image" }
// 本地图（与 query 里的图片 URL 互斥）
{ "query": "", "image_path": "/tmp/shot.jpg", "categories": "search_by_image" }
```

- **「图就是 query」**：URL 输入时图片 URL 写在 `query` 里（与 searxng 的 `online_url_search` 同形）；本地图用 `image_path`（网关同机路径）。两者必有其一，都缺席时只附提示、不调网关侧源。
- 各源候选统一成同一线格式后**按 URL 去重**（同 URL 的引擎归属并写入 `engines[]`），再走与 `categories=images` 相同的排序/渲染管线（图片直链 + 不走语义层）。
- 排序：按 `score`（tineye 匹配分 / trace.moe 与 SauceNAO 的 similarity / 百度识图的约定分）× `engine_boost`；`rerank.diversity` 开启时同注册域去冗余。
- 失败不致命：**单个源**失败/超时/无匹配都不影响其它源，只在结果末尾各附一条提示（`反向图搜：…`）。
- **本地图直传**：`tracemoe` / `saucenao` / `baidu` 都以 multipart 直传图片字节，**不经图床**；只有 `tineye` 需要公网 URL（见下）。
- **部署检查**：searxng 若没声明该类别，请求会被静默过滤、回落成 `general` 搜索（不报错）。验证：`curl -s localhost:8888/config | grep search_by_image`。
- 非敏感配置在 `gateway.yaml` 的 `search.reverse_image`（开关 / 触发类别 / `sources` 清单 / 各源地址与超时）；SauceNAO 的 `api_key` 在 `secrets.yaml`。

#### 本地图片（`image_path`）

`image_path` 给一张**网关所在机器上**的图片路径（MCP 没有上传通道，所以是同机路径），与 `query` 里的图片 URL **互斥**：

```jsonc
{ "query": "", "image_path": "/tmp/shot.jpg", "categories": "search_by_image" }
```

- **网关侧源直传**：`tracemoe`（字段 `image`）/ `saucenao`（字段 `file`）/ `baidu`（字段 `image`）都以 multipart 直接接收图片字节，**不经图床**；但它们各自是第三方服务（图仍会发给该服务）。
- **要 tineye 参与就得发布**：tineye 的图片是 **TinEye 服务器**去拉的，必须给一个**公网可达的图片 URL** → 网关先把图发布到图床（`search.reverse_image.publish`，uguu/pomf 协议，默认 `https://uguu.se/upload?output=json`），再拿返回的 URL 当 searxng 的 query。
  - ⚠️ **这一步会把图上传到公网第三方**：图公网可见、由对方按其 TTL 删除（uguu 为 **3 小时**），对方还会保留短时的**上传 IP / 文件名 / 哈希**日志。只有显式传 `image_path` 才会发生；`query` 给 URL 的老路径不发布。不想要就设 `publish.enabled: false`。
  - 发布前做三重校验：常规文件、大小 ≤ `local_max_bytes`（默认 5MiB）、**magic bytes 必须是图片** → 不可能把配置/密钥之类的文件发出去。
  - 发布失败**不影响**结果：跳过 searxng（tineye 不参与），仍返回网关侧源的结果并附一条提示。
  - 想换图床（含自建 pomf/uguu 实例）：改 `publish.endpoint` 即可，协议同形。
- 本地图请求**不写搜索缓存**（同路径文件内容会变），渲染标题退化为文件名。
- 出处/留存等细节见 `docs/adr/0011`。

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

## 后端安装（一个后端一个）

外部后端统一装到 `data/backends/<name>/`，安装/更新后自动把可执行文件路径写回 `gateway.yaml`。每个脚本都支持 `install | update | status | uninstall`（默认 `install`）。

| 后端 | Linux/macOS | Windows | 说明 |
|---|---|---|---|
| B 站 `bili` CLI | `./scripts/backends/bili.sh` | `scripts\backends\bili.ps1` | PyPI `bili-agent`，需要 Python ≥3.10 |
| `yt-dlp` | `./scripts/backends/ytdlp.sh` | `scripts\backends\ytdlp.ps1` | 官方独立二进制，自动校验 SHA256 |
| 微博 `OpenCLI` | `./scripts/backends/opencli.sh` | `scripts\backends\opencli.ps1` | npm 包；微博 override 会复制到 `~/.opencli/clis/weibo/` |
| B 站专栏 HTTP 服务 | `./scripts/backends/article.sh` | `scripts\backends\article.ps1` | 独立仓库 `djasdh/bilibili-article-server`（GPL-3.0） |

```bash
./scripts/backends/bili.sh install
./scripts/backends/ytdlp.sh update
./scripts/backends/article.sh status
./scripts/backends/opencli.sh uninstall
```

- 安装目录、版本、原配置值都在 `data/backends/<name>/`，`uninstall` 会还原 `gateway.yaml`。
- `opencli` 只在 `gateway.yaml` 已有 `weibo` 段时写 `weibo.cli.command`；私有分支没有该段时只安装、不写配置。
- 专栏服务需要登录态：在启动网关的环境里设置 `BILI_COOKIE` 或 `BILI_COOKIE_FILE`，不要写进 `gateway.yaml`。
- 如果 PATH 里没有 Node，薄包装会自动下载官方 LTS 到 `data/toolchain/node/`。
- 代理环境：脚本读取 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`，优先用系统 `curl` 下载（Windows 10+ 自带 `curl.exe`）。

## 网关自更新（一个平台一个）

```bash
./scripts/self-update/linux.sh            # Linux
./scripts/self-update/macos.sh            # macOS
scripts\self-update\windows.cmd           # Windows
```

流程：从公开仓库最新正式 Release 下载对应平台完整包 → SHA256 校验 → 解压到 `data/releases/<version>-<platform>/` → 切换 `data/current` → 重启并健康检查 → 失败自动回滚。

```bash
./scripts/self-update/linux.sh --check               # 只检查新版本
./scripts/self-update/linux.sh --version v0.2.0      # 指定版本
./scripts/self-update/linux.sh --no-restart          # 只更新不重启
./scripts/self-update/linux.sh --repo <owner>/<name> # 换发布源
```

- `gateway.yaml`、`secrets.yaml`、`data/` 不随版本切换；更新前请确认已备份密钥。
- 自更新只切换 `dist/` 与 `node_modules/`；`scripts/` 属于安装器，不随版本覆盖（升级安装器请重新拉取仓库）。
- 只保留最近 3 个版本；当前/上一版本记录在 `data/installed.json`。
- 完整包包含生产 `node_modules`，目标机器不需要 npm/tsc；Playwright 浏览器仍需首次 `npx playwright install chromium` 或已有浏览器。
- 代理环境：脚本读取 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`，优先用系统 `curl` 下载；GitHub API 元数据仍走 Node `fetch`。

## 管理脚本

```bash
./scripts/gateway.sh start|stop|restart|status|logs [searxng|flaresolverr|gateway|all]
./scripts/gateway.ps1 start|stop|restart|status|logs        # Windows（只管理 gateway）
node scripts/start-all.mjs                                  # 前台启动/监督全部组件（安装器自启入口）
node scripts/start-all.mjs --check                          # 只检查 launch.json 与健康状态
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
