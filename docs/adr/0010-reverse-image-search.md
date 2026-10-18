# 以图搜图：由类别触发的网关侧附加源（tineye + trace.moe）

以图搜图（reverse image search）**不新开工具、不加输入字段、不做源级路由**：沿用现有转发层，用一个请求类别 `search_by_image` 当唯一开关。命中该类别时，两件事同时发生——

1. `categories=search_by_image` 原样转发给 searxng；searxng 侧的 **tineye** 引擎（上游自带，`engine_type=online_url_search`）在 `settings.yml` 里声明了该类别，于是被"按类别选引擎"的逻辑选中。网关**不点名引擎**，ADR-0008 的「非 general 类别抑制常驻/轮换源」自然生效，零改动。
2. 网关再**并发**扇出一个**附加源** **trace.moe**（`search.reverse_image.sources`，默认 `[tracemoe]`），把 query 里的图片 URL 交给它。

两边的候选统一成 `SearxngResult` 线格式，按**规范化 URL 去重**（同 URL 的引擎归属取并集写进 `engines[]`），然后进现有排序尾部（`rerank` → `cleanResults` → `selectImageResults`）——与今天 `categories=images` 完全同一条管线。

**输入契约：「图就是 query」。** 图片以 URL 形式写在 `query` 里（与 searxng `online_url_search` 的 `search_syntax` 同形：`https?://[^ ]*`），网关与 searxng 从同一处取它。本 ADR 不新增输入字段，也不支持「文本 query + 图片」同时给；**本地图片文件**另见 ADR-0011（`image_path` + 可选公网发布）。

## Considered Options

- **网关侧 routing 配置块 + 谓词语言**（`when: {input: image}` / `category:` / `query_matches:` → `sources: [...]`）：能表达任意"输入特征 → 源集合"映射，也能暴露 `sources` 参数。但分派键本来就有现成的 `categories`，再发明一个维度会让"类别"和"源集合"两个概念撞车，且要重写 `planEngineBatches`/缓存键；被否。
- **把 trace.moe 做成 searxng 引擎**：要么在 Python 侧重算图向量（ColorLayout，需移植算法与依赖），要么给 searxng 加向量服务；两条都要动 searxng 运行时，且 ADR-0006 的"检索留在 searxng"本意是**避免网关侧 provider 抽象**，不是"禁止任何网关侧出口"；被否。
- **引入 `trace.moe-id`（MIT）在网关侧本地算向量**，再打 trace.moe 的 `vector` 接口：可以做到图不外传、免上传，但把算法版本与本地依赖（sharp/Node 侧计算）耦合进网关，收益只是"少一次上传"；被否（记录在此，将来若要求"图不外传"再评估）。
- **有序 + 顺序降级（单一源胜出）**：会白白丢掉另一源的候选，而排序层已经是"向量 + 算法"（ADR-0002），降级属于退回旧假设；被否。
- **本地上传图片**：tineye 是 `online_url_search`，图片由 **TinEye 侧拉取**，要求公网可达 URL —— 本机 `/files/<id>` 之类的内网地址不成立。**ADR-0011 已解决**：本地图走 trace.moe multipart 直传，另由图床发布拿到公网 URL 供 tineye 使用。附加源后来**扩展为多源**（SauceNAO / 百度识图，统一契约 + 清单驱动扇出），见 **ADR-0012**。

## Consequences

- 网关出现**第二个检索出口**（trace.moe），这是 ADR-0006「searxng 单一上游」的**第一条例外**。例外边界刻意收窄：附加源**必须由类别触发**、只产出候选、不参与源级路由、不改变排序政策；`CONTEXT.md` 的「上游」「检索」定义随之修订。
- 图片查询仍走 `selectImageResults`：不 embedding、不召回文本语料、不写语料。此时**没有文本 query 向量**，排序 = `score × boost` +（可选）authority + MMR 同域上限；trace.moe 的 `similarity` 与 searxng 的 `score` 同为 0..1，直接混排。**不做源内 min-max 归一化**——两家分数量纲相近，归一化属于阶段 2 的可选项。
- **不支持本地图片文件**。要支持得加一个新输入字段 + 上传通道，且 tineye 那一半仍然无解（除非自建公网可达的图床）。记在 `TODO.md`。
- trace.moe 免 key，按 IP 计 100 次/日、并发 1、ToS 禁商用转售。网关**不建配额台账**，只在失败/无匹配时给一条提示；真正耗尽的表现是"该源无结果"。
- searxng 若**没有**声明该类别，`parse_category_form` 会把它静默过滤掉、请求回落成 `general` 搜索 —— 不报错。部署检查项：`GET /config` 里必须能看到 `search_by_image`（README 已写）。
- 类别名按**字面**匹配（`categ in categories`）。网关侧比较大小写不敏感，并在转发前把命中项归一成配置里的规范名（`search.reverse_image.category`），因此 `Search_By_Image` 与 `search_by_image` 都能用。
- `search_by_image` 会额外挂上 `other` 类别（不在 `categories_as_tabs` 里的类别，searxng 自动补），无害。
- 网关侧附加源的调用结果进 `SearchMetrics.reverseImage`（源名/成败/条数/耗时），便于判断降级。
