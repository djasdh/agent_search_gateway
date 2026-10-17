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

- :py:obj:`page_size` -- 每次请求条数（默认 ``20``）
- :py:obj:`kuaku_code` -- KNS 全库串（默认取高级检索页 ``#CheckedDB`` 的实测值）
- :py:obj:`abstract_budget_seconds` -- 串行补摘要的总预算（默认 ``18`` 秒）
"""

import hashlib
import json
import math
import re
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
timeout = 20.0

#: CNKI 绑定机构出口 IP；默认绕开本地代理。settings.yml 的 ``network`` 可覆盖。
network = {"proxies": {}}

_CLIENT_ID_URL = "https://recsys.cnki.net/RCDService/api/UtilityOpenApi/GenerateClientID"
_LOGIN_URL = "https://login.cnki.net/TopLoginCore/api/loginapi/IpLoginFlushPo"
_GRID_URL = "https://kns.cnki.net/kns8s/brief/grid"
_ADVSEARCH_URL = "https://kns.cnki.net/kns8s/AdvSearch"
_KNS_BASE = "https://kns.cnki.net"

#: ``login.cnki.net`` 前端公开常量（ecpLoginDialogLink.js），不是密钥。
_SECRET = "t8b52yrsoyx66f35tk0p4nubrmrcglv5"

#: KNS ``OperatorType`` / ``Logic`` 枚举（common.min.js）。
_OP_TOPRANK = 1
_LOGIC_AND = 0

page_size = 20
"""每次请求的结果条数。"""

kuaku_code = "YSTT4HG0,LSTPFY1C,EMRPGLPA,JUP3MUPD,MPMFIG1A,WQ0UVIAA,BLZOG7CK,PWFIRAGL,NN3FJMUV,NLBO1Z6R"
"""KNS 全库串；默认值取自高级检索页 ``#CheckedDB``（实测）。"""

abstract_budget_seconds = 18.0
"""串行补摘要的总预算（秒）；超出即返回已得部分。"""

abstract_timeout_seconds = 3.0
"""单条摘要请求的超时上限（秒）。"""


def init(_):
    if not 1 <= page_size <= 50:
        raise ValueError("page_size must be between 1 and 50")


def request(query: str, params: "OnlineParams") -> None:
    """构造 KNS 检索请求；会话票据失败时降级为匿名检索。"""

    cookies = _flush_session()
    if cookies:
        params["cookies"] = cookies

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

    # 复用检索请求携带的会话 cookie 抓摘要（searxng 把 params["cookies"] 合进了请求头）
    cookie = resp.request.headers.get("cookie", "") if resp.request is not None else ""
    deadline = time.monotonic() + abstract_budget_seconds

    for row in rows:
        content = ""
        remaining = deadline - time.monotonic()
        if remaining > 0:
            content = _fetch_abstract(row["url"], cookie, min(abstract_timeout_seconds, max(0.5, remaining)))
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


_ABSTRACT_XPATHS = (
    '//span[@id="ChDivSummary"]',
    '//*[contains(@class, "abstract-text")]',
    '//div[@id="abstract"]',
)


def _fetch_abstract(url: str, cookie: str, timeout: float) -> str:
    """抓取摘要页并提取正文；失败返回空串（保留标题/作者/链接）。"""

    headers = {"Referer": _ADVSEARCH_URL}
    if cookie:
        headers["Cookie"] = cookie
    try:
        r = get(url, headers=headers, timeout=timeout, allow_redirects=True)
    except Exception:  # pylint: disable=broad-except
        return ""
    if not r.ok:
        return ""
    return _parse_abstract(r.text)


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
