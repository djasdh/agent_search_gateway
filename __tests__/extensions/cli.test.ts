import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  run,
  setExtensionsApiForTests,
  setRestartForTests,
  setStdinReaderForTests,
} from "../../src/cli/commands/extensions.js";
import type { Reporter } from "../../src/cli/output.js";
import {
  configPaths,
  getYamlPath,
  readYamlDocument,
} from "../../src/cli/config/gateway.js";

const tempDirs: string[] = [];

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asg-extensions-cli-"));
  tempDirs.push(dir);
  return dir;
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

function writeManifest(
  root: string,
  text: string,
  dir = "demo-fetch",
  fileName = "asg-extension.json",
): string {
  const target = path.join(root, "data", "extensions", dir);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, fileName), text, "utf8");
  return target;
}

function writeGateway(root: string, text = "{}\n"): string {
  const file = path.join(root, "gateway.yaml");
  fs.writeFileSync(file, text, "utf8");
  return file;
}

const MANIFEST = JSON.stringify({
  id: "demo-fetch",
  name: "Demo Fetch",
  version: "1.0.0",
  api_version: 2,
  provides: ["fetch"],
  entry: "index.mjs",
});

/** 与 extensions/config.test.ts 同构的 schema：必填 base_url + 默认值 + 嵌套对象。 */
const CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["base_url"],
  properties: {
    enabled: { type: "boolean", default: true, description: "总开关" },
    base_url: { type: "string", description: "上游根地址" },
    limit: { type: "integer", default: 10, minimum: 1, maximum: 50, description: "单次结果上限" },
    mode: { type: "string", enum: ["fast", "full"], default: "fast" },
    retry: {
      type: "object",
      additionalProperties: false,
      properties: {
        times: { type: "integer", default: 2, minimum: 0, maximum: 5 },
      },
      default: {},
    },
  },
};

function configManifest(schema: unknown = CONFIG_SCHEMA): string {
  return JSON.stringify({
    id: "demo-fetch",
    name: "Demo Fetch",
    version: "1.0.0",
    api_version: 2,
    provides: ["fetch"],
    entry: "index.mjs",
    ...(schema === undefined ? {} : { config_schema: schema }),
  });
}

/** 最小可用配置：base_url 满足 required，其余字段由默认值补齐。 */
const SEED_CONFIG = `extensions:
  demo-fetch:
    config:
      base_url: https://example.test
`;

function readRawConfig(root: string, id = "demo-fetch"): unknown {
  const paths = configPaths(root);
  return getYamlPath(readYamlDocument(paths.config).doc, ["extensions", id, "config"]);
}

function trackRestart(): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => {});
  setRestartForTests(fn);
  return fn;
}

