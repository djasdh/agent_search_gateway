# bilibili-article-server

最小的 B 站视频详情、专栏正文、评论与音频直链 HTTP 服务，供 `agent_search_gateway` 的 `bilibili` HTTP 后端拉起，转发 `/detail`、`/article`、`/comments` 与 `/playurl`。

## 安装

Python 3.10+；`bilibili-api-python` 需 `httpx`/`aiohttp`/`curl_cffi` 之一，`requirements.txt` 默认带 `httpx`。

```bash
cd scripts/bilibili-article-server
python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
```

## 启动

```bash
python3 server.py --host 127.0.0.1 --port 8010  # 默认 127.0.0.1:8010
```

## 环境变量

| 变量 | 说明 |
|---|---|
| `BILI_COOKIE` | 登录态 Cookie，如 `SESSDATA=...; bili_jct=...`，优先级最高。 |
| `BILI_COOKIE_FILE` | Cookie 文件路径，支持 `name=value; ...` 或 Netscape 格式；`BILI_COOKIE` 非空时忽略。 |
| `BILI_HTTP_TOKEN` | 非空时所有请求需带 `Authorization: Bearer <token>`，否则返回 401。 |

无 `SESSDATA` 时按游客态运行。Cookie 仅存内存，不写文件、不打日志。

## 接口

`GET /health`（不联网，`loggedIn` 仅表示是否读到 `SESSDATA`）：

```bash
curl -s http://127.0.0.1:8010/health
# {"ok":true,"loggedIn":false,"maxQuality":"n/a","service":"bilibili-article-server"}
```

`GET /detail?target=BV1xx411c7mD`（视频详情，`pages` 全量标题）：

```bash
curl -s 'http://127.0.0.1:8010/detail?target=BV1xx411c7mD'
```

`GET /article?cv=123`（`cv` 也接受 `cv123` 或含 `cv123` 的链接）：

```bash
curl -s 'http://127.0.0.1:8010/article?cv=123'
```
```json
{"ok":true,"data":{"cv":"123","title":"专栏标题","content":"正文纯文本……","meta":{"mid":123456,"author":"UP 主","publishTime":1700000000,"words":1234,"category":{"id":1,"name":"动画"},"stats":{"view":1000,"like":10},"url":"https://www.bilibili.com/read/cv123"}}}
```

`GET /comments?target=BV1xx411c7mD&page=1&sort=hot`（`target` 也接受 av 号或含 cv 的链接）：

```bash
curl -s 'http://127.0.0.1:8010/comments?target=BV1xx411c7mD&page=1&sort=hot'
```
```json
{"ok":true,"data":{"bvid":"BV1xx411c7mD","page":1,"total":100,"hasMore":true,"nextPage":2,"items":[{"rpid":1,"mid":123,"uname":"UP","content":"评论","like":10,"ctime":1700000000,"replies":[]}]}}
```

`GET /playurl?target=BV1xx411c7mD&p=1`（只返回音频直链）：

```bash
curl -s 'http://127.0.0.1:8010/playurl?target=BV1xx411c7mD&p=1'
```
```json
{"ok":true,"data":{"url":"https://.../audio.m4s?...","bandwidth":132000,"contentType":"audio/mp4"}}
```

失败统一返回 HTTP 200：`{"ok":false,"error":{"code":"...","message":"..."}}`；鉴权失败返回 401，单次抓取超时 20 秒。

## 游客限制

B 站对游客态通常只返回约 432 字预览；未配置 `SESSDATA` 且正文长度接近 432 字时返回：

```json
{"ok":false,"error":{"code":"BILI_AUTH_REQUIRED","message":"当前为游客态，B 站只返回约 432 字预览；请通过 BILI_COOKIE 或 BILI_COOKIE_FILE 配置登录态 Cookie 后重试。"}}
```

## 许可证

本目录以 **GPL-3.0-or-later** 发布（见 `LICENSE`），与仓库主体的 MIT 分开。正文解析 derived from [paopaonb666/bilibili-article-kb](https://github.com/paopaonb666/bilibili-article-kb)（MIT）。运行时依赖 `bilibili-api-python` 为 GPL-3.0-or-later，以独立库导入，不修改其源码。
