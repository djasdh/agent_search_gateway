#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# SPDX-License-Identifier: GPL-3.0-or-later
"""B 站专栏 HTTP 服务（最小实现）。

供 agent_search_gateway 的 bilibili http 后端拉起，转发 GET /detail?target=...、
GET /article?cv=xxx、GET /comments?target=...&page=...&sort=hot|time 与
GET /playurl?target=...&p=...
以 GPL-3.0-or-later 发布（见同目录 LICENSE）；正文解析 derived from
paopaonb666/bilibili-article-kb (MIT)：https://github.com/paopaonb666/bilibili-article-kb
依赖 Python 3.10+、bilibili-api-python（另需 httpx/aiohttp/curl_cffi 之一）。
cookie 仅从环境变量/文件读取，不写文件、不打日志；错误文本做脱敏。
"""

from __future__ import annotations

import argparse, asyncio, concurrent.futures, hmac, html, json, os, re, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

SERVICE_NAME, TIMEOUT, PREVIEW, PREVIEW_TOL = "bilibili-article-server", 20.0, 432, 28
FIELDS = ("sessdata", "bili_jct", "buvid3", "buvid4", "dedeuserid", "ac_time_value")
_COOKIE_RE = re.compile(r"(?i)\b(sessdata|bili_jct|buvid3|buvid4|dedeuserid|ac_time_value)=([^;\s\"']+)")
_CV_URL_RE = re.compile(r"(?:/read/)?cv(\d+)", re.I)
_BLOCK_RE = re.compile(r"(?is)<(?:br\s*/?|/p|/div|/li|/h[1-6]|/blockquote|/pre|/tr)\s*>")
_TAG_RE = re.compile(r"(?s)<[^>]+>")
_AUTH_MSG = "缺少或错误的 Authorization: Bearer <token>。"

class ServiceError(Exception):
    def __init__(self, msg, code="BILI_ARTICLE_FAIL"):
        super().__init__(msg)
        self.code, self.message = code, msg

def _norm(v: str) -> str:
    v = v.replace("\r\n", "\n").replace("\r", "\n")
    return re.sub(r"\n{3,}", "\n\n", "\n".join(x.rstrip() for x in v.split("\n"))).strip()

def extract_text(content) -> str:
    """Quill delta（JSON 字符串/dict）或简单 HTML → 纯文本。"""
    obj = content
    if content and not isinstance(obj, dict):
        text = str(content).lstrip("\ufeff").strip()
        try:
            obj = json.loads(text) if text.startswith("{") else None
        except ValueError:
            obj = None
        if not isinstance(obj, dict):
            return _norm(html.unescape(_TAG_RE.sub("", _BLOCK_RE.sub("\n", text))))
    parts = [op.get("insert") for op in obj.get("ops") or [] if isinstance(op, dict)] if isinstance(obj, dict) else []
    parts = [p if isinstance(p, str) else "\n[图片]\n" if "image" in p else "\n[视频]\n" if "video" in p else ""
             for p in parts if isinstance(p, (str, dict))]
    return _norm("".join(parts))
def normalize_cv(raw: str):
    """接受 123、cv123 或含 cv123 的链接。"""
    value = (raw or "").strip()
    m = re.fullmatch(r"(?:cv)?(\d+)", value, re.I) or _CV_URL_RE.search(value)
    n = int(m.group(1)) if m else 0
    return str(n) if n > 0 else None
def parse_cookies(text: str) -> dict:
    """解析 Cookie 请求头或 Netscape cookie 文件。"""
    out = {}
    for line in text.splitlines():
        line = re.sub(r"(?i)^cookie:\s*", "", line.strip().removeprefix("#HttpOnly_"))
        if not line or line.startswith("#"):
            continue
        cols = line.split("\t")
        pairs = [(cols[5], cols[6])] if len(cols) >= 7 else [p.partition("=")[::2] for p in line.split(";")]
        for name, value in pairs:
            name, value = name.strip().lower(), value.strip().strip("\"'")
            if name in FIELDS and value:
                out[name] = value
    return out
def safe_error(exc: BaseException, secrets) -> str:
    text = f"{type(exc).__name__}: {exc}".strip()
    for s in secrets:
        if s and len(s) >= 4:
            text = text.replace(s, "***")
    text = _COOKIE_RE.sub(r"\1=***", text)
    return text[:400] + "..." if len(text) > 400 else text
def _content(data):
    if not isinstance(data, dict):
        return None
    vals = [data.get("content")]
    vals += [data[k].get("content") for k in ("readInfo", "read_info") if isinstance(data.get(k), dict)]
    return next((v for v in vals if (isinstance(v, str) and v.strip()) or (isinstance(v, dict) and v)), None)
