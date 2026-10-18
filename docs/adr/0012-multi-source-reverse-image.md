# 多源反向图搜：附加源契约 + SauceNAO + 百度识图

ADR-0010 让以图搜图（`categories=search_by_image`）在 searxng 的 tineye 之外，再并发一个**网关侧附加源** trace.moe（动画截图）。本 ADR 把"附加源"从"硬编码一个 trace.moe"抽象为**清单驱动的多源契约**，并按同一契约接入两个新源：

| 源 | 性质 | 覆盖 | 成本 | 输入 |
|---|---|---|---|---|
| `tracemoe` | 官方 API | 动画截图 → 动画出处 | 免费（按 IP 限额） | URL / 字节 |
| `saucenao` | 官方 API（需 key） | 插画 / 同人图出处（Pixiv / Danbooru / Twitter…） | 免费 key（150 次/天、4 次/30 秒） | URL / 字节 |
| `baidu` | 抓网页（graph.baidu.com） | 中文 / 国内图 | 0 | URL（先下载）/ 字节 |

searxng 侧仍由 tineye 承担（`engine_type = online_url_search`）。四路候选统一成 `SearxngResult` 线格式 → 按 URL 去重（`engines[]` 取并集）→ 进现有排序。

## 契约（`src/search/sources.ts`）

```ts
type SourceCall =
  | { ok: true; results: SearxngResult[]; latencyMs: number; quota?: number; quotaUsed?: number; remaining?: {...} }
  | { ok: false; error: { kind: "timeout"|"http"|"network"|"invalid_json"|"api"; status?: number; message: string } };

type ImageInput =
  | { kind: "url"; url: string }
  | { kind: "bytes"; bytes: Uint8Array; filename: string; mime: string };
```

service 按 `reverse_image.sources` 清单**并发**扇出（每个源内部都不抛裸异常），逐源降级：单源失败/超时不影响其它源，只在结果尾部加一条提示。`sources` 默认仍是 `["tracemoe"]`（升级后行为不变）；`saucenao` 需配置 `api_key` 才会真正发起；`baidu` 由 `baidu.enabled` 控制。

## 为什么走网关侧附加源，而不是写成 searxng 引擎

searxng 全库只有 tineye 一个 `online_url_search`（能"拿图当 query"）引擎，且**不支持文件上传** —— 本地图（`image_path`）必须先发布到公网图床才能喂给它。网关侧附加源可直接 multipart 直传（图不外流），也免去维护 Python 引擎、跟随 searxng 升级（ADR-0010 已否掉引擎化）。

## 各源要点

### SauceNAO（官方 API）
- `POST https://saucenao.com/search.php`，参数 `output_type=2 / db=999 / numres / minsim(默认 30) / hide=0 / api_key`；输入 `url=` 或 multipart 字段 **`file=`**。
- 响应 `{ header:{ status, short_remaining, long_remaining, … }, results:[ { header:{ similarity, thumbnail, index_name, hidden }, data:{ title|material|jp_name, author|member_name|…, ext_urls, pixiv_id, … } } ] }`。
- `status < 0` = 业务拒绝（如**匿名 key 不允许 API 调用**，实测）→ 归类 `api` 错误。
- **必须注册免费 key**；限额 150 次/天、4 次/30 秒，网关把 `short/long remaining` 透进"无匹配"提示。

### 百度识图（抓网页）
- 三步：① `POST graph.baidu.com/upload`（header `Acs-Token: ""`，multipart `from=pc` + `image`）→ `data.url`；② `GET` 结果页 → 从 HTML 抠 `window.cardData`；③ `same.list[]`（完全相同）/ `simipic.firstUrl` → JSON `data.list[]`（相似）。
- **纯 IPv6 出口会被百度 Reject**；网关的 `fetch`（undici，Happy Eyeballs 会挑 IPv4）正常。用 curl 调试需加 `-4`。
- 百度不提供相似度 → 给排序约定分：`same`=1.0、`simipic`=0.5（**不是**跨源融合打分，只是让它在统一排序里不永远垫底）。
- 抓取脆弱：百度改版（`window.cardData` 消失）即失效 → 归入定期回归；失败只报结构化错误。

## Considered Options

- **Google Lens**：免费抓 `lens.google.com`（PicImageSearch 做法，易 403、需维护）或付费 SerpApi（免费 250 次/月、$25/月起 1000 次）。本次**不做**。
- **把 SauceNAO / 百度做成 searxng 引擎**：被否（不支持上传 + 需维护 Python）。
- **ascii2d / IQDB / Bing 反图**：契约同形，机制就绪后可按同一契约随时新增。

## Consequences

- **多源 = 更多第三方收到图**：URL 输入时各源各自取图（tineye 侧 TinEye 拉、百度侧网关先下载再上传）；本地图 multipart 直传给 trace.moe / SauceNAO / 百度，**只有 tineye 需要先发布到公网图床**（ADR-0011）。均在 README 写明。
- **端到端延迟取最慢源**：各源独立超时、彼此并发。
- **metrics 变更**：`SearchMetrics.reverseImage` 由单源对象 → `{ sources:[{name,ok,results,ms,error}], ms, published?, publishMs? }`（会破坏旧日志分析）。
- **限额**：SauceNAO 额度小（150/天）易耗尽，需节流/提示；trace.moe 按 IP 100/天；百度无明确额度但有风控。
- 许可：三者均为**服务调用**（不引入其代码）；参考实现 PicImageSearch 为 MIT，仅参考接口形态。
