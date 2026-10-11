# SPDX-License-Identifier: AGPL-3.0-or-later
"""Engine to search using the `Firecrawl Search API`_.

Firecrawl exposes a search endpoint that returns web, news and image results as
JSON.  An API key is *optional*: the keyless path is free but has a lower rate
limit (and, as observed, is rejected from some datacenter IPs).

.. _Firecrawl Search API: https://docs.firecrawl.dev/features/search

Configuration
=============

Optional settings are:

- :py:obj:`api_key` -- when empty, the keyless endpoint is used (when no
  ``Authorization`` header is sent)
- :py:obj:`page_size` -- number of results to request (default ``10``)

.. code:: yaml

  - name: firecrawl
    engine: firecrawl
    shortcut: fc
    api_key: ""
    disabled: false

The API wraps its payload in a ``success`` / ``data`` envelope::

  {"success": true, "data": {"web": [{url, title, description, position}], ...}}
"""

import os
import typing as t

from searx.exceptions import SearxEngineAPIException
from searx.result_types import EngineResults
from searx.utils import html_to_text

if t.TYPE_CHECKING:
    from searx.extended_types import SXNG_Response
    from searx.search.processors import OnlineParams


about = {
    "website": "https://firecrawl.dev",
    "wikidata_id": None,
    "official_api_documentation": "https://docs.firecrawl.dev/features/search",
    "use_official_api": True,
    "require_api_key": False,
    "results": "JSON",
}

categories = ["general", "web"]
paging = False
timeout = 10.0

base_url = "https://api.firecrawl.dev/v2/search"

api_key: str = ""
"""Firecrawl API key (optional). The keyless endpoint is used when empty."""

page_size: int = 10
"""Number of results to request (1-100)."""


def init(_):
    global api_key  # pylint: disable=global-statement
    api_key = api_key or os.environ.get("FIRECRAWL_API_KEY", "")
    if not 1 <= page_size <= 100:
        raise ValueError("page_size must be between 1 and 100")


def request(query: str, params: "OnlineParams") -> None:
    """Create the API request."""
    params["url"] = base_url
    params["method"] = "POST"
    params["headers"]["Content-Type"] = "application/json"
    if api_key:
        params["headers"]["Authorization"] = f"Bearer {api_key}"
    params["json"] = {"query": query, "limit": page_size}


def response(resp: "SXNG_Response") -> EngineResults:
    """Process the ``success`` / ``data`` wrapped response."""
    res = EngineResults()

    payload = resp.json()
    if not isinstance(payload, dict) or not payload.get("success"):
        raise SearxEngineAPIException(f"Firecrawl returned success=false: {payload}")

    data = payload.get("data") or {}
    for item in data.get("web") or []:
        url = item.get("url")
        if not url:
            continue
        res.add(
            res.types.MainResult(
                url=url,
                title=html_to_text(item.get("title") or url),
                content=html_to_text(item.get("description") or ""),
            )
        )

    return res
