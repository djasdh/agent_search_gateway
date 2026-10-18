import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import type { DomainFilter } from "../src/filter/domain-filter.js";
import type { Logger } from "../src/logger.js";
import {
  extractImageUrl,
  searchTraceMoe,
  traceMoeToResults,
  unionResults,
  type TraceMoeResponse,
} from "../src/search/reverse-image.js";
import {
  canonicalizeCategories,
  createSearchService,
  isImageQuery,
  isReverseImageQuery,
} from "../src/search/service.js";

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  close: () => {},
} as Logger;

const domainFilter: DomainFilter = { enabled: false, blocked: new Set(), allowlist: new Set(), count: 0 };

const IMG = "https://img.example/cat.jpg";

// ── 纯函数 ──

describe("extractImageUrl（与 searxng online_url_search 同形）", () => {
  it("抠出 query 里的图片 URL", () => {
    expect(extractImageUrl(IMG)).toBe(IMG);
    expect(extractImageUrl(`${IMG} 这是什么`)).toBe(IMG);
    expect(extractImageUrl(`看看这个 ${IMG}`)).toBe(IMG);
  });

  it("无 URL → undefined", () => {
    expect(extractImageUrl("普通文本查询")).toBeUndefined();
    expect(extractImageUrl("ftp://a/b.jpg")).toBeUndefined();
  });
});

describe("isReverseImageQuery / canonicalizeCategories / isImageQuery", () => {
  it("触发判定大小写不敏感；未配置类别名 → 永不触发", () => {
    expect(isReverseImageQuery("search_by_image", "search_by_image")).toBe(true);
    expect(isReverseImageQuery("general,Search_By_Image", "search_by_image")).toBe(true);
    expect(isReverseImageQuery("images", "search_by_image")).toBe(false);
    expect(isReverseImageQuery("search_by_image", "")).toBe(false);
    expect(isReverseImageQuery(undefined, "search_by_image")).toBe(false);
  });

  it("只在类别确实出现时改写大小写变体，其余请求逐字不动", () => {
    expect(canonicalizeCategories("Search_By_Image", "search_by_image")).toBe("search_by_image");
    expect(canonicalizeCategories("images,Search_By_Image", "search_by_image")).toBe("images,search_by_image");
    // 未命中 → 原样（含空格），保证既有行为零变化
    expect(canonicalizeCategories("images, news ", "search_by_image")).toBe("images, news ");
    expect(canonicalizeCategories(undefined, "search_by_image")).toBeUndefined();
  });

  it("isImageQuery：images 是内建图片类别，附加类别按配置并入", () => {
    expect(isImageQuery("images")).toBe(true);
    expect(isImageQuery("images,news")).toBe(true);
    expect(isImageQuery("search_by_image")).toBe(false);
    expect(isImageQuery("search_by_image", ["search_by_image"])).toBe(true);
    expect(isImageQuery("general")).toBe(false);
  });
});

