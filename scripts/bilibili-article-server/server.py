#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""B 站专栏 HTTP 服务（最小实现）。

供 agent_search_gateway 的 bilibili http 后端按配置拉起并转发 /article?cv=xxx。
只提供专栏正文，不处理视频、评论等能力。

正文解析逻辑 derived from paopaonb666/bilibili-article-kb (MIT)
https://github.com/paopaonb666/bilibili-article-kb

依赖：Python 3.10+、bilibili-api-python（其运行时还需要 httpx/aiohttp/curl_cffi 之一）。
只用标准库 http.server 提供 HTTP 接口，不引入 Web 框架。

安全约定：
- cookie 只从环境变量或文件读取，不写入任何文件、不打印到日志。
- 返回错误前会对异常文本做 cookie 脱敏。
"""

from __future__ import annotations

import argparse
import asyncio
import concurrent.futures
import hmac
import html
import json
import os
import re
import sys
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Mapping, Optional, Tuple
from urllib.parse import parse_qs, urlsplit

SERVICE_NAME = "bilibili-article-server"
MAX_QUALITY = "n/a"

# 单次 /article 请求的总超时（秒）。
REQUEST_TIMEOUT = 20.0

# B 站游客态专栏通常只返回约 432 字预览。
PREVIEW_LENGTH = 432
PREVIEW_TOLERANCE = 28

# bilibili_api.Credential 的字段名（小写）与 cookie 名（小写）一致。
CREDENTIAL_FIELDS = (
    "sessdata",
    "bili_jct",
    "buvid3",
    "buvid4",
    "dedeuserid",
    "ac_time_value",
)

_COOKIE_REDACT_RE = re.compile(
    r"(?i)\b(sessdata|bili_jct|buvid3|buvid4|dedeuserid|ac_time_value)=([^;\s\"']+)"
)
_CV_RE = re.compile(r"^(?:cv)?(\d+)$", re.IGNORECASE)
_CV_URL_RE = re.compile(r"(?:/read/)?cv(\d+)", re.IGNORECASE)
_BLOCK_TAG_RE = re.compile(
    r"(?is)<(?:br\s*/?|/p|/div|/li|/h[1-6]|/blockquote|/pre|/tr)\s*>"
)
_ANY_TAG_RE = re.compile(r"(?s)<[^>]+>")


class ServiceError(Exception):
    """可安全返回给调用方的业务错误。"""

    def __init__(self, code: str, message: str, status: int = HTTPStatus.OK):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


class ArticleTimeout(ServiceError):
    def __init__(self) -> None:
        super().__init__(
            "BILI_ARTICLE_FAIL",
            "请求 B 站超时（20 秒），请稍后重试。",
        )


def _html_to_text(value: str) -> str:
    """把简单 HTML 富文本转为纯文本，保留段落边界。"""
    value = _BLOCK_TAG_RE.sub("\n", value)
    value = _ANY_TAG_RE.sub("", value)
    return html.unescape(value)


def extract_text(content: Any) -> str:
    """把 B 站专栏 content（Quill delta JSON 字符串 / dict / HTML）提取为干净纯文本。

    返回已去除首尾空白、去除行尾空白的文本。

    实现思路与 paopaonb666/bilibili-article-kb 的 extract_text 一致（MIT）。
    """
    if not content:
        return ""

    # delta 可能是 dict 也可能是 JSON 字符串。
    if isinstance(content, dict):
        obj = content
    else:
        text = str(content).lstrip("\ufeff").strip()
        if text.startswith("{"):
            try:
                obj = json.loads(text)
            except Exception:
                return _normalize_text(_html_to_text(text))
        else:
            # 按 HTML 处理。
            return _normalize_text(_html_to_text(text))

    if not isinstance(obj, dict):
        return _normalize_text(str(obj))

    parts = []
    for op in obj.get("ops") or []:
        if not isinstance(op, dict):
            continue
        insert = op.get("insert")
        if isinstance(insert, str):
            parts.append(insert)
        elif isinstance(insert, dict):
            if "image" in insert:
                parts.append("\n[图片]\n")
            elif "video" in insert:
                parts.append("\n[视频]\n")

    raw = "".join(parts)
    return _normalize_text(raw)


def _normalize_text(value: str) -> str:
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    value = "\n".join(line.rstrip() for line in value.split("\n"))
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def _normalize_cv(raw: str) -> Optional[str]:
    """接受 123、cv123 或包含 cv123 的专栏链接，返回纯数字 cv。"""
    value = (raw or "").strip()
    if not value:
        return None
    match = _CV_RE.fullmatch(value)
    if not match:
        match = _CV_URL_RE.search(value)
    if not match:
        return None
    number = int(match.group(1))
    return str(number) if number > 0 else None


def _parse_cookie_text(text: str) -> Dict[str, str]:
    """解析 Cookie 请求头或 Netscape cookie 文件，返回小写字段名到值的映射。"""
    cookies: Dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("#HttpOnly_"):
            line = line[len("#HttpOnly_") :]
        if line.startswith("#"):
            continue
        if line.lower().startswith("cookie:"):
            line = line[len("cookie:") :].strip()

        # Netscape cookie 文件：domain flag path secure expiry name value
        if "\t" in line:
            fields = line.split("\t")
            if len(fields) >= 7:
                name = fields[5].strip().lower()
                value = fields[6].strip()
                if name in CREDENTIAL_FIELDS and value:
                    cookies[name] = value.strip("\"'")
                continue

        for item in line.split(";"):
            if "=" not in item:
                continue
            name, value = item.split("=", 1)
            name = name.strip().lower()
            value = value.strip().strip("\"'")
            if name in CREDENTIAL_FIELDS and value:
                cookies[name] = value
    return cookies


def _credential_kwargs(cookies: Mapping[str, str]) -> Dict[str, str]:
    return {
        name: cookies[name]
        for name in CREDENTIAL_FIELDS
        if cookies.get(name)
    }


def _safe_error_text(exc: BaseException, secrets: Tuple[str, ...]) -> str:
    """把异常文本压缩并脱敏，绝不把 cookie 写进日志或响应。"""
    text = f"{type(exc).__name__}: {exc}".strip()
    for secret in secrets:
        if secret and len(secret) >= 4:
            text = text.replace(secret, "***")
    text = _COOKIE_REDACT_RE.sub(r"\1=***", text)
    if len(text) > 400:
        text = text[:400] + "..."
    return text


def _content_of(data: Any) -> Optional[Any]:
    """从专栏 API 返回中取出 content（兼容 readInfo 结构）。"""
    if not isinstance(data, dict):
        return None
    candidates = [data.get("content")]
    for key in ("readInfo", "read_info"):
        nested = data.get(key)
        if isinstance(nested, dict):
            candidates.append(nested.get("content"))
    for candidate in candidates:
        if isinstance(candidate, str) and candidate.strip():
            return candidate
        if isinstance(candidate, dict) and candidate:
            return candidate
    return None


def _merge_data(info: Any, detail: Any) -> Dict[str, Any]:
    merged: Dict[str, Any] = {}
    if isinstance(info, dict):
        merged.update(info)
    if isinstance(detail, dict):
        merged.update(detail)
    return merged


def _build_meta(cv: str, data: Mapping[str, Any]) -> Dict[str, Any]:
    category = data.get("category")
    if isinstance(category, dict):
        category = {
            key: category[key]
            for key in ("id", "name", "parent_id", "parent_name")
            if key in category
        }

    meta: Dict[str, Any] = {
        "mid": data.get("mid"),
        "author": data.get("author_name") or data.get("author"),
        "publishTime": data.get("publish_time"),
        "words": data.get("words"),
        "category": category,
        "stats": data.get("stats") if isinstance(data.get("stats"), dict) else None,
        "url": f"https://www.bilibili.com/read/cv{cv}",
    }
    return {key: value for key, value in meta.items() if value is not None}


_BILI_LOCK = threading.Lock()
_BILI_MODULE: Optional[Any] = None


def _load_bilibili() -> Any:
    """延迟导入 bilibili_api，保证未安装时 /health 仍可用。"""
    global _BILI_MODULE
    if _BILI_MODULE is not None:
        return _BILI_MODULE

    with _BILI_LOCK:
        if _BILI_MODULE is not None:
            return _BILI_MODULE
        try:
            import bilibili_api as bili
        except ModuleNotFoundError as exc:
            raise ServiceError(
                "BILI_ARTICLE_FAIL",
                "未安装 bilibili-api-python，请先执行 pip install -r requirements.txt。",
            ) from exc

        try:
            # bilibili-api-python 不自带 HTTP 客户端，需要 httpx/aiohttp/curl_cffi 之一。
            bili.get_selected_client()
        except bili.ArgsException as exc:
            raise ServiceError(
                "BILI_ARTICLE_FAIL",
                "bilibili-api-python 缺少 HTTP 客户端，请安装 httpx、aiohttp 或 curl_cffi 之一。",
            ) from exc

        bili.request_settings.set_timeout(REQUEST_TIMEOUT)
        _BILI_MODULE = bili
        return _BILI_MODULE


async def _fetch_article_impl(
    cv: str,
    cookies: Mapping[str, str],
    logged_in: bool,
) -> Dict[str, Any]:
    bili = _load_bilibili()
    credential = bili.Credential(**_credential_kwargs(cookies))
    article = bili.article.Article(int(cv), credential=credential)

    # v17 的 get_info() 是 viewinfo（元信息），通常不含正文；
    # 这里仍按要求优先调用 get_info()，缺 content 时回退 get_detail()。
    info: Any = None
    try:
        info = await article.get_info()
    except Exception:
        info = None

    if _content_of(info) is not None:
        data = info
    else:
        detail = await article.get_detail()
        data = _merge_data(info, detail)

    if not isinstance(data, dict):
        raise ServiceError("BILI_ARTICLE_FAIL", "B 站返回了无法识别的专栏数据。")

    content = _content_of(data)
    if content is None:
        raise ServiceError("BILI_ARTICLE_FAIL", "B 站返回数据中没有专栏正文。")

    text = extract_text(content)
    if not logged_in and abs(len(text) - PREVIEW_LENGTH) <= PREVIEW_TOLERANCE:
        raise ServiceError(
            "BILI_AUTH_REQUIRED",
            "当前为游客态，B 站只返回约 432 字预览；请通过 BILI_COOKIE 或 "
            "BILI_COOKIE_FILE 配置登录态 Cookie 后重试。",
        )

    title = data.get("title") or ""
    return {
        "title": str(title),
        "content": text,
        "meta": _build_meta(cv, data),
    }


async def _fetch_article(
    cv: str,
    cookies: Mapping[str, str],
    logged_in: bool,
) -> Dict[str, Any]:
    return await _fetch_article_impl(cv, cookies, logged_in)


class Service:
    """持有一个后台 asyncio 事件循环，供各 HTTP 工作线程提交抓取任务。"""

    def __init__(self, cookies: Mapping[str, str], logged_in: bool):
        self.cookies = dict(cookies)
        self.logged_in = logged_in
        self.secrets = tuple(
            value for value in self.cookies.values() if value and len(value) >= 4
        )
        self.loop = asyncio.new_event_loop()
        self._thread = threading.Thread(
            target=self._run_loop,
            name="bilibili-article-asyncio",
            daemon=True,
        )

    def start(self) -> None:
        self._thread.start()

    def _run_loop(self) -> None:
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()

    def stop(self) -> None:
        if self.loop.is_running():
            self.loop.call_soon_threadsafe(self.loop.stop)
        if self._thread.is_alive():
            self._thread.join(timeout=2.0)

    def fetch_article(self, cv: str) -> Dict[str, Any]:
        future = asyncio.run_coroutine_threadsafe(
            _fetch_article(cv, self.cookies, self.logged_in),
            self.loop,
        )
        try:
            return future.result(timeout=REQUEST_TIMEOUT)
        except concurrent.futures.TimeoutError as exc:
            future.cancel()
            raise ArticleTimeout() from exc


class AppServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        server_address: Tuple[str, int],
        handler: type[BaseHTTPRequestHandler],
        service: Service,
        token: str,
    ):
        super().__init__(server_address, handler)
        self.service = service
        self.token = token


class Handler(BaseHTTPRequestHandler):
    server_version = "BilibiliArticleServer/1.0"
    protocol_version = "HTTP/1.1"

    @property
    def app(self) -> AppServer:
        return self.server  # type: ignore[return-value]

    def log_message(self, fmt: str, *args: Any) -> None:
        # 默认日志只包含请求行，不包含 Authorization 或 cookie。
        sys.stderr.write(
            "[%s] %s\n" % (self.log_date_time_string(), fmt % args)
        )

    def _authorized(self) -> bool:
        token = self.app.token
        if not token:
            return True
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return False
        return hmac.compare_digest(header[len("Bearer ") :].strip(), token)

    def _send_json(self, status: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _send_error(
        self,
        status: int,
        code: str,
        message: str,
    ) -> None:
        self._send_json(
            status,
            {"ok": False, "error": {"code": code, "message": message}},
        )

    def do_GET(self) -> None:
        if not self._authorized():
            self._send_error(
                HTTPStatus.UNAUTHORIZED,
                "BILI_AUTH_REQUIRED",
                "缺少或错误的 Authorization: Bearer <token>。",
            )
            return

        parsed = urlsplit(self.path)
        path = parsed.path.rstrip("/") or "/"

        if path == "/health":
            self._send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "loggedIn": self.app.service.logged_in,
                    "maxQuality": MAX_QUALITY,
                    "service": SERVICE_NAME,
                },
            )
            return

        if path == "/article":
            query = parse_qs(parsed.query, keep_blank_values=True)
            cv = _normalize_cv((query.get("cv") or [""])[0])
            if not cv:
                self._send_error(
                    HTTPStatus.OK,
                    "BILI_ARTICLE_FAIL",
                    "缺少或非法的 cv 参数，示例：/article?cv=123。",
                )
                return

            try:
                data = self.app.service.fetch_article(cv)
            except ArticleTimeout as exc:
                self._send_error(exc.status, exc.code, exc.message)
            except ServiceError as exc:
                self._send_error(exc.status, exc.code, exc.message)
            except Exception as exc:
                message = _safe_error_text(exc, self.app.service.secrets)
                sys.stderr.write("article cv%s failed: %s\n" % (cv, message))
                self._send_error(
                    HTTPStatus.OK,
                    "BILI_ARTICLE_FAIL",
                    f"获取专栏失败：{message}",
                )
            else:
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "data": {
                            "cv": cv,
                            "title": data.get("title", ""),
                            "content": data.get("content", ""),
                            "meta": data.get("meta", {}),
                        },
                    },
                )
            return

        self._send_error(
            HTTPStatus.NOT_FOUND,
            "NOT_FOUND",
            "未知路径，仅支持 GET /health 与 GET /article?cv=123。",
        )

    def do_POST(self) -> None:
        if not self._authorized():
            self._send_error(
                HTTPStatus.UNAUTHORIZED,
                "BILI_AUTH_REQUIRED",
                "缺少或错误的 Authorization: Bearer <token>。",
            )
            return
        self._send_error(
            HTTPStatus.METHOD_NOT_ALLOWED,
            "METHOD_NOT_ALLOWED",
            "仅支持 GET 请求。",
        )


def _read_cookie_source() -> Tuple[str, str]:
    """按 BILI_COOKIE > BILI_COOKIE_FILE 的优先级读取 cookie 文本。"""
    inline = os.environ.get("BILI_COOKIE", "")
    if inline.strip():
        return inline, "BILI_COOKIE"

    cookie_file = os.environ.get("BILI_COOKIE_FILE", "").strip()
    if cookie_file:
        path = os.path.expanduser(cookie_file)
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read(), "BILI_COOKIE_FILE"

    return "", ""


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="最小 B 站专栏 HTTP 服务（仅供网关 bilibili http 后端调用）。"
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="监听地址，默认 127.0.0.1。",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8010,
        help="监听端口，默认 8010。",
    )
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("--port 必须在 1-65535 之间")

    try:
        cookie_text, cookie_source = _read_cookie_source()
    except OSError as exc:
        # 不打印文件内容，只报告读取失败。
        sys.stderr.write(
            "读取 BILI_COOKIE_FILE 失败：%s\n" % _safe_error_text(exc, ())
        )
        return 1

    cookies = _parse_cookie_text(cookie_text)
    logged_in = bool(cookies.get("sessdata"))
    token = (os.environ.get("BILI_HTTP_TOKEN") or "").strip()

    service = Service(cookies, logged_in)
    service.start()
    try:
        httpd = AppServer((args.host, args.port), Handler, service, token)
    except OSError as exc:
        service.stop()
        sys.stderr.write(
            "启动 HTTP 服务失败：%s\n" % _safe_error_text(exc, service.secrets)
        )
        return 1

    source_hint = f"，cookie 来源 {cookie_source}" if cookie_source else "，游客态"
    print(
        f"{SERVICE_NAME} 监听 http://{args.host}:{args.port}"
        f"（登录态：{'是' if logged_in else '否'}{source_hint}；"
        f"网关鉴权：{'开启' if token else '关闭'}）",
        flush=True,
    )

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        service.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
