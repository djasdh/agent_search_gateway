# SPDX-License-Identifier: AGPL-3.0-or-later
"""配额台账插件（§9）。

三种额度形状:
  - ``daily``   自然日上限（窗口 YYYY-MM-DD，跨日自动重置）
  - ``monthly`` 自然月池（窗口 YYYY-MM，跨月自动重置）
  - ``once``    一次性余额（窗口恒为 ``once``，只减不增）

行为:
  - ``pre_search`` 选中时**自增**计数（失败也要记账，见 §7.4）
  - 已耗尽的引擎从本次请求的 ``engineref_list`` 里就地剔除（主动跳过）

配置文件: ``~/.config/agent-search/quota.config.json``::

    {"engines": {"youcom": {"type": "daily", "limit": 90}, ...}}

台账文件: ``~/.config/agent-search/quota.json``（可由环境变量覆盖）。

注意：测试环境 / 生产环境都读文件，不依赖被跟踪的 searxng 文件。
"""

# pylint: disable=missing-module-docstring

import json
import logging
import os
import tempfile
import threading
from datetime import datetime

from searx.plugins import Plugin, PluginInfo

log: logging.Logger = logging.getLogger("searx.plugins.quota")

DEFAULT_CONFIG_PATH = os.path.expanduser("~/.config/agent-search/quota.config.json")
DEFAULT_LEDGER_PATH = os.path.expanduser("~/.config/agent-search/quota.json")

_LOCK = threading.Lock()


def _config_path() -> str:
    return os.environ.get("QUOTA_CONFIG_PATH") or DEFAULT_CONFIG_PATH


def _ledger_path() -> str:
    return os.environ.get("QUOTA_LEDGER_PATH") or DEFAULT_LEDGER_PATH


def _read_json(path: str):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _atomic_write_json(path: str, data) -> None:
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".quota.", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2, sort_keys=True)
            fh.write("\n")
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _window_for(shape: str, now: datetime) -> str:
    if shape == "daily":
        return now.strftime("%Y-%m-%d")
    if shape == "monthly":
        return now.strftime("%Y-%m")
    return "once"


class QuotaPlugin(Plugin):

    id = "quota"
    active = True

    def __init__(self, plg_cfg):
        super().__init__(plg_cfg)
        self.info = PluginInfo(
            id=self.id,
            name="Quota ledger",
            description="Per-engine quota accounting and exhausted-engine skip",
        )

    def pre_search(self, request, search) -> bool:
        cfg = _read_json(_config_path())
        if not isinstance(cfg, dict) or not isinstance(cfg.get("engines"), dict):
            return True
        specs: dict = cfg["engines"]

        sq = search.search_query
        refs = sq.engineref_list
        tracked = {e.name for e in refs if e.name in specs}
        if not tracked:
            return True

        now = datetime.now()
        exhausted: set[str] = set()

        with _LOCK:
            ledger = _read_json(_ledger_path())
            if not isinstance(ledger, dict):
                ledger = {}
            engines: dict = ledger.get("engines")
            if not isinstance(engines, dict):
                engines = {}
                ledger["engines"] = engines

            for name, spec in specs.items():
                shape = spec.get("type", "monthly")
                limit = int(spec.get("limit", 0))
                entry = engines.get(name)
                if not isinstance(entry, dict):
                    entry = {"used": 0}
                    engines[name] = entry
                window = _window_for(shape, now)
                if shape != "once" and entry.get("window") != window:
                    entry["used"] = 0
                    entry["window"] = window
                entry["type"] = shape
                entry["limit"] = limit
                entry.setdefault("window", window)

            for name in tracked:
                entry = engines[name]
                if int(entry.get("limit", 0)) > 0 and int(entry.get("used", 0)) >= int(entry["limit"]):
                    exhausted.add(name)

            # 计数时机：选中即自增（即使随后调用失败，也已完成记账）
            for name in tracked - exhausted:
                engines[name]["used"] = int(engines[name].get("used", 0)) + 1

            ledger["version"] = 1
            ledger["updated_at"] = now.isoformat(timespec="seconds")
            try:
                _atomic_write_json(_ledger_path(), ledger)
            except OSError as exc:
                log.warning("quota ledger write failed: %s", exc)

        if exhausted:
            before = len(refs)
            refs[:] = [e for e in refs if e.name not in exhausted]
            log.warning(
                "quota: skip exhausted %s (engines %d->%d)",
                sorted(exhausted),
                before,
                len(refs),
            )

        return True
