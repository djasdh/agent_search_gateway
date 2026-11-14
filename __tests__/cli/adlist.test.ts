import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Reporter } from "../../src/cli/output.js";
import {
  countHostEntries,
  readConfiguredLevel,
  run as adlistRun,
  setHostsFetcherForTests,
  setRestartForTests,
} from "../../src/cli/commands/adlist.js";
import { HOSTS_SOURCES } from "../../src/filter/domain-filter.js";

const reporter = new Reporter({ json: true, jsonl: false });
const dirs: string[] = [];
const restartCalls: string[] = [];
const fetched: string[] = [];

const HOSTS_TEXT = [
  "# StevenBlack hosts",
  "127.0.0.1 localhost",
  "",
  "0.0.0.0 ads.example.com",
  "0.0.0.0 tracker.example.net",
  "::1 ipv6.example.org",
  "not-a-host-line",
  "",
].join("\n");

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asg-adlist-"));
  dirs.push(dir);
  return dir;
}

function makeRoot(level?: string): string {
  const root = tempRoot();
  const lines = ["gateway:", "  port: 3000"];
  if (level !== undefined) lines.push("ad_filter:", `  level: ${level}`);
  fs.writeFileSync(path.join(root, "gateway.yaml"), `${lines.join("\n")}\n`, "utf8");
  return root;
}

beforeEach(() => {
  restartCalls.length = 0;
  fetched.length = 0;
  setRestartForTests(async (root) => {
    restartCalls.push(root);
  });
  setHostsFetcherForTests(async (url) => {
    fetched.push(url);
    return HOSTS_TEXT;
  });
});

afterEach(() => {
  setRestartForTests(null);
  setHostsFetcherForTests(null);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("adlist update", () => {
  it("不带 --level 时读 gateway.yaml，写文件并整栈重启", async () => {
    const root = makeRoot("full");

    const result = await adlistRun({ root, reporter, rest: ["update"] });
    const hostsPath = path.join(root, "data", "adblock", "hosts");

    expect(result.data).toEqual({
      level: "full",
      entries: 4,
      path: hostsPath,
      restart: "all",
      restarted: true,
    });
    expect(result.human).toContain("整栈重启会断开所有 MCP 连接");
    expect(fetched).toEqual([HOSTS_SOURCES.full]);
    expect(fs.readFileSync(hostsPath, "utf8")).toBe(HOSTS_TEXT);
    expect(restartCalls).toEqual([root]);
  });

  it("--level 覆盖配置", async () => {
    const root = makeRoot("full");

    const result = await adlistRun({ root, reporter, rest: ["update", "--level", "ads"] });

    expect((result.data as { level: string }).level).toBe("ads");
    expect(fetched).toEqual([HOSTS_SOURCES.ads]);
    expect(restartCalls).toHaveLength(1);
  });

  it("level=off 直接成功，不下载也不重启", async () => {
    const root = makeRoot("off");

    const result = await adlistRun({ root, reporter, rest: ["update"] });

    expect(result.data).toEqual({
      level: "off",
      entries: 0,
      path: path.join(root, "data", "adblock", "hosts"),
      restart: "all",
      restarted: false,
    });
    expect(result.human).toContain("无需更新");
    expect(fetched).toHaveLength(0);
    expect(restartCalls).toHaveLength(0);
    expect(fs.existsSync(path.join(root, "data", "adblock", "hosts"))).toBe(false);
  });

  it("配置省略 ad_filter.level 时默认 ads", async () => {
    const root = makeRoot();
    expect(readConfiguredLevel(root)).toBe("ads");

    const result = await adlistRun({ root, reporter, rest: ["update"] });
    expect((result.data as { level: string }).level).toBe("ads");
    expect(fetched).toEqual([HOSTS_SOURCES.ads]);
  });

  it("下载失败报 DOWNLOAD_FAILED，不写文件也不重启", async () => {
    const root = makeRoot("ads");
    setHostsFetcherForTests(async () => {
      throw new Error("network down");
    });

    await expect(adlistRun({ root, reporter, rest: ["update"] })).rejects.toMatchObject({
      code: "DOWNLOAD_FAILED",
      exitCode: 1,
    });
    expect(fs.existsSync(path.join(root, "data", "adblock", "hosts"))).toBe(false);
    expect(restartCalls).toHaveLength(0);
  });

  it("未知 level 退出码 2", async () => {
    const root = makeRoot("ads");
    await expect(
      adlistRun({ root, reporter, rest: ["update", "--level", "extreme"] }),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(fetched).toHaveLength(0);
  });

  it("缺少 update 子命令退出码 2", async () => {
    const root = makeRoot("ads");
    await expect(adlistRun({ root, reporter, rest: [] })).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe("countHostEntries", () => {
  it("只统计有效 hosts 行，忽略注释、空行与非法行", () => {
    expect(countHostEntries(HOSTS_TEXT)).toBe(4);
    expect(countHostEntries("")).toBe(0);
    expect(countHostEntries("# 0.0.0.0 comment.com\n0.0.0.0 a.com\n")).toBe(1);
  });
});