afterEach(() => {
  setExtensionsApiForTests(null);
  setRestartForTests(null);
  setStdinReaderForTests(null);
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("asg extensions install", () => {
  it("解析 owner/repo@version 并提示重启后生效", async () => {
    const events: Array<Record<string, unknown>> = [];
    const install = vi.fn(async () => ({
      id: "demo-fetch",
      version: "1.0.0",
      name: "Demo Fetch",
      provides: ["fetch"],
      path: "/root/data/extensions/demo-fetch",
    }));
    setExtensionsApiForTests({ install });

    const result = await run({
      root: "/root",
      reporter: fakeReporter(events),
      rest: ["install", "owner/repo@v1.0.0"],
    });

    expect(install).toHaveBeenCalledWith({
      root: "/root",
      repo: "owner/repo",
      version: "1.0.0",
      logger: expect.any(Function),
    });
    expect(result.human).toContain("重启网关后生效。");
    expect(result.human).toContain("demo-fetch");
    expect(result.data).toMatchObject({ id: "demo-fetch", provides: ["fetch"] });

    const options = install.mock.calls[0]![0] as { logger: (message: string) => void };
    options.logger("下载中");
    expect(events[0]).toMatchObject({ event: "log", service: "extensions", message: "下载中" });
  });

  it("缺少参数 / 非法仓库 / 非法版本按用法错误处理", async () => {
    for (const args of [
      ["install"],
      ["install", "owner"],
      ["install", "owner/repo@nope"],
      ["install", "owner/repo@1.0.0", "extra"],
    ]) {
      await expect(
        run({ root: "/root", reporter: fakeReporter(), rest: args }),
      ).rejects.toMatchObject({ code: "UNEXPECTED", exitCode: 2 });
    }
  });
});

describe("asg extensions search", () => {
  it("支持多词 query 与 --limit", async () => {
    const search = vi.fn(async () => [
      {
        repo: "owner/demo",
        description: "示例插件",
        url: "https://github.com/owner/demo",
        stars: 3,
        updated_at: "2026-01-01T00:00:00Z",
      },
    ]);
    setExtensionsApiForTests({ search });

    const result = await run({
      root: "/root",
      reporter: fakeReporter(),
      rest: ["search", "foo", "bar", "--limit", "5"],
    });

    expect(search).toHaveBeenCalledWith({ query: "foo bar", limit: 5 });
    expect(result.human).toContain("owner/demo");
    expect(result.human).toContain("示例插件");
    expect(result.data).toMatchObject({ query: "foo bar" });
  });

  it("拒绝非法 --limit 与未知选项", async () => {
    for (const args of [
      ["search", "--limit", "0"],
      ["search", "--limit", "abc"],
      ["search", "--nope"],
    ]) {
      await expect(
        run({ root: "/root", reporter: fakeReporter(), rest: args }),
      ).rejects.toMatchObject({ code: "UNEXPECTED", exitCode: 2 });
    }
  });
});

describe("asg extensions list", () => {
  it("输出 ID / VERSION / PROVIDES / ENTRY 并提供 JSON 数据", async () => {
    const root = tempRoot();
    const target = writeManifest(root, MANIFEST);

    const result = await run({ root, reporter: fakeReporter(), rest: ["list"] });

    expect(result.human).toContain("ID");
    expect(result.human).toContain("VERSION");
    expect(result.human).toContain("PROVIDES");
    expect(result.human).toContain("ENTRY");
    expect(result.human).toContain("demo-fetch");
    expect(result.human).toContain("1.0.0");
    expect(result.human).toContain("fetch");
    expect(result.human).toContain("index.mjs");
    expect(result.data).toMatchObject({
      extensions: [
        {
          id: "demo-fetch",
          name: "Demo Fetch",
          version: "1.0.0",
          provides: ["fetch"],
          entry: "index.mjs",
          path: target,
        },
      ],
    });
  });

  it("V2 输出 backends / fetch_channels / search_engines", async () => {
    const root = tempRoot();
    const target = path.join(root, "data", "extensions", "demo-v2");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(
      path.join(target, "asg-extension.json"),
      JSON.stringify({
        id: "demo-v2",
        name: "Demo V2",
        version: "2.0.0",
        api_version: 2,
        provides: ["fetch", "search"],
        entry: "index.mjs",
        backends: [{ id: "demo-api", name: "Demo API" }],
        fetch_channels: [
          { id: "example:cli", name: "Example CLI", backends: ["demo-api"] },
        ],
        search_engines: [{ id: "gateway.search:example", name: "Example Search" }],
      }),
      "utf8",
    );

    const result = await run({ root, reporter: fakeReporter(), rest: ["list"] });

    expect(result.human).toContain("CHANNELS");
    expect(result.human).toContain("ENGINES");
    expect(result.human).toContain("example:cli");
    expect(result.human).toContain("gateway.search:example");
    expect(result.data).toMatchObject({
      extensions: [
        {
          id: "demo-v2",
          backends: [{ id: "demo-api", name: "Demo API" }],
          fetch_channels: [{ id: "example:cli" }],
          search_engines: [{ id: "gateway.search:example" }],
        },
      ],
    });
  });

  it("只有 asg-plugin.json 的目录在列表里提示升级插件", async () => {
    const root = tempRoot();
    writeManifest(
      root,
      JSON.stringify({
        id: "demo-fetch",
        name: "Demo Fetch",
        version: "1.0.0",
        api_version: 1,
        provides: ["fetch"],
        entry: "index.mjs",
      }),
      "demo-fetch",
      "asg-plugin.json",
    );

    const result = await run({ root, reporter: fakeReporter(), rest: ["list"] });

    expect(result.human).toContain("asg-extension.json");
    expect(result.human).toContain("asg extensions install");
    expect(result.data).toMatchObject({
      extensions: [{ id: "demo-fetch", error: expect.stringContaining("asg-extension.json") }],
    });
  });

  it("空目录给出提示", async () => {
    const result = await run({ root: tempRoot(), reporter: fakeReporter(), rest: ["list"] });
    expect(result.human).toContain("未安装任何第三方插件");
    expect(result.data).toEqual({ extensions: [] });
  });
});

describe("asg extensions remove", () => {
  it("删除后输出已卸载", async () => {
    const root = tempRoot();
    const remove = vi.fn(async () => ({ id: "demo-fetch", removed: true as const }));
    setExtensionsApiForTests({ remove });

    const result = await run({
      root,
      reporter: fakeReporter(),
      rest: ["remove", "demo-fetch"],
    });

    expect(remove).toHaveBeenCalledWith(root, "demo-fetch");
    expect(result.human).toContain("已卸载");
    expect(result.data).toMatchObject({
      id: "demo-fetch",
      removed: true,
      backends: [],
      data_removed: false,
    });
  });

  it("未知目录报 PLUGIN_UNKNOWN / 退出码 4", async () => {
    await expect(
      run({ root: tempRoot(), reporter: fakeReporter(), rest: ["remove", "nope"] }),
    ).rejects.toMatchObject({ code: "PLUGIN_UNKNOWN", exitCode: 4 });
  });

  it("缺少参数按用法错误处理", async () => {
    await expect(
      run({ root: "/root", reporter: fakeReporter(), rest: ["remove"] }),
    ).rejects.toMatchObject({ code: "UNEXPECTED", exitCode: 2 });
  });
});

describe("asg extensions config 读取", () => {
  it("无参数读取补齐默认值，--json 数据带 valid=true", async () => {
    const root = tempRoot();
    writeManifest(root, configManifest());
    writeGateway(root, SEED_CONFIG);

    const result = await run({
      root,
      reporter: fakeReporter(),
      rest: ["config", "demo-fetch"],
    });

    expect(result.data).toMatchObject({
      id: "demo-fetch",
      valid: true,
      config: {
        base_url: "https://example.test",
        enabled: true,
        limit: 10,
        mode: "fast",
        retry: { times: 2 },
      },
    });
    expect(result.human).toContain('"enabled": true');
    expect(result.human).toContain('"limit": 10');

    const json = await run({
      root,
      reporter: fakeReporter(),
      rest: ["config", "demo-fetch", "--json"],
    });
    expect(json.data).toMatchObject({ id: "demo-fetch", valid: true });
  });

  it("--get <key> 输出单个字段（含嵌套键）", async () => {
    const root = tempRoot();
    writeManifest(root, configManifest());
    writeGateway(root, SEED_CONFIG);

    const single = await run({
      root,
      reporter: fakeReporter(),
      rest: ["config", "demo-fetch", "--get", "limit"],
    });
    expect(single.human).toBe("limit: 10");
    expect(single.data).toMatchObject({ key: "limit", value: 10, valid: true });

    const nested = await run({
      root,
      reporter: fakeReporter(),
      rest: ["config", "demo-fetch", "--get=retry.times"],
    });
    expect(nested.human).toBe("retry.times: 2");
    expect(nested.data).toMatchObject({ key: "retry.times", value: 2 });

    await expect(
      run({
        root,
        reporter: fakeReporter(),
        rest: ["config", "demo-fetch", "--get", "nope"],
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID", exitCode: 4 });
  });

  it("--describe 输出字段表", async () => {
    const root = tempRoot();
    writeManifest(root, configManifest());
    writeGateway(root, SEED_CONFIG);

    const result = await run({
      root,
      reporter: fakeReporter(),
      rest: ["config", "demo-fetch", "--describe"],
    });

    expect(result.human).toContain("enabled");
    expect(result.human).toContain("boolean");
    expect(result.human).toContain("默认 true");
    expect(result.human).toContain("必填");
    expect(result.human).toContain("总开关");
    expect(result.data).toMatchObject({
      id: "demo-fetch",
      fields: expect.arrayContaining([
        expect.objectContaining({ key: "enabled", type: "boolean", required: false, default: true }),
        expect.objectContaining({ key: "base_url", type: "string", required: true }),
      ]),
    });
  });
});

describe("asg extensions config 写入", () => {
  it("一次应用多个 --set：只写 raw 值，默认值不落盘，重启一次", async () => {
    const root = tempRoot();
    writeManifest(root, configManifest());
    writeGateway(root, SEED_CONFIG);
    const restart = trackRestart();

    const result = await run({
      root,
      reporter: fakeReporter(),
      rest: ["config", "demo-fetch", "--set", "limit=20", "--set", "retry.times=3"],
    });

    expect(readRawConfig(root)).toEqual({
      base_url: "https://example.test",
      limit: 20,
      retry: { times: 3 },
    });
    expect(result.data).toMatchObject({
      id: "demo-fetch",
      config: { enabled: true, limit: 20, mode: "fast", retry: { times: 3 } },
      changed: [
        "extensions.demo-fetch.config.limit",
        "extensions.demo-fetch.config.retry.times",
      ],
      restart: "all",
      restarted: true,
    });
    expect(result.human).toContain("已更新扩展 demo-fetch 的配置");
    expect(restart).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledWith(root, expect.anything());
  });

  it("--unset 删除字段；config 变空时清理 extensions.<id>", async () => {
    const root = tempRoot();
    writeManifest(root, configManifest());
    writeGateway(
      root,
      `extensions:
  demo-fetch:
    config:
      base_url: https://example.test
      limit: 20
`,
    );
    const restart = trackRestart();

    await run({
      root,
      reporter: fakeReporter(),
      rest: ["config", "demo-fetch", "--unset", "limit"],
    });

    expect(readRawConfig(root)).toEqual({ base_url: "https://example.test" });
    expect(restart).toHaveBeenCalledTimes(1);

    const emptyRoot = tempRoot();
    writeManifest(emptyRoot, MANIFEST);
    writeGateway(
      emptyRoot,
      `extensions:
  demo-fetch:
    config:
      limit: 3
`,
    );

    await run({
      root: emptyRoot,
      reporter: fakeReporter(),
      rest: ["config", "demo-fetch", "--unset", "limit"],
    });

    expect(readRawConfig(emptyRoot)).toBeUndefined();
    const doc = readYamlDocument(configPaths(emptyRoot).config).doc;
    expect(getYamlPath(doc, ["extensions"])).toEqual({});
  });

  it("--file 整体替换配置", async () => {
    const root = tempRoot();
    writeManifest(root, configManifest());
    writeGateway(root, SEED_CONFIG);
    const file = path.join(root, "replacement.yaml");
    fs.writeFileSync(file, "base_url: https://other.test\nlimit: 30\n", "utf8");
    trackRestart();

    const result = await run({
      root,
      reporter: fakeReporter(),
      rest: ["config", "demo-fetch", "--file", file],
    });

    expect(readRawConfig(root)).toEqual({ base_url: "https://other.test", limit: 30 });
    expect(result.data).toMatchObject({ changed: ["extensions.demo-fetch.config"] });
  });

  it("校验失败不写文件、不重启（未知键 / 类型 / 枚举 / required）", async () => {
    for (const args of [
      ["--set", "nope=1"],
      ["--set", "limit=abc"],
      ["--set", "mode=slow"],
    ]) {
      const root = tempRoot();
      writeManifest(root, configManifest());
      const file = writeGateway(root, SEED_CONFIG);
      const before = fs.readFileSync(file, "utf8");
      const restart = trackRestart();

      await expect(
        run({
          root,
          reporter: fakeReporter(),
          rest: ["config", "demo-fetch", ...args],
        }),
      ).rejects.toMatchObject({ code: "CONFIG_INVALID", exitCode: 4 });

      expect(fs.readFileSync(file, "utf8")).toBe(before);
      expect(restart).not.toHaveBeenCalled();
    }

    const root = tempRoot();
    writeManifest(root, configManifest());
    const file = writeGateway(root);
    const restart = trackRestart();

    await expect(
      run({
        root,
        reporter: fakeReporter(),
        rest: ["config", "demo-fetch", "--set", "limit=20"],
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID", exitCode: 4 });

    expect(fs.readFileSync(file, "utf8")).toBe("{}\n");
    expect(restart).not.toHaveBeenCalled();
  });

  it("changed 只记录真实变化，未变化时为空数组", async () => {
    const root = tempRoot();
    writeManifest(root, configManifest());
    writeGateway(
      root,
      `extensions:
  demo-fetch:
    config:
      base_url: https://example.test
      limit: 10
`,
    );
    const restart = trackRestart();

    const same = await run({
      root,
      reporter: fakeReporter(),
      rest: ["config", "demo-fetch", "--set", "limit=10"],
    });
    expect(same.data).toMatchObject({ changed: [] });
    expect(readRawConfig(root)).toEqual({ base_url: "https://example.test", limit: 10 });
    expect(restart).toHaveBeenCalledTimes(1);

    const missing = await run({
      root,
      reporter: fakeReporter(),
      rest: ["config", "demo-fetch", "--unset", "nope"],
    });
    expect(missing.data).toMatchObject({ changed: [] });
    expect(readRawConfig(root)).toEqual({ base_url: "https://example.test", limit: 10 });
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it("没有 config_schema 时按原样透传，--describe 提示未声明", async () => {
    const root = tempRoot();
    writeManifest(root, MANIFEST);
    writeGateway(root);
    const restart = trackRestart();

    const result = await run({
      root,
      reporter: fakeReporter(),
      rest: ["config", "demo-fetch", "--set", "anything.nested=true"],
    });

    expect(readRawConfig(root)).toEqual({ anything: { nested: true } });
    expect(result.data).toMatchObject({ config: { anything: { nested: true } } });
    expect(restart).toHaveBeenCalledTimes(1);

    const described = await run({
      root,
      reporter: fakeReporter(),
      rest: ["config", "demo-fetch", "--describe"],
    });
    expect(described.human).toContain("未声明 config_schema");
    expect(described.data).toEqual({ id: "demo-fetch", fields: [] });
  });

  it("未安装 / manifest 损坏", async () => {
    const root = tempRoot();
    writeGateway(root);
    await expect(
      run({ root, reporter: fakeReporter(), rest: ["config", "nope"] }),
    ).rejects.toMatchObject({ code: "PLUGIN_UNKNOWN", exitCode: 3 });

    const bad = tempRoot();
    writeManifest(bad, "{not json");
    writeGateway(bad);
    await expect(
      run({ root: bad, reporter: fakeReporter(), rest: ["config", "demo-fetch"] }),
    ).rejects.toMatchObject({ code: "PLUGIN_FAILED", exitCode: 4 });
  });

  it("--get / --file / --describe / 写入参数冲突按用法错误处理", async () => {
    for (const args of [
      ["config", "demo-fetch", "--get", "limit", "--set", "limit=1"],
      ["config", "demo-fetch", "--file", "x.yaml", "--set", "limit=1"],
      ["config", "demo-fetch", "--describe", "--set", "limit=1"],
      ["config", "demo-fetch", "--get", "--describe"],
      ["config", "demo-fetch", "--set", "novalue"],
    ]) {
      await expect(
        run({ root: tempRoot(), reporter: fakeReporter(), rest: args }),
      ).rejects.toMatchObject({ code: "UNEXPECTED", exitCode: 2 });
    }
  });
});

describe("asg extensions secret", () => {
  it("--stdin 写入 0600 的 secrets.yaml 且不打印明文；--clear 删除", async () => {
    const root = tempRoot();
    writeManifest(root, MANIFEST);
    writeGateway(root);
    const restart = trackRestart();
    setStdinReaderForTests(async () => "s3cret\n");

    const result = await run({
      root,
      reporter: fakeReporter(),
      rest: ["secret", "demo-fetch", "--name", "api_key", "--stdin"],
    });

    const paths = configPaths(root);
    expect(fs.statSync(paths.secrets).mode & 0o777).toBe(0o600);
    expect(
      getYamlPath(readYamlDocument(paths.secrets).doc, ["extensions", "demo-fetch", "api_key"]),
    ).toBe("s3cret");
    expect(result.human).toContain("已更新密钥: secrets.extensions.demo-fetch.api_key");
    expect(result.human).not.toContain("s3cret");
    expect(JSON.stringify(result.data)).not.toContain("s3cret");
    expect(restart).toHaveBeenCalledTimes(1);

    const cleared = await run({
      root,
      reporter: fakeReporter(),
      rest: ["secret", "demo-fetch", "--name", "api_key", "--clear"],
    });

    expect(
      getYamlPath(readYamlDocument(paths.secrets).doc, ["extensions", "demo-fetch", "api_key"]),
    ).toBeUndefined();
    expect(cleared.human).toContain("已删除密钥");
  });

  it("空值 / 非法名称 / 缺少 --name / 缺少模式按用法错误处理", async () => {
    const root = tempRoot();
    writeManifest(root, MANIFEST);
    writeGateway(root);
    setStdinReaderForTests(async () => "\n");

    for (const args of [
      ["secret", "demo-fetch", "--name", "api_key", "--stdin"],
      ["secret", "demo-fetch", "--name", "API_KEY", "--stdin"],
      ["secret", "demo-fetch", "--stdin"],
      ["secret", "demo-fetch", "--name", "api_key"],
      ["secret", "demo-fetch", "--name", "api_key", "--stdin", "--clear"],
    ]) {
      await expect(
        run({ root, reporter: fakeReporter(), rest: args }),
      ).rejects.toMatchObject({ code: "UNEXPECTED", exitCode: 2 });
    }

    expect(fs.existsSync(configPaths(root).secrets)).toBe(false);
  });

  it("未安装插件 / manifest 损坏", async () => {
    const root = tempRoot();
    writeGateway(root);
    setStdinReaderForTests(async () => "s3cret\n");

    await expect(
      run({
        root,
        reporter: fakeReporter(),
        rest: ["secret", "nope", "--name", "api_key", "--stdin"],
      }),
    ).rejects.toMatchObject({ code: "PLUGIN_UNKNOWN", exitCode: 3 });
    expect(fs.existsSync(configPaths(root).secrets)).toBe(false);

    const bad = tempRoot();
    writeManifest(bad, "{not json");
    writeGateway(bad);
    await expect(
      run({
        root: bad,
        reporter: fakeReporter(),
        rest: ["secret", "demo-fetch", "--name", "api_key", "--stdin"],
      }),
    ).rejects.toMatchObject({ code: "PLUGIN_FAILED", exitCode: 4 });
    expect(fs.existsSync(configPaths(bad).secrets)).toBe(false);
  });
});

describe("asg extensions 顶层", () => {
  it("未知子命令与帮助", async () => {
    await expect(
      run({ root: "/root", reporter: fakeReporter(), rest: ["nope"] }),
    ).rejects.toMatchObject({ code: "UNEXPECTED", exitCode: 2 });

    const help = await run({ root: "/root", reporter: fakeReporter(), rest: ["--help"] });
    expect(help.human).toContain("asg extensions");
    expect(help.data).toMatchObject({ usage: expect.stringContaining("install") });
  });
});
