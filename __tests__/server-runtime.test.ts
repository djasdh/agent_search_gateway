import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../src/logger.js";
import { closeGatewayRuntime, createServer } from "../src/server.js";
import type { Settings } from "../src/settings/index.js";
import { deepMerge, makeSecrets, makeSettings, type DeepPartial } from "./helpers/settings.js";

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

function makeConfig(overrides: DeepPartial<Settings> = {}): Settings {
  const base: DeepPartial<Settings> = {
    ad_filter: {
      enabled: true,
      level: "ads",
      hosts_file: HOSTS,
      auto_update: true,
      auto_update_interval_ms: 86400000,
    },
    fetch: {
      download_dir: DIR,
      download_ttl_ms: 604800000,
      download_max_total_bytes: 4294967296,
      files_route: false,
    },
  };
  return makeSettings(deepMerge(base, overrides));
}

describe("进程级运行时", () => {
  beforeAll(async () => {
    // 预热一次：adlist 调度器、fetch 产物清扫等一次性资源在此建立
    await createServer(makeConfig(), makeSecrets(), silentLogger);
  });

  afterAll(async () => {
    await closeGatewayRuntime();
    rmSync(DIR, { recursive: true, force: true });
  });

  it("多会话初始化不再新增 interval / signal 监听器", async () => {
    const termBefore = process.listenerCount("SIGTERM");
    const intBefore = process.listenerCount("SIGINT");
    const intervalSpy = vi.spyOn(globalThis, "setInterval");

    await createServer(makeConfig(), makeSecrets(), silentLogger);
    await createServer(makeConfig(), makeSecrets(), silentLogger);

    expect(intervalSpy).not.toHaveBeenCalled();
    intervalSpy.mockRestore();

    // R7-①：signal 监听器只在 index.ts 注册一次，不再随会话增长
    expect(process.listenerCount("SIGTERM")).toBe(termBefore);
    expect(process.listenerCount("SIGINT")).toBe(intBefore);
  });
});
