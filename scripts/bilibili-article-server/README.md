# bilibili-article-server

最小的 B 站专栏正文 HTTP 服务，供 `agent_search_gateway` 的 `bilibili` HTTP 后端拉起并转发 `/article?cv=xxx`。

只做一件事：根据 cv 号取专栏标题和正文纯文本。不处理视频、音频、评论、弹幕等能力。

## 依赖

- Python 3.10+
- [`bilibili-api-python`](https://pypi.org/project/bilibili-api-python/) `>=17.0`
- 该库运行时不捆绑 HTTP 客户端，需要 `httpx` / `aiohttp` / `curl_cffi` 之一。`requirements.txt` 默认带上 `httpx`。

安装：

```bash
cd scripts/bilibili-article-server
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

> **上游已归档**：`bilibili-api-python` 的上游仓库 `Nemo2011/bilibili-api` 已于 2026 年 7 月归档并停止维护，后续 B 站接口变化可能导致本服务失效。

## 启动

```bash
python3 server.py
# 或指定监听地址 / 端口
python3 server.py --host 127.0.0.1 --port 8010
```

参数：

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--host` | `127.0.0.1` | 监听地址 |
| `--port` | `8010` | 监听端口 |

网关配置示例（字段名以当前 `gateway.yaml` schema 为准）：

```yaml
bilibili:
  enabled: true
  routes:
    article: ["http"]
  http:
    base_url: "http://127.0.0.1:8010"
    token: ""          # 与服务的 BILI_HTTP_TOKEN 保持一致；留空表示不鉴权
    command: ["python3", "scripts/bilibili-article-server/server.py"]
```

## 环境变量

| 变量 | 说明 |
|---|---|
| `BILI_COOKIE` | 登录态 Cookie 请求头，例如 `SESSDATA=...; bili_jct=...; buvid3=...`。优先级最高。 |
| `BILI_COOKIE_FILE` | 存放 Cookie 的文件路径。支持普通 `name=value; ...` 文本，也支持 Netscape cookie 文件。`BILI_COOKIE` 非空时忽略此项。 |
| `BILI_HTTP_TOKEN` | 非空时，所有请求都必须带 `Authorization: Bearer <token>`，否则返回 HTTP 401。 |

未配置 `BILI_COOKIE` / `BILI_COOKIE_FILE`，或 Cookie 中没有 `SESSDATA` 时，服务以游客态运行。

Cookie 只保存在进程内存中，不会写入任何文件，也不会打印到启动日志或错误日志。建议把 Cookie 文件权限设为 `600`。

## 接口

### `GET /health`

```bash
curl -s http://127.0.0.1:8010/health
```

```json
{
  "ok": true,
  "loggedIn": false,
  "maxQuality": "n/a",
  "service": "bilibili-article-server"
}
```

`loggedIn` 表示是否从环境变量/文件读到了 `SESSDATA`，不做联网校验。`maxQuality` 固定为 `"n/a"`（专栏服务不涉及画质）。

### `GET /article?cv=123`

```bash
curl -s 'http://127.0.0.1:8010/article?cv=123'
```

成功：

```json
{
  "ok": true,
  "data": {
    "cv": "123",
    "title": "专栏标题",
    "content": "专栏正文纯文本……",
    "meta": {
      "mid": 123456,
      "author": "UP 主昵称",
      "publishTime": 1700000000,
      "words": 1234,
      "category": { "id": 1, "name": "动画" },
      "stats": { "view": 1000, "like": 10 },
      "url": "https://www.bilibili.com/read/cv123"
    }
  }
}
```

`cv` 也接受 `cv123` 或包含 `cv123` 的专栏链接。

业务失败统一返回 HTTP 200（用 `ok: false` 表达）：

```json
{
  "ok": false,
  "error": {
    "code": "BILI_ARTICLE_FAIL",
    "message": "获取专栏失败：..."
  }
}
```

`code` 取值：

- `BILI_ARTICLE_FAIL`：抓取/解析失败、参数非法、超时等。
- `BILI_AUTH_REQUIRED`：游客态只拿到约 432 字预览，需要配置登录态 Cookie。

### 鉴权

当 `BILI_HTTP_TOKEN` 非空时：

```bash
curl -s -H "Authorization: Bearer <token>" \
  'http://127.0.0.1:8010/article?cv=123'
```

缺失或错误的 token 返回 HTTP 401：

```json
{
  "ok": false,
  "error": {
    "code": "BILI_AUTH_REQUIRED",
    "message": "缺少或错误的 Authorization: Bearer <token>。"
  }
}
```

## 游客限制

B 站对游客态专栏正文有 IP 级限流，通常只返回约 432 字预览。服务检测到「未配置 `SESSDATA` 且正文长度接近 432 字」时，会返回：

```json
{
  "ok": false,
  "error": {
    "code": "BILI_AUTH_REQUIRED",
    "message": "当前为游客态，B 站只返回约 432 字预览；请通过 BILI_COOKIE 或 BILI_COOKIE_FILE 配置登录态 Cookie 后重试。"
  }
}
```

需要完整正文时请配置登录态 Cookie。

## 超时与并发

- 单次 `/article` 请求总超时 **20 秒**（含 API 请求和解析）。
- 使用 `ThreadingHTTPServer`，抓取期间 `/health` 仍可响应。
- 所有抓取任务提交到同一个后台 asyncio 事件循环，避免反复创建/销毁事件循环和连接池。

## 实现说明

正文解析流程：调用 `bilibili_api.article.Article(cvid).get_info()`；若返回中没有 `content`（v17 的 `get_info()` 对应 `viewinfo`，通常只有元信息），回退调用 `get_detail()` 获取富文本。随后用 `extract_text()` 把 Quill delta（JSON 字符串或 dict，也兼容简单 HTML）转成纯文本。

## 许可证与归属

- 本目录代码以 **GPL-3.0-or-later** 发布（见同目录 `LICENSE`），与仓库主体的 MIT 分开。
- 正文解析逻辑 derived from [paopaonb666/bilibili-article-kb](https://github.com/paopaonb666/bilibili-article-kb)（MIT License，Copyright (c) 2026 bilibili-article-kb contributors）。
- 运行时依赖 [`bilibili-api-python`](https://pypi.org/project/bilibili-api-python/) 的许可证为 **GPL-3.0-or-later**。它由本服务以独立 Python 库方式导入使用，不修改其源码。使用/分发前请自行确认 GPL 合规性。
