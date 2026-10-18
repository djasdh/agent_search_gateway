import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import type { DomainFilter } from "../src/filter/domain-filter.js";
import type { Logger } from "../src/logger.js";
import {
  extractImageUrl,
  searchTraceMoe,
  searchTraceMoeUpload,
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
let lastTraceMethod = "";
let lastTraceBody = "";
let lastTraceContentType = "";

beforeAll(async () => {
  traceServer = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    lastTraceQuery = url.searchParams;
    lastTraceMethod = req.method ?? "";
    lastTraceContentType = String(req.headers["content-type"] ?? "");
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      lastTraceBody = Buffer.concat(chunks).toString("latin1");
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

  it("本地图走 multipart 直传：POST + 字段 image + 原始字节（图不经图床）", async () => {
    traceMode = "ok";
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const r = await searchTraceMoeUpload(base(), 3000, bytes, "shot.jpg", "image/jpeg", 8);
    expect(lastTraceMethod).toBe("POST");
    expect(lastTraceContentType).toContain("multipart/form-data; boundary=");
    expect(lastTraceQuery?.get("anilistInfo")).toBe("1");
    expect(lastTraceQuery?.get("url")).toBeNull();
    expect(lastTraceBody).toContain('name="image"');
    expect(lastTraceBody).toContain('filename="shot.jpg"');
    expect(lastTraceBody).toContain("Content-Type: image/jpeg");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.results).toHaveLength(1);
  });
});

// ── 服务级：类别触发的多源扇出 ──

let searxServer: ReturnType<typeof createHttpServer>;
let searxPort = 0;
let searxCategories: string[] = [];
let searxEngines: Array<string | null> = [];
let searxQueries: string[] = [];
let searxFail = false;
let searxResults: Array<Record<string, unknown>> = [];

// mock 图床（uguu/pomf 协议）；记录收到的 multipart 原文以便断言
let publishServer: ReturnType<typeof createHttpServer>;
let publishPort = 0;
let publishMode: "ok" | "apifail" | "http500" = "ok";
let publishBody = "";
let publishCalls = 0;

// mock SauceNAO（官方 JSON API 形状）
let saucenaoServer: ReturnType<typeof createHttpServer>;
let saucenaoPort = 0;
let saucenaoMode: "ok" | "apierror" | "http500" = "ok";
let saucenaoQueries: string[] = [];

