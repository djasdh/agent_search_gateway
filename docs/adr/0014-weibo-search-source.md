# 微博搜索：由类别触发的网关侧文本源

微博搜索/热搜**不新开工具、不加输入字段、不做源级路由**：沿用现有 `search` 工具，用 `categories` 当唯一开关。

- `categories=weibo`：只搜微博帖子，网关直接调用 OpenCLI 的 `weibo search`，**完全不请求 searxng**。
- `categories=weibo_hot`：返回微博热搜榜，调用 `weibo hot`；`query` 可空。

两条路径都要求 `weibo.enabled=true` 且 `search.weibo.enabled=true`。未命中时，`search` 的既有路径逐字不变。

## Considered Options

- **把微博做成 searxng 引擎**：需要在 searxng 容器里装 Node、OpenCLI 和 Chrome，并维护一份微博登录态；与网关已有的 CDP 登录态重复。被否。
- **网关侧 HTTP 服务 + 多后端路由**：当前只有 OpenCLI 一个后端，包装一层 HTTP 只会增加部署面。被否；后续若出现第二个可用后端再评估。
- **新增独立 MCP 工具 `weibo_search`**：与「全部走 search/fetch，不新增工具」的既定模式冲突，也会让 agent 多一个选择成本。被否。
- **把 `weibo` 类别原样转发给 searxng**：searxng 按字面匹配类别，不认识 `weibo`，会静默回落成 `general` 搜索，等于把普通网页混进「只搜微博」。因此网关在内部消费该类别，不转发。
- **复用 `mergeAndRank` 做语义重排**：该函数会从本地语料 KNN 召回并合并文本条目，会把普通网页混进「只搜微博」的结果。被否；微博路径只做 `rerank`（score × boost）→ `cleanResults` → 截断渲染。

## Consequences

- 网关新增一条**网关侧检索出口**（OpenCLI 微博），是 ADR-0006「searxng 单一上游」的**窄例外**。例外边界：必须由类别触发、只产出候选、不参与源级路由、不改变既有排序政策；未命中类别的请求不受影响。
- 微博结果是 `SearxngResult` 线格式，复用现有清洗/去重/渲染；`engine` 写 `weibo` / `weibo_hot`，便于在结果里识别来源。
- `SearchParams` / `SearchOutcome` / `fetch` 工具 schema **均不修改**；只新增配置段 `search.weibo.*`（默认关闭）。
- 微博搜索首次经常返回空（搜索页异步加载，OpenCLI 只等 2 秒）。源内自动重试一次（间隔 1 秒）；重试后仍为空按「没有结果」正常渲染，不报错。
- 微博搜索**只保留微博候选**，不读本地语料、不写语料。排序不使用 embedding，避免为微博查询引入无关文本。
- CLI 调用串行（`Semaphore(1)`），避免多个搜索抢同一个浏览器登录态；结果缓存 `search.weibo.cache_ttl_ms`（默认 60 秒）。
- 失败映射：超时 → `SEARCH_TIMEOUT`；未登录/CLI 不可用/其它 → `SEARCH_UPSTREAM`，文本里带处理提示。微博源失败不会影响普通搜索路径。
- 微博抓取仍走 `fetch` 的 `?weibo=` 动作（ADR 记录见 README）；抓取与搜索共用 `weibo.cli.command` 与登录态，但配置开关独立。
