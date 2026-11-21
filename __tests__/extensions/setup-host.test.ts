import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setupInitPaths,
  SetupHost,
  type SetupHostOptions,
} from "../../src/extensions/setup/host.js";

const downloadState = vi.hoisted(() => ({
  content: "fake-download",
  error: null as Error | null,
}));

vi.mock("../../scripts/install/http.mjs", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    download: async (_url: string, dest: string) => {
      if (downloadState.error) throw downloadState.error;
      const fsp = await import("node:fs/promises");
      const nodePath = await import("node:path");
      await fsp.mkdir(nodePath.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, downloadState.content);
      return dest;
    },
  };
});

const PLUGIN = { id: "example-plugin", name: "Example Plugin", version: "0.1.0" };
const tempDirs: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "asg-setup-host-"));
  tempDirs.push(root);
  return root;
}

function writeGateway(root: string): void {
  fs.writeFileSync(
    path.join(root, "gateway.yaml"),
    [
      "# 网关顶层注释",
      "gateway:",
      "  port: 3000",
      "",
      "extensions:",
      "  other-plugin:   # 保留其它插件的注释",
      "    config:",
      "      keep: true",
      "",
    ].join("\n"),
    "utf8",
  );
}

function makeHost(
  root = makeRoot(),
  extra: Pick<SetupHostOptions, "configSchema"> = {},
): { host: SetupHost; root: string } {
  return {
    root,
    host: new SetupHost({ root, plugin: PLUGIN, ...extra }),
  };
}

function killPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // 已经退出
  }
}

beforeEach(() => {
  downloadState.content = "fake-download";
  downloadState.error = null;
});

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("SetupHost 路径布局", () => {
  it("可写数据位于 data/extension-data/<id>，不随插件目录原子替换丢失", () => {
    const root = makeRoot();
    const { host } = makeHost(root);

    expect(host.paths.pluginDir).toBe(
      path.join(root, "data", "extensions", PLUGIN.id),
    );
    expect(host.paths.dataDir).toBe(
      path.join(root, "data", "extension-data", PLUGIN.id),
    );
    expect(host.paths.tempDir).toBe(
      path.join(root, "data", "extension-data", PLUGIN.id, "tmp"),
    );
    // dataDir 不能在 pluginDir 内，否则更新插件目录会丢失后端数据。
    expect(host.paths.dataDir.startsWith(`${host.paths.pluginDir}${path.sep}`)).toBe(false);
  });

  it("initPaths 不包含旧后端目录", () => {
    const root = makeRoot();
    const initPaths = setupInitPaths(makeHost(root).host.paths);
    expect(Object.keys(initPaths).sort()).toEqual([
      "backendDirBase",
      "config",
      "dataDir",
      "pluginDir",
      "root",
      "secrets",
      "tempDir",
    ]);
    expect(initPaths.backendDirBase).toBe(
      path.join(root, "data", "extension-data", PLUGIN.id, "backends"),
    );
  });
});

