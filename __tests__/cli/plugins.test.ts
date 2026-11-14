import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Reporter } from "../../src/cli/output.js";
import {
  listPlugins,
  pluginAction,
  spawnStream,
  type StreamRunner,
} from "../../src/cli/deps/plugins.js";

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
      installed: true,
      version: "1.2.3",
      enabled: true,
      path: path.join(backends, "bili"),
    });

    expect(plugins.find((plugin) => plugin.name === "ytdlp")).toMatchObject({
      installed: false,
      enabled: false,
    });
    expect(plugins.find((plugin) => plugin.name === "opencli")).toMatchObject({
      installed: false,
      enabled: false,
    });
    expect(plugins.find((plugin) => plugin.name === "article")).toMatchObject({
      installed: true,
      version: "0.4.0",
      enabled: true,
      path: path.join(backends, "article-server"),
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
