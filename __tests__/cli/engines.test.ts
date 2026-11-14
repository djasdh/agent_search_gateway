import fs from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Reporter } from "../../src/cli/output.js";
import { listEngines, readLocalEngines, setEngines } from "../../src/cli/config/engines.js";
import { run as enginesRun, setRestartForTests } from "../../src/cli/commands/engines.js";

const reporter = new Reporter({ json: true, jsonl: false });
const dirs: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];
const restartCalls: string[] = [];

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asg-engines-"));
  dirs.push(dir);
  return dir;
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

const SETTINGS_YML = [
  "use_default_settings: true",
  "engines:",
  "  - name: bilibili",
  "    disabled: false",
  "    categories: [videos]",
  "  - name: google",
  "    disabled: true",
  "  - name: tavily",
  "    disabled: false",
  "",
].join("\n");

function gatewayConfig(searxngUrl: string, extra: string[] = []): string {
  return [
    "gateway:",
    "  port: 3000",
    "searxng:",
    `  url: ${searxngUrl}`,
    "search:",
    "  engines:",
    "    resident: [bilibili]",
    "    rotating: [tavily]",
    ...extra,
    "  reverse_image:",
    "    sources: [tracemoe, baidu]",
    "",
  ].join("\n");
}

function makeRoot(options: { searxngUrl?: string; saucenaoKey?: string; config?: string } = {}): string {
  const root = tempRoot();
  write(path.join(root, "gateway.yaml"), options.config ?? gatewayConfig(options.searxngUrl ?? "http://127.0.0.1:1"));
  write(
    path.join(root, "data", "deps", "searxng", "settings.yml"),
    SETTINGS_YML,
  );
  if (options.saucenaoKey !== undefined) {
    write(
      path.join(root, "secrets.yaml"),
      [
        "search:",
        "  reverse_image:",
        "    saucenao:",
        `      api_key: ${JSON.stringify(options.saucenaoKey)}`,
        "",
      ].join("\n"),
    );
  }
  return root;
}

function read(root: string, relative: string): string {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function hasBak(root: string, relative: string): boolean {
  return fs.existsSync(path.join(root, `${relative}.bak`));
}

function listenConfig(payload: unknown): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === "/config") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

beforeEach(() => {
  restartCalls.length = 0;
  setRestartForTests(async (root) => {
    restartCalls.push(root);
  });
});

