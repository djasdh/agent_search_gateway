# SPDX-License-Identifier: AGPL-3.0-or-later
"""Engine to search CNKI (中国知网) through its KNS advanced-search interface.

CNKI 没有公开检索 API，本引擎直接使用 KNS 站内接口。检索本身不需要登录；
零凭据 IP 登录（``IpLoginFlushPo``）只用于拿到会话票据（``LID`` cookie），
以便补全摘要。拿不到票据时仍返回标题/作者/链接（结果降级），因为该权限
绑定机构出口 IP，离开机构网段时登录必然失败。

实测结论（2026-10-17，机构出口 IP 下）：

- 检索：``POST /kns8s/brief/grid``，form body 含 ``QueryJson``；响应是
  **HTML**。失败也是 200，错误信息写在 ``<p class="no-content" value="...">``。
- ``QueryJson`` 必须带 ``Classid``（缺了报「没有指定检索分类」），默认
  ``Classid=WD0FTY92`` / ``Resource=CROSSDB``；``KuaKuCode`` 取高级检索页
  ``#CheckedDB`` 的值（缺了没有结果）。
- ``Operator`` / ``Logic`` 是**数字枚举**（``common.min.js``：
  ``DEFAULT:0, TOPRANK:1, ...``；``AND:0, OR:1, NOT:2``）；传字符串
  ``"TOPRANK"`` 会得到「非法逻辑操作符」。
- 结果行是 ``<tr>``：``td.name``（标题 ``a.fz14``）、``td.author``、
  ``td.source``、``td.date``。
- 摘要页 ``#ChDivSummary`` 是摘要正文；下载（由网关取件插件负责）从摘要页的
  ``#pdfDown`` / ``#cajDown``（``bar.cnki.net/bar/download/order?id=...``）取。

.. _CNKI: https://www.cnki.net/

Configuration
=============

.. code:: yaml

  - name: cnki
    engine: cnki
    shortcut: cnki
    # CNKI 权限绑定机构出口 IP；searxng 全局配了代理时默认绕开。
    # 若代理本身就在机构出口，删掉 network 即可。
    network:
      proxies: {}

Optional settings are:

- :py:obj:`page_size` -- 单页条数（默认 ``50``；实测 CNKI 上限就是 50）
- :py:obj:`num_pages` -- 引擎内翻页数（默认 ``1`` = 关闭）
- :py:obj:`kuaku_code` -- KNS 全库串（默认取高级检索页 ``#CheckedDB`` 的实测值）

``timeout`` 与 :py:obj:`abstract_budget_seconds` **不需要手配**：``init()`` 会按
``page_size × num_pages`` 用引擎自己的耗时模型算出，并把 ``timeout`` 汇报给
searxng。**不要在 settings.yml 里覆盖 ``timeout``**，那会盖掉引擎算出的值。

补摘要走**独立 HTTP 客户端**（curl_cffi，缺失时回落 httpx），不经
``searx.network``——后者把 ``timeout`` 当作引擎的绝对截止时间，会让串行补摘要
从第 N 条起全部瞬间超时。补摘要的预算还会再夹到「本次检索起点 + ``timeout`` -
余量」以内，确保它永远不会撞上 searxng 的 watchdog：撞上会让这批结果被**整批
丢弃**（连标题都没有）。
"""

import hashlib
import json
import math
import os
import re
import threading
import time
import typing as t
from datetime import datetime
from urllib.parse import urljoin

from lxml import html as lxml_html

from searx import logger
from searx.exceptions import SearxEngineAPIException
from searx.network import get, post
from searx.result_types import EngineResults

if t.TYPE_CHECKING:
    from searx.extended_types import SXNG_Response
    from searx.search.processors import OnlineParams


logger = logger.getChild("cnki")

about = {
    "website": "https://www.cnki.net",
    "wikidata_id": "Q1148057",
    "official_api_documentation": None,
    "use_official_api": False,
    "require_api_key": False,
    "results": "HTML",
}

categories = ["academic"]
paging = False

#: 引擎内翻页：对 searxng 仍是「一页」（``paging = False``），所以必须自己把
#: ``pageNum=1..num_pages`` 抓完再返回。searxng 用 :py:obj:`timeout` 作为本引擎
#: 的**绝对截止时间**，超时会丢弃该引擎的全部结果（见 ``searx/search/__init__.py``
#: 的 watchdog），故超时按页数乘法放大。
page_size = 50
"""单页结果条数（1-50）。实测 50 为 CNKI 上限；100 会报「字段【pageSize】校验失败」。"""

