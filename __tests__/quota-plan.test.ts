import { describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { parseQuotaLedger, planEngines, type QuotaLedger } from "../src/search/service.js";

/** planEngines 只读取这几个字段，其余用类型断言兜底。 */
function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    searchEngines: ["youcom", "exaapi", "tavily", "firecrawl"],
    searchFanoutDefault: 1,
    searchQuotaTightThreshold: 0.1,
    ...overrides,
  } as GatewayConfig;
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
    const batches = planEngines({ query: "q" }, makeConfig(), enabled, undefined);
    expect(batches).toEqual(["youcom", "exaapi", "tavily", "firecrawl"]);
  });

  it("剔除已耗尽引擎", () => {
    const quota: QuotaLedger = {
      youcom: entry(90, 10),
      exaapi: entry(2250, 2250), // 耗尽
      tavily: entry(900, 100),
      firecrawl: entry(450, 0),
    };
    const batches = planEngines({ query: "q" }, makeConfig(), enabled, quota);
    expect(batches).toEqual(["youcom", "tavily", "firecrawl"]);
  });

  it("全部耗尽 → 返回空批次（主动停用）", () => {
    const quota: QuotaLedger = {
      youcom: entry(90, 90),
      exaapi: entry(2250, 2250),
      tavily: entry(900, 900),
      firecrawl: entry(450, 450),
    };
    expect(planEngines({ query: "q" }, makeConfig(), enabled, quota)).toEqual([]);
  });

  it("fanout>1 时按剩余额度降序排序", () => {
    const quota: QuotaLedger = {
      // 优先级里 tavily 在前，但剩余占比低 → 排序后 exaapi 在前
      tavily: entry(100, 89), // 剩余 0.11
      exaapi: entry(100, 0), // 剩余 1.00
    };
    const cfg = makeConfig({ searchEngines: ["tavily", "exaapi"] });
    const batches = planEngines({ query: "q", fanout: 2 }, cfg, new Set(["tavily", "exaapi"]), quota);
    expect(batches).toEqual(["exaapi,tavily"]);
  });

  it("余额紧张 → 扇出压回 1", () => {
    const quota: QuotaLedger = {
      exaapi: entry(100, 95), // 剩余 0.05
      tavily: entry(100, 95), // 合计剩余占比 0.05 < 0.1
    };
    const cfg = makeConfig({ searchEngines: ["exaapi", "tavily"] });
    const batches = planEngines({ query: "q", fanout: 2 }, cfg, new Set(["exaapi", "tavily"]), quota);
    // 扇出被压回 1 → 拆成两批
    expect(batches).toEqual(["exaapi", "tavily"]);
  });

  it("显式 engines 也剔除已耗尽者；全耗尽则回落原集合交给 searxng", () => {
    const quota: QuotaLedger = { exaapi: entry(10, 10), tavily: entry(900, 1) };
    expect(planEngines({ query: "q", engines: "exaapi,tavily" }, makeConfig(), enabled, quota)).toEqual(["tavily"]);
    expect(planEngines({ query: "q", engines: "exaapi" }, makeConfig(), enabled, quota)).toEqual(["exaapi"]);
  });

  it("未配置引擎清单时仍交给 searxng 默认（不被配额改写）", () => {
    const cfg = makeConfig({ searchEngines: [] });
    expect(planEngines({ query: "q" }, cfg, enabled, { exaapi: entry(1, 1) })).toEqual([""]);
  });
});