def build_meta(cv: str, data: dict) -> dict:
    cat = data.get("category")
    cat = {k: cat[k] for k in ("id", "name", "parent_id", "parent_name") if k in cat} if isinstance(cat, dict) else cat
    images = data.get("image_urls") if isinstance(data.get("image_urls"), list) else []
    cover = data.get("banner_url") or (images[0] if images else None)
    meta = dict(mid=data.get("mid"), author=data.get("author_name") or data.get("author"), url=f"https://www.bilibili.com/read/cv{cv}",
                cover=cover, publishTime=data.get("publish_time"), words=data.get("words"), category=cat,
                stats=data.get("stats") if isinstance(data.get("stats"), dict) else None)
    return {k: v for k, v in meta.items() if v is not None}

_BILI = None
def load_bilibili():
    """延迟导入，未安装时 /health 仍可用。"""
    global _BILI
    if _BILI is None:
        try:
            import bilibili_api as bili
        except ModuleNotFoundError as exc:
            raise ServiceError("未安装 bilibili-api-python，请先执行 pip install -r requirements.txt。") from exc
        try:
            bili.get_selected_client()
        except bili.ArgsException as exc:
            raise ServiceError("bilibili-api-python 缺少 HTTP 客户端，请安装 httpx、aiohttp 或 curl_cffi 之一。") from exc
        bili.request_settings.set_timeout(TIMEOUT)
        _BILI = bili
    return _BILI

async def fetch_article(cv: str, cookies: dict, logged_in: bool) -> dict:
    bili = load_bilibili()
    cred = bili.Credential(**{k: cookies[k] for k in FIELDS if cookies.get(k)})
    article = bili.article.Article(int(cv), credential=cred)
    try:
        info = await article.get_info()
    except Exception:
        info = None
    # get_info() 通常只有元信息，缺正文时回退 get_detail()。
    data = info
    if _content(data) is None:
        detail = await article.get_detail()
        data = dict(info) if isinstance(info, dict) else {}
        data.update(detail if isinstance(detail, dict) else {})
    content = _content(data)
    if content is None: raise ServiceError("B 站返回数据中没有专栏正文。")
    text = extract_text(content)
    if not logged_in and abs(len(text) - PREVIEW) <= PREVIEW_TOL:
        raise ServiceError("当前为游客态，B 站只返回约 432 字预览；请通过 BILI_COOKIE 或 "
                           "BILI_COOKIE_FILE 配置登录态 Cookie 后重试。", "BILI_AUTH_REQUIRED")
    return {"title": str(data.get("title") or ""), "content": text, "meta": build_meta(cv, data)}

def _comment_target(raw: str):
    s = (raw or "").strip()
    m = re.search(r"(BV[0-9A-Za-z]{10})", s)
    if m: return "video", m.group(1)
    m = re.search(r"/video/av(\d+)", s, re.I)
    if m: return "video", int(m.group(1))
    m = re.search(r"(?:/read/)?cv(\d+)", s, re.I)
    if m: return "article", int(m.group(1))
    raise ServiceError("无法识别的评论目标，示例：BV1xx411c7mD 或 /read/cv123。")

def _map_comment(raw):
    if not isinstance(raw, dict):
        return None
    member = raw.get("member") if isinstance(raw.get("member"), dict) else {}
    content = raw.get("content") if isinstance(raw.get("content"), dict) else {}
    replies = [x for x in (_map_comment(r) for r in (raw.get("replies") or [])) if x]
    return {"rpid": raw.get("rpid") or raw.get("id") or 0, "root": raw.get("root"), "parent": raw.get("parent"),
            "mid": member.get("mid") or 0, "uname": member.get("uname") or "",
            "content": content.get("message") or "", "like": raw.get("like") or 0,
            "ctime": raw.get("ctime") or 0, "replies": replies}

async def fetch_detail(target: str, cookies: dict) -> dict:
    bili = load_bilibili()
    kind, value = _comment_target(target)
    if kind != "video": raise ServiceError("详情只支持视频目标。")
    cred = bili.Credential(**{k: cookies[k] for k in FIELDS if cookies.get(k)})
    video = bili.video.Video(bvid=value, credential=cred) if isinstance(value, str) else bili.video.Video(aid=value, credential=cred)
    data = await video.get_info()
    owner = data.get("owner") if isinstance(data.get("owner"), dict) else {}
    stat = data.get("stat") if isinstance(data.get("stat"), dict) else {}
    keys = ("view", "like", "coin", "favorite", "share", "reply", "danmaku")
    return {"bvid": data.get("bvid") or (value if isinstance(value, str) else ""), "aid": data.get("aid"),
            "title": data.get("title") or "", "desc": data.get("desc") or "",
            "owner": {"mid": owner.get("mid"), "name": owner.get("name")},
            "stat": {k: stat[k] for k in keys if k in stat}, "cover": data.get("pic"),
            "pages": [{"page": p.get("page"), "title": p.get("part") or ""} for p in (data.get("pages") or []) if isinstance(p, dict)]}

