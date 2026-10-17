import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { cnkiPlugin, endpoints, policy } from "../src/fetch/plugins/cnki.js";
import { createFetchService } from "../src/fetch/service.js";
import { FetchStore } from "../src/fetch/store.js";
import type { Logger } from "../src/logger.js";

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  close: () => {},
} as Logger;

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    host: "127.0.0.1",
    port: 3210,
    token: undefined,
    logLevel: "info",
    logFile: undefined,
    searxngUrl: "http://127.0.0.1:1",
    searxngTimeoutMs: 3000,
    flaresolverrUrl: "http://127.0.0.1:1",
    flaresolverrEnabled: false,
    flaresolverrTimeoutMs: 5000,
    flaresolverrMaxConcurrent: 2,
    flaresolverrTriggerStatus: [403, 405, 429],
    flaresolverrFallbackOnEmpty: true,
    searchMaxResults: 10,
    searchMaxResultsCap: 50,
    searchMaxResultChars: 500,
    searchCacheTtlMs: 300000,
    searchCacheMaxEntries: 200,
    searchMaxConcurrent: 2,
    adFilterEnabled: false,
    adFilterLevel: "off",
    adFilterExtraDomains: [],
    adFilterHostsFile: "data/adblock/hosts",
    adFilterAllowlist: [],
    adFilterAutoUpdate: false,
    adFilterAutoUpdateIntervalMs: 86400000,
    fetchTimeoutMs: 4000,
    fetchMaxBytes: 5 * 1024 * 1024,
    fetchUserAgent: "",
    fetchBlockPrivateIps: false,
    fetchPrivateIpExemptCidrs: [],
    fetchStructural: "clean",
    fetchMaxOutputChars: 20000,
    fetchCacheTtlMs: 600000,
    fetchCacheMaxEntries: 200,
    fetchMaxDownloadBytes: 4 * 1024 * 1024,
    fetchDownloadDir: "data/downloads",
    fetchDownloadTtlMs: 604800000,
    fetchDownloadMaxTotalBytes: 4294967296,
    fetchFilesRoute: true,
    ...overrides,
  } as GatewayConfig;
}

const PDF = Buffer.concat([Buffer.from("%PDF-1.6\n"), Buffer.alloc(512, 0x20)]);

const ABSTRACT_HTML = `<!doctype html><html><body>
  <div class="download-btns">
    <li class="btn-dlcaj"><a id="cajDown" name="cajDown" href="/bar/download/order?id=caj">CAJ下载</a></li>
    <li class="btn-dlpdf"><a id="pdfDown" name="pdfDown" href="/bar/download/order?id=pdf">PDF下载</a></li>
  </div></body></html>`;

/** 桩服务器行为开关。 */
let behaviour: "ok" | "not-subscribed" | "htmlread" | "no-lid" | "bad-target" | "huge" = "ok";
let server: ReturnType<typeof createHttpServer>;
let base = "";
const tmpDirs: string[] = [];

function tmpStore(): FetchStore {
  const dir = mkdtempSync(join(tmpdir(), "cnki-plugin-"));
  tmpDirs.push(dir);
  return new FetchStore(dir, 604800000, 4294967296);
}

beforeAll(async () => {
  server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path.endsWith("/GenerateClientID")) {
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "SID_recsys=1; Path=/" });
      res.end(JSON.stringify({ Success: true, Code: 1, Data: "client-1" }));
      return;
    }
    if (path.endsWith("/IpLoginFlushPo")) {
      const cookies = behaviour === "no-lid" ? ["Ecp_ClientId=client-1"] : ["Ecp_ClientId=client-1", "LID=ticket-1"];
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": cookies });
      // 实测响应体是带外层括号的非标准 JSON
      res.end('({"IsSuccess":true,"ShowName":"测试机构"})');
      return;
    }
    if (path.includes("/kcms2/article/abstract")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      if (behaviour === "not-subscribed") {
        res.end("<html><body><div>您当前所属机构未订购该资源</div></body></html>");
      } else if (behaviour === "bad-target") {
        res.end('<html><body><a id="pdfDown" href="http://evil.example/steal">PDF下载</a></body></html>');
      } else {
        res.end(ABSTRACT_HTML);
      }
      return;
    }
    if (path.startsWith("/bar/download/order")) {
      res.writeHead(302, { Location: `${base}/docdown/fulltext/download?q=1` });
      res.end();
      return;
    }
    if (path.startsWith("/docdown/fulltext/download")) {
      if (behaviour === "htmlread") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end('<html><body><script src="./js/htmlread.js"></script>htmlread</body></html>');
        return;
      }
      const body = behaviour === "huge" ? Buffer.alloc(64 * 1024, 0x41) : PDF;
      res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": String(body.byteLength) });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end("nope");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  behaviour = "ok";
  endpoints.clientId = `${base}/RCDService/api/UtilityOpenApi/GenerateClientID`;
  endpoints.login = `${base}/TopLoginCore/api/loginapi/IpLoginFlushPo`;
  endpoints.knsBase = base;
  policy.cnkiHostSuffix = "127.0.0.1";
});