describe("traceMoeToResults", () => {
  const resp: TraceMoeResponse = {
    quota: 100,
    quotaUsed: 1,
    error: "",
    result: [
      { anilist: { id: 21034, siteUrl: "https://anilist.co/anime/21034", title: { chinese: "点兔" } }, episode: 7, similarity: 0.59, at: 1262, image: "https://api.trace.moe/image/b", video: "https://api.trace.moe/video/b", filename: "b.mkv" },
      { anilist: { id: 21034, siteUrl: "https://anilist.co/anime/21034", title: { chinese: "点兔" } }, episode: 1, similarity: 0.996, at: 272.272, image: "https://api.trace.moe/image/a", video: "https://api.trace.moe/video/a", filename: "a.mp4" },
      { image: undefined, similarity: 0.9 }, // 无预览图 → 丢弃
    ],
  };

  it("按相似度降序、映射成 SearxngResult 线格式、丢弃无预览图的条目", () => {
    const out = traceMoeToResults(resp, 8);
    expect(out.map((r) => r.url)).toEqual([
      "https://anilist.co/anime/21034",
      "https://anilist.co/anime/21034",
    ]);
    const top = out[0];
    expect(top.engine).toBe("tracemoe");
    expect(top.score).toBeCloseTo(0.996);
    expect(top.img_src).toBe("https://api.trace.moe/image/a");
    expect(top.thumbnail_src).toBe("https://api.trace.moe/image/a");
    expect(top.title).toBe("点兔 · 第 1 集");
    expect(top.content).toContain("相似度 99.6%");
    expect(top.content).toContain("出现于 04:32");
    expect(top.category).toBe("search_by_image");
  });

  it("maxResults 截断；anilist 为纯数字时兜底站内链接；无标题时用文件名", () => {
    const out = traceMoeToResults(
      {
        result: [
          { anilist: 42, episode: 3, similarity: 0.5, image: "https://api.trace.moe/image/x" },
          { similarity: 0.4, image: "https://api.trace.moe/image/y", filename: "Show - 01 (BD).mp4" },
        ],
      },
      1,
    );
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe("https://anilist.co/anime/42");

    const fallback = traceMoeToResults(
      { result: [{ similarity: 0.4, image: "https://api.trace.moe/image/y", filename: "Show - 01 (BD).mp4" }] },
      8,
    );
    expect(fallback[0].title).toBe("Show - 01 (BD)");
    expect(fallback[0].url).toBe("https://api.trace.moe/image/y");
  });

  it("空/非法响应 → 空列表", () => {
    expect(traceMoeToResults({}, 8)).toEqual([]);
    expect(traceMoeToResults({ result: undefined }, 8)).toEqual([]);
  });
});

describe("unionResults（跨源合并）", () => {
  it("按规范化 URL 去重，同 URL 的引擎归属取并集", () => {
    const merged = unionResults(
      [{ url: "https://a.example/x?utm_source=t", engine: "tineye", title: "A" }],
      [
        { url: "https://a.example/x", engine: "tracemoe", title: "A2" },
        { url: "https://b.example/y", engine: "tracemoe", title: "B" },
      ],
    );
    expect(merged).toHaveLength(2);
    expect(merged[0].title).toBe("A"); // 主源条目保留
    expect(merged[0].engines).toEqual(["tineye", "tracemoe"]);
    expect(merged[1].url).toBe("https://b.example/y");
  });

  it("不修改入参数组", () => {
    const base = [{ url: "https://a.example/x", engine: "tineye" }];
    unionResults(base, [{ url: "https://a.example/x", engine: "tracemoe" }]);
    expect(base[0].engines).toBeUndefined();
  });
});

// ── trace.moe 客户端（打本地 mock） ──

let traceServer: ReturnType<typeof createHttpServer>;
let tracePort = 0;
let traceMode: "ok" | "http500" | "apierror" | "notjson" = "ok";
let lastTraceQuery: URLSearchParams | undefined;

beforeAll(async () => {
  traceServer = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    lastTraceQuery = url.searchParams;
    if (traceMode === "http500") {
      res.statusCode = 500;
      res.end("boom");
      return;
    }
    res.setHeader("Content-Type", "application/json");
    if (traceMode === "apierror") {
      res.end(JSON.stringify({ quota: 100, quotaUsed: 100, error: "Invalid image url" }));
      return;
    }
    if (traceMode === "notjson") {
      res.end("<html>nope</html>");
      return;
    }
    res.end(
      JSON.stringify({
        quota: 100,
        quotaUsed: 3,
        error: "",
        result: [{ anilist: { id: 1, title: { chinese: "某番" } }, episode: 2, similarity: 0.8, at: 61, image: "https://api.trace.moe/image/z" }],
      }),
    );
  });
  await new Promise<void>((r) => traceServer.listen(0, "127.0.0.1", r));
  tracePort = (traceServer.address() as AddressInfo).port;
});

afterAll(() => {
  traceServer.close();
});

