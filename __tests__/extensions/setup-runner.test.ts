import { spawn, type fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runPluginSetup, type RunPluginSetupResult } from "../../src/extensions/setup/runner.js";

const PLUGIN = { id: "example-plugin", name: "Example Plugin", version: "0.1.0" };
const FIXTURES = fileURLToPath(new URL("./fixtures/example-plugin", import.meta.url));
const WORKER_TS = fileURLToPath(new URL("../../src/extensions/setup/worker.ts", import.meta.url));
const TSX_CLI = path.resolve("node_modules/tsx/dist/cli.mjs");

const tempDirs: string[] = [];

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, timeoutMs = 1_500): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid);
}

/**
 * 测试专用 fork：用 tsx 直接跑 `src/extensions/setup/worker.ts`，
 * 因而测试不依赖 `npm run build` 生成的 dist/worker.js。
 */
const tsxFork = ((_modulePath: string, _args: readonly string[], options: Record<string, unknown>) =>
  spawn(process.execPath, [TSX_CLI, WORKER_TS], {
    cwd: options.cwd as string | undefined,
    env: options.env as NodeJS.ProcessEnv | undefined,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  })) as unknown as typeof fork;

function makePluginRoot(entryName = "plugin.mjs"): {
  root: string;
  pluginDir: string;
  entry: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "asg-setup-runner-"));
  tempDirs.push(root);
  const pluginDir = path.join(root, "data", "extensions", PLUGIN.id);
  fs.mkdirSync(pluginDir, { recursive: true });
  const entry = path.join(pluginDir, entryName);
  fs.copyFileSync(path.join(FIXTURES, entryName), entry);
  return { root, pluginDir, entry };
}

