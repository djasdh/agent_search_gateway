import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Reporter } from "../../src/cli/output.js";
import type { SetupRunner } from "../../src/cli/commands/extensions.js";
import {
  run,
  setExtensionsApiForTests,
} from "../../src/cli/commands/extensions.js";

const tempDirs: string[] = [];

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asg-extensions-setup-"));
  tempDirs.push(dir);
  return dir;
}

function fakeReporter(
  events: Array<Record<string, unknown>> = [],
): Reporter & { info: ReturnType<typeof vi.fn> } {
  return {
    mode: "jsonl",
    event: (event: Record<string, unknown>) => {
      events.push(event);
    },
    info: vi.fn(),
    line: vi.fn(),
    result: vi.fn(),
  } as unknown as Reporter & { info: ReturnType<typeof vi.fn> };
}

const CONFIG_SCHEMA = {
  type: "object",
  properties: { endpoint: { type: "string", description: "上游地址" } },
};

const BACKENDS = [
  { id: "demo-api", name: "Demo API", aliases: ["old-demo"] },
  { id: "demo-cli", name: "Demo CLI" },
];

const MANIFEST = {
  id: "demo-plugin",
  name: "Demo Plugin",
  version: "1.0.0",
  api_version: 2,
  provides: ["fetch"],
  entry: "index.mjs",
  backends: BACKENDS,
  config_schema: CONFIG_SCHEMA,
};

function writeManifest(
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
): string {
  const dir = path.join(root, "data", "extension-data", pluginId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "backends.json");
  fs.writeFileSync(file, JSON.stringify(states), "utf8");
  return file;
}

function installResult(): {
  id: string;
  version: string;
  name: string;
  provides: string[];
  backends: typeof BACKENDS;
  path: string;
} {
  return {
    id: "demo-plugin",
    version: "1.0.0",
    name: "Demo Plugin",
    provides: ["fetch"],
    backends: BACKENDS,
    path: "/root/data/extensions/demo-plugin",
  };
}

