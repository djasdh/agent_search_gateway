# 本地图片：trace.moe 直传 + 可选的公网发布（图床）

`search` 增加了 `image_path`（网关可读的本地图片路径），只在 `categories` 命中以图搜图类别（默认 `search_by_image`）时可用，且与 `query` 里的图片 URL **互斥**（图只能有一个）。两条源各走各的路：

- **trace.moe**：直接 **multipart 上传图片字节**（`POST /search`，字段 `image`），不经图床、图不外流；因此图床挂了它照样出结果。
- **searxng 的 tineye**：`engine_type=online_url_search` —— 图片由 **TinEye 侧**拉取，所以本地文件必须先变成**公网可达的图片 URL**。这一步交给**图床**（`publish`）。

图床发布用 **uguu/pomf 协议**（实测契约）：

```
POST {publish.endpoint}      # 默认 https://uguu.se/upload?output=json
multipart 字段: files[]
→ {"success":true,"files":[{"hash":"…","filename":"…","url":"https://n.uguu.se/….jpg",…}]}
```

`endpoint` 指到任何 uguu/pomf 系实例即可（含自建），无需改代码。发布成功后就拿返回的 URL 当 searxng 的 query。

**图床不是关键路径**：未启用 / 发布失败 → 跳过 searxng（tineye 不参与）、仍返回 trace.moe 的结果，并在结果末尾附一条提示；绝不因图床让整次搜索失败。

上线前实测了 5 家免 key 图床，**只有 uguu 与 pomf.lain.la 两家能被 TinEye 真的取到**（同一张图 10 条命中）。x0.at / filebin 明明返回 `image/jpeg` 但 TinEye 取不到（按 UA/ASN 拦抓取器），tmpfiles / temp.sh 的"直链"其实是网页；pixeldrain 要 API key，telegra.ph 的 `/upload` 已不可用；catbox / litterbox / 0x0.st / bashupload 在本机直连与代理下都不可达，envs.sh / oshi.at 已变成待售域名。**结论：图床能不能用作基础设施，只能用 TinEye 实测，读 API 文档没用。**

## Considered Options

- **只做 trace.moe（不支持本地图）**：零第三方、图不外流，但本地图就完全拿不到 tineye 的结果；被否（用户要的就是这一半）。
- **只靠 `data:image/...;base64,...` 塞进 query**：searxng 的 tineye 引擎确实支持 data URL，但网关是用 GET 把 query 传给 searxng，长图 base64 会撞 URL 长度上限（只能压到几 KB）；留档不做。
- **自建公网图床**（复用 `/files/<id>` + 反代/隧道）：不依赖第三方、TTL 自己控制。本机试过（公网 IP、`0.0.0.0` 上起临时静态服务），`http://<裸IP>:39321/…` 与 `http://<sslip.io 域名>:39321/…` 让 TinEye 取都是 0 条（无法区分是 NAT 还是 TinEye 拒非标端口/裸 IP）；要落需 **443 + 域名 + https**，成本高于先用现成图床；暂缓。
- **用需 key 的稳定图床**（ImgBB / postimages / SM.MS）：可达但要注册与密钥，且是永久托管，不符合"短期"；先不用。

## Consequences

- **本地图会上传到公网第三方**：图公网可见、由对方按自己的 TTL 删除（uguu 为 3 小时），对方还保留短时的上传 IP / 文件名 / 哈希日志（uguu FAQ 明文）。所以这是**隐私上更重的一步**：`publish.enabled` 默认开（用户选定），但只有**显式给 `image_path`** 时才会用到；`query`=URL 的老路径完全不发布。README 里对用户写清楚。
- **发布前本地三重校验**：必须是常规文件、大小 ≤ `local_max_bytes`（默认 5 MiB，multipart 与图床共用）、**magic bytes 必须是图片**（jpeg/png/gif/webp/bmp/tiff）。合起来保证不可能把任意本地文件（配置、密钥…）发到公网。
- **MCP 没有上传通道**，所以 `image_path` 是"网关所在机器上的路径"——同机假设，README 写明；容器部署时路径要对容器可见。
- 本地图请求**不进搜索缓存**（同一路径的文件内容随时会变），且渲染标题退化为文件名（没有 query 文本可用）。
- 发布耗时约 0.7s，与 trace.moe 并发，端到端约 3.6s（trace.moe 是慢的一侧）。
- 图床返回的域名不固定（uguu 可能给 `n.uguu.se` 子域），代码不写死；`ad_filter.allowlist` 建议加 `uguu.se`，免得我们自己的过滤影响图床直链。
- 图床链接**只用于喂给 TinEye**，不进结果渲染（渲染用的仍是 tineye 返回的 `img_src`）；链接随对方 TTL 过期，不要当长期资源。
