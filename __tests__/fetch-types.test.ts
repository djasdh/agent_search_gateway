import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { formatBytes } from "../src/fetch/convert.js";
import { createFetchService } from "../src/fetch/service.js";
import { FetchStore } from "../src/fetch/store.js";
import type { Logger } from "../src/logger.js";
import { makeMinimalPdf } from "./helpers/pdf-fixture.js";

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
    fetchTimeoutMs: 3000,
    fetchMaxBytes: 5 * 1024 * 1024,
    fetchUserAgent: "",
    fetchBlockPrivateIps: false,
    fetchPrivateIpExemptCidrs: [],
    fetchStructural: "clean",
    fetchMaxOutputChars: 20000,
    fetchCacheTtlMs: 600000,
    fetchCacheMaxEntries: 200,
    fetchMaxDownloadBytes: 1024 * 1024,
    fetchDownloadDir: "data/downloads",
    fetchDownloadTtlMs: 604800000,
    fetchDownloadMaxTotalBytes: 4294967296,
    fetchFilesRoute: true,
    ...overrides,
  } as GatewayConfig;
}

let server: ReturnType<typeof createHttpServer>;
let base = "";
let lastAccept = "";
const tmpDirs: string[] = [];

function tmpStore(): FetchStore {
  const dir = mkdtempSync(join(tmpdir(), "fetch-types-"));
  tmpDirs.push(dir);
  return new FetchStore(dir, 604800000, 4294967296);
}

beforeAll(async () => {
  server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    lastAccept = req.headers.accept ?? "";
    switch (url.pathname) {
      case "/html":
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<html><head><title>页面标题</title></head><body><article><h1>正文</h1><p>网页内容</p></article></body></html>");
        return;
      case "/plain":
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("hello 纯文本\n第二行");
        return;
      case "/json":
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ b: 1, a: [1, 2] }));
        return;
      case "/csv":
        res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
        res.end("name,score\nalice,90\nbob,85\n");
        return;
      case "/xml":
        res.writeHead(200, { "Content-Type": "application/xml" });
        res.end("<root><a>x</a></root>");
        return;
      case "/pdf":
        res.writeHead(200, { "Content-Type": "application/pdf" });
        res.end(makeMinimalPdf("Hello PDF Gateway"));
        return;
      case "/png":
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]));
        return;
      case "/big":
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(Buffer.alloc(4096, 7));
        return;
      default:
        res.writeHead(404, { "Content-Type": "text/html" });
        res.end("<html><body>not found</body></html>");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("fetch 全类型分派", () => {
  it("text/html 仍走 markdown（回归）", async () => {
    const svc = createFetchService(makeConfig(), silentLogger, undefined, tmpStore());
    const r = await svc.fetch({ url: `${base}/html` });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("# 页面标题");
    expect(r.text).toContain("网页内容");
  });

  it("text/plain 直出原文", async () => {
    const svc = createFetchService(makeConfig(), silentLogger, undefined, tmpStore());
    const r = await svc.fetch({ url: `${base}/plain` });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("hello 纯文本");
  });

  it("application/json 美化为 json 代码块", async () => {
    const svc = createFetchService(makeConfig(), silentLogger, undefined, tmpStore());
    const r = await svc.fetch({ url: `${base}/json` });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("```json");
    expect(r.text).toContain('"b": 1');
  });

  it("text/csv 转 markdown 表格", async () => {
    const svc = createFetchService(makeConfig(), silentLogger, undefined, tmpStore());
    const r = await svc.fetch({ url: `${base}/csv` });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("| name | score |");
    expect(r.text).toContain("| alice | 90 |");
  });

  it("application/xml 包 xml 代码块", async () => {
    const svc = createFetchService(makeConfig(), silentLogger, undefined, tmpStore());
    const r = await svc.fetch({ url: `${base}/xml` });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("```xml");
    expect(r.text).toContain("<root>");
  });

  it("application/pdf 抽正文", async () => {
    const svc = createFetchService(makeConfig(), silentLogger, undefined, tmpStore());
    const r = await svc.fetch({ url: `${base}/pdf` });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("PDF 正文（共 1 页）");
    expect(r.text).toContain("Hello PDF Gateway");
  });

  it("image/png 落盘并返回路径 + /files 链接", async () => {
    const store = tmpStore();
    const svc = createFetchService(makeConfig(), silentLogger, undefined, store);
    const r = await svc.fetch({ url: `${base}/png` });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("已下载文件");
    const m = /sha256：([0-9a-f]{64})/.exec(r.text);
    expect(m).not.toBeNull();
    const id = m![1]!;
    expect(r.text).toContain(`/files/${id}`);
    const ref = store.get(id);
    expect(ref).not.toBeUndefined();
    expect(ref!.contentType).toBe("image/png");
    expect(ref!.size).toBe(12);
  });

  it("二进制超 max_download_bytes 报 FETCH_TOO_LARGE", async () => {
    const svc = createFetchService(makeConfig({ fetchMaxDownloadBytes: 1024 }), silentLogger, undefined, tmpStore());
    const r = await svc.fetch({ url: `${base}/big` });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("FETCH_TOO_LARGE");
    expect(r.text).toContain("[FETCH_TOO_LARGE]");
    // 文案按量级换算，并带上当前上限
    expect(r.text).toContain("1.0KB");
  });

  it("Accept 头按需协商（含 pdf/json）", async () => {
    const svc = createFetchService(makeConfig(), silentLogger, undefined, tmpStore());
    await svc.fetch({ url: `${base}/plain` });
    expect(lastAccept).toContain("application/pdf");
    expect(lastAccept).toContain("application/json");
    expect(lastAccept).not.toBe("text/html,application/xhtml+xml,*/*;q=0.8");
  });

  it("无 store 时二进制报 FETCH_UNSUPPORTED_TYPE", async () => {
    const svc = createFetchService(makeConfig(), silentLogger);
    const r = await svc.fetch({ url: `${base}/png` });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("FETCH_UNSUPPORTED_TYPE");
  });
});

describe("formatBytes", () => {
  it("按量级换算（KB/MB/GB）", () => {
    expect(formatBytes(500)).toBe("500 字节");
    expect(formatBytes(1024)).toBe("1.0KB");
    expect(formatBytes(1536)).toBe("1.5KB");
    expect(formatBytes(5242880)).toBe("5.0MB");
    expect(formatBytes(1073741824)).toBe("1.0GB");
  });
});