afterEach(() => {
  setExtensionsApiForTests(null);
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("asg extensions install 自动 setup", () => {
  it("默认对 manifest 声明的全部后端执行 install setup", async () => {
    const setup = vi.fn<SetupRunner>(async () => ({
      ok: true,
      result: { installed: ["demo-api", "demo-cli"] },
    }));
    const install = vi.fn(async () => installResult());
    const loadManifest = vi.fn(() => MANIFEST);
    setExtensionsApiForTests({ install, setup, loadManifest });

    const result = await run({
      root: "/root",
      reporter: fakeReporter(),
      rest: ["install", "owner/repo"],
    });

    expect(install).toHaveBeenCalledWith({
      root: "/root",
      repo: "owner/repo",
      logger: expect.any(Function),
    });
    expect(loadManifest).toHaveBeenCalledWith("/root", "demo-plugin");
    expect(setup).toHaveBeenCalledTimes(1);
    expect(setup.mock.calls[0]![0]).toMatchObject({
      root: "/root",
      entry: "index.mjs",
      action: "install",
      plugin: { id: "demo-plugin", name: "Demo Plugin", version: "1.0.0" },
      backends: ["demo-api", "demo-cli"],
      configSchema: CONFIG_SCHEMA,
      onLog: expect.any(Function),
    });

    expect(result.human).toContain("demo-plugin");
    expect(result.human).toContain("后端: demo-api, demo-cli");
    expect(result.human).toContain("路径: /root/data/extensions/demo-plugin");
    expect(result.human).toContain("重启网关后生效");
    expect(result.data).toMatchObject({
      id: "demo-plugin",
      plugin_id: "demo-plugin",
      backends: ["demo-api", "demo-cli"],
      backend_ids: ["demo-api", "demo-cli"],
      restarted: false,
      setup: { attempted: true, ok: true, action: "install" },
    });
  });

  it("--no-setup 跳过 setup，但仍报告后端", async () => {
    const setup = vi.fn<SetupRunner>(async () => ({ ok: true }));
    setExtensionsApiForTests({
      install: async () => installResult(),
      setup,
      loadManifest: () => MANIFEST,
    });

    const result = await run({
      root: "/root",
      reporter: fakeReporter(),
      rest: ["install", "owner/repo", "--no-setup"],
    });

    expect(setup).not.toHaveBeenCalled();
    expect(result.human).toContain("已跳过");
    expect(result.data).toMatchObject({
      backends: ["demo-api", "demo-cli"],
      backend_ids: ["demo-api", "demo-cli"],
      restarted: false,
      setup: { attempted: false, backends: ["demo-api", "demo-cli"] },
    });
  });

  it("--backend 缩小范围；可重复并可等待号形式", async () => {
    const setup = vi.fn<SetupRunner>(async () => ({ ok: true }));
    setExtensionsApiForTests({
      install: async () => installResult(),
      setup,
      loadManifest: () => MANIFEST,
    });

    const single = await run({
      root: "/root",
      reporter: fakeReporter(),
      rest: ["install", "owner/repo@v1.0.0", "--backend", "demo-api"],
    });
    expect(setup.mock.calls[0]![0].backends).toEqual(["demo-api"]);
    expect(single.data).toMatchObject({ backends: ["demo-api", "demo-cli"] });

    setup.mockClear();
    await run({
      root: "/root",
      reporter: fakeReporter(),
      rest: [
        "install",
        "owner/repo",
        "--backend=demo-cli",
        "--backend",
        "demo-api",
      ],
    });
    expect(setup.mock.calls[0]![0].backends).toEqual(["demo-cli", "demo-api"]);
  });

  it("未知 --backend 报 CONFIG_INVALID / 退出码 4，说明插件已安装并列出可用后端", async () => {
    const setup = vi.fn<SetupRunner>(async () => ({ ok: true }));
    setExtensionsApiForTests({
      install: async () => installResult(),
      setup,
      loadManifest: () => MANIFEST,
    });

    const error = await run({
      root: "/root",
      reporter: fakeReporter(),
      rest: ["install", "owner/repo", "--backend", "nope"],
    }).catch((caught: unknown) => caught as Error);

    expect(error).toMatchObject({
      code: "CONFIG_INVALID",
      exitCode: 4,
      details: {
        plugin_id: "demo-plugin",
        backend_ids: ["demo-api", "demo-cli"],
        requested_backends: ["nope"],
        restarted: false,
      },
    });
    expect(error.message).toContain("可用：demo-api, demo-cli");
    expect(error.message).toContain(
      "插件已安装到 /root/data/extensions/demo-plugin",
    );
    expect(error.message).toContain("可用后端：demo-api, demo-cli");
    expect(setup).not.toHaveBeenCalled();
  });

  it("插件未声明后端却传 --backend：仍说明插件已安装，可用后端为空", async () => {
    const setup = vi.fn<SetupRunner>(async () => ({ ok: true }));
    setExtensionsApiForTests({
      install: async () => ({ ...installResult(), backends: [] }),
      setup,
      loadManifest: () => MANIFEST,
    });

    const error = await run({
      root: "/root",
      reporter: fakeReporter(),
      rest: ["install", "owner/repo", "--backend", "nope"],
    }).catch((caught: unknown) => caught as Error);

    expect(error).toMatchObject({ code: "CONFIG_INVALID", exitCode: 4 });
    expect(error.message).toContain("插件已安装到 /root/data/extensions/demo-plugin");
    expect(error.message).toContain("可用后端：（无）");
    expect(setup).not.toHaveBeenCalled();
  });

  it("setup 失败：插件保留，命令返回 PLUGIN_FAILED 并提示 extensions setup 重试", async () => {
    setExtensionsApiForTests({
      install: async () => installResult(),
      setup: async () => ({ ok: false, error: "下载失败" }),
      loadManifest: () => MANIFEST,
    });

    await expect(
      run({
        root: "/root",
        reporter: fakeReporter(),
        rest: ["install", "owner/repo"],
      }),
    ).rejects.toMatchObject({
      code: "PLUGIN_FAILED",
      exitCode: 1,
      message: expect.stringContaining("asg extensions setup demo-plugin"),
    });
  });
});

describe("asg extensions setup", () => {
  it("默认 action=install，传入 manifest 入口、后端与 configSchema", async () => {
    const root = tempRoot();
    writeManifest(root, MANIFEST);
    const setup = vi.fn<SetupRunner>(async () => ({ ok: true, result: { done: true } }));
    setExtensionsApiForTests({ setup });

    const result = await run({
      root,
      reporter: fakeReporter(),
      rest: ["setup", "demo-plugin"],
    });

    expect(setup).toHaveBeenCalledWith(
      expect.objectContaining({
        root,
        entry: "index.mjs",
        action: "install",
        plugin: { id: "demo-plugin", name: "Demo Plugin", version: "1.0.0" },
        backends: ["demo-api", "demo-cli"],
        configSchema: CONFIG_SCHEMA,
      }),
    );
    expect(result.human).toContain("action=install");
    expect(result.human).toContain("未自动重启网关");
    expect(result.data).toMatchObject({
      id: "demo-plugin",
      plugin_id: "demo-plugin",
      action: "install",
      backends: ["demo-api", "demo-cli"],
      backend_ids: ["demo-api", "demo-cli"],
      restarted: false,
      setup: { attempted: true, ok: true },
    });
  });

  it("--status / --uninstall 切换 action，--backend 缩小范围", async () => {
    const root = tempRoot();
    writeManifest(root, MANIFEST);
    const setup = vi.fn<SetupRunner>(async () => ({ ok: true, result: { healthy: true } }));
    setExtensionsApiForTests({ setup });

    const status = await run({
      root,
      reporter: fakeReporter(),
      rest: ["setup", "demo-plugin", "--status", "--backend", "demo-cli"],
    });
    expect(setup.mock.calls[0]![0]).toMatchObject({
      action: "status",
      backends: ["demo-cli"],
    });
    expect(status.data).toMatchObject({ action: "status", backends: ["demo-cli"] });

    const uninstall = await run({
      root,
      reporter: fakeReporter(),
      rest: ["setup", "demo-plugin", "--uninstall"],
    });
    expect(setup.mock.calls[1]![0]).toMatchObject({
      action: "uninstall",
      backends: ["demo-api", "demo-cli"],
    });
    expect(uninstall.data).toMatchObject({ action: "uninstall" });
  });

  it("--status 与 --uninstall 互斥；插件没有后端时明确报错", async () => {
    const root = tempRoot();
    writeManifest(root, MANIFEST);
    const setup = vi.fn<SetupRunner>(async () => ({ ok: true }));
    setExtensionsApiForTests({ setup });

    await expect(
      run({
        root,
        reporter: fakeReporter(),
        rest: ["setup", "demo-plugin", "--status", "--uninstall"],
      }),
    ).rejects.toMatchObject({ code: "UNEXPECTED", exitCode: 2 });

    const noBackend = tempRoot();
    writeManifest(noBackend, {
      id: "demo-plugin",
      name: "Demo Plugin",
      version: "1.0.0",
      api_version: 2,
      provides: ["fetch"],
      entry: "index.mjs",
    });

    await expect(
      run({
        root: noBackend,
        reporter: fakeReporter(),
        rest: ["setup", "demo-plugin"],
      }),
    ).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      exitCode: 4,
      message: expect.stringContaining("该插件没有声明后端"),
    });
    expect(setup).not.toHaveBeenCalled();
  });

  it("setup 失败返回 PLUGIN_FAILED", async () => {
    const root = tempRoot();
    writeManifest(root, MANIFEST);
    setExtensionsApiForTests({
      setup: async () => ({ ok: false, error: "状态检查失败" }),
    });

    await expect(
      run({
        root,
        reporter: fakeReporter(),
        rest: ["setup", "demo-plugin", "--status"],
      }),
    ).rejects.toMatchObject({
      code: "PLUGIN_FAILED",
      exitCode: 1,
      message: expect.stringContaining("状态检查失败"),
    });
  });
});