describe("SetupHost 配置读写", () => {
  it("get 缺省返回空对象，patch 递归合并并保留 YAML 注释", async () => {
    const root = makeRoot();
    writeGateway(root);
    const { host } = makeHost(root);

    await expect(host.dispatch("config.get", [])).resolves.toEqual({});

    const first = await host.dispatch("config.patch", [
      { timeout_ms: 20000, nested: { a: 1 } },
    ]);
    expect(first).toEqual({ timeout_ms: 20000, nested: { a: 1 } });

    const second = await host.dispatch("config.patch", [{ nested: { b: 2 } }]);
    expect(second).toEqual({ timeout_ms: 20000, nested: { a: 1, b: 2 } });

    const text = fs.readFileSync(path.join(root, "gateway.yaml"), "utf8");
    expect(text).toContain("# 网关顶层注释");
    expect(text).toContain("# 保留其它插件的注释");
    expect(text).toContain("timeout_ms: 20000");
    expect(text).toContain("a: 1");
    expect(text).toContain("b: 2");
    // 其它插件配置原样保留
    expect(text).toContain("other-plugin");
    expect(text).toContain("keep: true");
  });

  it("replace 整体替换，unset 支持点号路径并清理空 config", async () => {
    const root = makeRoot();
    writeGateway(root);
    const { host } = makeHost(root);

    await host.dispatch("config.replace", [{ mode: "full", nested: { a: 1, b: 2 } }]);
    await expect(host.dispatch("config.get", [])).resolves.toEqual({
      mode: "full",
      nested: { a: 1, b: 2 },
    });

    const afterUnset = await host.dispatch("config.unset", [["nested.a", "mode"]]);
    expect(afterUnset).toEqual({ nested: { b: 2 } });

    const emptied = await host.dispatch("config.unset", [["nested.b"]]);
    expect(emptied).toEqual({});

    const text = fs.readFileSync(path.join(root, "gateway.yaml"), "utf8");
    expect(text).not.toContain("example-plugin");
    expect(text).not.toContain("mode:");
    expect(text).toContain("# 网关顶层注释");
    expect(text).toContain("other-plugin");
  });

  it("提供 configSchema 时合法配置写入，非法配置拒绝且文件不变", async () => {
    const root = makeRoot();
    writeGateway(root);
    const schema = {
      type: "object",
      properties: {
        timeout_ms: { type: "integer", default: 15000, minimum: 1000 },
        mode: { type: "string", enum: ["fast", "full"], default: "fast" },
      },
      additionalProperties: false,
    };
    const { host } = makeHost(root, { configSchema: schema });

    await host.dispatch("config.patch", [{ timeout_ms: 20000 }]);
    // 只落盘用户显式值，schema 默认值不写回文件。
    await expect(host.dispatch("config.get", [])).resolves.toEqual({ timeout_ms: 20000 });

    const before = fs.readFileSync(path.join(root, "gateway.yaml"), "utf8");
    await expect(
      host.dispatch("config.patch", [{ timeout_ms: 100 }]),
    ).rejects.toThrow(/插件配置校验失败/);
    await expect(
      host.dispatch("config.replace", [{ unknown: true }]),
    ).rejects.toThrow(/插件配置校验失败/);
    await expect(
      host.dispatch("config.patch", [{ timeout_ms: "not-a-number" }]),
    ).rejects.toThrow(/插件配置校验失败/);

    expect(fs.readFileSync(path.join(root, "gateway.yaml"), "utf8")).toBe(before);
    await expect(host.dispatch("config.get", [])).resolves.toEqual({ timeout_ms: 20000 });
  });

  it("config.unset 后候选配置非法时拒绝且文件不变", async () => {
    const root = makeRoot();
    writeGateway(root);
    const schema = {
      type: "object",
      properties: { token: { type: "string" } },
      required: ["token"],
    };
    const { host } = makeHost(root, { configSchema: schema });

    await host.dispatch("config.patch", [{ token: "abc" }]);
    const before = fs.readFileSync(path.join(root, "gateway.yaml"), "utf8");

    await expect(host.dispatch("config.unset", [["token"]])).rejects.toThrow(
      /插件配置校验失败/,
    );
    expect(fs.readFileSync(path.join(root, "gateway.yaml"), "utf8")).toBe(before);
    await expect(host.dispatch("config.get", [])).resolves.toEqual({ token: "abc" });
  });

  it("无 configSchema 时任意对象原样写入", async () => {
    const root = makeRoot();
    writeGateway(root);
    const { host } = makeHost(root);

    await host.dispatch("config.replace", [{ arbitrary: { nested: true } }]);
    await expect(host.dispatch("config.get", [])).resolves.toEqual({
      arbitrary: { nested: true },
    });
  });

  it("并发 config.patch 串行合并，不丢字段", async () => {
    const root = makeRoot();
    writeGateway(root);
    const { host } = makeHost(root);

    await Promise.all([
      host.dispatch("config.patch", [{ a: 1 }]),
      host.dispatch("config.patch", [{ b: 2 }]),
      host.dispatch("config.patch", [{ c: 3 }]),
    ]);

    await expect(host.dispatch("config.get", [])).resolves.toEqual({
      a: 1,
      b: 2,
      c: 3,
    });
  });

  it("并发 config.unset 不会破坏其它字段", async () => {
    const root = makeRoot();
    writeGateway(root);
    const { host } = makeHost(root);

    await host.dispatch("config.replace", [{ keep: 1, a: 1, b: 2, c: 3 }]);
    await Promise.all([
      host.dispatch("config.unset", [["a"]]),
      host.dispatch("config.unset", [["b"]]),
      host.dispatch("config.unset", [["c"]]),
    ]);

    await expect(host.dispatch("config.get", [])).resolves.toEqual({ keep: 1 });
  });

  it("gateway.yaml 不存在时给出明确错误", async () => {
    const { host } = makeHost();
    await expect(host.dispatch("config.get", [])).rejects.toThrow(/未找到网关配置文件/);
    await expect(host.dispatch("config.patch", [{ a: 1 }])).rejects.toThrow(
      /未找到网关配置文件/,
    );
  });

  it("gateway.yaml 内容不是对象或 YAML 损坏时报错", async () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, "gateway.yaml"), "- 1\n- 2\n", "utf8");
    const { host } = makeHost(root);
    await expect(host.dispatch("config.get", [])).rejects.toThrow(/必须是 YAML 对象/);

    fs.writeFileSync(path.join(root, "gateway.yaml"), "gateway: [\n", "utf8");
    await expect(host.dispatch("config.get", [])).rejects.toThrow(/解析失败/);
  });
});

