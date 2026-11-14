import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Reporter } from "../../src/cli/output.js";
import {
  run as configRun,
  setRestartForTests,
  setStdinReaderForTests,
} from "../../src/cli/commands/config.js";

const reporter = new Reporter({ json: true, jsonl: false });
const dirs: string[] = [];
const restartCalls: string[] = [];

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asg-config-"));
  dirs.push(dir);
  return dir;
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

function makeRoot(options: { secrets?: boolean; config?: string } = {}): string {
  const root = tempRoot();
  write(
    path.join(root, "gateway.yaml"),
    options.config ??
      [
        "# 顶部注释：必须保留",
        "gateway:",
        "  host: 127.0.0.1",
        "  port: 3000 # 端口注释",
        "searxng:",
        "  url: http://127.0.0.1:8888",
        "ad_filter:",
        "  level: ads",
        "",
      ].join("\n"),
  );
  if (options.secrets !== false) {
    write(
      path.join(root, "secrets.yaml"),
      ["gateway:", "  token: super-secret", "search:", "  reverse_image:", "    saucenao:", '      api_key: ""', ""].join(
        "\n",
      ),
    );
  }
  return root;
}

function read(root: string, name = "gateway.yaml"): string {
  return fs.readFileSync(path.join(root, name), "utf8");
}

beforeEach(() => {
  restartCalls.length = 0;
  setRestartForTests(async (root) => {
    restartCalls.push(root);
  });
  setStdinReaderForTests(async () => "new-token\n");
});