describe("asg extensions remove", () => {
  it("有 backends 时先 uninstall setup，再删除插件目录与数据目录", async () => {
    const root = tempRoot();
    const pluginDir = writeManifest(root, MANIFEST);
    fs.mkdirSync(path.join(root, "data", "extension-data", "demo-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "data", "extension-data", "demo-plugin", "state.json"),
      "{}\n",
      "utf8",
    );
    const setup = vi.fn<SetupRunner>(async () => ({ ok: true }));
    setExtensionsApiForTests({ setup });

    const result = await run({
      root,
      reporter: fakeReporter(),
      rest: ["remove", "demo-plugin"],
    });

    expect(setup).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "uninstall",
        backends: ["demo-api", "demo-cli"],
      }),
    );
    expect(fs.existsSync(pluginDir)).toBe(false);
    expect(fs.existsSync(path.join(root, "data", "extension-data", "demo-plugin"))).toBe(false);
    expect(result.human).toContain("已卸载");
    expect(result.human).toContain("重启网关后生效");
    expect(result.data).toMatchObject({
      id: "demo-plugin",
      plugin_id: "demo-plugin",
      removed: true,
      backends: ["demo-api", "demo-cli"],
      backend_ids: ["demo-api", "demo-cli"],
      data_removed: true,
      restarted: false,
    });
  });

  it("--keep-data 保留 data/extension-data/<id>", async () => {
    const root = tempRoot();
    writeManifest(root, MANIFEST);
    const dataDir = path.join(root, "data", "extension-data", "demo-plugin");
    fs.mkdirSync(dataDir, { recursive: true });
    setExtensionsApiForTests({ setup: async () => ({ ok: true }) });

    const result = await run({
      root,
      reporter: fakeReporter(),
      rest: ["remove", "demo-plugin", "--keep-data"],
    });

    expect(fs.existsSync(dataDir)).toBe(true);
    expect(result.data).toMatchObject({ data_removed: false });
    expect(result.human).toContain("已保留插件数据");
  });

  // root 不受目录权限限制，无法用 chmod 模拟删除失败。
  const canSimulateRmFailure =
    typeof process.getuid !== "function" || process.getuid() !== 0;

  it.skipIf(!canSimulateRmFailure)(
    "数据目录删除失败：插件已卸载，但返回 PLUGIN_FAILED 并保留原错误",
    async () => {
      const root = tempRoot();
      const pluginDir = writeManifest(root, MANIFEST);
      const dataDir = path.join(root, "data", "extension-data", "demo-plugin");
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, "state.json"), "{}\n", "utf8");
      setExtensionsApiForTests({ setup: async () => ({ ok: true }) });

      fs.chmodSync(dataDir, 0o500);
      let error: Error | undefined;
      try {
        error = await run({
          root,
          reporter: fakeReporter(),
          rest: ["remove", "demo-plugin"],
        }).catch((caught: unknown) => caught as Error);
      } finally {
        fs.chmodSync(dataDir, 0o700);
      }

      expect(error).toBeDefined();
      expect(error).toMatchObject({
        code: "PLUGIN_FAILED",
        exitCode: 1,
        details: {
          plugin_id: "demo-plugin",
          path: dataDir,
          restarted: false,
        },
      });
      expect(error!.message).toContain("插件已卸载，但数据目录删除失败");
      expect(error!.message).toContain("EACCES");
      expect((error as { cause?: unknown }).cause).toBeInstanceOf(Error);
      expect(fs.existsSync(pluginDir)).toBe(false);
      expect(fs.existsSync(path.join(dataDir, "state.json"))).toBe(true);
    },
  );

  it("--force 跳过 uninstall setup 直接删除", async () => {
    const root = tempRoot();
    const pluginDir = writeManifest(root, MANIFEST);
    const setup = vi.fn<SetupRunner>(async () => ({ ok: true }));
    setExtensionsApiForTests({ setup });

    await run({
      root,
      reporter: fakeReporter(),
      rest: ["remove", "demo-plugin", "--force"],
    });

    expect(setup).not.toHaveBeenCalled();
    expect(fs.existsSync(pluginDir)).toBe(false);
  });

  it("uninstall setup 失败不删除插件；--force 可继续", async () => {
    const root = tempRoot();
    const pluginDir = writeManifest(root, MANIFEST);
    const setup = vi.fn<SetupRunner>(async () => ({ ok: false, error: "拒绝卸载" }));
    setExtensionsApiForTests({ setup });

    await expect(
      run({
        root,
        reporter: fakeReporter(),
        rest: ["remove", "demo-plugin"],
      }),
    ).rejects.toMatchObject({
      code: "PLUGIN_FAILED",
      exitCode: 1,
      message: expect.stringContaining("插件目录未删除"),
    });
    expect(fs.existsSync(pluginDir)).toBe(true);

    await run({
      root,
      reporter: fakeReporter(),
      rest: ["remove", "demo-plugin", "--force"],
    });
    expect(fs.existsSync(pluginDir)).toBe(false);
    expect(setup).toHaveBeenCalledTimes(1);
  });

  it("未安装插件仍报 PLUGIN_UNKNOWN / 退出码 4", async () => {
    await expect(
      run({
        root: tempRoot(),
        reporter: fakeReporter(),
        rest: ["remove", "nope"],
      }),
    ).rejects.toMatchObject({ code: "PLUGIN_UNKNOWN", exitCode: 4 });
  });
});