describe("SetupHost 路径限制", () => {
  it("拒绝写入 dataDir / tempDir 之外的路径", async () => {
    const root = makeRoot();
    const { host } = makeHost(root);
    const outside = path.join(root, "outside.txt");
    const pluginFile = path.join(host.paths.pluginDir, "index.mjs");

    await expect(host.dispatch("fs.writeFile", [outside, "x"])).rejects.toThrow(/越界/);
    await expect(host.dispatch("fs.writeFile", [pluginFile, "x"])).rejects.toThrow(/越界/);
    await expect(
      host.dispatch("fs.mkdir", [path.join(root, "outside-dir")]),
    ).rejects.toThrow(/越界/);
    await expect(host.dispatch("fs.remove", [pluginFile])).rejects.toThrow(/越界/);

    // 相对路径按 dataDir 解析，允许写入
    await host.dispatch("fs.writeFile", ["relative.txt", "ok"]);
    expect(fs.readFileSync(path.join(host.paths.dataDir, "relative.txt"), "utf8")).toBe("ok");

    await host.dispatch("fs.mkdir", ["nested/deep"]);
    expect(fs.statSync(path.join(host.paths.dataDir, "nested/deep")).isDirectory()).toBe(true);
  });

  it("rename 的源路径也必须是可写路径，避免搬走插件文件", async () => {
    const root = makeRoot();
    const { host } = makeHost(root);
    fs.mkdirSync(host.paths.pluginDir, { recursive: true });
    const pluginFile = path.join(host.paths.pluginDir, "asg-plugin.json");
    fs.writeFileSync(pluginFile, "{}", "utf8");

    await expect(
      host.dispatch("fs.rename", [pluginFile, path.join(host.paths.dataDir, "stolen.json")]),
    ).rejects.toThrow(/越界/);
    expect(fs.existsSync(pluginFile)).toBe(true);
  });

  it("拒绝通过符号链接逃逸到可写目录之外", async () => {
    if (process.platform === "win32") return;

    const root = makeRoot();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "asg-setup-outside-"));
    tempDirs.push(outside);
    const { host } = makeHost(root);
    fs.mkdirSync(host.paths.dataDir, { recursive: true });
    fs.symlinkSync(outside, path.join(host.paths.dataDir, "escape"), "dir");

    await expect(
      host.dispatch("fs.writeFile", ["escape/escaped.txt", "x"]),
    ).rejects.toThrow(/符号链接|越界/);
    expect(fs.existsSync(path.join(outside, "escaped.txt"))).toBe(false);
  });

  it("读取插件目录是允许的", async () => {
    const root = makeRoot();
    const { host } = makeHost(root);
    fs.mkdirSync(host.paths.pluginDir, { recursive: true });
    const file = path.join(host.paths.pluginDir, "index.mjs");
    fs.writeFileSync(file, "export const x = 1;\n", "utf8");

    await expect(host.dispatch("fs.readFile", [file])).resolves.toBe("export const x = 1;\n");
    await expect(host.dispatch("fs.exists", [file])).resolves.toBe(true);
  });
});

