import { describe, expect, it } from "vitest";
import { parseQuotaLedger, planEngines, resolveSearxngTimeout, type QuotaLedger } from "../src/search/service.js";
import type { Settings } from "../src/settings/index.js";
import { deepMerge, makeSettings, type DeepPartial } from "./helpers/settings.js";

function makeConfig(overrides: DeepPartial<Settings> = {}): Settings {
  return makeSettings(
    deepMerge(
      {
        search: {
          engines: { rotating: ["youcom", "exaapi", "tavily", "firecrawl"], resident: [] },
          fanout_default: 1,
          quota_tight_threshold: 0.1,
          resident_quota_floor: 0.2,
        },
      },
      overrides,
    ),
  );
}

function plan(
  params: Parameters<typeof planEngines>[0],
  cfg: Settings,
  enabled: Set<string> | undefined,
  quota: QuotaLedger | undefined,
): string[] {
  return planEngines(params, cfg.search, enabled, quota);
}

function timeout(params: Parameters<typeof resolveSearxngTimeout>[0], cfg: Settings): number {
  return resolveSearxngTimeout(params, { search: cfg.search, searxng: cfg.searxng });
}

function entry(limit: number, used: number): QuotaLedger[string] {
  return { type: "monthly", window: "2026-10", limit, used };
}

describe("parseQuotaLedger", () => {
  it("解析合法台账", () => {
    const l = parseQuotaLedger({
      engines: { exaapi: { type: "monthly", window: "2026-10", limit: 2250, used: 5 } },
    });
    expect(l?.exaapi).toEqual({ type: "monthly", window: "2026-10", limit: 2250, used: 5 });
  });

  it("结构非法 → undefined（优雅降级）", () => {
    expect(parseQuotaLedger(null)).toBeUndefined();
    expect(parseQuotaLedger({})).toBeUndefined();
    expect(parseQuotaLedger({ engines: {} })).toEqual({});
    // 类型/数值非法条目被跳过
    expect(parseQuotaLedger({ engines: { x: { type: "bogus", limit: 1, used: 0 } } })).toEqual({});
    expect(parseQuotaLedger({ engines: { y: { type: "daily", limit: "NaN", used: 0 } } })).toEqual({});
  });
});

describe("planEngines 配额消费", () => {
  const enabled = new Set(["youcom", "exaapi", "tavily", "firecrawl"]);

  it("无台账 → 保持原优先级行为（轮换 1 家）", () => {
    const batches = plan({ query: "q" }, makeConfig(), enabled, undefined);
    expect(batches).toEqual(["youcom", "exaapi", "tavily", "firecrawl"]);
  });

  it("剔除已耗尽引擎", () => {
    const quota: QuotaLedger = {
      youcom: entry(90, 10),
      exaapi: entry(2250, 2250), // 耗尽
      tavily: entry(900, 100),
      firecrawl: entry(450, 0),
    };
    const batches = plan({ query: "q" }, makeConfig(), enabled, quota);
    expect(batches).toEqual(["youcom", "tavily", "firecrawl"]);
  });

  it("全部耗尽 → 返回空批次（主动停用）", () => {
    const quota: QuotaLedger = {
      youcom: entry(90, 90),
      exaapi: entry(2250, 2250),
      tavily: entry(900, 900),
      firecrawl: entry(450, 450),
    };
    expect(plan({ query: "q" }, makeConfig(), enabled, quota)).toEqual([]);
  });

  it("fanout>1 时按剩余额度降序排序", () => {
    const quota: QuotaLedger = {
      // 优先级里 tavily 在前，但剩余占比低 → 排序后 exaapi 在前
      tavily: entry(100, 89), // 剩余 0.11
      exaapi: entry(100, 0), // 剩余 1.00
    };
    const cfg = makeConfig({ search: { engines: { rotating: ["tavily", "exaapi"] } } });
    const batches = plan({ query: "q", fanout: 2 }, cfg, new Set(["tavily", "exaapi"]), quota);
    expect(batches).toEqual(["exaapi,tavily"]);
  });

  it("余额紧张 → 扇出压回 1", () => {
    const quota: QuotaLedger = {
      exaapi: entry(100, 95), // 剩余 0.05
      tavily: entry(100, 95), // 合计剩余占比 0.05 < 0.1
    };
    const cfg = makeConfig({ search: { engines: { rotating: ["exaapi", "tavily"] } } });
    const batches = plan({ query: "q", fanout: 2 }, cfg, new Set(["exaapi", "tavily"]), quota);
    // 扇出被压回 1 → 拆成两批
    expect(batches).toEqual(["exaapi", "tavily"]);
  });

  it("显式 engines 也剔除已耗尽者；全耗尽则回落原集合交给 searxng", () => {
    const quota: QuotaLedger = { exaapi: entry(10, 10), tavily: entry(900, 1) };
    expect(plan({ query: "q", engines: "exaapi,tavily" }, makeConfig(), enabled, quota)).toEqual(["tavily"]);
    expect(plan({ query: "q", engines: "exaapi" }, makeConfig(), enabled, quota)).toEqual(["exaapi"]);
  });

  it("未配置引擎清单时仍交给 searxng 默认（不被配额改写）", () => {
    const cfg = makeConfig({ search: { engines: { rotating: [] } } });
    expect(plan({ query: "q" }, cfg, enabled, { exaapi: entry(1, 1) })).toEqual([""]);
  });
});

