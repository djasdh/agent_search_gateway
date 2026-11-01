import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayConfig } from "../src/config.js";
import type { Logger } from "../src/logger.js";
import { closeGatewayRuntime, createServer } from "../src/server.js";

/** 进程级运行时测试：adlist 目录用临时目录，避免污染仓库 data/。 */
const DIR = mkdtempSync(join(tmpdir(), "gw-runtime-"));
const HOSTS = join(DIR, "hosts");
writeFileSync(HOSTS, "0.0.0.0 ads.example.com\n");

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
    port: 0,
    token: undefined,
    logLevel: "info",
    logFile: undefined,
    searxngUrl: "http://127.0.0.1:1",
    searxngTimeoutMs: 3000,
    flaresolverrUrl: "http://127.0.0.1:1",
    flaresolverrEnabled: true,
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
    adFilterEnabled: true,
    adFilterLevel: "ads",
    adFilterExtraDomains: [],
    adFilterHostsFile: HOSTS,
    adFilterAllowlist: [],
    adFilterAutoUpdate: true,
    adFilterAutoUpdateIntervalMs: 86400000,
    fetchDownloadDir: DIR,
    fetchDownloadTtlMs: 604800000,
    fetchDownloadMaxTotalBytes: 4294967296,
    fetchFilesRoute: false,
    ...overrides,
  } as GatewayConfig;
}

describe("进程级运行时", () => {
  beforeAll(async () => {
    // 预热一次：adlist 调度器、fetch 产物清扫等一次性资源在此建立
    await createServer(makeConfig(), silentLogger);
  });

  afterAll(async () => {
    await closeGatewayRuntime();
    rmSync(DIR, { recursive: true, force: true });
  });

  it("多会话初始化不再新增 interval / signal 监听器", async () => {
    const termBefore = process.listenerCount("SIGTERM");
    const intBefore = process.listenerCount("SIGINT");
    const intervalSpy = vi.spyOn(globalThis, "setInterval");

    await createServer(makeConfig(), silentLogger);
    await createServer(makeConfig(), silentLogger);

    expect(intervalSpy).not.toHaveBeenCalled();
    intervalSpy.mockRestore();

    // R7-①：signal 监听器只在 index.ts 注册一次，不再随会话增长
    expect(process.listenerCount("SIGTERM")).toBe(termBefore);
    expect(process.listenerCount("SIGINT")).toBe(intBefore);
  });
});