async function run(
  root: string,
  entry: string,
  overrides: Partial<Parameters<typeof runPluginSetup>[0]> = {},
): Promise<RunPluginSetupResult> {
  return runPluginSetup({
    root,
    entry,
    action: "install",
    plugin: PLUGIN,
    backends: ["demo"],
    fork: tsxFork,
    ...overrides,
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("runPluginSetup（真实 fork，tsx 运行 worker.ts）", () => {
  it("执行 setup、转发 log/progress、回传结果", async () => {
    const { root, pluginDir, entry } = makePluginRoot();
    const logs: string[] = [];
    const progress: Array<[string, string | undefined]> = [];

    const result = await run(root, entry, {
      onLog: (message) => logs.push(message),
      onProgress: (phase, detail) => progress.push([phase, detail]),
    });

    expect(result.ok).toBe(true);
    const value = result.result as {
      action: string;
      backends: string[];
      plugin: typeof PLUGIN;
      host: { os: string; arch: string };
      pluginDir: string;
      dataDir: string;
      tempDir: string;
      marker: string;
      before: unknown;
      backendState: unknown;
    };
    expect(value.action).toBe("install");
    expect(value.backends).toEqual(["demo"]);
    expect(value.plugin).toEqual(PLUGIN);
    expect(["linux", "darwin", "win32"]).toContain(value.host.os);
    expect(typeof value.host.arch).toBe("string");
    expect(value.pluginDir).toBe(pluginDir);
    expect(value.dataDir).toBe(path.join(root, "data", "extension-data", PLUGIN.id));
    expect(value.tempDir).toBe(path.join(value.dataDir, "tmp"));
    expect(value.dataDir.startsWith(`${pluginDir}${path.sep}`)).toBe(false);
    expect(value.marker).toBe("hello from setup\n");
    expect(value.before).toBeNull();
    expect(value.backendState).toEqual({ version: "0.1.0" });

    expect(logs.some((line) => line.includes("action=install"))).toBe(true);
    expect(progress).toContainEqual(["checking", "example-plugin"]);
    expect(progress.some(([phase]) => phase === "done")).toBe(true);

    // 宿主真实落盘：数据在 extension-data 下，插件目录更新不会带走它。
    const dataDir = path.join(root, "data", "extension-data", PLUGIN.id);
    const marker = path.join(dataDir, "backends", "demo", "marker.txt");
    expect(fs.readFileSync(marker, "utf8")).toBe("hello from setup\n");
    const state = JSON.parse(
      fs.readFileSync(path.join(dataDir, "state.json"), "utf8"),
    ) as unknown;
    expect(state).toEqual({ installed: true, action: "install" });
  });

  it("configSchema 透传：合法写入，非法拒绝且文件不变", async () => {
    const { root, entry } = makePluginRoot("config.mjs");
    const gateway = path.join(root, "gateway.yaml");
    fs.writeFileSync(gateway, "# 配置注释\nextensions: {}\n", "utf8");
    const configSchema = {
      type: "object",
      properties: { timeout_ms: { type: "integer", minimum: 1000 } },
      additionalProperties: false,
    };

    const good = await run(root, entry, { configSchema });
    expect(good.ok).toBe(true);
    expect((good.result as { config: unknown }).config).toEqual({ timeout_ms: 20000 });

    const before = fs.readFileSync(gateway, "utf8");
    const bad = await run(root, entry, {
      action: "update",
      backends: ["invalid"],
      configSchema,
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("插件配置校验失败");
    expect(fs.readFileSync(gateway, "utf8")).toBe(before);
    expect(before).toContain("# 配置注释");
  });

  it("uninstall 可以读取并清理 backendState", async () => {
    const { root, entry } = makePluginRoot();

    const install = await run(root, entry, { action: "install" });
    expect(install.ok).toBe(true);

    const uninstall = await run(root, entry, { action: "uninstall" });
    expect(uninstall.ok).toBe(true);
    expect(uninstall.result).toEqual({
      action: "uninstall",
      removed: { version: "0.1.0" },
    });
  });

  it("setup 抛异常时返回 ok=false 且保留错误信息", async () => {
    const { root, entry } = makePluginRoot("throw.mjs");
    const logs: string[] = [];

    const result = await run(root, entry, { onLog: (line) => logs.push(line) });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("BOOM: setup failed");
    expect(result.result).toBeUndefined();
    // 异常来自 worker 的 done.error；子进程被清理，也不会创建插件数据目录
    expect(fs.existsSync(path.join(root, "data", "extension-data", PLUGIN.id))).toBe(false);
    expect(logs.some((line) => line.includes("setup stderr"))).toBe(false);
  });

  it("超时会终止子进程并返回明确错误", async () => {
    const { root, entry } = makePluginRoot("hang.mjs");
    const logs: string[] = [];
    const started = Date.now();

    const result = await run(root, entry, {
      timeoutMs: 1_500,
      onLog: (line) => logs.push(line),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("1500ms 内未完成");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(logs).toContain("hang:start");
  });

  it("超时会终止命令树，不留下继承 stdio 的孙进程", async () => {
    const { root, entry } = makePluginRoot("background.mjs");
    const started = Date.now();

    const result = await run(root, entry, { timeoutMs: 2_500 });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("2500ms 内未完成");
    expect(Date.now() - started).toBeLessThan(10_000);

    const pidFile = path.join(
      root,
      "data",
      "extension-data",
      PLUGIN.id,
      "tmp",
      "grandchild.pid",
    );
    expect(fs.existsSync(pidFile)).toBe(true);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(0);
    expect(await waitUntilDead(pid)).toBe(true);
  });

  it("fire-and-forget 的未捕获异常通过 done error 返回", async () => {
    const { root, entry } = makePluginRoot("uncaught.mjs");
    const result = await run(root, entry);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("ASYNC_BOOM");
    expect(result.result).toBeUndefined();
  });

  it("未处理的 Promise rejection 通过 done error 返回", async () => {
    const { root, entry } = makePluginRoot("unhandled.mjs");
    const result = await run(root, entry);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("REJECTION_BOOM");
    expect(result.result).toBeUndefined();
  });

  it("入口没有导出 setup 函数时给出明确错误", async () => {
    const { root, entry } = makePluginRoot("not-a-function.mjs");
    const result = await run(root, entry);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("没有导出 setup 函数");
  });

  it("入口路径必须位于插件目录内", async () => {
    const { root } = makePluginRoot();
    const outside = path.join(root, "outside.mjs");
    fs.writeFileSync(outside, "export function setup() {}\n", "utf8");

    await expect(run(root, outside)).rejects.toThrow(/入口必须位于插件目录内/);
  });

  it("worker 不存在时提示先 npm run build", async () => {
    const { root, entry } = makePluginRoot();
    const result = await runPluginSetup({
      root,
      entry,
      action: "status",
      plugin: PLUGIN,
      workerPath: path.join(root, "missing-worker.js"),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("npm run build");
  });
});