afterEach(() => {
  setRestartForTests(null);
  setStdinReaderForTests(null);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("config get", () => {
  it("按点号路径读取 YAML 值", async () => {
    const root = makeRoot();
    const result = await configRun({ root, reporter, rest: ["get", "gateway.port"] });
    expect(result.data).toEqual({ path: "gateway.port", value: 3000 });
    expect(result.human).toContain("gateway.port: 3000");
  });

  it("--all 返回整份配置，secrets 掩码为 set/unset", async () => {
    const root = makeRoot();
    const result = await configRun({ root, reporter, rest: ["get", "--all"] });
    const data = result.data as Record<string, unknown>;
    const secrets = data.secrets as {
      gateway: { token: string };
      search: { reverse_image: { saucenao: { api_key: string } } };
    };

    expect((data.gateway as { port: number }).port).toBe(3000);
    expect(secrets.gateway.token).toBe("set");
    expect(secrets.search.reverse_image.saucenao.api_key).toBe("unset");
    expect(JSON.stringify(data)).not.toContain("super-secret");
    expect(result.human).not.toContain("super-secret");
  });

  it("缺失的路径报 CONFIG_INVALID（退出码 4）", async () => {
    const root = makeRoot();
    await expect(configRun({ root, reporter, rest: ["get", "gateway.nope"] })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      exitCode: 4,
    });
  });

  it("secrets 单路径只返回 set/unset", async () => {
    const root = makeRoot();
    const result = await configRun({ root, reporter, rest: ["get", "secrets.gateway.token"] });
    expect(result.data).toEqual({ path: "secrets.gateway.token", value: "set" });
    expect(result.human).toBe("secrets.gateway.token: set");
  });

  it("gateway.yaml 不存在时报 NOT_INSTALLED", async () => {
    const root = tempRoot();
    await expect(configRun({ root, reporter, rest: ["get", "gateway.port"] })).rejects.toMatchObject({
      code: "NOT_INSTALLED",
      exitCode: 3,
    });
  });
});

describe("config set", () => {
  it("JSON 值语法 + 保留注释 + 备份 .bak + 整栈重启一次", async () => {
    const root = makeRoot();
    const before = read(root);

    const result = await configRun({ root, reporter, rest: ["set", "gateway.port", "3100"] });

    expect(result.data).toEqual({
      changed: ["gateway.port"],
      restart: "all",
      restarted: true,
    });
    expect(result.human).toContain("MCP 连接");
    expect(restartCalls).toEqual([root]);

    const after = read(root);
    expect(after).toContain("port: 3100");
    expect(after).toContain("# 顶部注释：必须保留");
    expect(after).toContain("# 端口注释");
    expect(after).toContain("host: 127.0.0.1");

    expect(fs.readFileSync(path.join(root, "gateway.yaml.bak"), "utf8")).toBe(before);
  });

  it("--string 强制字符串", async () => {
    const root = makeRoot();
    const result = await configRun({
      root,
      reporter,
      rest: ["set", "logging.file", "true", "--string"],
    });
    expect(result.data).toMatchObject({ changed: ["logging.file"] });

    const readBack = await configRun({ root, reporter, rest: ["get", "logging.file"] });
    expect(readBack.data).toEqual({ path: "logging.file", value: "true" });
  });

  it("数组值按 JSON 解析并通过 schema 校验", async () => {
    const root = makeRoot();
    await configRun({
      root,
      reporter,
      rest: ["set", "search.reverse_image.sources", '["tracemoe","baidu"]'],
    });

    const readBack = await configRun({
      root,
      reporter,
      rest: ["get", "search.reverse_image.sources"],
    });
    expect(readBack.data).toEqual({
      path: "search.reverse_image.sources",
      value: ["tracemoe", "baidu"],
    });
  });

  it("校验失败不写文件、不备份、不重启", async () => {
    const root = makeRoot();
    const before = read(root);

    await expect(
      configRun({ root, reporter, rest: ["set", "gateway.port", "99999"] }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID", exitCode: 4 });

    expect(read(root)).toBe(before);
    expect(fs.existsSync(path.join(root, "gateway.yaml.bak"))).toBe(false);
    expect(restartCalls).toHaveLength(0);
  });

  it("secrets 只从 stdin 读，写入后 get 仍只返回 set", async () => {
    const root = makeRoot();
    const result = await configRun({
      root,
      reporter,
      rest: ["set", "secrets.gateway.token", "--stdin"],
    });

    expect(result.data).toEqual({
      changed: ["secrets.gateway.token"],
      restart: "all",
      restarted: true,
    });
    expect(read(root, "secrets.yaml")).toContain("new-token");
    expect(JSON.stringify(result.data)).not.toContain("new-token");
    expect(restartCalls).toEqual([root]);

    const readBack = await configRun({ root, reporter, rest: ["get", "secrets.gateway.token"] });
    expect(readBack.data).toEqual({ path: "secrets.gateway.token", value: "set" });
    expect(JSON.stringify(readBack)).not.toContain("new-token");

    const all = await configRun({ root, reporter, rest: ["get", "--all"] });
    expect(JSON.stringify(all)).not.toContain("new-token");
  });

  it("secrets 不允许把值写进 argv", async () => {
    const root = makeRoot();
    await expect(
      configRun({ root, reporter, rest: ["set", "secrets.gateway.token", "plain"] }),
    ).rejects.toMatchObject({ exitCode: 2 });
  });

  it("secrets.yaml 不存在时按需创建，权限收紧为 600", async () => {
    const root = makeRoot({ secrets: false });
    await configRun({ root, reporter, rest: ["set", "secrets.gateway.token", "--stdin"] });

    const file = path.join(root, "secrets.yaml");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("未知子命令退出码 2", async () => {
    const root = makeRoot();
    await expect(configRun({ root, reporter, rest: ["nope"] })).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe("config validate", () => {
  it("合法配置校验通过，不写文件也不重启", async () => {
    const root = makeRoot();
    const before = read(root);

    const result = await configRun({ root, reporter, rest: ["validate"] });

    expect(result.data).toMatchObject({ valid: true });
    expect(result.human).toContain("配置校验通过");
    expect(read(root)).toBe(before);
    expect(fs.existsSync(path.join(root, "gateway.yaml.bak"))).toBe(false);
    expect(restartCalls).toHaveLength(0);
  });

  it("非法配置报 CONFIG_INVALID 且原文件不变", async () => {
    const root = makeRoot({
      config: "gateway:\n  port: 99999\n",
    });
    const before = read(root);

    await expect(configRun({ root, reporter, rest: ["validate"] })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      exitCode: 4,
    });
    expect(read(root)).toBe(before);
    expect(restartCalls).toHaveLength(0);
  });
});
