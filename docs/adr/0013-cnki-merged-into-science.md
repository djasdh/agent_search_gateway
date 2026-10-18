# CNKI 并入 science 类别，移除 academic

原先 CNKI 使用自定义类别 `academic`（原决策编号 D21）。现决定将 CNKI 引擎的 `categories` 由 `["academic"]` 改为 `["science"]`，即并入 searxng 官方的 `science` 类别，使 `science` 成为一个**统一的学术搜索类别**（国际来源 + 中文知网）；`academic` 类别随之移除，不再作为独立类别存在。

为容纳 CNKI 引擎内较慢的串行补摘要（引擎在 `init()` 里按 `page_size × num_pages` 自算 `timeout`，单页 50 条 → 30s），类别感知超时（ADR-0008 / D18）由 `academic: 25000` 改为 `science: 40000`。

## Consequences

- `categories=science` 现在同时召回 CNKI 与 arxiv / pubmed / google scholar / semantic scholar / openaire* / pdbe 等国际引擎；`categories=academic` 不再命中知网（searxng 已无该类别）。
- **所有** `categories=science` 请求的 searxng 超时上限放宽到 25s（原 10s），以容纳 CNKI 摘要抓取；代价是该类别的失败判定阈值一并放宽。
- 未对 CNKI 结果加权（`rerank.engine_boost` 不加 `cnki`），依赖既有重排层自然排序；如需可后续调整。
- 默认搜索行为不变：不指定类别时仍走常驻源 ∪ 轮换源（ADR-0008）。
- 部署侧需同步：searxng 实例的 `settings.yml` 中 cnki 的 `categories` 改为 `[science]`，并按需重建 / 重启 searxng 与 gateway。仓库内模板（`searxng-ext/settings.example.yml`、`docker/searxng/settings.template.yml`）与示例（`gateway.yaml.example`、`docker/gateway.docker.yaml`）已一并更新。