afterEach(() => {
  setRestartForTests(null);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

afterAll(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("engines list（本地视图）", () => {
  it("合并 searxng 与网关源，routing / requires 正确", () => {
    const root = makeRoot();
    const engines = readLocalEngines(root);
    const byName = new Map(engines.map((engine) => [engine.name, engine]));

    expect(byName.get("bilibili")).toMatchObject({
      kind: "searxng",
      enabled: true,
      routing: ["resident"],
    });
    expect(byName.get("tavily")).toMatchObject({
      kind: "searxng",
      enabled: true,
      routing: ["rotating"],
    });
    expect(byName.get("google")).toMatchObject({
      kind: "searxng",
      enabled: false,
      routing: [],
    });

    expect(byName.get("tracemoe")).toMatchObject({
      kind: "gateway",
      enabled: true,
      available: true,
      routing: ["source"],
    });
    expect(byName.get("baidu")).toMatchObject({ kind: "gateway", enabled: true, available: true });

    const saucenao = byName.get("saucenao")!;
    expect(saucenao).toMatchObject({
      kind: "gateway",
      enabled: false,
      available: false,
      routing: ["source"],
    });
    expect(saucenao.requires).toEqual(["secrets.search.reverse_image.saucenao.api_key"]);
    expect(engines.every((engine) => engine.source === undefined)).toBe(true);
  });

  it("有 saucenao 密钥时 available=true", () => {
    const root = makeRoot({ saucenaoKey: "abc" });
    const saucenao = readLocalEngines(root).find((engine) => engine.name === "saucenao")!;
    expect(saucenao.available).toBe(true);
    expect(saucenao.enabled).toBe(false);
  });

  it("settings.yml 缺失时仍显示网关源与配置里引用的引擎", () => {
    const root = makeRoot();
    fs.rmSync(path.join(root, "data", "deps", "searxng", "settings.yml"));

    const engines = readLocalEngines(root);
    const names = engines.map((engine) => engine.name);
    expect(names).toEqual(expect.arrayContaining(["bilibili", "tavily", "tracemoe", "saucenao", "baidu"]));
  });
});

describe("engines list --all", () => {
  it("叠加 searxng /config 全量列表并标记 source", async () => {
    const url = await listenConfig({
      engines: [
        { name: "bilibili", enabled: true },
        { name: "google", enabled: true },
        { name: "bing", enabled: true },
        { name: "mojeek", enabled: false },
      ],
    });
    const root = makeRoot({ searxngUrl: url });

    const engines = await listEngines(root, { all: true });
    const byName = new Map(engines.map((engine) => [engine.name, engine]));

    // 本地条目以文件为准，并标记 local
    expect(byName.get("google")).toMatchObject({ enabled: false, source: "local" });
    expect(byName.get("bilibili")).toMatchObject({ source: "local" });
    // 远端独有条目
    expect(byName.get("bing")).toMatchObject({ kind: "searxng", enabled: true, source: "default" });
    expect(byName.get("mojeek")).toMatchObject({ enabled: false, source: "default" });
    // 网关源不受 --all 影响
    expect(byName.get("saucenao")!.source).toBeUndefined();

    const result = await enginesRun({ root, reporter, rest: ["list", "--all"] });
    expect(result.data).toMatchObject({ scope: "all" });
  });

  it("searxng 不在线时报 BACKEND_DOWN（退出码 1）", async () => {
    const root = makeRoot({ searxngUrl: "http://127.0.0.1:1" });
    await expect(enginesRun({ root, reporter, rest: ["list", "--all"] })).rejects.toMatchObject({
      code: "BACKEND_DOWN",
      exitCode: 1,
    });
  });
});

describe("engines enable/disable", () => {
  it("批量修改两种文件后只重启一次", async () => {
    const root = makeRoot();
    const settingsBefore = read(root, path.join("data", "deps", "searxng", "settings.yml"));
    const configBefore = read(root, "gateway.yaml");

    const result = await enginesRun({ root, reporter, rest: ["enable", "google", "baidu"] });

    expect(result.data).toEqual({
      changed: ["google", "baidu"],
      restart: "all",
      restarted: true,
    });
    expect(result.human).toContain("MCP 连接");
    expect(restartCalls).toEqual([root]);

    const searxngDoc = await import("yaml").then((YAML) => YAML.parse(read(root, path.join("data", "deps", "searxng", "settings.yml"))));
    const google = (searxngDoc as { engines: Array<{ name: string; disabled: boolean }> }).engines.find(
      (engine) => engine.name === "google",
    )!;
    expect(google.disabled).toBe(false);
    // 其它字段与注释不受影响（tavily 仍启用）
    expect(read(root, path.join("data", "deps", "searxng", "settings.yml"))).toMatch(
      /categories:\s*\[\s*videos\s*\]/,
    );

    // baidu 本来就在 sources 中；config 无需重写
    expect(read(root, "gateway.yaml")).toBe(configBefore);
    expect(hasBak(root, "gateway.yaml")).toBe(false);
    expect(settingsBefore).not.toBe(read(root, path.join("data", "deps", "searxng", "settings.yml")));
  });

  it("disable 从 sources 数组移除网关源并写回 gateway.yaml", async () => {
    const root = makeRoot();
    await enginesRun({ root, reporter, rest: ["disable", "tracemoe", "google"] });

    const config = read(root, "gateway.yaml");
    expect(config).toContain("sources:");
    expect(config).not.toContain("tracemoe");
    expect(config).toContain("baidu");
    expect(hasBak(root, "gateway.yaml")).toBe(true);
    expect(restartCalls).toHaveLength(1);
  });

  it("本地 settings.yml 没有的引擎追加最小条目", async () => {
    const root = makeRoot();
    // resident 里引用 newengine，但 settings.yml 没有
    write(
      path.join(root, "gateway.yaml"),
      gatewayConfig("http://127.0.0.1:1").replace(
        "resident: [bilibili]",
        "resident: [bilibili, newengine]",
      ),
    );

    await enginesRun({ root, reporter, rest: ["enable", "newengine"] });

    const settings = read(root, path.join("data", "deps", "searxng", "settings.yml"));
    expect(settings).toContain("name: newengine");
    expect(settings).toContain("disabled: false");
    expect(restartCalls).toHaveLength(1);
  });

  it("缺 secret 时拒绝启用 saucenao，且一个文件都不写", async () => {
    const root = makeRoot();
    const settingsBefore = read(root, path.join("data", "deps", "searxng", "settings.yml"));
    const configBefore = read(root, "gateway.yaml");

    await expect(
      enginesRun({ root, reporter, rest: ["enable", "saucenao"] }),
    ).rejects.toMatchObject({ code: "MISSING_SECRET", exitCode: 4 });

    expect(read(root, path.join("data", "deps", "searxng", "settings.yml"))).toBe(settingsBefore);
    expect(read(root, "gateway.yaml")).toBe(configBefore);
    expect(restartCalls).toHaveLength(0);
  });

  it("批量全有或全无：任一缺 secret 时第一个文件也不改", async () => {
    const root = makeRoot();
    const settingsBefore = read(root, path.join("data", "deps", "searxng", "settings.yml"));
    const configBefore = read(root, "gateway.yaml");

    await expect(
      enginesRun({ root, reporter, rest: ["enable", "google", "saucenao"] }),
    ).rejects.toMatchObject({ code: "MISSING_SECRET", exitCode: 4 });

    expect(read(root, path.join("data", "deps", "searxng", "settings.yml"))).toBe(settingsBefore);
    expect(read(root, "gateway.yaml")).toBe(configBefore);
    expect(restartCalls).toHaveLength(0);
  });

  it("有 secret 时可以启用 saucenao", async () => {
    const root = makeRoot({ saucenaoKey: "abc" });
    setEngines(root, ["saucenao"], true);

    expect(read(root, "gateway.yaml")).toContain("saucenao");
    expect(restartCalls).toHaveLength(0); // 纯函数不重启
  });

  it("未知引擎名报 ENGINE_NOT_FOUND，不写文件", async () => {
    const root = makeRoot();
    const configBefore = read(root, "gateway.yaml");

    await expect(enginesRun({ root, reporter, rest: ["enable", "nope"] })).rejects.toMatchObject({
      code: "ENGINE_NOT_FOUND",
      exitCode: 4,
    });
    expect(read(root, "gateway.yaml")).toBe(configBefore);
    expect(restartCalls).toHaveLength(0);
  });

  it("只禁用 searxng 引擎时不改 gateway.yaml", async () => {
    const root = makeRoot();
    const configBefore = read(root, "gateway.yaml");

    await enginesRun({ root, reporter, rest: ["disable", "bilibili"] });

    expect(read(root, "gateway.yaml")).toBe(configBefore);
    expect(hasBak(root, "gateway.yaml")).toBe(false);
    expect(read(root, path.join("data", "deps", "searxng", "settings.yml"))).toMatch(
      /name: bilibili\n\s+disabled: true/,
    );
    expect(restartCalls).toHaveLength(1);
  });
});