describe("planEngines 分档（resident / rotating）", () => {
  const enabled = new Set(["zhihu", "zhihu web", "bilibili", "exaapi", "tavily", "firecrawl"]);
  const tiered = () =>
    makeConfig({
      search: {
        engines: { resident: ["zhihu", "zhihu web", "bilibili"], rotating: ["exaapi", "tavily", "firecrawl"] },
      },
    });

  it("resident 每次查询恒在：叠加到每个 rotating 批次", () => {
    const batches = plan({ query: "q" }, tiered(), enabled, undefined);
    expect(batches).toEqual([
      "zhihu,zhihu web,bilibili,exaapi",
      "zhihu,zhihu web,bilibili,tavily",
      "zhihu,zhihu web,bilibili,firecrawl",
    ]);
  });

  it("resident 额度接近耗尽（剩余 < floor）→ 移出；无额度引擎永不降", () => {
    const quota: QuotaLedger = {
      zhihu: entry(100, 85), // 剩余 0.15 < 0.2 → 移出
      "zhihu web": entry(100, 80), // 剩余 0.20 >= 0.2 → 保留
      // bilibili 无台账 → 保留
      exaapi: entry(100, 0),
    };
    const batches = plan({ query: "q" }, tiered(), enabled, quota);
    expect(batches).toEqual([
      "zhihu web,bilibili,exaapi",
      "zhihu web,bilibili,tavily",
      "zhihu web,bilibili,firecrawl",
    ]);
  });

  it("resident 为空 = 旧行为（仅 rotating）", () => {
    const legacy = makeConfig({ search: { engines: { rotating: ["exaapi", "tavily"] } } });
    const batches = plan({ query: "q" }, legacy, new Set(["exaapi", "tavily"]), undefined);
    expect(batches).toEqual(["exaapi", "tavily"]);
  });

  it("rotating 全耗尽 → 仍跑 resident 一批", () => {
    const quota: QuotaLedger = {
      exaapi: entry(10, 10),
      tavily: entry(10, 10),
      firecrawl: entry(10, 10),
    };
    expect(plan({ query: "q" }, tiered(), enabled, quota)).toEqual(["zhihu,zhihu web,bilibili"]);
  });

  it("searxng 侧 disabled 的 resident 引擎被剔除", () => {
    const en = new Set(["zhihu", "exaapi", "tavily", "firecrawl"]); // zhihu web / bilibili 未启用
    const batches = plan({ query: "q" }, tiered(), en, undefined);
    expect(batches).toEqual(["zhihu,exaapi", "zhihu,tavily", "zhihu,firecrawl"]);
  });

  it("全程无 resident 且无 rotating → 交给 searxng 默认", () => {
    const cfg = makeConfig({ search: { engines: { rotating: [], resident: [] } } });
    expect(plan({ query: "q" }, cfg, enabled, undefined)).toEqual([""]);
  });
});

describe("planEngines 类别抑制（ADR-0008）", () => {
  const enabled = new Set(["zhihu", "bilibili", "exaapi", "tavily"]);
  const cfg = () => makeConfig({ search: { engines: { resident: ["zhihu"], rotating: ["exaapi", "tavily"] } } });

  it("指定非 general 类别 → 抑制 resident/rotating，engines 留空交 searxng 按类别选", () => {
    expect(plan({ query: "q", categories: "science" }, cfg(), enabled, undefined)).toEqual([""]);
  });

  it("非 general 与 general 混写仍算非 general", () => {
    expect(plan({ query: "q", categories: "general,science" }, cfg(), enabled, undefined)).toEqual([""]);
  });

  it("只有 general（或纯空白）→ 不抑制", () => {
    const expected = ["zhihu,exaapi", "zhihu,tavily"];
    expect(plan({ query: "q", categories: "general" }, cfg(), enabled, undefined)).toEqual(expected);
    expect(plan({ query: "q", categories: "  " }, cfg(), enabled, undefined)).toEqual(expected);
  });

  it("显式 engines 优先于类别抑制", () => {
    const batches = plan({ query: "q", categories: "science", engines: "tavily" }, cfg(), enabled, undefined);
    expect(batches).toEqual(["tavily"]);
  });
});

describe("resolveSearxngTimeout（类别感知超时，D18）", () => {
  it("命中类别 → 用类别超时", () => {
    const cfg = makeConfig({ searxng: { timeout_ms: 10000 }, search: { category_timeout_ms: { science: 25000 } } });
    expect(timeout({ query: "q", categories: "science" }, cfg)).toBe(25000);
  });

  it("未命中 / 未指定类别 → 回落 searxngTimeoutMs", () => {
    const cfg = makeConfig({ searxng: { timeout_ms: 10000 }, search: { category_timeout_ms: { science: 25000 } } });
    expect(timeout({ query: "q" }, cfg)).toBe(10000);
    expect(timeout({ query: "q", categories: "news" }, cfg)).toBe(10000);
  });

  it("多类别按顺序取第一个命中", () => {
    const cfg = makeConfig({
      searxng: { timeout_ms: 10000 },
      search: { category_timeout_ms: { science: 25000, news: 15000 } },
    });
    expect(timeout({ query: "q", categories: "news,science" }, cfg)).toBe(15000);
    expect(timeout({ query: "q", categories: "science,news" }, cfg)).toBe(25000);
  });

  it("未配置 category_timeout_ms → 等同旧行为", () => {
    const cfg = makeConfig({ searxng: { timeout_ms: 10000 }, search: { category_timeout_ms: {} } });
    expect(timeout({ query: "q", categories: "science" }, cfg)).toBe(10000);
  });
});