describe("SetupHost state / backendState", () => {
  it("state 原子读写、JSON 格式化、无临时文件残留", async () => {
    const { host } = makeHost();
    await expect(host.dispatch("state.read", [])).resolves.toBeNull();

    await host.dispatch("state.write", [{ installed: true, nested: { n: 1 } }]);
    await expect(host.dispatch("state.read", [])).resolves.toEqual({
      installed: true,
      nested: { n: 1 },
    });

    const file = path.join(host.paths.dataDir, "state.json");
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain('  "installed": true');
    expect(text.endsWith("\n")).toBe(true);
    expect(fs.readdirSync(host.paths.dataDir).some((name) => name.includes(".tmp-"))).toBe(false);
  });

  it("backendState 按 id 读写与清理，并校验 id", async () => {
    const { host } = makeHost();
    await expect(host.dispatch("backendState.read", ["demo"])).resolves.toBeNull();

    await host.dispatch("backendState.write", ["demo", { version: "1.2.3" }]);
    await host.dispatch("backendState.write", ["other", { enabled: true }]);
    await expect(host.dispatch("backendState.read", ["demo"])).resolves.toEqual({
      version: "1.2.3",
    });

    const file = path.join(host.paths.dataDir, "backends.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(data).toEqual({ demo: { version: "1.2.3" }, other: { enabled: true } });

    await host.dispatch("backendState.clear", ["demo"]);
    await expect(host.dispatch("backendState.read", ["demo"])).resolves.toBeNull();
    await expect(host.dispatch("backendState.read", ["other"])).resolves.toEqual({
      enabled: true,
    });

    await expect(host.dispatch("backendState.read", ["../evil"])).rejects.toThrow(
      /后端 id 不合法/,
    );
    await expect(host.dispatch("backendState.write", ["a/b", {}])).rejects.toThrow(
      /后端 id 不合法/,
    );
  });

  it("并发 backendState.write 不丢数据", async () => {
    const { host } = makeHost();

    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        host.dispatch("backendState.write", [`backend-${index}`, { index }]),
      ),
    );

    const data = JSON.parse(
      fs.readFileSync(path.join(host.paths.dataDir, "backends.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual([
      "backend-0",
      "backend-1",
      "backend-2",
      "backend-3",
      "backend-4",
    ]);
  });

  it("损坏的 state.json 给出明确错误", async () => {
    const { host } = makeHost();
    fs.mkdirSync(host.paths.dataDir, { recursive: true });
    fs.writeFileSync(path.join(host.paths.dataDir, "state.json"), "{oops", "utf8");
    await expect(host.dispatch("state.read", [])).rejects.toThrow(/不是合法 JSON/);
  });
});

