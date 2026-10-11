import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import type { DomainFilter } from "../src/filter/domain-filter.js";
import type { Logger } from "../src/logger.js";
import { createSearchService } from "../src/search/service.js";

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  close: () => {},
} as Logger;

const domainFilter: DomainFilter = { enabled: false, blocked: new Set(), allowlist: new Set(), count: 0 };

// 记录每次 /search 收到的 engines 参数，用于断言引擎选择顺序
let engineParams: string[] = [];

function makeConfig(port: number, overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: undefined,
    logLevel: "info",
    logFile: undefined,
    searxngUrl: `http://127.0.0.1:${port}`,
    searxngTimeoutMs: 3000,
    flaresolverrUrl: "http://127.0.0.1:1",
    flaresolverrEnabled: false,
    flaresolverrTimeoutMs: 5000,
    flaresolverrMaxConcurrent: 2,
    flaresolverrTriggerStatus: [403, 405, 429],
    flaresolverrFallbackOnEmpty: true,
    searchMaxResults: 10,
    searchMaxResultChars: 500,
    searchCacheTtlMs: 60000,
    searchCacheMaxEntries: 200,
    searchMaxConcurrent: 2,
    searchEngines: ["youcom", "exaapi", "tavily"],
    searchFanoutDefault: 1,
    rerankEnabled: false,
    rerankEngineBoost: {},
    adFilterEnabled: false,
    adFilterLevel: "off",
    adFilterExtraDomains: [],
    adFilterHostsFile: "data/adblock/hosts",
    adFilterAllowlist: [],
    adFilterAutoUpdate: false,
    adFilterAutoUpdateIntervalMs: 86400000,
    ...overrides,
  } as GatewayConfig;
}

// mock searxng：youcom disabled；exaapi 返回空；tavily 返回一条结果 + unresponsive 噪声
let mockServer: ReturnType<typeof createHttpServer>;
let mockPort = 0;

beforeAll(async () => {
  mockServer = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/config") {
      res.end(
        JSON.stringify({
          engines: [
            { name: "youcom", enabled: false },
            { name: "exaapi", enabled: true },
            { name: "tavily", enabled: true },
          ],
        }),
      );
      return;
    }
    const engines = url.searchParams.get("engines") ?? "";
    engineParams.push(engines);
    if (engines.includes("tavily")) {
      res.end(
        JSON.stringify({
          results: [{ url: "https://ok.example/x", title: "Tavily Hit", content: "hit", engine: "tavily", score: 0.8 }],
          unresponsive_engines: [["exaapi", "engine timeout"]],
        }),
      );
      return;
    }
    res.end(JSON.stringify({ results: [], unresponsive_engines: [["exaapi", "engine timeout"]] }));
  });
  await new Promise<void>((r) => mockServer.listen(0, "127.0.0.1", r));
  mockPort = (mockServer.address() as AddressInfo).port;
});

afterAll(() => {
  mockServer.close();
});

describe("createSearchService 引擎选择 + 静默降级", () => {
  it("跳过 disabled 引擎，首个批次选 exaapi；exaapi 空结果时静默换 tavily", async () => {
    engineParams = [];
    const svc = createSearchService(makeConfig(mockPort), domainFilter, silentLogger);
    const r = await svc.search({ query: "failover" });
    expect(r.ok).toBe(true);
    // 跳过 youcom（enabled:false）→ 首批 exaapi → 空 → 换 tavily
    expect(engineParams).toEqual(["exaapi", "tavily"]);
    expect(r.text).toContain("Tavily Hit");
    // 降级过程与 unresponsive 噪声都不暴露
    expect(r.text).not.toContain("exaapi");
    expect(r.text).not.toContain("部分引擎暂不可用");
    expect(r.text).not.toContain("不可用");
  });

  it("显式 engines → 严格按该集合，不降级到集合外", async () => {
    engineParams = [];
    const svc = createSearchService(makeConfig(mockPort), domainFilter, silentLogger);
    const r = await svc.search({ query: "strict", engines: "exaapi" });
    expect(r.ok).toBe(true);
    expect(engineParams).toEqual(["exaapi"]);
    expect(r.text).toContain("没有找到结果");
  });

  it("fanout=2 → 单次查询两家（exaapi,tavily）", async () => {
    engineParams = [];
    const svc = createSearchService(makeConfig(mockPort), domainFilter, silentLogger);
    const r = await svc.search({ query: "fanout", fanout: 2 });
    expect(r.ok).toBe(true);
    expect(engineParams).toEqual(["exaapi,tavily"]);
    expect(r.text).toContain("Tavily Hit");
  });

  it("fanout 写入缓存键：fanout=1 与 fanout=2 不互相命中", async () => {
    engineParams = [];
    const svc = createSearchService(makeConfig(mockPort, { searchCacheTtlMs: 60000 }), domainFilter, silentLogger);
    const r1 = await svc.search({ query: "cachekey", fanout: 1 });
    const r2 = await svc.search({ query: "cachekey", fanout: 2 });
    expect(r1.cacheHit).toBe(false);
    expect(r2.cacheHit).toBe(false);
  });
});