// mock 百度识图（upload → 结果页 cardData）
let baiduServer: ReturnType<typeof createHttpServer>;
let baiduPort = 0;
let baiduMode: "ok" | "reject" = "ok";
let baiduUploads = 0;

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
    searchMaxResultsCap: 50,
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
    searchReverseImageLocalMaxBytes: 5 * 1024 * 1024,
    searchReverseImagePublishEnabled: true,
    searchReverseImagePublishEndpoint: `http://127.0.0.1:${publishPort}/upload?output=json`,
    searchReverseImagePublishTimeoutMs: 3000,
    searchSaucenaoApiKey: "test-key",
    searchSaucenaoUrl: `http://127.0.0.1:${saucenaoPort}`,
    searchSaucenaoTimeoutMs: 3000,
    searchSaucenaoMaxResults: 8,
    searchSaucenaoMinsim: 0,
    searchBaiduReverseEnabled: true,
    searchBaiduReverseUrl: `http://127.0.0.1:${baiduPort}`,
    searchBaiduReverseTimeoutMs: 3000,
    searchBaiduReverseMaxResults: 8,
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
    searxQueries.push(url.searchParams.get("q") ?? "");
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

  publishServer = createHttpServer((req, res) => {
    publishCalls++;
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      publishBody = Buffer.concat(chunks).toString("latin1");
      if (publishMode === "http500") {
        res.statusCode = 500;
        res.end("nope");
        return;
      }
      res.setHeader("Content-Type", "application/json");
      if (publishMode === "apifail") {
        res.end(JSON.stringify({ success: false, error: "File too large" }));
        return;
      }
      res.end(JSON.stringify({ success: true, files: [{ url: "https://n.uguu.se/published.jpg" }] }));
    });
  });
  await new Promise<void>((r) => publishServer.listen(0, "127.0.0.1", r));
  publishPort = (publishServer.address() as AddressInfo).port;

  saucenaoServer = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    saucenaoQueries.push(url.searchParams.get("url") ?? "");
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      if (saucenaoMode === "http500") {
        res.statusCode = 500;
        res.end("boom");
        return;
      }
      res.setHeader("Content-Type", "application/json");
      if (saucenaoMode === "apierror") {
        res.end(JSON.stringify({ header: { status: -1, message: "The anonymous account type does not permit API usage." } }));
        return;
      }
      res.end(
        JSON.stringify({
          header: { status: 0, short_remaining: 2, long_remaining: 100 },
          results: [
            {
              header: { similarity: "88.0", thumbnail: "https://pixiv.example/thumb.jpg", index_name: "Pixiv" },
              data: { pixiv_id: 999, title: "插画出处" },
            },
          ],
        }),
      );
    });
  });
  await new Promise<void>((r) => saucenaoServer.listen(0, "127.0.0.1", r));
  saucenaoPort = (saucenaoServer.address() as AddressInfo).port;

  baiduServer = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${baiduPort}`);
    if (req.method === "POST" && url.pathname === "/upload") {
      baiduUploads++;
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        if (baiduMode === "reject") {
          res.end(JSON.stringify({ status: 1, msg: "Reject", data: null }));
          return;
        }
        res.end(JSON.stringify({ status: 0, msg: "Success", data: { url: `http://127.0.0.1:${baiduPort}/s?sign=x` } }));
      });
      return;
    }
    if (url.pathname === "/s") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        '<script>window.cardData = [{"cardName":"same","tplData":{"list":[{"url":"https://duitang.example/1","image_src":"https://img.example/bd1.jpg"}]}}];</script>',
      );
      return;
    }
    if (url.pathname === "/img.jpg") {
      res.setHeader("Content-Type", "image/jpeg");
      res.end(LOCAL_JPEG);
      return;
    }
    res.statusCode = 404;
    res.end("nf");
  });
  await new Promise<void>((r) => baiduServer.listen(0, "127.0.0.1", r));
  baiduPort = (baiduServer.address() as AddressInfo).port;
});

afterAll(() => {
  searxServer.close();
  publishServer.close();
  saucenaoServer.close();
  baiduServer.close();
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

// ── 本地图片（image_path）：trace.moe 直传 + 可选公网发布（ADR-0011） ──

/** 最小合法 JPEG 头（≥12 字节）。 */
const LOCAL_JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
  Buffer.alloc(64, 0x5a),
]);