def _fetch_detail(target: str) -> dict:
    cookies, _, _ = _SERVICE
    fut = asyncio.run_coroutine_threadsafe(fetch_detail(target, cookies), _LOOP)
    try:
        return fut.result(timeout=TIMEOUT)
    except concurrent.futures.TimeoutError as exc:
        fut.cancel()
        raise ServiceError("请求 B 站详情超时（20 秒），请稍后重试。") from exc

async def fetch_comments(target: str, page: int, order: str, cookies: dict) -> dict:
    bili = load_bilibili()
    kind, value = _comment_target(target)
    cred = bili.Credential(**{k: cookies[k] for k in FIELDS if cookies.get(k)})
    if kind == "video":
        oid = value if isinstance(value, int) else bili.video.Video(bvid=value).get_aid()
        type_ = bili.comment.CommentResourceType.VIDEO
    else:
        oid, type_ = value, bili.comment.CommentResourceType.ARTICLE
    order_enum = bili.comment.OrderType.LIKE if order == "hot" else bili.comment.OrderType.TIME
    data = await bili.comment.get_comments(oid=oid, type_=type_, page_index=page, order=order_enum, credential=cred)
    replies = data.get("replies") or []
    page_info = data.get("page") if isinstance(data.get("page"), dict) else {}
    cursor = data.get("cursor") if isinstance(data.get("cursor"), dict) else {}
    items = [x for x in (_map_comment(r) for r in replies) if x]
    total = page_info.get("acount") or page_info.get("count")
    size = page_info.get("size") or 20
    more = (not bool(cursor.get("is_end"))) if "is_end" in cursor else (page * int(size) < int(total) if total else len(items) >= int(size))
    return {"bvid": target, "page": page, "total": total,
            "hasMore": more, "nextPage": cursor.get("next") or page + 1, "items": items}

def _fetch_comments(target: str, page: int, order: str) -> dict:
    cookies, _, _ = _SERVICE
    fut = asyncio.run_coroutine_threadsafe(fetch_comments(target, page, order, cookies), _LOOP)
    try:
        return fut.result(timeout=TIMEOUT)
    except concurrent.futures.TimeoutError as exc:
        fut.cancel()
        raise ServiceError("请求 B 站评论超时（20 秒），请稍后重试。") from exc

async def fetch_audio(target: str, page: int, cookies: dict) -> dict:
    bili = load_bilibili()
    kind, value = _comment_target(target)
    if kind != "video": raise ServiceError("音频直链只支持视频目标。")
    cred = bili.Credential(**{k: cookies[k] for k in FIELDS if cookies.get(k)})
    video = bili.video.Video(bvid=value, credential=cred) if isinstance(value, str) else bili.video.Video(aid=value, credential=cred)
    data = await video.get_download_url(page_index=max(0, page - 1))
    streams = bili.video.VideoDownloadURLDataDetecter(data).detect()
    audios = [s for s in streams if isinstance(s, bili.video.AudioStreamDownloadURL)]
    if not audios: raise ServiceError("B 站没有返回音频流。")
    best = max(audios, key=lambda s: s.bandwidth or 0)
    return {"url": best.url, "bandwidth": best.bandwidth, "contentType": "audio/mp4"}

def _fetch_audio(target: str, page: int) -> dict:
    cookies, _, _ = _SERVICE
    fut = asyncio.run_coroutine_threadsafe(fetch_audio(target, page, cookies), _LOOP)
    try:
        return fut.result(timeout=TIMEOUT)
    except concurrent.futures.TimeoutError as exc:
        fut.cancel()
        raise ServiceError("请求 B 站音频直链超时（20 秒），请稍后重试。") from exc

_LOOP = asyncio.new_event_loop()
_SERVICE = ({}, False, ())
def _run_loop():
    asyncio.set_event_loop(_LOOP)
    _LOOP.run_forever()
