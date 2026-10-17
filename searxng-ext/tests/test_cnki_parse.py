# SPDX-License-Identifier: AGPL-3.0-or-later
"""cnki.py 解析器的离线回归测试。

用 2026-10-17 机构出口 IP 下实测抓取的 HTML 裁剪样本（``fixtures/``）验证：

- 模块级约定（``categories`` / ``timeout`` / ``paging`` / ``network``）
- ``QueryJson`` 形状（**``Operator`` 必须是数字枚举 1 = TOPRANK**，字符串会
  被知网拒绝为「非法逻辑操作符」）
- 结果行解析（``td.name/author/source/date``）
- 摘要解析（``span#ChDivSummary``）与错误信息提取

运行：``python3 -m unittest discover searxng-ext/tests``（或直接执行本文件）。
不联网：``searx.network`` 被替换成会抛错的桩。
"""

import importlib.util
import logging
import sys
import types
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENGINE = HERE.parent / "searx" / "engines" / "cnki.py"
FIXTURES = HERE / "fixtures"

engine = None


def _load_engine():
    """Stub 掉 searx 后加载 cnki.py（本测试只覆盖纯解析函数）。"""

    def stub(name, **attrs):
        mod = types.ModuleType(name)
        for key, value in attrs.items():
            setattr(mod, key, value)
        sys.modules[name] = mod
        return mod

    class SearxEngineAPIException(Exception):
        pass

    def _no_network(*args, **kwargs):
        raise RuntimeError("test must not touch the network")

    searx = stub("searx", logger=logging.getLogger("searx"))
    exc = stub("searx.exceptions", SearxEngineAPIException=SearxEngineAPIException)
    net = stub("searx.network", get=_no_network, post=_no_network)
    rt = stub("searx.result_types", EngineResults=object)
    sys.modules["searx.extended_types"] = stub("searx.extended_types", SXNG_Response=object)
    sys.modules["searx.search.processors"] = stub("searx.search.processors", OnlineParams=dict)
    searx.exceptions, searx.network, searx.result_types = exc, net, rt

    spec = importlib.util.spec_from_file_location("cnki_engine", ENGINE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def setUpModule():  # noqa: N802 (unittest hook)
    global engine
    engine = _load_engine()


class TestModuleContract(unittest.TestCase):
    def test_engine_metadata(self):
        self.assertEqual(engine.categories, ["academic"])
        self.assertEqual(engine.paging, False)
        # 超时按页数乘法放大（searxng 用它作为本引擎的绝对截止时间）
        self.assertEqual(engine.timeout, engine._page_timeout_seconds * engine.num_pages)
        self.assertEqual(engine.about["results"], "HTML")
        self.assertFalse(engine.about["use_official_api"])

    def test_network_bypasses_proxy_by_default(self):
        self.assertEqual(engine.network, {"proxies": {}})


class TestQueryJson(unittest.TestCase):
    def setUp(self):
        self.qj = engine._query_json("深度学习")
        self.item = self.qj["QNode"]["QGroup"][0]["Items"][0]

    def test_operator_is_numeric_toprank(self):
        self.assertEqual(self.item["Operator"], 1)
        self.assertIsInstance(self.item["Operator"], int)
        self.assertEqual(self.item["Logic"], 0)

    def test_required_fields(self):
        self.assertEqual(self.item["Field"], "SU")
        self.assertEqual(self.item["Value"], "深度学习")
        self.assertEqual(self.qj["Classid"], "WD0FTY92")
        self.assertEqual(self.qj["Resource"], "CROSSDB")
        self.assertTrue(self.qj["KuaKuCode"], "KuaKuCode 缺失会导致知网返回无结果")


class TestGridParsing(unittest.TestCase):
    def setUp(self):
        self.rows = engine._parse_grid(
            (FIXTURES / "kns_grid.html").read_text(encoding="utf-8"),
            "https://kns.cnki.net/kns8s/brief/grid",
        )

    def test_row_count_and_fields(self):
        # fixture 取的是响应前 3 个 <tr>，其中首个是表头 → 2 个结果行
        self.assertEqual(len(self.rows), 2)
        first = self.rows[0]
        self.assertTrue(first["title"])
        self.assertTrue(first["url"].startswith("https://kns.cnki.net/kcms2/article/abstract"))
        self.assertTrue(first["authors"], "作者未解析")
        self.assertTrue(first["source"], "来源未解析")
        self.assertIsNotNone(first["published"], "日期未解析")
        self.assertEqual(first["comments"], "网络首发")

    def test_urls_are_unique(self):
        self.assertEqual(len({row["url"] for row in self.rows}), len(self.rows))

    def test_error_extraction(self):
        self.assertEqual(engine._grid_error('<p class="no-content" value="非法逻辑操作符。">'), "非法逻辑操作符。")
        self.assertEqual(engine._grid_error("<div>无错误</div>"), "")
        self.assertEqual(engine._parse_grid("<html>nope</html>", "https://x/"), [])


class TestAbstractParsing(unittest.TestCase):
    def test_ch_div_summary(self):
        text = engine._parse_abstract((FIXTURES / "kns_abstract.html").read_text(encoding="utf-8"))
        self.assertTrue(text.startswith("高光谱遥感图像全色锐化技术"), text[:60])
        self.assertGreater(len(text), 100)


GRID_BASE = "https://kns.cnki.net/kns8s/brief/grid"


class _FakeResp:
    """模拟 searxng 的 SXNG_Response（翻页只用 text/url/search_params）。"""

    def __init__(self, text="", url=GRID_BASE, search_params=None):
        self.text = text
        self.url = url
        self.search_params = search_params if search_params is not None else {}


class _FakeHttpResp:
    def __init__(self, text, status_code=200):
        self.text = text
        self.status_code = status_code


def _grid_html(ids):
    """合成 KNS 结果网格（只含解析器需要的 td.name/author/source/date）。"""

    rows = "".join(
        "<tr>"
        f'<td class="name"><a class="fz14" href="https://kns.cnki.net/kcms2/article/abstract?v={i}">标题{i}</a></td>'
        f'<td class="author"><a>作者{i}</a></td>'
        '<td class="source"><p>来源</p></td>'
        '<td class="date">2026-01-01</td>'
        "</tr>"
        for i in ids
    )
    return f"<html><body><table>{rows}</table></body></html>"


def _ids(rows):
    return [row["url"].split("v=")[-1] for row in rows]


class TestPaging(unittest.TestCase):
    def test_paging_constants(self):
        self.assertEqual(engine.page_size, 20)
        self.assertGreaterEqual(engine.num_pages, 1)
        # 超时/预算都按页数乘法放大，避免 searxng watchdog 丢弃全部结果
        self.assertEqual(engine.timeout, engine._page_timeout_seconds * engine.num_pages)
        self.assertEqual(engine.abstract_budget_seconds, 18.0 * engine.num_pages)

    def setUp(self):
        self._orig_post = engine.post
        self.first = engine._parse_grid(_grid_html(["a", "b"]), GRID_BASE)
        self.resp = _FakeResp(search_params={"data": {"pageNum": "1"}, "headers": {}})

    def tearDown(self):
        engine.post = self._orig_post

    def test_merges_and_dedupes_across_pages(self):
        pages = {"2": _grid_html(["b", "c"]), "3": _grid_html(["d"])}

        def fake_post(url, data=None, headers=None, timeout=None):
            return _FakeHttpResp(pages[data["pageNum"]])

        engine.post = fake_post
        rows = engine._fetch_more_pages(None, self.resp, self.first)
        # 第 1 页 a,b；第 2 页 b(重复)+c；第 3 页 d
        self.assertEqual(_ids(rows), ["a", "b", "c", "d"])

    def test_stops_on_request_error_and_keeps_first_page(self):
        def boom(*args, **kwargs):
            raise RuntimeError("network down")

        engine.post = boom
        rows = engine._fetch_more_pages(None, self.resp, self.first)
        self.assertEqual(_ids(rows), ["a", "b"])

    def test_stops_when_page_has_no_new_rows(self):
        calls = []

        def repeat(*args, **kwargs):
            calls.append(1)
            return _FakeHttpResp(_grid_html(["a", "b"]))  # 与第 1 页完全相同

        engine.post = repeat
        rows = engine._fetch_more_pages(None, self.resp, self.first)
        self.assertEqual(_ids(rows), ["a", "b"])
        # 第 2 页全重复 → 立即停止，不再请求第 3 页
        self.assertEqual(len(calls), 1)

    def test_strips_user_agent_and_reuses_form_body(self):
        captured = {}

        def fake_post(url, data=None, headers=None, timeout=None):
            captured["headers"] = headers
            captured["data"] = data
            return _FakeHttpResp("<html></html>")  # 空网格 → 停止

        engine.post = fake_post
        self.resp.search_params = {
            "data": {"pageNum": "1", "pageSize": "20", "QueryJson": "{}"},
            "headers": {
                "User-Agent": "searxng",
                "Cookie": "a=1",
                "Referer": "https://kns.cnki.net/kns8s/AdvSearch",
            },
        }
        engine._fetch_more_pages(None, self.resp, self.first)
        # 去掉 searxng 的 UA，让 curl_cffi 浏览器指纹生效；其余认证头保留
        self.assertNotIn("User-Agent", captured["headers"])
        self.assertEqual(captured["headers"]["Cookie"], "a=1")
        # form body 复用第 1 页，仅 pageNum 递增
        self.assertEqual(captured["data"]["pageNum"], "2")
        self.assertEqual(captured["data"]["pageSize"], "20")

    def test_missing_search_params_returns_first_page(self):
        self.resp.search_params = {}
        rows = engine._fetch_more_pages(None, self.resp, self.first)
        self.assertEqual(_ids(rows), ["a", "b"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