describe("SetupHost 下载与进程", () => {
  it("只允许 https 下载地址", async () => {
    const { host } = makeHost();
    const dest = path.join(host.paths.dataDir, "file.bin");
    await expect(
      host.dispatch("net.download", ["http://example.com/file.bin", dest]),
    ).rejects.toThrow(/只允许 https/);
    await expect(
      host.dispatch("net.download", ["not-a-url", dest]),
    ).rejects.toThrow(/下载地址无效/);
    await expect(
      host.dispatch("net.fetchText", ["ftp://example.com/x"]),
    ).rejects.toThrow(/只允许 https/);
  });

  it("download 先写 part，sha256 失败时保留旧文件", async () => {
    const { host } = makeHost();
    const dest = path.join(host.paths.dataDir, "artifact.bin");
    fs.mkdirSync(host.paths.dataDir, { recursive: true });
    fs.writeFileSync(dest, "old-good", "utf8");

    downloadState.content = "bad-content";
    const expected = createHash("sha256").update("expected-content").digest("hex");

    await expect(
      host.dispatch("net.download", [
        "https://example.test/artifact.bin",
        dest,
        { sha256: expected },
      ]),
    ).rejects.toThrow(/SHA256 校验失败/);

    expect(fs.readFileSync(dest, "utf8")).toBe("old-good");
    expect(
      fs.readdirSync(host.paths.dataDir).filter((name) => name.includes(".part-")),
    ).toEqual([]);
  });

  it("download 校验成功后原子替换目标", async () => {
    const { host } = makeHost();
    const dest = path.join(host.paths.dataDir, "artifact.bin");
    fs.mkdirSync(host.paths.dataDir, { recursive: true });
    fs.writeFileSync(dest, "old-good", "utf8");

    downloadState.content = "new-good";
    const expected = createHash("sha256").update("new-good").digest("hex");
    await host.dispatch("net.download", [
      "https://example.test/artifact.bin",
      dest,
      { sha256: expected },
    ]);

    expect(fs.readFileSync(dest, "utf8")).toBe("new-good");
    expect(
      fs.readdirSync(host.paths.dataDir).filter((name) => name.includes(".part-")),
    ).toEqual([]);
  });

  it("sha256 与 crypto 一致", async () => {
    const { host } = makeHost();
    const file = path.join(host.paths.dataDir, "hash.txt");
    await host.dispatch("fs.writeFile", [file, "hello setup"]);
    const expected = createHash("sha256").update("hello setup").digest("hex");
    await expect(host.dispatch("fs.sha256", [file])).resolves.toBe(expected);
  });

  it("run 转发 stdout/stderr 并返回结果", async () => {
    const logs: string[] = [];
    const { root } = makeHost();
    const host = new SetupHost({ root, plugin: PLUGIN, logger: (line) => logs.push(line) });

    const result = (await host.dispatch("proc.run", [
      process.execPath,
      ["-e", "console.log('hello-out'); console.error('hello-err')"],
      { timeoutMs: 10_000 },
    ])) as { code: number | null; stdout: string; stderr: string };
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("hello-out");
    expect(result.stderr).toContain("hello-err");
    expect(logs).toContain("hello-out");
    expect(logs).toContain("[stderr] hello-err");

    // 复用同一个 host 再跑一次，确保 logger 注入点生效
    const again = (await host.dispatch("proc.run", [
      process.execPath,
      ["-e", "console.log('logged')"],
      { timeoutMs: 10_000 },
    ])) as { code: number | null };
    expect(again.code).toBe(0);
    expect(logs).toContain("logged");

    await expect(
      host.dispatch("proc.run", [process.execPath, ["-e", ""], { cwd: "/definitely/missing" }]),
    ).rejects.toThrow(/cwd 不存在/);
  });

  it("run 超时会终止命令并标记 timedOut", async () => {
    const { host } = makeHost();
    const started = Date.now();
    const result = (await host.dispatch("proc.run", [
      process.execPath,
      ["-e", "setTimeout(() => {}, 30_000)"],
      { timeoutMs: 150 },
    ])) as { code: number | null; timedOut?: boolean; stderr: string };

    expect(result.timedOut).toBe(true);
    expect(result.stderr).toContain("命令超时");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("孙进程继承 stdio 时 proc.run 也会在 drain 后返回", async () => {
    const { host, root } = makeHost();
    const pidFile = path.join(root, "grandchild.pid");
    const script = [
      'const {spawn}=require("node:child_process");',
      'const fs=require("node:fs");',
      'const child=spawn(process.execPath,["-e","setTimeout(()=>{}, 30000)"],{stdio:"inherit"});',
      "fs.writeFileSync(process.argv[1], String(child.pid));",
      "child.unref();",
    ].join("");
    const started = Date.now();

    const result = (await host.dispatch("proc.run", [
      process.execPath,
      ["-e", script, pidFile],
      { timeoutMs: 10_000 },
    ])) as { code: number | null; stdout: string; stderr: string };

    try {
      // 直接子进程已退出；旧实现会等孙进程关闭继承的管道而挂起。
      expect(result.code).toBe(0);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      if (fs.existsSync(pidFile)) {
        killPid(Number(fs.readFileSync(pidFile, "utf8")));
      }
    }
  });

  it("dispose 会终止所有在途 proc.run 命令树", async () => {
    const { host } = makeHost();
    const running = host.dispatch("proc.run", [
      process.execPath,
      ["-e", "setTimeout(() => {}, 30_000)"],
      { timeoutMs: 30_000 },
    ]);

    await new Promise((resolve) => setTimeout(resolve, 150));
    const started = Date.now();
    host.dispose();
    const result = (await running) as { code: number | null; signal: string | null };

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.code).not.toBe(0);
  });

  it("extract 支持 .tar.gz（系统 tar 可用时）", async () => {
    const probe = spawnSync("tar", ["--version"], { stdio: "ignore" });
    if (probe.status !== 0) return;

    const root = makeRoot();
    const { host } = makeHost(root);
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "asg-setup-src-"));
    tempDirs.push(src);
    fs.writeFileSync(path.join(src, "inside.txt"), "tar-content", "utf8");

    const archive = path.join(src, "bundle.tar.gz");
    const tar = spawnSync("tar", ["-czf", archive, "-C", src, "inside.txt"], {
      encoding: "utf8",
    });
    expect(tar.status).toBe(0);

    const dest = path.join(host.paths.dataDir, "extracted");
    await host.dispatch("fs.extract", [archive, dest]);
    expect(fs.readFileSync(path.join(dest, "inside.txt"), "utf8")).toBe("tar-content");
  });

  it("extract 对不支持的格式给出明确错误", async () => {
    const { host } = makeHost();
    const archive = path.join(host.paths.dataDir, "bundle.rar");
    await host.dispatch("fs.writeFile", [archive, "x"]);
    await expect(host.dispatch("fs.extract", [archive, "out"])).rejects.toThrow(
      /不支持的压缩格式/,
    );
  });
});