describe("asg extensions list 后端状态", () => {
  it("BACKENDS 列与 JSON backends 读取 backends.json，缺失显示未安装", async () => {
    const root = tempRoot();
    writeManifest(root, MANIFEST);
    writeBackendState(root, "demo-plugin", {
      "demo-api": { installed: true, enabled: true, version: "1.2.3", path: "/opt/demo" },
    });

    const result = await run({
      root,
      reporter: fakeReporter(),
      rest: ["list"],
    });

    expect(result.human).toContain("BACKENDS");
    expect(result.human).toContain("demo-api@1.2.3");
    expect(result.human).toContain("demo-cli(未安装)");
    expect(result.data).toMatchObject({
      extensions: [
        {
          id: "demo-plugin",
          backends: [
            {
              id: "demo-api",
              name: "Demo API",
              aliases: ["old-demo"],
              installed: true,
              enabled: true,
              version: "1.2.3",
              path: "/opt/demo",
            },
            {
              id: "demo-cli",
              name: "Demo CLI",
              installed: false,
              enabled: false,
            },
          ],
        },
      ],
    });
  });

  it("backends.json 缺失但后端目录存在时显示已安装（与 asg plugins list 一致）", async () => {
    const root = tempRoot();
    writeManifest(root, MANIFEST);
    fs.mkdirSync(
      path.join(root, "data", "extension-data", "demo-plugin", "backends", "demo-api"),
      { recursive: true },
    );

    const result = await run({
      root,
      reporter: fakeReporter(),
      rest: ["list"],
    });

    expect(result.human).toContain("demo-api");
    expect(result.human).not.toContain("demo-api(未安装)");
    expect(result.human).toContain("demo-cli(未安装)");
    expect(result.data).toMatchObject({
      extensions: [
        {
          id: "demo-plugin",
          backends: [
            expect.objectContaining({ id: "demo-api", installed: true }),
            expect.objectContaining({ id: "demo-cli", installed: false }),
          ],
        },
      ],
    });
  });

  it("状态文件损坏只告警，不影响列表", async () => {
    const root = tempRoot();
    writeManifest(root, MANIFEST);
    const file = path.join(root, "data", "extension-data", "demo-plugin", "backends.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json", "utf8");

    const reporter = fakeReporter();
    const result = await run({ root, reporter, rest: ["list"] });

    expect(reporter.info).toHaveBeenCalledWith(expect.stringContaining("警告"));
    expect(reporter.info).toHaveBeenCalledWith(expect.stringContaining("backends.json"));
    expect(result.human).toContain("demo-plugin");
    expect(result.human).toContain("demo-api(未安装)");
    expect(result.data).toMatchObject({
      extensions: [
        {
          id: "demo-plugin",
          backends: [
            expect.objectContaining({ id: "demo-api", installed: false }),
            expect.objectContaining({ id: "demo-cli", installed: false }),
          ],
        },
      ],
    });
  });
});

describe("asg extensions setup 用法", () => {
  it("缺少参数 / 未知选项按用法错误处理", async () => {
    for (const args of [
      ["setup"],
      ["setup", "demo-plugin", "extra"],
      ["install"],
      ["install", "owner/repo", "extra"],
      ["remove"],
      ["remove", "demo-plugin", "extra"],
    ]) {
      await expect(
        run({ root: tempRoot(), reporter: fakeReporter(), rest: args }),
      ).rejects.toMatchObject({ code: "UNEXPECTED", exitCode: 2 });
    }
  });

  it("帮助里包含 setup 与 --no-setup", async () => {
    const help = await run({
      root: "/root",
      reporter: fakeReporter(),
      rest: ["--help"],
    });
    expect(help.human).toContain("setup");
    expect(help.human).toContain("--no-setup");
  });
});