describe("searchTraceMoe", () => {
  const base = () => `http://127.0.0.1:${tracePort}`;

  it("成功：带 url + anilistInfo 参数，映射候选并回传配额", async () => {
    traceMode = "ok";
    const r = await searchTraceMoe(base(), 3000, IMG, 8);
    expect(lastTraceQuery?.get("url")).toBe(IMG);
    expect(lastTraceQuery?.get("anilistInfo")).toBe("1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.results).toHaveLength(1);
      expect(r.quota).toBe(100);
      expect(r.quotaUsed).toBe(3);
    }
  });

  it("HTTP 非 2xx → kind=http", async () => {
    traceMode = "http500";
    const r = await searchTraceMoe(base(), 3000, IMG, 8);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("http");
  });

  it("HTTP 200 带 error → kind=api（含配额）", async () => {
    traceMode = "apierror";
    const r = await searchTraceMoe(base(), 3000, IMG, 8);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("api");
      expect(r.error.message).toContain("Invalid image url");
      expect(r.error.message).toContain("100/100");
    }
  });

  it("非 JSON → kind=invalid_json", async () => {
    traceMode = "notjson";
    const r = await searchTraceMoe(base(), 3000, IMG, 8);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("invalid_json");
  });

  it("网络不可达 → kind=network（不抛异常）", async () => {
    traceMode = "ok";
    const r = await searchTraceMoe("http://127.0.0.1:1", 1000, IMG, 8);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(["network", "timeout"]).toContain(r.error.kind);
  });
});

// ── 服务级：类别触发的多源扇出 ──

let searxServer: ReturnType<typeof createHttpServer>;
let searxPort = 0;
let searxCategories: string[] = [];
let searxEngines: Array<string | null> = [];
let searxFail = false;
let searxResults: Array<Record<string, unknown>> = [];

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: undefined,
    logLevel: "info",
    logFile: undefined,
    searxngUrl: `http://127.0.0.1:${searxPort}`,
    searxngTimeoutMs: 5000,
    searchMaxResults: 10,
    searchMaxResultChars: 500,
    searchCacheTtlMs: 0,
    searchCacheMaxEntries: 0,
    searchMaxConcurrent: 2,
    searchEngines: ["exaapi"],
    searchEnginesResident: [],
    searchFanoutDefault: 1,
    searchQuotaEnabled: false,
    searchQuotaLedgerPath: "",
    searchQuotaTightThreshold: 0.1,
    searchResidentQuotaFloor: 0.2,
    searchCategoryTimeoutMs: {},
    searchReverseImageEnabled: true,
    searchReverseImageCategory: "search_by_image",
    searchReverseImageSources: ["tracemoe"],
    searchTraceMoeUrl: `http://127.0.0.1:${tracePort}`,
    searchTraceMoeTimeoutMs: 3000,
    searchTraceMoeMaxResults: 8,
    rerankEnabled: true,
    rerankEngineBoost: {},
    rerankDiversityEnabled: false,
    rerankDiversityMmrLambda: 1,
    rerankDiversityMaxPerDomain: 3,
    rerankAuthorityEnabled: false,
    rerankAuthorityWeight: 0.5,
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

beforeAll(async () => {
  searxServer = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/config") {
      res.end(JSON.stringify({ engines: [{ name: "exaapi", enabled: true }] }));
      return;
    }
    searxCategories.push(url.searchParams.get("categories") ?? "");
    searxEngines.push(url.searchParams.get("engines"));
    if (searxFail) {
      res.statusCode = 502;
      res.end("bad gateway");
      return;
    }
    res.end(JSON.stringify({ results: searxResults }));
  });
  await new Promise<void>((r) => searxServer.listen(0, "127.0.0.1", r));
  searxPort = (searxServer.address() as AddressInfo).port;
});

afterAll(() => {
  searxServer.close();
});

