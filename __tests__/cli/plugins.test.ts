import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Reporter } from "../../src/cli/output.js";
import {
  listPlugins,
  pluginAction,
  spawnStream,
  type SetupRunner,
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

function fakeReporter(events: Array<Record<string, unknown>> = []): Reporter {
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

function writeExtension(
  root: string,
  manifest: Record<string, unknown>,
  dir = String(manifest.id),
): string {
  const target = path.join(root, "data", "extensions", dir);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "asg-extension.json"), JSON.stringify(manifest), "utf8");
  return target;
}

function writeBackendState(
  root: string,
  pluginId: string,
  states: Record<string, unknown>,
): void {
  const dir = path.join(root, "data", "extension-data", pluginId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "backends.json"), JSON.stringify(states), "utf8");
}

const DEMO_MANIFEST = {
  id: "demo-plugin",
  name: "Demo Plugin",
  version: "1.0.0",
  api_version: 2,
  provides: ["fetch"],
  entry: "index.mjs",
  backends: [
    { id: "demo-backend", name: "Demo Backend", aliases: ["old-demo"] },
    { id: "demo-cli", name: "Demo CLI" },
  ],
  config_schema: {
    type: "object",
    properties: { endpoint: { type: "string" } },
  },
};

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("asg plugins facade 解析顺序", () => {
  it("未命中 manifest 且没有旧安装脚本：PLUGIN_UNKNOWN（退出码 4）并提示 extensions install", async () => {
    const runner = vi.fn<StreamRunner>(async () => ({ code: 0, signal: null }));
    const setup = vi.fn<SetupRunner>(async () => ({ ok: true }));

    await expect(
      pluginAction({
        root: tempRoot(),
        name: "nope",
        action: "install",
        reporter: fakeReporter(),
        runner,
        setup,
      }),
    ).rejects.toMatchObject({
      code: "PLUGIN_UNKNOWN",
      exitCode: 4,
      message: expect.stringContaining("asg extensions install"),
    });
    expect(runner).not.toHaveBeenCalled();
    expect(setup).not.toHaveBeenCalled();
  });

  it("manifest backend aliases 命中：调用 setup，不触碰旧脚本，成功后重启", async () => {
    const root = tempRoot();
    writeExtension(root, DEMO_MANIFEST);

    const events: Array<Record<string, unknown>> = [];
    const setup = vi.fn<SetupRunner>(async () => ({
      ok: true,
      result: { installed: true },
    }));
    const restart = vi.fn(async () => {});
    const runner = vi.fn<StreamRunner>(async () => ({ code: 0, signal: null }));

    const result = await pluginAction({
      root,
      name: "old-demo",
      action: "install",
      reporter: fakeReporter(events),
      setup,
      restart,
      runner,
    });

    expect(setup).toHaveBeenCalledTimes(1);
    expect(setup.mock.calls[0]![0]).toMatchObject({
      root,
      entry: "index.mjs",
      action: "install",
      plugin: { id: "demo-plugin", name: "Demo Plugin", version: "1.0.0" },
      backends: ["demo-backend"],
      configSchema: { type: "object" },
    });
    expect(runner).not.toHaveBeenCalled();
    expect(restart).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      name: "old-demo",
      action: "install",
      restarted: true,
      source: "extension",
      plugin_id: "demo-plugin",
      backend_id: "demo-backend",
    });

    setup.mock.calls[0]![0].onLog?.("下载中");
    expect(events[0]).toMatchObject({
      event: "log",
      service: "old-demo",
      message: "下载中",
    });
  });

  it("backend.id 精确命中时 remove 走 uninstall setup", async () => {
    const root = tempRoot();
    writeExtension(root, DEMO_MANIFEST);
    const setup = vi.fn<SetupRunner>(async () => ({ ok: true }));
    const restart = vi.fn(async () => {});

    const result = await pluginAction({
      root,
      name: "demo-cli",
      action: "uninstall",
      reporter: fakeReporter(),
      setup,
      restart,
    });

    expect(setup.mock.calls[0]![0]).toMatchObject({
      action: "uninstall",
      backends: ["demo-cli"],
    });
    expect(result).toMatchObject({ source: "extension", backend_id: "demo-cli" });
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("manifest setup 失败：PLUGIN_FAILED，且不重启", async () => {
    const root = tempRoot();
    writeExtension(root, DEMO_MANIFEST);
    const restart = vi.fn(async () => {});

    await expect(
      pluginAction({
        root,
        name: "old-demo",
        action: "install",
        reporter: fakeReporter(),
        setup: async () => ({ ok: false, error: "下载失败" }),
        restart,
      }),
    ).rejects.toMatchObject({
      code: "PLUGIN_FAILED",
      exitCode: 1,
      message: expect.stringContaining("下载失败"),
    });
    expect(restart).not.toHaveBeenCalled();
  });

  it("未命中 manifest 时回退旧脚本，name 原样透传并在成功后重启", async () => {
    const { root, cli } = makeInstallRoot();
    const events: Array<Record<string, unknown>> = [];
    const calls: Array<{ command: string; args: string[] }> = [];

    const runner: StreamRunner = async (command, args, options) => {
      calls.push({ command, args });
      options?.onLine?.(
        JSON.stringify({
          type: "event",
          event: "log",
          service: "legacy-name",
          message: "下载中",
        }),
        "stdout",
      );
      options?.onLine?.("[legacy-name] 普通文本", "stderr");
      return { code: 0, signal: null };
    };
    const restart = vi.fn(async () => {});

    const result = await pluginAction({
      root,
      name: "legacy-name",
      action: "install",
      reporter: fakeReporter(events),
      runner,
      restart,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe(process.execPath);
    expect(calls[0]!.args).toEqual([
      cli,
      "legacy-name",
      "install",
      "--root",
      root,
      "--json",
    ]);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      name: "legacy-name",
      action: "install",
      restarted: true,
      source: "legacy",
    });

    expect(events[0]).toMatchObject({
      event: "log",
      service: "legacy-name",
      message: "下载中",
    });
    expect(events[0]).not.toHaveProperty("type");
    expect(events[1]).toMatchObject({
      event: "log",
      service: "legacy-name",
      line: "[legacy-name] 普通文本",
    });
  });

  it("旧脚本失败：PLUGIN_FAILED 并带 previous.json 路径，不重启", async () => {
    const { root } = makeInstallRoot();
    const restart = vi.fn(async () => {});

    await expect(
      pluginAction({
        root,
        name: "legacy-name",
        action: "uninstall",
        reporter: fakeReporter(),
        runner: async () => ({ code: 2, signal: null }),
        restart,
      }),
    ).rejects.toMatchObject({
      code: "PLUGIN_FAILED",
      exitCode: 1,
      message: expect.stringContaining("data/backends/legacy-name/previous.json"),
    });
    expect(restart).not.toHaveBeenCalled();
  });
});

