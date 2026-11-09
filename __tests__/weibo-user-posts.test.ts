import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSettings } from "../src/settings/index.js";
import type { FetchPluginContext } from "../src/fetch/plugins/types.js";
import { weiboPlugin } from "../src/weibo/index.js";

const dirs: string[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "weibo-posts-"));
  dirs.push(d);
  return d;
}

const FAKE_CLI = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const cmd = args[1];
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, args.join(" ") + "\\n");
if (cmd !== "user-posts") { console.error("unknown command: " + cmd); process.exit(1); }
const get = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ""; };
const start = get("--start");
const end = get("--end");
const mode = process.env.FAKE_MODE || "two";
const row = (i, day) => ({
  rank: i,
  id: day + "-" + i,
  mblogid: day + "-" + i,
  author: "测试作者",
  text: "第 " + i + " 条微博",
  time: "Mon Nov 02 " + String(10 + (i % 10)).padStart(2, "0") + ":00:00 +0800 2026",
  reposts: 1,
  comments: 2,
  likes: 3,
  pic_count: 1,
  url: "https://weibo.com/1/" + day + "-" + i,
});
if (mode === "empty") { console.error("no posts"); process.exit(66); }
if (mode === "range" && start !== end) {
  const rows = [];
  for (let i = 1; i <= 100; i++) rows.push(row(i, "range"));
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
if (mode === "single100") {
  const rows = [];
  for (let i = 1; i <= 100; i++) rows.push(row(i, start));
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
if (mode === "range") {
  process.stdout.write(JSON.stringify([row(1, start)]));
  process.exit(0);
}
process.stdout.write(JSON.stringify([row(1, start), row(2, start)]));
`;

function makeConfig(mode: string, overrides: Record<string, string> = {}): FetchPluginContext {
  const d = tmpDir();
  const cli = join(d, "fake-opencli.js");
  writeFileSync(cli, FAKE_CLI);
  chmodSync(cli, 0o755);
  process.env.FAKE_MODE = mode;
  const lines = [
    "gateway: { host: 127.0.0.1 }",
    "weibo:",
    "  enabled: true",
    `  cli: { command: "${cli}", timeout_ms: 5000 }`,
  ];
  if (!("cache_ttl_ms" in overrides)) lines.push("  cache_ttl_ms: 0");
  for (const [k, v] of Object.entries(overrides)) lines.push(`  ${k}: ${v}`);
  const path = join(d, "gateway.yaml");
  writeFileSync(path, lines.join("\n") + "\n");
  const { settings, secrets } = loadSettings({ configPath: path, secretsPath: join(d, "secrets.yaml"), env: {} });
  return {
    settings: { fetch: settings.fetch, bilibili: settings.bilibili, weibo: settings.weibo },
    secrets: { bilibili: { http: { token: secrets.bilibili.http.token } } },
  };
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.FAKE_LOG;
  delete process.env.FAKE_MODE;
});

describe("user-posts 时间段抓取", () => {
  it("默认最近 7 天返回 Markdown（按日期分组、含互动数）", () => {
    const config = makeConfig("two");
    return weiboPlugin
      .fetch(new URL("https://weibo.com/u/1?weibo=user-posts"), config)
      .then((result) => {
        expect(result.ok).toBe(true);
        expect(result.contentType).toBe("text/markdown");
        const text = result.bytes?.toString("utf8") ?? "";
        expect(text).toContain("# @测试作者");
        expect(text).toContain("共 2 条，1 次抓取。");
        expect(text).toContain("## 2026-11-02");
        expect(text).toContain("赞 3 · 评 2 · 转 1 · 图 1");
      });
  });

  it("区间满 100 条时二分抓取并去重", async () => {
    const config = makeConfig("range");
    const log = join(tmpDir(), "calls.log");
    process.env.FAKE_LOG = log;
    const result = await weiboPlugin.fetch(
      new URL("https://weibo.com/u/1?weibo=user-posts&start=2026-04-01&end=2026-04-02"),
      config,
    );
    expect(result.ok).toBe(true);
    const text = result.bytes?.toString("utf8") ?? "";
    expect(text).toContain("共 2 条，3 次抓取。");
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(3);
  });

  it("单日满 100 条时提示可能不完整", async () => {
    const config = makeConfig("single100");
    const result = await weiboPlugin.fetch(
      new URL("https://weibo.com/u/1?weibo=user-posts&start=2026-03-01&end=2026-03-01"),
      config,
    );
    const text = result.bytes?.toString("utf8") ?? "";
    expect(result.ok).toBe(true);
    expect(text).toContain("单日 100 条上限");
    expect(text).toContain("2026-03-01");
  });

  it("max_items 截断并提示", async () => {
    const config = makeConfig("single100");
    const result = await weiboPlugin.fetch(
      new URL(
        "https://weibo.com/u/1?weibo=user-posts&start=2026-03-01&end=2026-03-01&max_items=10",
      ),
      config,
    );
    const text = result.bytes?.toString("utf8") ?? "";
    expect(result.ok).toBe(true);
    expect(text).toContain("共 10 条");
    expect(text).toContain("max_items=10");
  });

  it("空区间返回空 Markdown，不报错", async () => {
    const config = makeConfig("empty");
    const result = await weiboPlugin.fetch(
      new URL("https://weibo.com/u/1?weibo=user-posts&start=2026-05-01&end=2026-05-02"),
      config,
    );
    expect(result.ok).toBe(true);
    expect(result.bytes?.toString("utf8")).toContain("没有抓到微博");
  });

  it("同一时间段命中缓存后不再调用 CLI", async () => {
    const config = makeConfig("two", { cache_ttl_ms: "60000" });
    const d = tmpDir();
    const log = join(d, "calls.log");
    process.env.FAKE_LOG = log;
    const url = new URL("https://weibo.com/u/1?weibo=user-posts&start=2026-06-01&end=2026-06-07");
    await weiboPlugin.fetch(url, config);
    await weiboPlugin.fetch(url, config);
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
  });
});