describe("createSearchService 反向图搜扇出（ADR-0010）", () => {
  it("类别命中 → 转发规范类别、引擎留空（抑制作用）、并发拉起 trace.moe 并合并结果", async () => {
    traceMode = "ok";
    searxFail = false;
    searxCategories = [];
    searxEngines = [];
    searxResults = [
      {
        url: "https://backlink.example/page",
        title: "TinEye Hit",
        engine: "tineye",
        img_src: "https://backlink.example/pic.jpg",
        thumbnail_src: "https://tineye.example/thumb.jpg",
        format: "jpeg",
        width: 1280,
        height: 720,
        score: 0.7,
      },
    ];
    const svc = createSearchService(makeConfig(), domainFilter, silentLogger);
    const r = await svc.search({ query: `找一下这张图 ${IMG}`, categories: "Search_By_Image" });
    expect(r.ok).toBe(true);
    // 大小写变体归一后转发；非 general 类别 → 引擎留空，交 searxng 按类别选引擎
    expect(searxCategories).toEqual(["search_by_image"]);
    expect(searxEngines).toEqual([null]);
    // 两边候选都进结果：tineye（来源页/图片直链）与 tracemoe（AniList 标题）
    expect(r.text).toContain("TinEye Hit");
    expect(r.text).toContain("某番 · 第 2 集");
    expect(r.text).toContain("![某番 · 第 2 集](https://api.trace.moe/image/z)");
    // tineye 只给 width/height/format → 兜底成 resolution/img_format 后渲染
    expect(r.text).toContain("1280 x 720");
    expect(r.text).toContain("jpeg");
    // 图片查询不走语义层：不混文本语料、无降级提示
    expect(r.text).not.toContain("本地缓存");
    expect(r.text).not.toContain("反向图搜：");
  });

  it("类别未命中 → 不调 trace.moe，参数逐字转发（既有行为零变化）", async () => {
    traceMode = "ok";
    searxFail = false;
    searxCategories = [];
    searxEngines = [];
    searxResults = [];
    lastTraceQuery = undefined;
    const svc = createSearchService(makeConfig(), domainFilter, silentLogger);
    const r = await svc.search({ query: "普通查询", categories: "images" });
    expect(r.ok).toBe(true);
    expect(searxCategories).toEqual(["images"]);
    expect(lastTraceQuery).toBeUndefined();
  });

  it("query 里没有图片 URL → 跳过网关侧图源，并附提示", async () => {
    traceMode = "ok";
    searxFail = false;
    searxCategories = [];
    searxResults = [];
    lastTraceQuery = undefined;
    const svc = createSearchService(makeConfig(), domainFilter, silentLogger);
    const r = await svc.search({ query: "只有文字没有图片", categories: "search_by_image" });
    expect(r.ok).toBe(true);
    expect(lastTraceQuery).toBeUndefined();
    expect(r.text).toContain("query 里没有图片 URL");
  });

  it("searxng 失败但网关侧图源有结果 → 部分成功（ok）且附提示", async () => {
    traceMode = "ok";
    searxFail = true;
    searxCategories = [];
    searxResults = [];
    const svc = createSearchService(makeConfig(), domainFilter, silentLogger);
    const r = await svc.search({ query: IMG, categories: "search_by_image" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("某番 · 第 2 集");
    expect(r.text).toContain("searxng 未返回结果");
  });

  it("网关侧图源失败（无 searxng 结果）→ 报错并附失败原因", async () => {
    traceMode = "http500";
    searxFail = true;
    searxCategories = [];
    searxResults = [];
    const svc = createSearchService(makeConfig(), domainFilter, silentLogger);
    const r = await svc.search({ query: IMG, categories: "search_by_image" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("搜索失败");
    expect(r.text).toContain("tracemoe 不可用");
  });

  it("总开关关闭 → 类别只走 searxng（不调 trace.moe）", async () => {
    traceMode = "ok";
    searxFail = false;
    searxCategories = [];
    searxResults = [];
    lastTraceQuery = undefined;
    const svc = createSearchService(makeConfig({ searchReverseImageEnabled: false }), domainFilter, silentLogger);
    const r = await svc.search({ query: IMG, categories: "search_by_image" });
    expect(r.ok).toBe(true);
    expect(lastTraceQuery).toBeUndefined();
    expect(r.text).not.toContain("反向图搜");
  });
});