describe("插件列表（通用扫描）", () => {
  it("manifest backends + backends.json 状态 + 旧 data/backends 目录", () => {
    const root = tempRoot();
    writeExtension(root, DEMO_MANIFEST);
    writeBackendState(root, "demo-plugin", {
      "demo-backend": {
        installed: true,
        enabled: true,
        version: "1.2.3",
        path: "/opt/demo",
      },
    });
    // 没有状态文件条目，但 backend 目录存在：仍视为已安装。
    fs.mkdirSync(
      path.join(root, "data", "extension-data", "demo-plugin", "backends", "demo-cli"),
      { recursive: true },
    );
    // aliases 已覆盖的旧目录不应重复出现。
    fs.mkdirSync(path.join(root, "data", "backends", "old-demo"), { recursive: true });
    // 未被覆盖的旧安装。
    const legacyDir = path.join(root, "data", "backends", "legacy-dir");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, "version.json"),
      `${JSON.stringify({ version: "9.9.9" })}\n`,
      "utf8",
    );

    const plugins = listPlugins(root);
    expect(plugins.map((plugin) => plugin.name)).toEqual([
      "old-demo",
      "demo-cli",
      "legacy-dir",
    ]);

    expect(plugins[0]).toMatchObject({
      name: "old-demo",
      plugin_id: "demo-plugin",
      backend_id: "demo-backend",
      aliases: ["old-demo"],
      platform: "",
      channel: "",
      channel_id: "",
      installed: true,
      enabled: true,
      version: "1.2.3",
      path: "/opt/demo",
    });
    expect(plugins[1]).toMatchObject({
      name: "demo-cli",
      plugin_id: "demo-plugin",
      backend_id: "demo-cli",
      installed: true,
      enabled: false,
    });
    expect(plugins[2]).toMatchObject({
      name: "legacy-dir",
      platform: "",
      channel: "",
      channel_id: "",
      installed: true,
      enabled: false,
      version: "9.9.9",
      path: legacyDir,
    });
  });

  it("asg plugins list 输出 deprecation 提示与 JSON 数据", async () => {
    const root = tempRoot();
    writeExtension(root, DEMO_MANIFEST);
    writeBackendState(root, "demo-plugin", {
      "demo-backend": { installed: true, version: "1.0.0" },
    });

    const result = await runPlugins({
      root,
      reporter: fakeReporter(),
      rest: ["list"],
    });

    expect(result.human).toContain("NAME");
    expect(result.human).toContain("已弃用");
    expect(result.human).toContain("asg extensions install/setup/remove");
    expect(result.data).toMatchObject({
      deprecated: expect.stringContaining("已弃用"),
      plugins: expect.arrayContaining([
        expect.objectContaining({
          name: "old-demo",
          plugin_id: "demo-plugin",
          backend_id: "demo-backend",
          installed: true,
          version: "1.0.0",
        }),
      ]),
    });
  });

  it("没有 manifest 与旧目录时返回空列表", () => {
    expect(listPlugins(tempRoot())).toEqual([]);
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