def _fetch(cv: str) -> dict:
    cookies, logged_in, _ = _SERVICE
    fut = asyncio.run_coroutine_threadsafe(fetch_article(cv, cookies, logged_in), _LOOP)
    try:
        return fut.result(timeout=TIMEOUT)
    except concurrent.futures.TimeoutError as exc:
        fut.cancel()
        raise ServiceError("请求 B 站超时（20 秒），请稍后重试。") from exc

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def _send(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try: self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError): pass
    def _auth(self) -> bool:
        token = self.server.token
        got = self.headers.get("Authorization", "")
        return not token or (got.startswith("Bearer ") and hmac.compare_digest(got[7:].strip(), token))
    def _fail(self, code: str, message: str, status: int = 200):
        self._send(status, {"ok": False, "error": {"code": code, "message": message}})
    def do_GET(self):
        if not self._auth(): return self._fail("BILI_AUTH_REQUIRED", _AUTH_MSG, 401)
        url = urlsplit(self.path)
        path = url.path.rstrip("/") or "/"
        if path == "/health":
            return self._send(200, {"ok": True, "loggedIn": _SERVICE[1], "maxQuality": "n/a", "service": SERVICE_NAME})
        query = parse_qs(url.query)
        if path == "/detail":
            target = (query.get("target") or [""])[0]
            try:
                data = _fetch_detail(target)
            except ServiceError as exc:
                return self._fail(exc.code, exc.message)
            except Exception as exc:
                message = safe_error(exc, _SERVICE[2])
                sys.stderr.write("detail %s failed: %s\n" % (target, message))
                return self._fail("BILI_DETAIL_FAIL", f"获取视频详情失败：{message}")
            return self._send(200, {"ok": True, "data": data})
        if path == "/playurl":
            target = (query.get("target") or [""])[0]
            try:
                page = max(1, int((query.get("p") or ["1"])[0]))
            except ValueError:
                page = 1
            try:
                data = _fetch_audio(target, page)
            except ServiceError as exc:
                return self._fail(exc.code, exc.message)
            except Exception as exc:
                message = safe_error(exc, _SERVICE[2])
                sys.stderr.write("playurl %s failed: %s\n" % (target, message))
                return self._fail("BILI_AUDIO_FAIL", f"获取音频直链失败：{message}")
            return self._send(200, {"ok": True, "data": data})
        if path == "/comments":
            target = (query.get("target") or [""])[0]
            try:
                page = max(1, int((query.get("page") or ["1"])[0]))
            except ValueError:
                page = 1
            order = "time" if (query.get("sort") or ["hot"])[0] == "time" else "hot"
            try:
                data = _fetch_comments(target, page, order)
            except ServiceError as exc:
                return self._fail(exc.code, exc.message)
            except Exception as exc:
                message = safe_error(exc, _SERVICE[2])
                sys.stderr.write("comments %s failed: %s\n" % (target, message))
                return self._fail("BILI_COMMENT_FAIL", f"获取评论失败：{message}")
            return self._send(200, {"ok": True, "data": data})
        if path != "/article":
            return self._fail("NOT_FOUND", "未知路径，仅支持 GET /health、/detail?target=...、/article?cv=123、/comments?target=... 与 /playurl?target=...。", 404)
        cv = normalize_cv((query.get("cv") or [""])[0])
        if not cv: return self._fail("BILI_ARTICLE_FAIL", "缺少或非法的 cv 参数，示例：/article?cv=123。")
        try:
            data = _fetch(cv)
        except ServiceError as exc:
            return self._fail(exc.code, exc.message)
        except Exception as exc:
            message = safe_error(exc, _SERVICE[2])
            sys.stderr.write("article cv%s failed: %s\n" % (cv, message))
            return self._fail("BILI_ARTICLE_FAIL", f"获取专栏失败：{message}")
        self._send(200, {"ok": True, "data": {"cv": cv, "title": data.get("title", ""),
                                              "content": data.get("content", ""), "meta": data.get("meta", {})}})
    def do_POST(self):
        if not self._auth(): return self._fail("BILI_AUTH_REQUIRED", _AUTH_MSG, 401)
        self._fail("METHOD_NOT_ALLOWED", "仅支持 GET 请求。", 405)

def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="最小 B 站专栏 HTTP 服务。")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8010)
    a = p.parse_args(argv)
    if not 1 <= a.port <= 65535: p.error("--port 必须在 1-65535 之间")
    try:
        inline, path = os.environ.get("BILI_COOKIE", "").strip(), os.environ.get("BILI_COOKIE_FILE", "").strip()
        text = inline or (open(os.path.expanduser(path), encoding="utf-8").read() if path else "")
    except OSError as exc:
        sys.stderr.write("读取 Cookie 文件失败：%s\n" % safe_error(exc, ()))
        return 1
    global _SERVICE
    cookies = parse_cookies(text)
    _SERVICE = (cookies, bool(cookies.get("sessdata")), tuple(v for v in cookies.values() if v and len(v) >= 4))
    token = (os.environ.get("BILI_HTTP_TOKEN") or "").strip()
    threading.Thread(target=_run_loop, daemon=True).start()
    try:
        httpd = ThreadingHTTPServer((a.host, a.port), Handler)
    except OSError as exc:
        sys.stderr.write("启动 HTTP 服务失败：%s\n" % safe_error(exc, _SERVICE[2]))
        return 1
    httpd.token = token
    print(f"{SERVICE_NAME} 监听 http://{a.host}:{a.port}（登录态：{'是' if _SERVICE[1] else '否'}；"
          f"网关鉴权：{'开启' if token else '关闭'}）", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        _LOOP.call_soon_threadsafe(_LOOP.stop)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