num_pages = 1
"""引擎内翻页数（默认 1 = 关闭翻页）。

实测 CNKI 的 ``pageNum>1`` 会返回**验证码页**（``vericodeForm``），翻页拿不到
数据；且多次请求易触发 403 频率风控。故默认只用单页 + 大 ``page_size``。
若要试验翻页，需自行承担反爬风险（见 docs/cnki-channel.md D23）。
"""

# ---------------------------------------------------------------------------
# 耗时模型：引擎自己按条数估算时间，并在 init() 里汇报给 searxng
# （engine.timeout）。searxng 取所有选中引擎的 max 作为 watchdog 的绝对截止
# 时间，超时会丢弃该引擎的全部结果（searx/search/__init__.py 的 actual_timeout
# 与 processors/abstract.py 的 _timeout）。单位成本为实测值；调整 page_size /
# num_pages 时无需改算式。
# ---------------------------------------------------------------------------

_search_seconds = 2.0
"""每次检索往返的耗时估算（秒）。"""

_result_seconds = 0.5
"""每条结果的耗时估算（秒，含串行补摘要）。"""

_timeout_margin = 3.0
"""超时余量（秒）。"""

_http_timeout_seconds = 20.0
"""单次 HTTP 请求超时（秒）；防挂死，与上面的总耗时估算无关。"""

timeout = 20.0
"""引擎总超时（秒）；由 init() 按 ``page_size × num_pages`` 重算后汇报给 searxng。"""

abstract_budget_seconds = 0.0
"""补摘要的内部预算（秒）；由 init() 按条数重算，超出即返回已得部分。"""

#: CNKI 绑定机构出口 IP；默认绕开本地代理。settings.yml 的 ``network`` 可覆盖。
network = {"proxies": {}}

_CLIENT_ID_URL = "https://recsys.cnki.net/RCDService/api/UtilityOpenApi/GenerateClientID"
_LOGIN_URL = "https://login.cnki.net/TopLoginCore/api/loginapi/IpLoginFlushPo"
_GRID_URL = "https://kns.cnki.net/kns8s/brief/grid"
_ADVSEARCH_URL = "https://kns.cnki.net/kns8s/AdvSearch"
_KNS_BASE = "https://kns.cnki.net"

#: ``login.cnki.net`` 前端公开常量（ecpLoginDialogLink.js），不是密钥。
_SECRET = "t8b52yrsoyx66f35tk0p4nubrmrcglv5"

#: 摘要抓取用的浏览器 UA（独立客户端不再有 searxng 注入的 User-Agent）。
_BROWSER_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

#: KNS ``OperatorType`` / ``Logic`` 枚举（common.min.js）。
_OP_TOPRANK = 1
_LOGIC_AND = 0

kuaku_code = "YSTT4HG0,LSTPFY1C,EMRPGLPA,JUP3MUPD,MPMFIG1A,WQ0UVIAA,BLZOG7CK,PWFIRAGL,NN3FJMUV,NLBO1Z6R"
"""KNS 全库串；默认值取自高级检索页 ``#CheckedDB``（实测）。"""

abstract_timeout_seconds = 10.0
"""单条摘要请求的超时上限（秒）。要容忍经代理/隧道的慢路径（实测直连 ~0.25s、经隧道 ~5s）。"""

#: 记录本次检索的起始时刻：``request()`` 与 ``response()`` 在同一 processor 线程，
#: 用 thread-local 传递（引擎是全局单例，不并发共享）。
_TLS = threading.local()


def init(_):
    """校验配置，并按条数算出本引擎的时间预算后汇报给 searxng。

    settings.yml 的覆盖在模块加载**之后**、init **之前**生效（searx/engines/
    ``__init__.py`` 的 setattr），所以耗时必须在 init 里重算，才能用上被覆盖的
    ``page_size`` / ``num_pages``。
    """

    global timeout, abstract_budget_seconds

    if not 1 <= page_size <= 50:
        raise ValueError("page_size must be between 1 and 50")
    if not 1 <= num_pages <= 10:
        raise ValueError("num_pages must be between 1 and 10")

    results = page_size * num_pages
    abstract_budget_seconds = _result_seconds * results
    timeout = _search_seconds * num_pages + abstract_budget_seconds + _timeout_margin


