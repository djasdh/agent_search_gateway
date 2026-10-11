# embedding 以可插拔外部 provider 为主，自托管仅作备选

下一代将引入 Exa 等 AI 搜索基础设施，其内部具备 embedding；但这些设施作为 searxng 的引擎接入，网关只看到 searxng，也拿不到通用文本向量。语义召回所需的 query 向量仍需独立来源，因此 embedding 采用可插拔的外部 provider（独立于上游 searxng）；自托管 embedding 视为可行但非建议的备选选项。

## Consequences

- 语义召回依赖一个与上游解耦的外部 embedding API；该 API 与上游一起不可用时，退化为引擎分排序，召回不可用。
- 网关看不到单个结果来自哪个引擎，无法据此跳过重排，统一走 searxng 结果 + 纯语义排序。
