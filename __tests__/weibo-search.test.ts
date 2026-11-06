import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type GatewayConfig } from "../src/config.js";
import type { DomainFilter } from "../src/filter/domain-filter.js";
import type { Logger } from "../src/logger.js";
import { createSearchService } from "../src/search/service.js";
import {
  mapWeiboHotRows,
  mapWeiboSearchRows,
  searchWeibo,
  stripWeiboRefer,
} from "../src/search/weibo.js";

const dirs: string[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "weibo-search-"));
  dirs.push(d);
  return d;
}

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  close: () => {},
} as Logger;

const noFilter: DomainFilter = {
  enabled: false,
  blocked: new Set(),
  allowlist: new Set(),
  count: 0,
};

const FAKE_CLI = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const cmd = args[1];
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, args.join(" ") + "\\n");
const searchRows = [
  { rank: 1, id: "R1", title: "洛天依演唱会", author: "Vsinger_洛天依", time: "今天 12:00", url: "https://weibo.com/5146173015/R1?refer_flag=1001030103_" },
  { rank: 2, id: "R2", title: "第二条微博", author: "测试用户", time: "昨天 09:00", url: "https://weibo.com/1/R2" },
];
const hotRows = [
  { rank: 1, word: "测试话题", hot_value: 123456, category: "文娱", label: "热", url: "https://s.weibo.com/weibo?q=%23%E6%B5%8B%E8%AF%95%E8%AF%9D%E9%A2%98%23" },
];
if (cmd === "search") {
  const mode = process.env.FAKE_MODE || "ok";
  if (mode === "retry") {
    const file = process.env.FAKE_COUNTER;
    const n = file && fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0;
    if (file) fs.writeFileSync(file, String(n + 1));
    if (n === 0) { console.error("No Weibo search results found"); process.exit(66); }
  }
  process.stdout.write(JSON.stringify(searchRows));
  process.exit(0);
}
if (cmd === "hot") {
  process.stdout.write(JSON.stringify(hotRows));
  process.exit(0);
}
console.error("unknown command: " + cmd);
process.exit(1);
`;

function writeCli(): string {
  const d = tmpDir();
  const cli = join(d, "fake-opencli.js");
  writeFileSync(cli, FAKE_CLI);
  chmodSync(cli, 0o755);
  return cli;
}

function makeConfig(cli: string, overrides: { searchWeibo?: boolean; weibo?: boolean } = {}): GatewayConfig {
  const d = tmpDir();
  const path = join(d, "gateway.yaml");
  writeFileSync(
    path,
    [
      "gateway: { host: 127.0.0.1 }",
      "searxng:",
      "  url: http://127.0.0.1:1",
      "  timeout_ms: 300",
      "weibo:",
      `  enabled: ${overrides.weibo === false ? "false" : "true"}`,
      `  cli: { command: "${cli}", timeout_ms: 5000 }`,
      "  cache_ttl_ms: 0",
      "search:",
      "  weibo:",
      `    enabled: ${overrides.searchWeibo === false ? "false" : "true"}`,
      "    cache_ttl_ms: 0",
      "    retry: 0",
      "",
    ].join("\n"),
  );
  return loadConfig(path);
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.FAKE_LOG;
  delete process.env.FAKE_MODE;
  delete process.env.FAKE_COUNTER;
});

describe("映射", () => {
  it("帖子：去 refer、标题带作者、engine=weibo", () => {
    const results = mapWeiboSearchRows(
      [
        {
          rank: 1,
          title: "洛天依演唱会",
          author: "Vsinger_洛天依",
          time: "今天 12:00",
          url: "https://weibo.com/5146173015/R1?refer_flag=1001030103_",
        },
      ],
      10,
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      url: "https://weibo.com/5146173015/R1",
      title: "@Vsinger_洛天依：洛天依演唱会",
      engine: "weibo",
    });
    expect(results[0]?.content).toContain("作者：Vsinger_洛天依");
  });

  it("热搜：标题含排名/热度，engine=weibo_hot", () => {
    const results = mapWeiboHotRows(
      [{ rank: 2, word: "测试话题", hot_value: 123456, category: "文娱", label: "热", url: "https://s.weibo.com/weibo?q=x" }],
      10,
    );
    expect(results[0]).toMatchObject({
      title: "#2 测试话题（热度 123456）",
      content: "文娱｜热",
      engine: "weibo_hot",
    });
  });

  it("stripWeiboRefer 只删跟踪参数", () => {
    expect(stripWeiboRefer("https://weibo.com/1/R1?refer_flag=x&a=1")).toBe("https://weibo.com/1/R1?a=1");
    expect(stripWeiboRefer("not a url")).toBe("not a url");
  });
});

describe("搜索源", () => {
  it("空结果重试一次后成功", async () => {
    const cli = writeCli();
    const counter = join(tmpDir(), "counter");
    process.env.FAKE_MODE = "retry";
    process.env.FAKE_COUNTER = counter;
    const result = await searchWeibo("洛天依", { limit: 5, timeoutMs: 5000, retry: 1, cacheTtlMs: 0 }, cli);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.results).toHaveLength(2);
    expect(readFileSync(counter, "utf8")).toBe("2");
  });

  it("缓存命中后不再调用 CLI", async () => {
    const cli = writeCli();
    const log = join(tmpDir(), "calls.log");
    process.env.FAKE_LOG = log;
    const opts = { limit: 5, timeoutMs: 5000, retry: 0, cacheTtlMs: 60000 };
    await searchWeibo("缓存测试", opts, cli);
    await searchWeibo("缓存测试", opts, cli);
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
  });
});

describe("service 类别分支", () => {
  it("categories=weibo 只走微博源，不请求 searxng", async () => {
    const config = makeConfig(writeCli());
    const svc = createSearchService(config, noFilter, silentLogger);
    const result = await svc.search({ query: "洛天依", categories: "weibo" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("洛天依演唱会");
    expect(result.text).toContain("weibo");
    expect(result.text).not.toContain("搜索失败");
  });

  it("categories=weibo_hot 在 query 为空时也能工作", async () => {
    const config = makeConfig(writeCli());
    const svc = createSearchService(config, noFilter, silentLogger);
    const result = await svc.search({ query: "", categories: "weibo_hot" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("测试话题");
    expect(result.text).toContain("123456");
  });

  it("search.weibo.enabled=false 时不接管 weibo 类别", async () => {
    const config = makeConfig(writeCli(), { searchWeibo: false });
    const svc = createSearchService(config, noFilter, silentLogger);
    const result = await svc.search({ query: "洛天依", categories: "weibo" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("SEARCH_UPSTREAM");
  });

  it("weibo.enabled=false 时不接管 weibo 类别", async () => {
    const config = makeConfig(writeCli(), { weibo: false });
    const svc = createSearchService(config, noFilter, silentLogger);
    const result = await svc.search({ query: "", categories: "weibo_hot" });
    expect(result.ok).toBe(false);
  });
});