describe("createSearchService 本地图片（image_path）", () => {
  let dir = "";
  let imgPath = "";
  let txtPath = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "revimg-local-"));
    imgPath = join(dir, "shot.jpg");
    txtPath = join(dir, "secret.txt");
    await writeFile(imgPath, LOCAL_JPEG);
    await writeFile(txtPath, "这不是图片\n");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const reset = (mode: "ok" | "apifail" | "http500" = "ok") => {
    traceMode = "ok";
    publishMode = mode;
    searxFail = false;
    searxCategories = [];
    searxEngines = [];
    searxQueries = [];
    searxResults = [];
    publishBody = "";
    publishCalls = 0;
    lastTraceMethod = "";
    lastTraceQuery = undefined;
  };

  const tinEyeHit = {
    url: "https://backlink.example/page",
    title: "TinEye Hit",
    engine: "tineye",
    img_src: "https://backlink.example/pic.jpg",
    thumbnail_src: "https://tineye.example/thumb.jpg",
    score: 0.7,
  };

  it("发布成功 → trace.moe 直传 + searxng 用发布到的公网 URL（tineye 参与）", async () => {
    reset("ok");
    searxResults = [tinEyeHit];
    const svc = createSearchService(makeConfig(), domainFilter, silentLogger);
    const r = await svc.search({ query: "", imagePath: imgPath, categories: "search_by_image" });
    expect(r.ok).toBe(true);
    // trace.moe：POST multipart 直传本地字节（不借助图床）
    expect(lastTraceMethod).toBe("POST");
    expect(publishBody).toContain('name="files[]"');
    expect(publishBody).toContain('filename="shot.jpg"');
    // searxng：query 用的是发布出来的公网 URL，类别照旧转发、引擎留空
    expect(searxQueries).toEqual(["https://n.uguu.se/published.jpg"]);
    expect(searxCategories).toEqual(["search_by_image"]);
    expect(searxEngines).toEqual([null]);
    // 两源结果合并；标题用本地文件名（没有 query 文本）
    expect(r.text).toContain("TinEye Hit");
    expect(r.text).toContain("某番 · 第 2 集");
    expect(r.text).toContain("# Search: 本地图片 shot.jpg");
    expect(r.text).toContain("已发布到公网图床");
  });

  it("发布失败 → 跳过 searxng，只返回 trace.moe 结果 + 提示", async () => {
    reset("apifail");
    const svc = createSearchService(makeConfig(), domainFilter, silentLogger);
    const r = await svc.search({ query: "", imagePath: imgPath, categories: "search_by_image" });
    expect(r.ok).toBe(true);
    expect(searxQueries).toEqual([]); // 没有公网 URL → 不调 searxng
    expect(r.text).toContain("某番 · 第 2 集");
    expect(r.text).toContain("图床发布失败");
    expect(r.text).toContain("File too large");
  });

  it("publish 关闭 → 只走 trace.moe，并说明 tineye 未参与", async () => {
    reset("ok");
    const svc = createSearchService(makeConfig({ searchReverseImagePublishEnabled: false }), domainFilter, silentLogger);
    const r = await svc.search({ query: "", imagePath: imgPath, categories: "search_by_image" });
    expect(r.ok).toBe(true);
    expect(publishCalls).toBe(0);
    expect(searxQueries).toEqual([]);
    expect(r.text).toContain("publish 未启用");
  });

  it("trace.moe 也失败（图床失败）→ 报错并附原因", async () => {
    reset("http500");
    traceMode = "http500";
    const svc = createSearchService(makeConfig(), domainFilter, silentLogger);
    const r = await svc.search({ query: "", imagePath: imgPath, categories: "search_by_image" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("[SEARCH_UPSTREAM]");
    expect(r.text).toContain("tracemoe 不可用");
    expect(r.text).toContain("图床发布失败");
  });

  it("非图片文件 → 明确拒绝（不读不传）", async () => {
    reset("ok");
    const svc = createSearchService(makeConfig(), domainFilter, silentLogger);
    const r = await svc.search({ query: "", imagePath: txtPath, categories: "search_by_image" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("[SEARCH_INVALID]");
    expect(r.text).toContain("not_image");
    expect(publishCalls).toBe(0);
    expect(lastTraceMethod).toBe("");
  });

  it("文件不存在 → not_found；目录 → not_file", async () => {
    reset("ok");
    const svc = createSearchService(makeConfig(), domainFilter, silentLogger);
    const a = await svc.search({ query: "", imagePath: join(dir, "nope.jpg"), categories: "search_by_image" });
    expect(a.ok).toBe(false);
    expect(a.text).toContain("not_found");
    const b = await svc.search({ query: "", imagePath: dir, categories: "search_by_image" });
    expect(b.ok).toBe(false);
    expect(b.text).toContain("not_file");
  });

  it("image_path 与 query 里的图片 URL 互斥", async () => {
    reset("ok");
    const svc = createSearchService(makeConfig(), domainFilter, silentLogger);
    const r = await svc.search({ query: IMG, imagePath: imgPath, categories: "search_by_image" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("[SEARCH_INVALID]");
    expect(r.text).toContain("只能给一个");
  });

  it("没带以图搜图类别时给 image_path → 明确报错", async () => {
    reset("ok");
    const svc = createSearchService(makeConfig(), domainFilter, silentLogger);
    const r = await svc.search({ query: "点兔", imagePath: imgPath });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("[SEARCH_INVALID]");
    expect(r.text).toContain("image_path");
  });

  it("本地图请求不进搜索缓存（同一路径改了文件也不会命中旧结果）", async () => {
    reset("ok");
    const svc = createSearchService(makeConfig({ searchCacheTtlMs: 60000 }), domainFilter, silentLogger);
    const a = await svc.search({ query: "", imagePath: imgPath, categories: "search_by_image" });
    const b = await svc.search({ query: "", imagePath: imgPath, categories: "search_by_image" });
    expect(a.cacheHit).toBe(false);
    expect(b.cacheHit).toBe(false);
    expect(publishCalls).toBe(2); // 每次都真跑
  });
});

// ── 多源扇出（ADR-0012）：trace.moe + SauceNAO + 百度识图 ──

describe("createSearchService 多源扇出（ADR-0012）", () => {
  let dir = "";
  let imgPath = "";
  const all = ["tracemoe", "saucenao", "baidu"];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "revimg-multi-"));
    imgPath = join(dir, "shot.jpg");
    await writeFile(imgPath, LOCAL_JPEG);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const resetAll = () => {
    traceMode = "ok";
    searxFail = false;
    searxCategories = [];
    searxEngines = [];
    searxQueries = [];
    searxResults = [];
    saucenaoMode = "ok";
    saucenaoQueries = [];
    baiduMode = "ok";
    baiduUploads = 0;
    lastTraceMethod = "";
    lastTraceQuery = undefined;
  };

  // 百度识图在 URL 输入时要先把图下载下来再上传，所以这里用「可下载」的 mock 图片 URL
  const imgUrl = () => `http://127.0.0.1:${baiduPort}/img.jpg`;

  it("三源并发：URL 输入 → 各源候选合并进结果", async () => {
    resetAll();
    const q = imgUrl();
    const svc = createSearchService(makeConfig({ searchReverseImageSources: all }), domainFilter, silentLogger);
    const r = await svc.search({ query: q, categories: "search_by_image" });
    expect(r.ok).toBe(true);
    expect(searxQueries).toEqual([q]); // searxng（tineye）用 query 里的图片 URL
    expect(saucenaoQueries).toEqual([q]); // SauceNAO 收到 url 参数
    expect(baiduUploads).toBe(1); // 百度识图上传了一次
    expect(lastTraceMethod).toBe("GET"); // trace.moe 走 URL
    expect(r.text).toContain("某番"); // trace.moe 结果
    expect(r.text).toContain("插画出处"); // SauceNAO 结果
    expect(r.text).toContain("duitang.example"); // 百度识图结果
  });

  it("SauceNAO 未配 api_key → 跳过该源（不发请求）", async () => {
    resetAll();
    const svc = createSearchService(
      makeConfig({ searchReverseImageSources: all, searchSaucenaoApiKey: "" }),
      domainFilter,
      silentLogger,
    );
    const r = await svc.search({ query: imgUrl(), categories: "search_by_image" });
    expect(r.ok).toBe(true);
    expect(saucenaoQueries).toEqual([]);
    expect(baiduUploads).toBe(1);
  });

  it("百度识图被拒 → 其它源结果照常 + 提示 baidu 不可用", async () => {
    resetAll();
    baiduMode = "reject";
    const svc = createSearchService(makeConfig({ searchReverseImageSources: all }), domainFilter, silentLogger);
    const r = await svc.search({ query: imgUrl(), categories: "search_by_image" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("某番");
    expect(r.text).toContain("插画出处");
    expect(r.text).toContain("图源 baidu 不可用");
  });

  it("SauceNAO 匿名拒绝（status<0）→ 提示 + 其它源照常", async () => {
    resetAll();
    saucenaoMode = "apierror";
    const svc = createSearchService(makeConfig({ searchReverseImageSources: all }), domainFilter, silentLogger);
    const r = await svc.search({ query: imgUrl(), categories: "search_by_image" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("图源 saucenao 不可用");
    expect(r.text).toContain("某番");
    expect(r.text).toContain("duitang.example");
  });

  it("本地图：三源直传（不经图床）+ searxng 用发布后的公网 URL", async () => {
    resetAll();
    const svc = createSearchService(makeConfig({ searchReverseImageSources: all }), domainFilter, silentLogger);
    const r = await svc.search({ query: "", imagePath: imgPath, categories: "search_by_image" });
    expect(r.ok).toBe(true);
    expect(saucenaoQueries).toEqual([""]); // 本地直传 → 没有 url 参数
    expect(baiduUploads).toBe(1);
    expect(lastTraceMethod).toBe("POST"); // trace.moe 走 multipart
    expect(searxQueries).toEqual(["https://n.uguu.se/published.jpg"]); // tineye 用发布出来的公网 URL
    expect(r.text).toContain("某番");
    expect(r.text).toContain("插画出处");
  });
});
