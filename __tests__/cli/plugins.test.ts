import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Reporter } from "../../src/cli/output.js";
import {
  listPlugins,
  normalizePluginInput,
  pluginAction,
  spawnStream,
  type StreamRunner,
} from "../../src/cli/deps/plugins.js";
import { run as runPlugins } from "../../src/cli/commands/plugins.js";

const tempDirs: string[] = [];

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asg-plugins-"));
  tempDirs.push(dir);
  return dir;
}

function makeInstallRoot(): { root: string; cli: string } {
  const root = tempRoot();
  const release = path.join(root, "release");
  const cli = path.join(release, "scripts", "backends", "cli.mjs");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, "", "utf8");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "data", "current.json"),
    `${JSON.stringify({ dir: release, version: "0.3.0" })}\n`,
    "utf8",
  );
  return { root, cli };
}

function fakeReporter(events: Array<Record<string, unknown>>): Reporter {
  return {
    mode: "jsonl",
    event: (event: Record<string, unknown>) => {
      events.push(event);
    },
    info: vi.fn(),
    line: vi.fn(),
    result: vi.fn(),
  } as unknown as Reporter;
}

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("插件参数与名称校验", () => {
  it("未知插件名抛 PLUGIN_UNKNOWN（退出码 4），不触碰子进程", async () => {
    const runner = vi.fn<StreamRunner>(async () => ({ code: 0, signal: null }));
    await expect(
      pluginAction({
        root: tempRoot(),
        name: "nope",
        action: "install",
        reporter: fakeReporter([]),
        runner,
      }),
    ).rejects.toMatchObject({ code: "PLUGIN_UNKNOWN", exitCode: 4 });
    expect(runner).not.toHaveBeenCalled();
  });

  it("cnki:http 是内置平台，报 PLUGIN_UNKNOWN 并提示无需安装", async () => {
    const runner = vi.fn<StreamRunner>(async () => ({ code: 0, signal: null }));
    await expect(
      pluginAction({
        root: tempRoot(),
        name: "cnki:http",
        action: "install",
        reporter: fakeReporter([]),
        runner,
      }),
    ).rejects.toMatchObject({
      code: "PLUGIN_UNKNOWN",
      exitCode: 4,
      message: expect.stringContaining("cnki 是内置平台，无需安装"),
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it("normalizePluginInput 接受旧名、规范通道 ID 与别名", () => {
    expect(normalizePluginInput("bili")).toBe("bili");
    expect(normalizePluginInput("bilibili:kukemc")).toBe("bili");
    expect(normalizePluginInput("bilibili:ytdlp")).toBe("ytdlp");
    expect(normalizePluginInput("weibo:opencli")).toBe("opencli");
    expect(normalizePluginInput("weibo")).toBe("opencli");
    expect(normalizePluginInput("article")).toBe("article");
    expect(normalizePluginInput("bilibili:http")).toBe("article");
    expect(normalizePluginInput("cnki:http")).toBeUndefined();
    expect(normalizePluginInput("nope")).toBeUndefined();
  });

  it("install 拼装 --root/--json，透传事件并在成功后重启", async () => {
    const { root, cli } = makeInstallRoot();
    const events: Array<Record<string, unknown>> = [];
    const calls: Array<{ command: string; args: string[] }> = [];

    const runner: StreamRunner = async (command, args, options) => {
      calls.push({ command, args });
      options?.onLine?.(
        JSON.stringify({ type: "event", event: "log", service: "bili", message: "下载中" }),
        "stdout",
      );
      options?.onLine?.("[bili] 普通文本", "stderr");
      return { code: 0, signal: null };
    };
    const restart = vi.fn(async () => {});

    const result = await pluginAction({
      root,
      name: "bili",
      action: "install",
      reporter: fakeReporter(events),
      runner,
      restart,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual([cli, "bili", "install", "--root", root, "--json"]);
    expect(calls[0]!.command).toBe(process.execPath);
    expect(result).toEqual({ name: "bili", action: "install", restarted: true });
    expect(restart).toHaveBeenCalledTimes(1);

    expect(events[0]).toMatchObject({ event: "log", service: "bili", message: "下载中" });
    expect(events[0]).not.toHaveProperty("type");
    expect(events[1]).toMatchObject({ event: "log", service: "bili", line: "[bili] 普通文本" });
  });

  it("install 规范通道 ID 归一化成安装名", async () => {
    for (const [input, expected] of [
      ["bilibili:ytdlp", "ytdlp"],
      ["weibo:opencli", "opencli"],
      ["bilibili:article", "article"],
      ["bilibili:kukemc", "bili"],
    ] as const) {
      const { root, cli } = makeInstallRoot();
      const calls: Array<{ command: string; args: string[] }> = [];
      const runner: StreamRunner = async (command, args) => {
        calls.push({ command, args });
        return { code: 0, signal: null };
      };

      const result = await pluginAction({
        root,
        name: input,
        action: "install",
        reporter: fakeReporter([]),
        runner,
        restart: async () => {},
      });

      expect(calls[0]!.args).toEqual([cli, expected, "install", "--root", root, "--json"]);
      expect(result.name).toBe(expected);
    }
  });

  it("remove 传 uninstall；失败抛 PLUGIN_FAILED 并带 previous.json 路径，不重启", async () => {
    const { root } = makeInstallRoot();
    const restart = vi.fn(async () => {});
    const events: Array<Record<string, unknown>> = [];

    const runner: StreamRunner = async () => ({ code: 2, signal: null });

    await expect(
      pluginAction({
        root,
        name: "article",
        action: "uninstall",
        reporter: fakeReporter(events),
        runner,
        restart,
      }),
    ).rejects.toMatchObject({
      code: "PLUGIN_FAILED",
      exitCode: 1,
      message: expect.stringContaining("data/backends/article-server/previous.json"),
    });
    expect(restart).not.toHaveBeenCalled();
  });
});

describe("插件列表", () => {
  it("读 version.json 与 gateway.yaml，离线输出 installed/enabled/version/path", () => {
    const root = tempRoot();
    const backends = path.join(root, "data", "backends");
    for (const [dir, version] of [
      ["bili", "1.2.3"],
      ["article-server", "0.4.0"],
    ] as const) {
      fs.mkdirSync(path.join(backends, dir), { recursive: true });
      fs.writeFileSync(
        path.join(backends, dir, "version.json"),
        `${JSON.stringify({ name: dir, version })}\n`,
        "utf8",
      );
    }

    fs.writeFileSync(
      path.join(root, "gateway.yaml"),
      [
        "bilibili:",
        "  cli_kukemc:",
        "    command: /opt/bili",
        "  cli_ytdlp:",
        "    command: \"\"",
        "  http:",
        "    command: [python, server.py]",
        "",
      ].join("\n"),
      "utf8",
    );

    const plugins = listPlugins(root);
    expect(plugins.map((plugin) => plugin.name)).toEqual(["bili", "ytdlp", "opencli", "article"]);

    const bili = plugins.find((plugin) => plugin.name === "bili")!;
    expect(bili).toMatchObject({
      platform: "bilibili",
      channel: "kukemc",
      channel_id: "bilibili:kukemc",
      installed: true,
      version: "1.2.3",
      enabled: true,
      path: path.join(backends, "bili"),
    });

    expect(plugins.find((plugin) => plugin.name === "ytdlp")).toMatchObject({
      platform: "bilibili",
      channel: "ytdlp",
      channel_id: "bilibili:ytdlp",
      installed: false,
      enabled: false,
    });
    expect(plugins.find((plugin) => plugin.name === "opencli")).toMatchObject({
      platform: "weibo",
      channel: "opencli",
      channel_id: "weibo:opencli",
      installed: false,
      enabled: false,
    });
    expect(plugins.find((plugin) => plugin.name === "article")).toMatchObject({
      platform: "bilibili",
      channel: "article",
      channel_id: "bilibili:article",
      installed: true,
      version: "0.4.0",
      enabled: true,
      path: path.join(backends, "article-server"),
    });
  });

  it("list 表格含 PLATFORM / CHANNEL 列", async () => {
    const root = tempRoot();
    const result = await runPlugins({ root, reporter: fakeReporter([]), rest: ["list"] });
    expect(result.human).toContain("NAME");
    expect(result.human).toContain("PLATFORM");
    expect(result.human).toContain("CHANNEL");
    expect(result.human).toContain("bilibili");
    expect(result.human).toContain("kukemc");
    expect(result.data).toMatchObject({
      plugins: expect.arrayContaining([
        expect.objectContaining({
          name: "bili",
          platform: "bilibili",
          channel: "kukemc",
          channel_id: "bilibili:kukemc",
        }),
        expect.objectContaining({
          name: "opencli",
          platform: "weibo",
          channel: "opencli",
          channel_id: "weibo:opencli",
        }),
      ]),
    });
  });

  it("gateway.yaml 缺失时仍可列出已安装插件", () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, "data", "backends", "ytdlp"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "data", "backends", "ytdlp", "version.json"),
      `${JSON.stringify({ version: "2026.01.01" })}\n`,
      "utf8",
    );

    const plugins = listPlugins(root);
    expect(plugins.find((plugin) => plugin.name === "ytdlp")).toMatchObject({
      installed: true,
      version: "2026.01.01",
      enabled: false,
    });
  });
});

describe("默认流式 runner", () => {
  it("逐行回调 stdout 与 stderr", async () => {
    const lines: Array<[string, string]> = [];
    const result = await spawnStream(
      process.execPath,
      ["-e", "process.stdout.write('a\\nb\\n'); process.stderr.write('c\\n')"],
      { onLine: (line, stream) => lines.push([stream, line]) },
    );

    expect(result.code).toBe(0);
    expect(lines).toEqual([
      ["stdout", "a"],
      ["stdout", "b"],
      ["stderr", "c"],
    ]);
  });
});