def request(query: str, params: "OnlineParams") -> None:
    """构造 KNS 检索请求；会话票据失败时降级为匿名检索。"""

    _TLS.started = time.monotonic()

    cookies = _flush_session()
    if cookies:
        params["cookies"] = cookies
        # searxng 的 network 层不会把 cookies 写回 ``resp.request.headers``，
        # 而 ``response()`` 需要从那里取会话去抓摘要页；这里显式补一份。
        params["headers"]["Cookie"] = "; ".join(f"{k}={v}" for k, v in cookies.items())

    params["url"] = _GRID_URL
    params["method"] = "POST"
    params["data"] = {
        "boolSearch": "true",
        "QueryJson": json.dumps(_query_json(query), ensure_ascii=False),
        "pageNum": "1",
        "pageSize": str(page_size),
        "sortField": "",
        "sortType": "",
        "dstyle": "listmode",
    }
    params["headers"]["X-Requested-With"] = "XMLHttpRequest"
    params["headers"]["Referer"] = _ADVSEARCH_URL
    params["headers"]["Origin"] = _KNS_BASE
    params["headers"]["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8"


def response(resp: "SXNG_Response") -> EngineResults:
    """解析 KNS 结果网格，并在预算内串行补摘要。"""

    res = EngineResults()
    rows = _parse_grid(resp.text, str(resp.url))
    if not rows:
        error = _grid_error(resp.text)
        if error:
            raise SearxEngineAPIException(f"CNKI: {error}")
        return res

    # 复用检索请求携带的会话 cookie 抓摘要（见 request() 中显式写入的 Cookie 头），
    # 并合并 brief/grid 响应下发的 cookie（如 ``SID_kns_new``）——摘要页会校验它，
    # 缺失时会被重定向到 ``/verify/`` 验证码页，表现为摘要全空。
    cookie = resp.request.headers.get("cookie", "") if resp.request is not None else ""
    cookies = getattr(resp, "cookies", None)
    if cookies is not None:
        try:
            extra = "; ".join(f"{k}={v}" for k, v in cookies.items())
            if extra:
                cookie = f"{cookie}; {extra}" if cookie else extra
        except Exception:  # pylint: disable=broad-except
            logger.debug("CNKI: 合并检索响应 cookie 失败，仅用会话 cookie")
    session = _new_http_session()

    try:
        # 引擎内翻页：第 1 页已由 searxng 取回（resp），这里补齐 pageNum=2..num_pages。
        # 复用同一会话（cookie / 代理）并跨页去重；任一步失败即停，返回已得部分。
        if num_pages > 1:
            rows = _fetch_more_pages(session, resp, rows)

        deadline = time.monotonic() + abstract_budget_seconds
        # 摘要绝不能越过 searxng 的 watchdog：一旦超时，``processors/abstract.py``
        # 会把这批结果**整批丢弃**（连标题都没有）。所以把预算再夹到
        # 「本次检索起点 + timeout - margin」以内，宁可少补几条摘要也要保住结果。
        started = getattr(_TLS, "started", None)
        if started is not None:
            deadline = min(deadline, started + timeout - _timeout_margin)
        for row in rows:
            content = ""
            remaining = deadline - time.monotonic()
            if remaining > 0:
                content = _fetch_abstract(
                    session, row["url"], cookie, min(abstract_timeout_seconds, max(0.5, remaining))
                )
            res.add(
                res.types.Paper(
                    url=row["url"],
                    title=row["title"],
                    content=content,
                    authors=row["authors"],
                    journal=row["source"],
                    comments=row["comments"],
                    publishedDate=row["published"],
                )
            )
    finally:
        if session is not None:
            session.close()

    return res


def _query_json(query: str) -> dict[str, t.Any]:
    """KNS 高级检索的 QueryJson（字段形状见模块 docstring）。"""

    return {
        "Platform": "",
        "Resource": "CROSSDB",
        "Classid": "WD0FTY92",
        "Products": "",
        "QNode": {
            "QGroup": [
                {
                    "Key": "Subject",
                    "Title": "",
                    "Logic": _LOGIC_AND,
                    "Items": [
                        {
                            "Key": "",
                            "Title": "",
                            "Logic": _LOGIC_AND,
                            "Field": "SU",
                            "Operator": _OP_TOPRANK,
                            "Value": query,
                            "ExtendType": 0,
                        }
                    ],
                    "ChildItems": [],
                    "ExtendType": 0,
                }
            ]
        },
        "ExScope": "0",
        "SimpTrad": "0",
        "SearchType": "1",
        "Rlang": "CHINESE",
        "KuaKuCode": kuaku_code,
        "Expands": {},
    }


def _js_nonce(timestamp: int) -> str:
    """模拟前端 ``Math.sin(ts).toString().substr(6)``（实测可用）。"""

    return repr(math.sin(timestamp))[6:]


def _flush_session() -> dict[str, str]:
    """零凭据 IP 登录，返回会话 cookie；任何一步失败都返回已拿到的部分。"""

    try:
        r = get(_CLIENT_ID_URL, headers={"Referer": _KNS_BASE}, timeout=5)
        client_id = (r.json() or {}).get("Data") or ""
    except Exception:  # pylint: disable=broad-except
        logger.debug("CNKI: GenerateClientID 失败，降级为匿名检索")
        return {}

    if not client_id:
        return {}

    cookies = {"Ecp_ClientId": client_id}

    timestamp = int(time.time() * 1000)
    nonce = _js_nonce(timestamp)
    signature = hashlib.md5(
        f"{timestamp}{nonce}{_SECRET}{client_id}".encode(), usedforsecurity=False
    ).hexdigest()

    try:
        r = post(
            _LOGIN_URL,
            content=b"{}",
            headers={
                "Content-Type": "application/json",
                "timestamp": str(timestamp),
                "nonce": nonce,
                "signature": signature,
                "appID": "LoginWap",
                "ClientID": client_id,
                "Referer": "https://login.cnki.net/",
            },
            timeout=5,
        )
        # 响应体是 ``({...})``（外层带括号的非标准 JSON），这里只取 cookie
        cookies.update({c.name: c.value for c in r.cookies.jar})
        if "LID" not in cookies:
            logger.debug("CNKI: IP 登录未返回 LID（可能不在机构网段），结果将缺摘要")
    except Exception:  # pylint: disable=broad-except
        logger.debug("CNKI: IP 登录请求失败，降级为匿名检索")

    return cookies


def _grid_error(text: str) -> str:
    """KNS 在 200 响应里用 ``no-content`` 的 ``value`` 携带错误信息。"""

    m = re.search(r'class="no-content"\s+value="([^"]*)"', text)
    return (m.group(1) or "").strip() if m else ""


def _text(node) -> str:
    return " ".join((node.text_content() or "").split())


def _first_text(tree, xpath: str) -> str:
    found = tree.xpath(xpath)
    return _text(found[0]) if found else ""


def _parse_date(value: str) -> datetime | None:
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(value.strip(), fmt)
        except ValueError:
            continue
    return None


def _parse_grid(text: str, base_url: str) -> list[dict[str, t.Any]]:
    """从 KNS ``brief/grid`` 的 HTML 表格里提取结果行（实测结构见模块 docstring）。"""

    try:
        doc = lxml_html.fromstring(text)
    except Exception:  # pylint: disable=broad-except
        return []

    rows: list[dict[str, t.Any]] = []
    seen: set[str] = set()

    for tr in doc.xpath("//tr"):
        anchors = tr.xpath('.//td[contains(@class, "name")]//a[contains(@class, "fz14")]')
        if not anchors:
            continue
        anchor = anchors[0]
        title = _text(anchor)
        href = (anchor.get("href") or "").strip()
        if not title or not href:
            continue
        url = urljoin(base_url, href)
        if url in seen:
            continue
        seen.add(url)

        # 「网络首发」等标记（<b class="marktip">）从标题列取
        marks = [_text(b) for b in tr.xpath('.//td[contains(@class, "name")]//b[contains(@class, "marktip")]')]
        rows.append(
            {
                "title": title,
                "url": url,
                "authors": [x for x in (_text(a) for a in tr.xpath('.//td[contains(@class, "author")]//a')) if x],
                "source": _first_text(tr, './/td[contains(@class, "source")]'),
                "comments": " ".join(x for x in marks if x),
                "published": _parse_date(_first_text(tr, './/td[contains(@class, "date")]')),
            }
        )

    return rows


def _fetch_more_pages(
    session, resp: "SXNG_Response", first_rows: list[dict[str, t.Any]]
) -> list[dict[str, t.Any]]:
    """补齐 ``pageNum=2..num_pages``；复用第 1 页的请求参数并跨页去重。

    searxng 把本次引擎调用的请求参数挂在 ``resp.search_params`` 上（含 form body
    与 headers），据此构造后续页的同一份检索请求。任一步失败即停止翻页，
    返回已得部分（第 1 页永远保留）。
    """

    params = getattr(resp, "search_params", None) or {}
    data = dict(params.get("data") or {})
    if not data:
        return first_rows

    # 去掉 searxng 的 UA，让 curl_cffi 的浏览器指纹（_new_http_session）生效；
    # 其余（Cookie/Referer/Origin/X-Requested-With/Content-Type）沿用第 1 页。
    headers = {
        k: v for k, v in (params.get("headers") or {}).items() if k.lower() != "user-agent"
    }
    base_url = str(resp.url)
    rows = list(first_rows)
    seen = {row["url"] for row in rows}

    for page in range(2, num_pages + 1):
        body = dict(data)
        body["pageNum"] = str(page)
        try:
            r = _page_request(session, base_url, body, headers)
        except Exception:  # pylint: disable=broad-except
            logger.debug("CNKI: 翻页 pageNum=%s 请求失败，返回已得部分", page)
            break
        if r.status_code != 200:
            break
        page_rows = _parse_grid(r.text, base_url)
        if not page_rows:
            break
        new = [row for row in page_rows if row["url"] not in seen]
        if not new:
            break
        seen.update(row["url"] for row in new)
        rows.extend(new)

    return rows


def _page_request(session, url: str, data: dict[str, str], headers: dict[str, str]):
    """发一次 KNS 检索请求；有独立会话用独立会话，否则回落 ``searx.network``。"""

    if session is not None:
        return session.post(url, data=data, headers=headers, timeout=_http_timeout_seconds)
    return post(url, data=data, headers=headers, timeout=_http_timeout_seconds)


_ABSTRACT_XPATHS = (
    '//span[@id="ChDivSummary"]',
    '//*[contains(@class, "abstract-text")]',
    '//div[@id="abstract"]',
)


def _new_http_session():
    """摘要页抓取用的独立会话。

    **必须绕开 ``searx.network``**：它把 ``timeout`` 当成「引擎绝对截止时间」
    （每次再减去引擎已耗时），串行补摘要时从第 N 条起剩余超时为负，表现为
    整批请求同一时刻 ``Timeout``（摘要全空）。

    优先 curl_cffi（浏览器 TLS 指纹，知网 WAF 对指纹敏感）；不可用时回落
    ``httpx``（独立客户端，同样不经 ``searx.network``）。两者都不可用才返回
    ``None``，此时摘要放弃（保留标题）。
    """

    try:
        from curl_cffi import requests as curl_requests  # pylint: disable=import-outside-toplevel

        return curl_requests.Session(impersonate="chrome")
    except Exception:  # pylint: disable=broad-except
        logger.debug("CNKI: curl_cffi 不可用，摘要抓取回落 httpx")
    try:
        import httpx  # pylint: disable=import-outside-toplevel

        # 显式传 proxy=：httpx 对 HTTPS_PROXY 环境变量的处理不可靠
        # （实测可能绕过代理走本机 IPv6）；引擎的 network.proxies 也不在环境里。
        # 必须自带浏览器 UA：独立客户端不再有 searxng 注入的 User-Agent，
        # 缺失时摘要页会被知网以 403 拒绝。
        proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or None
        return httpx.Client(
            proxy=proxy,
            follow_redirects=True,
            headers={"User-Agent": _BROWSER_UA, "Accept-Language": "zh-CN,zh;q=0.9"},
        )
    except Exception as exc:  # pylint: disable=broad-except
        logger.debug("CNKI: httpx 会话创建失败: %s", exc)
        return None


def _fetch_abstract(session, url: str, cookie: str, timeout: float) -> str:
    """抓取摘要页并提取正文；失败返回空串（保留标题/作者/链接）。"""

    headers = {"Referer": _ADVSEARCH_URL}
    if cookie:
        headers["Cookie"] = cookie
    if session is None:
        return ""
    try:
        r = session.get(url, headers=headers, timeout=timeout)
    except Exception as exc:  # pylint: disable=broad-except
        logger.debug("CNKI 摘要页请求异常: %s", exc)
        return ""
    if r.status_code != 200:
        logger.debug("CNKI 摘要页 HTTP %s", r.status_code)
        return ""
    txt = _parse_abstract(r.text)
    if not txt:
        logger.debug(
            "CNKI 摘要页无正文 len=%d final=%s head=%s",
            len(r.text),
            str(getattr(r, "url", ""))[:80],
            r.text[:110].replace("\n", " "),
        )
    return txt


def _parse_abstract(text: str) -> str:
    try:
        doc = lxml_html.fromstring(text)
    except Exception:  # pylint: disable=broad-except
        return ""

    for xpath in _ABSTRACT_XPATHS:
        for node in doc.xpath(xpath):
            value = _text(node)
            if value:
                return value
    return ""