describe("cnkiPlugin.match", () => {
  it("命中知网摘要页 / 下载链接", () => {
    const original = policy.cnkiHostSuffix;
    policy.cnkiHostSuffix = "cnki.net";
    try {
      expect(cnkiPlugin.match(new URL("https://kns.cnki.net/kcms2/article/abstract?v=abc"))).toBe(true);
      expect(cnkiPlugin.match(new URL("https://pay.cnki.net/zscsdoc/download?filename=X&dbtype=CAPJ"))).toBe(true);
      expect(cnkiPlugin.match(new URL("https://bar.cnki.net/bar/download/order?id=1"))).toBe(true);
      expect(cnkiPlugin.match(new URL("https://example.com/kcms2/article/abstract"))).toBe(false);
      expect(cnkiPlugin.match(new URL("https://kns.cnki.net/kns8s/brief/grid"))).toBe(false);
    } finally {
      policy.cnkiHostSuffix = original;
    }
  });
});

describe("cnkiPlugin.fetch", () => {
  it("摘要页 → #pdfDown → 跟随重定向拿到 %PDF", async () => {
    const r = await cnkiPlugin.fetch(new URL(`${base}/kcms2/article/abstract?v=abc`), {
      config: makeConfig(),
      logger: silentLogger,
    });
    expect(r.ok).toBe(true);
    expect(r.contentType).toBe("application/pdf");
    expect(r.bytes?.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(r.finalUrl).toContain("/docdown/fulltext/download");
  });

  it("直接给下载链接也能取件", async () => {
    const r = await cnkiPlugin.fetch(new URL(`${base}/bar/download/order?id=pdf`), {
      config: makeConfig(),
      logger: silentLogger,
    });
    expect(r.ok).toBe(true);
    expect(r.bytes?.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("IP 登录拿不到 LID → CNKI_NO_SESSION（不静默返回 HTML）", async () => {
    behaviour = "no-lid";
    const r = await cnkiPlugin.fetch(new URL(`${base}/kcms2/article/abstract?v=abc`), {
      config: makeConfig(),
      logger: silentLogger,
    });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("CNKI_NO_SESSION");
  });

  it("未订购的摘要页 → NOT_SUBSCRIBED", async () => {
    behaviour = "not-subscribed";
    const r = await cnkiPlugin.fetch(new URL(`${base}/kcms2/article/abstract?v=abc`), {
      config: makeConfig(),
      logger: silentLogger,
    });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("NOT_SUBSCRIBED");
  });

  it("只有 HTML 阅读版（无 PDF 版）→ NO_PDF", async () => {
    behaviour = "htmlread";
    const r = await cnkiPlugin.fetch(new URL(`${base}/kcms2/article/abstract?v=abc`), {
      config: makeConfig(),
      logger: silentLogger,
    });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("NO_PDF");
  });

  it("超过 fetch.max_download_bytes → TOO_LARGE（不把大文件读进内存）", async () => {
    behaviour = "huge";
    const r = await cnkiPlugin.fetch(new URL(`${base}/bar/download/order?id=pdf`), {
      config: makeConfig({ fetchMaxDownloadBytes: 1024 }),
      logger: silentLogger,
    });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("TOO_LARGE");
  });

  it("摘要页指向站外地址 → BAD_TARGET（不跟随到非知网域名）", async () => {
    behaviour = "bad-target";
    const r = await cnkiPlugin.fetch(new URL(`${base}/kcms2/article/abstract?v=abc`), {
      config: makeConfig(),
      logger: silentLogger,
    });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("BAD_TARGET");
  });
});

describe("service 集成：插件产物落盘而非抽正文", () => {
  it("返回本地路径 + /files 链接", async () => {
    const store = tmpStore();
    const svc = createFetchService(makeConfig({ fetchDownloadDir: "data/downloads" }), silentLogger, undefined, store);
    const r = await svc.fetch({ url: `${base}/kcms2/article/abstract?v=abc` });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("已下载文件");
    expect(r.text).toContain("/files/");
    expect(r.text).toContain("application/pdf");
    // 取件语义：不抽正文（否则会注入「PDF 正文」）
    expect(r.text).not.toContain("PDF 正文");
  });
});
