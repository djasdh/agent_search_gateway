# SPDX-License-Identifier: AGPL-3.0-or-later
"""Engine to search Zhihu via the official `Zhihu Developer API`_.

A single module backs two engine instances, selected by :py:obj:`scope`:

- ``scope: zhihu`` -- in-site Q&A / article search
  (``/api/v1/content/zhihu_search``, ``Count`` <= 10)
- ``scope: web``   -- whole-web search
  (``/api/v1/content/global_search``, ``Count`` <= 20, ``SearchDB: all``)

Authentication requires **two** headers::

    Authorization: Bearer <Access Secret>
    X-Request-Timestamp: <unix seconds>

A missing/expired timestamp is rejected with code ``20001``.  The secret is
read from the ``ZHIHU_ACCESS_SECRET`` environment variable when the ``api_key``
setting is left empty.

.. code:: yaml

  - name: zhihu
    engine: zhihu
    shortcut: zh
    scope: zhihu
  - name: zhihu web
    engine: zhihu
    shortcut: zhw
    scope: web
    count: 3

.. _Zhihu Developer API: https://developer.zhihu.com
"""

import os
import time
import typing as t
from datetime import datetime, timezone
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from searx.exceptions import SearxEngineAPIException
from searx.result_types import EngineResults
from searx.utils import html_to_text

if t.TYPE_CHECKING:
    from searx.extended_types import SXNG_Response
    from searx.search.processors import OnlineParams


about = {
    "website": "https://www.zhihu.com",
    "wikidata_id": None,
    "official_api_documentation": "https://developer.zhihu.com",
    "use_official_api": True,
    "require_api_key": True,
    "results": "JSON",
}

categories = ["general", "web"]
paging = False
timeout = 15.0

base_url = "https://developer.zhihu.com"

api_key: str = ""
"""Zhihu Access Secret; falls back to env ``ZHIHU_ACCESS_SECRET``."""

scope: str = "zhihu"
"""``zhihu`` (in-site search) or ``web`` (whole-web search)."""

count: int = 0
"""Results per request; ``0`` uses the scope default (``10`` / ``20``)."""

search_db: str = "all"
"""``SearchDB`` for ``global_search``: ``all``, ``realtime`` or ``static``."""

content_max_characters: int = 500
"""Truncate ``ContentText`` to at most this many characters."""

_ENDPOINTS = {
    "zhihu": "/api/v1/content/zhihu_search",
    "web": "/api/v1/content/global_search",
}

_MAX_COUNT = {"zhihu": 10, "web": 20}


def init(_):
    global api_key, count  # pylint: disable=global-statement
    if scope not in _ENDPOINTS:
        raise ValueError(f"Unsupported scope: {scope!r} (expected 'zhihu' or 'web')")
    api_key = api_key or os.environ.get("ZHIHU_ACCESS_SECRET", "")
    if not api_key:
        raise SearxEngineAPIException("No Zhihu access secret provided")
    # ``0`` -> scope default; anything else is clamped into ``[1, scope max]``.
    count = min(max(int(count or _MAX_COUNT[scope]), 1), _MAX_COUNT[scope])


def _strip_utm(url: str) -> str:
    """Drop ``utm_*`` tracking parameters, keeping every other query param.

    Zhihu's own links carry ``?utm_medium=openapi_platform&utm_source=<hash>``;
    external URLs in ``global_search`` results have none.  Stripping keeps the
    "original link" contract.
    """
    parts = urlsplit(url)
    if not parts.query:
        return url
    pairs = parse_qsl(parts.query, keep_blank_values=True)
    kept = [(k, v) for k, v in pairs if not k.lower().startswith("utm_")]
    if len(kept) == len(pairs):
        return url
    return urlunsplit(parts._replace(query=urlencode(kept)))


def _published_date(value: t.Any) -> datetime | None:
    """Convert a unix (seconds) ``EditTime`` into an aware datetime."""
    try:
        return datetime.fromtimestamp(int(value), tz=timezone.utc)
    except (TypeError, ValueError, OSError, OverflowError):
        return None


def request(query: str, params: "OnlineParams") -> None:
    """Create the API request (GET, timestamped bearer auth)."""
    query_params: dict[str, t.Any] = {"Query": query, "Count": count}
    if scope == "web":
        query_params["SearchDB"] = search_db

    params["url"] = f"{base_url}{_ENDPOINTS[scope]}?{urlencode(query_params)}"
    params["method"] = "GET"
    params["headers"]["Authorization"] = f"Bearer {api_key}"
    params["headers"]["X-Request-Timestamp"] = str(int(time.time()))


def response(resp: "SXNG_Response") -> EngineResults:
    """Parse ``Data.Items[]`` and emit main results."""
    res = EngineResults()

    payload = resp.json()
    if not isinstance(payload, dict) or payload.get("Code") != 0:
        raise SearxEngineAPIException(f"Zhihu API error: {payload}")

    items = (payload.get("Data") or {}).get("Items") or []
    for item in items:
        url = _strip_utm(item.get("Url") or "")
        if not url:
            continue

        content = html_to_text(item.get("ContentText") or "")
        if len(content) > content_max_characters:
            content = content[:content_max_characters].rstrip() + "…"

        res.add(
            res.types.MainResult(
                url=url,
                title=html_to_text(item.get("Title") or url),
                content=content,
                publishedDate=_published_date(item.get("EditTime")),
                author=item.get("AuthorName") or "",
            )
        )

    return res
