# SPDX-License-Identifier: AGPL-3.0-or-later
"""Engine to search via You.com's **keyless** MCP endpoint.

You.com exposes a free profile at ``https://api.you.com/mcp?profile=free`` that
requires no API key, no account and no credit card.  It allows the
``you-search`` tool with a limit of 100 queries per day (enforced by
Cloudflare on the source IP, no rate-limit headers are returned).

The endpoint is stateless: no ``initialize`` handshake is needed, a single
``tools/call`` POST per query is enough.  Responses are ``text/event-stream``
and carry the search payload as a JSON string inside ``result.content[0].text``.

Configuration
=============

.. code:: yaml

  - name: youcom
    engine: youcom
    shortcut: you
    disabled: false
"""

import json
import typing as t

from searx.result_types import EngineResults

if t.TYPE_CHECKING:
    from searx.extended_types import SXNG_Response
    from searx.search.processors import OnlineParams


about = {
    "website": "https://you.com",
    "wikidata_id": None,
    "official_api_documentation": "https://you.com/docs",
    "use_official_api": True,
    "require_api_key": False,
    "results": "JSON",
}

categories = ["general", "web"]
paging = False
timeout = 15.0

base_url = "https://api.you.com/mcp?profile=free"

page_size = 10
"""Number of results requested per call (1-100)."""


def init(_):
    return True


def request(query: str, params: "OnlineParams") -> None:
    """Build the JSON-RPC ``tools/call`` request for ``you-search``."""
    params["url"] = base_url
    params["method"] = "POST"
    params["headers"]["Content-Type"] = "application/json"
    params["headers"]["Accept"] = "application/json, text/event-stream"
    params["json"] = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "you-search",
            "arguments": {"query": query, "count": page_size},
        },
    }


def _iter_sse_json(text: str):
    """Yield decoded JSON objects from an SSE body."""
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[len("data:") :].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            yield json.loads(payload)
        except ValueError:
            continue


def _extract_content(item: dict[str, t.Any]) -> str:
    highlights = (item.get("contents") or {}).get("highlights") or []
    if highlights:
        return "\n".join(h for h in highlights if h)
    return item.get("description") or ""


def response(resp: "SXNG_Response") -> EngineResults:
    """Parse the SSE stream and collect ``results.web`` items."""
    res = EngineResults()

    for message in _iter_sse_json(resp.text):
        result = message.get("result")
        if not isinstance(result, dict):
            continue
        for block in result.get("content") or []:
            raw = block.get("text") if isinstance(block, dict) else None
            if not raw:
                continue
            try:
                payload = json.loads(raw)
            except ValueError:
                continue
            web = (payload.get("results") or {}).get("web") or []
            for item in web:
                url = item.get("url")
                if not url:
                    continue
                res.add(
                    res.types.MainResult(
                        url=url,
                        title=item.get("title") or url,
                        content=_extract_content(item),
                    )
                )

    return res
