# 网关保留 searxng 单一上游，外部搜索基础设施作为其引擎接入

Exa 等 AI 搜索基础设施不在网关内做 provider 抽象，而是作为 searxng 的引擎接入；轮换、限流、API 切换都由 searxng 内部承担。网关的搜索边界保持 `searchSearxng` 单一上游不变。

## Considered Options

- **网关内多 provider 端口 + Router**：能表达主备/融合/调用方选，但需引入能力位、跨 provider 去重与排序，复杂度过高；被否。
- **调用方选 provider**：契约更明确，但把轮换责任推给 agent；被否。

## Consequences

- 网关无法感知单个结果来自 Exa 还是别的引擎，也无法据此跳过重排。
- 上游的可用性与轮换不在网关控制内；语料召回恒开，不因上游失败而单独触发。
