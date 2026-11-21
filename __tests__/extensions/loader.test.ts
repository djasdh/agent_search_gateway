import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineProvider } from "../../src/engines/provider.js";
import type { Logger } from "../../src/logger.js";
import { extensionsDir, loadExtensions } from "../../src/extensions/loader.js";
import { backendInstallDir, extensionDataDir } from "../../src/extensions/paths.js";
import { createFetchProviderRegistry } from "../../src/fetch/plugins/index.js";

const tempDirs: string[] = [];

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asg-extensions-loader-"));
  tempDirs.push(dir);
  return dir;
}

function writeExtension(
  root: string,
  dirName: string,
  manifest: Record<string, unknown>,
  entryText: string,
  entryName = "index.mjs",
): string {
  const dir = path.join(extensionsDir(root), dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "asg-extension.json"), JSON.stringify(manifest), "utf8");
  fs.writeFileSync(path.join(dir, entryName), entryText, "utf8");
  return dir;
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "demo-fetch",
    name: "Demo Fetch",
    version: "1.0.0",
    api_version: 2,
    provides: ["fetch"],
    entry: "index.mjs",
    ...overrides,
  };
}

const FETCH_ENTRY = [
  "export const fetch = {",
  '  platform: "example",',
  '  capabilities: ["page"],',
  "  match: (url) => url.hostname === 'example.com',",
  "  async fetch() { return { ok: true, status: 200 }; },",
  "};",
  "",
].join("\n");

const ENGINE_ENTRY = [
  "export const engine = {",
  '  id: "gateway.search:demo",',
  '  group: "gateway.search",',
  '  name: "demo",',
  '  kind: "gateway",',
  '  displayName: "Demo 搜索",',
  "  routing: () => ['category:demo'],",
  "  available: () => true,",
  "  runtime: {",
  '    kind: "search",',
  "    plan: () => undefined,",
  "    search: async () => ({ ok: false, error: { kind: 'api', message: 'x' }, latencyMs: 0 }),",
  "  },",
  "};",
  "",
].join("\n");

/** 把收到的 pluginConfig / pluginSecrets 塞进失败消息，测试里可直接读回。 */
const CONTEXT_PROBE_ENGINE_ENTRY = [
  "export const engine = {",
  '  id: "gateway.search:demo",',
  '  group: "gateway.search",',
  '  name: "demo",',
  '  kind: "gateway",',
  '  displayName: "Demo",',
  "  routing: () => ['category:demo'],",
  "  available: () => true,",
  "  runtime: {",
  '    kind: "search",',
  "    plan: (categories, ctx) => (ctx.pluginConfig ? { hot: true } : undefined),",
  "    search: async (query, options, ctx) => ({",
  "      ok: false,",
  "      error: {",
  "        kind: 'api',",
  "        message: JSON.stringify({",
  "          config: ctx.pluginConfig ?? null,",
  "          configFrozen: ctx.pluginConfig ? Object.isFrozen(ctx.pluginConfig) : null,",
  "          nestedFrozen: ctx.pluginConfig?.nested",
  "            ? Object.isFrozen(ctx.pluginConfig.nested)",
  "            : null,",
  "          secrets: ctx.pluginSecrets ?? null,",
  "          secretsFrozen: ctx.pluginSecrets ? Object.isFrozen(ctx.pluginSecrets) : null,",
  "        }),",
  "      },",
  "      latencyMs: 0,",
  "    }),",
  "  },",
  "};",
  "",
].join("\n");

const CONFIG_FETCH_ENTRY = [
  "export const fetch = {",
  '  platform: "example",',
  '  capabilities: ["page"],',
  "  match: (url) => url.hostname === 'example.com',",
  "  enabled: (ctx) => ctx.pluginConfig?.disabled !== true,",
  "  available: (ctx) => ctx.pluginConfig?.maintenance !== true,",
  "  async fetch(url, ctx) {",
  "    return {",
  "      ok: true,",
  "      status: 200,",
  "      finalUrl: `https://example.com/${ctx.pluginConfig?.marker ?? 'none'}/${ctx.pluginSecrets?.cookie ?? 'none'}`,",
  "    };",
  "  },",
  "};",
  "",
].join("\n");

/** 显式报告 pluginConfig 是否为 undefined；不声明 available，用于确认不会被凭空补上。 */
const ABSENCE_FETCH_ENTRY = [
  "export const fetch = {",
  '  platform: "example",',
  "  match: () => true,",
  "  enabled: (ctx) => ctx.pluginConfig === undefined,",
  "  async fetch(url, ctx) {",
  '    return { ok: true, status: 200, finalUrl: String(ctx.pluginConfig) };',
  "  },",
  "};",
  "",
].join("\n");

interface ContextProbe {
  config: unknown;
  configFrozen: boolean | null;
  nestedFrozen: boolean | null;
  secrets: unknown;
  secretsFrozen: boolean | null;
}

/** 调用被包装的 search runtime，读回宿主注入的 pluginConfig / pluginSecrets。 */
async function readContextProbe(provider: EngineProvider): Promise<ContextProbe> {
  const runtime = provider.runtime;
  if (runtime?.kind !== "search") throw new Error("expected search runtime");
  const result = await runtime.search(
    "q",
    { hot: false, limit: 10 },
    { config: {}, secrets: {} },
  );
  if (result.ok) throw new Error("expected probe failure");
  return JSON.parse(result.error.message) as ContextProbe;
}


function fakeLogger(warnings: string[]): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: (message: string) => warnings.push(message),
    error: () => {},
    close: () => {},
  } as unknown as Logger;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("加载 fetch 扩展", () => {
  it("读取命名导出并用 manifest 覆盖身份元数据", async () => {
    const root = tempRoot();
    writeExtension(root, "demo-fetch", manifest(), FETCH_ENTRY);

    const loaded = await loadExtensions(root);

    expect(loaded.errors).toEqual([]);
    expect(loaded.engines).toEqual([]);
    expect(loaded.fetch).toHaveLength(1);
    const plugin = loaded.fetch[0]!;
    expect(plugin).toMatchObject({
      id: "demo-fetch",
      name: "demo-fetch",
      displayName: "Demo Fetch",
      platform: "example",
      capabilities: ["page"],
    });
    expect(plugin.match(new URL("https://example.com/a"))).toBe(true);
    expect(plugin.match(new URL("https://other.com/a"))).toBe(false);
    await expect(plugin.fetch(new URL("https://example.com/a"), {} as never)).resolves.toMatchObject({
      ok: true,
    });
  });

  it("platform 缺省回落到 manifest.id", async () => {
    const root = tempRoot();
    writeExtension(
      root,
      "demo-fetch",
      manifest(),
      ["export const fetch = {", "  match: () => true,", "  async fetch() { return { ok: true }; },", "};"].join(
        "\n",
      ),
    );

    const loaded = await loadExtensions(root);
    expect(loaded.fetch[0]!.platform).toBe("demo-fetch");
    expect(loaded.fetch[0]!.capabilities).toEqual([]);
  });
});

describe("加载 search 扩展", () => {
  it("读取 engine 导出并用于引擎注册表", async () => {
    const root = tempRoot();
    writeExtension(
      root,
      "demo-search",
      manifest({ id: "demo-search", name: "Demo 搜索", provides: ["search"] }),
      ENGINE_ENTRY,
    );

    const loaded = await loadExtensions(root);

    expect(loaded.errors).toEqual([]);
    expect(loaded.fetch).toEqual([]);
    expect(loaded.engines).toHaveLength(1);
    expect(loaded.engines[0]).toMatchObject({
      id: "gateway.search:demo",
      group: "gateway.search",
      name: "demo",
      kind: "gateway",
      displayName: "Demo 搜索",
    });
    expect(loaded.engines[0]!.runtime?.kind).toBe("search");
  });

  it("search provider 的 pluginId 固定为 manifest id，不被入口导出覆盖", async () => {
    const root = tempRoot();
    const entry = ENGINE_ENTRY.replace(
      '  group: "gateway.search",',
      '  pluginId: "forged-id",\n  group: "gateway.search",',
    );
    writeExtension(
      root,
      "demo-search",
      manifest({ id: "demo-search", name: "Demo 搜索", provides: ["search"] }),
      entry,
    );

    const loaded = await loadExtensions(root);
    expect(loaded.errors).toEqual([]);
    expect(loaded.engines[0]!.pluginId).toBe("demo-search");
  });

  it("同一插件可同时提供 fetch 与 search", async () => {
    const root = tempRoot();
    writeExtension(
      root,
      "demo-both",
      manifest({ id: "demo-both", name: "Demo Both", provides: ["search", "fetch"] }),
      `${FETCH_ENTRY}\n${ENGINE_ENTRY}`,
    );

    const loaded = await loadExtensions(root);
    expect(loaded.errors).toEqual([]);
    expect(loaded.fetch.map((plugin) => plugin.id)).toEqual(["demo-both"]);
    expect(loaded.engines.map((engine) => engine.id)).toEqual(["gateway.search:demo"]);
  });
});

describe("坏包隔离与校验", () => {
  it("单个插件失败只记录 error，不影响其它插件", async () => {
    const root = tempRoot();
    writeExtension(root, "good-fetch", manifest({ id: "good-fetch" }), FETCH_ENTRY);
    writeExtension(root, "broken", manifest({ id: "broken" }), "export const fetch = {};\n");

    const warnings: string[] = [];
    const loaded = await loadExtensions(root, { logger: fakeLogger(warnings) });

    expect(loaded.fetch.map((plugin) => plugin.id)).toEqual(["good-fetch"]);
    expect(loaded.errors).toHaveLength(1);
    expect(loaded.errors[0]).toMatchObject({
      id: "broken",
      error: expect.stringContaining("match / fetch"),
    });
    expect(warnings[0]).toContain("broken");
  });

  it("目录名与 manifest.id 不一致时跳过", async () => {
    const root = tempRoot();
    writeExtension(root, "wrong-dir", manifest({ id: "demo-fetch" }), FETCH_ENTRY);

    const loaded = await loadExtensions(root);
    expect(loaded.fetch).toEqual([]);
    expect(loaded.errors[0]).toMatchObject({
      id: "wrong-dir",
      error: expect.stringContaining("目录名"),
    });
  });

  it("asg-extension.json 的 api_version 不是 2 时跳过并记录 error", async () => {
    for (const apiVersion of [1, 3]) {
      const root = tempRoot();
      writeExtension(root, "demo-fetch", manifest({ api_version: apiVersion }), FETCH_ENTRY);

      const loaded = await loadExtensions(root);
      expect(loaded.fetch).toEqual([]);
      expect(loaded.errors[0]).toMatchObject({
        id: "demo-fetch",
        error: expect.stringContaining("api_version: 2"),
      });
      expect(loaded.errors[0]!.error).toContain("asg-extension.json");
    }
  });

  it("多个 V2 扩展同时加载", async () => {
    const root = tempRoot();
    writeExtension(
      root,
      "demo-v2",
      manifest({
        id: "demo-v2",
        backends: [
          {
            id: "demo-api",
            name: "Demo API",
            description: "示例后端",
            aliases: ["demo_old"],
          },
        ],
      }),
      FETCH_ENTRY,
    );
    writeExtension(root, "demo-v1", manifest({ id: "demo-v1" }), FETCH_ENTRY);

    const loaded = await loadExtensions(root);
    expect(loaded.errors).toEqual([]);
    expect(loaded.fetch.map((plugin) => plugin.id)).toEqual(["demo-v1", "demo-v2"]);
  });

  it("只有 asg-plugin.json 时产生可操作的升级错误", async () => {
    const root = tempRoot();
    const dir = path.join(extensionsDir(root), "demo-v1");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "asg-plugin.json"),
      JSON.stringify({ ...manifest(), api_version: 1 }),
      "utf8",
    );
    fs.writeFileSync(path.join(dir, "index.mjs"), FETCH_ENTRY, "utf8");

    const loaded = await loadExtensions(root);
    expect(loaded.fetch).toEqual([]);
    expect(loaded.errors).toEqual([
      {
        id: "demo-v1",
        error: expect.stringContaining("未找到 asg-extension.json"),
      },
    ]);
    expect(loaded.errors[0]!.error).toContain("请执行 asg extensions install");
  });

  it("缺少 manifest / 条目导入失败时只记录对应错误", async () => {
    const root = tempRoot();
    const missing = path.join(extensionsDir(root), "no-manifest");
    fs.mkdirSync(missing, { recursive: true });
    writeExtension(root, "import-fails", manifest({ id: "import-fails" }), FETCH_ENTRY);

    const warnings: string[] = [];
    const loaded = await loadExtensions(root, {
      logger: fakeLogger(warnings),
      importModule: async (url) => {
        if (url.includes("import-fails")) throw new Error("boom");
        return import(url);
      },
    });

    expect(loaded.fetch).toEqual([]);
    expect(loaded.errors).toEqual([
      { id: "import-fails", error: expect.stringContaining("boom") },
      { id: "no-manifest", error: expect.stringContaining("asg-extension.json") },
    ]);
    expect(warnings).toHaveLength(2);
  });

  it("search 导出缺少 runtime 时跳过", async () => {
    const root = tempRoot();
    writeExtension(
      root,
      "bad-engine",
      manifest({ id: "bad-engine", provides: ["search"] }),
      [
        "export const engine = {",
        '  id: "gateway.search:bad",',
        '  group: "gateway.search",',
        '  name: "bad",',
        "};",
      ].join("\n"),
    );

    const loaded = await loadExtensions(root);
    expect(loaded.engines).toEqual([]);
    expect(loaded.errors[0]!.error).toContain("runtime");
  });

  it("扩展目录不存在时返回空结果", async () => {
    const loaded = await loadExtensions(tempRoot());
    expect(loaded).toEqual({ fetch: [], engines: [], errors: [] });
  });
});

describe("外部插件注册", () => {
  it("加载官方 id 后注册到 fetch 注册表", async () => {
    const root = tempRoot();
    writeExtension(root, "bilibili", manifest({ id: "bilibili", name: "外部 B 站" }), FETCH_ENTRY);

    const loaded = await loadExtensions(root);
    expect(loaded.fetch.map((plugin) => plugin.id)).toEqual(["bilibili"]);

    const registry = createFetchProviderRegistry(loaded.fetch);
    expect(registry.list().map((plugin) => plugin.id)).toEqual(["bilibili"]);
    const matched = registry.find(new URL("https://example.com/a"), {} as never);
    expect(matched?.id).toBe("bilibili");
    expect(matched?.displayName).toBe("外部 B 站");
  });
});

describe("扩展配置覆盖（routing / secret）", () => {
  const ctx = { config: {}, secrets: {} } as const;

  it("routing.category / hot_category 同步覆盖 routing() 与 plan()", async () => {
    const root = tempRoot();
    writeExtension(
      root,
      "demo-search",
      manifest({ id: "demo-search", name: "Demo 搜索", provides: ["search"] }),
      ENGINE_ENTRY,
    );

    const loaded = await loadExtensions(root, {
      extensionConfig: {
        "gateway.search:demo": {
          routing: { category: "news", hot_category: "news_hot" },
        },
      },
    });

    const provider = loaded.engines[0]!;
    expect(provider.routing(ctx)).toEqual(["category:news", "category:news_hot"]);
    const runtime = provider.runtime!;
    if (runtime.kind !== "search") throw new Error("expected search runtime");
    expect(runtime.plan("foo, NEWS_HOT", ctx)).toEqual({ hot: true });
    expect(runtime.plan("news", ctx)).toEqual({ hot: false });
    expect(runtime.plan("other", ctx)).toBeUndefined();
  });

  it("只覆盖普通类别时 hot 不命中", async () => {
    const root = tempRoot();
    writeExtension(
      root,
      "demo-search",
      manifest({ id: "demo-search", name: "Demo 搜索", provides: ["search"] }),
      ENGINE_ENTRY,
    );

    const loaded = await loadExtensions(root, {
      extensionConfig: { "gateway.search:demo": { routing: { category: "news" } } },
    });
    const runtime = loaded.engines[0]!.runtime!;
    if (runtime.kind !== "search") throw new Error("expected search runtime");
    expect(loaded.engines[0]!.routing(ctx)).toEqual(["category:news"]);
    expect(runtime.plan("news", ctx)).toEqual({ hot: false });
    expect(runtime.plan("news_hot", ctx)).toBeUndefined();
  });

  it("pluginSecrets 注入到插件 plan/search", async () => {
    const root = tempRoot();
    const entry = [
      "export const engine = {",
      '  id: "gateway.search:demo",',
      '  group: "gateway.search",',
      '  name: "demo",',
      '  kind: "gateway",',
      '  displayName: "Demo",',
      "  routing: () => ['category:demo'],",
      "  available: () => true,",
      "  runtime: {",
      '    kind: "search",',
      "    plan: (categories, ctx) => (ctx.pluginSecrets?.cookie ? { hot: true } : undefined),",
      "    search: async () => ({ ok: false, error: { kind: 'api', message: 'x' }, latencyMs: 0 }),",
      "  },",
      "};",
      "",
    ].join("\n");
    writeExtension(
      root,
      "demo-search",
      manifest({ id: "demo-search", name: "Demo 搜索", provides: ["search"] }),
      entry,
    );

    const loaded = await loadExtensions(root, {
      extensionSecrets: { "demo-search": { cookie: "env:DEMO_COOKIE" } },
      env: { DEMO_COOKIE: "cookie-value" },
    });
    const runtime = loaded.engines[0]!.runtime!;
    if (runtime.kind !== "search") throw new Error("expected search runtime");
    expect(runtime.plan("demo", ctx)).toEqual({ hot: true });

    const missing = await loadExtensions(root, {
      extensionSecrets: { "demo-search": { cookie: "env:DEMO_COOKIE" } },
      env: {},
    });
    const missingRuntime = missing.engines[0]!.runtime!;
    if (missingRuntime.kind !== "search") throw new Error("expected search runtime");
    expect(missingRuntime.plan("demo", ctx)).toBeUndefined();
  });

  it("secret: 依赖缺失时 available=false，含 env: 解析", async () => {
    const root = tempRoot();
    const entry = [
      "export const engine = {",
      '  id: "gateway.search:demo",',
      '  group: "gateway.search",',
      '  name: "demo",',
      '  kind: "gateway",',
      '  displayName: "Demo",',
      "  routing: () => ['category:demo'],",
      "  available: () => true,",
      '  requires: ["secret:cookie"],',
      "  runtime: {",
      '    kind: "search",',
      "    plan: () => undefined,",
      "    search: async () => ({ ok: false, error: { kind: 'api', message: 'x' }, latencyMs: 0 }),",
      "  },",
      "};",
      "",
    ].join("\n");
    writeExtension(
      root,
      "demo-search",
      manifest({ id: "demo-search", name: "Demo 搜索", provides: ["search"] }),
      entry,
    );

    const missing = await loadExtensions(root);
    expect(missing.engines[0]!.available(ctx)).toBe(false);

    const unresolved = await loadExtensions(root, {
      extensionSecrets: { "demo-search": { cookie: "env:DEMO_COOKIE" } },
      env: {},
    });
    expect(unresolved.engines[0]!.available(ctx)).toBe(false);

    const satisfied = await loadExtensions(root, {
      extensionSecrets: { "demo-search": { cookie: "env:DEMO_COOKIE" } },
      env: { DEMO_COOKIE: "cookie-value" },
    });
    expect(satisfied.engines[0]!.available(ctx)).toBe(true);
  });

  it("未配置扩展时不改变插件默认行为", async () => {
    const root = tempRoot();
    writeExtension(
      root,
      "demo-search",
      manifest({ id: "demo-search", name: "Demo 搜索", provides: ["search"] }),
      ENGINE_ENTRY,
    );

    const loaded = await loadExtensions(root);
    const provider = loaded.engines[0]!;
    expect(provider.routing(ctx)).toEqual(["category:demo"]);
    const runtime = provider.runtime!;
    if (runtime.kind !== "search") throw new Error("expected search runtime");
    expect(runtime.plan("anything", ctx)).toBeUndefined();
  });

  it("防御性忽略非对象的扩展配置", async () => {
    const root = tempRoot();
    writeExtension(
      root,
      "demo-search",
      manifest({ id: "demo-search", name: "Demo 搜索", provides: ["search"] }),
      ENGINE_ENTRY,
    );

    const loaded = await loadExtensions(root, {
      extensionConfig: { "gateway.search:demo": "not-an-object" } as never,
      extensionSecrets: { "gateway.search:demo": ["nope"] } as never,
    });
    expect(loaded.engines[0]!.routing(ctx)).toEqual(["category:demo"]);
  });

  it("图搜源的 routing 不受 extensions.routing 影响", async () => {
    const root = tempRoot();
    const entry = [
      "export const engine = {",
      '  id: "gateway.reverse_image:demo",',
      '  group: "gateway.reverse_image",',
      '  name: "demo",',
      '  kind: "gateway",',
      '  displayName: "Demo 图搜",',
      "  routing: () => ['source'],",
      "  available: () => true,",
      "  runtime: {",
      '    kind: "reverse_image",',
      "    search: async () => ({ ok: true, results: [], latencyMs: 0 }),",
      "  },",
      "};",
      "",
    ].join("\n");
    writeExtension(
      root,
      "demo-image",
      manifest({ id: "demo-image", name: "Demo 图搜", provides: ["search"] }),
      entry,
    );

    const loaded = await loadExtensions(root, {
      extensionConfig: {
        "gateway.reverse_image:demo": { routing: { category: "news" } },
      },
    });
    expect(loaded.engines[0]!.routing(ctx)).toEqual(["source"]);
  });
});

describe("扩展私有配置（manifest.config_schema）", () => {
  const ctx = { config: {}, secrets: {} } as const;

  const SEARCH_SCHEMA = {
    type: "object",
    properties: {
      limit: { type: "integer", default: 5 },
      label: { type: "string", default: "default" },
    },
  };

  function writeSearchPlugin(
    root: string,
    schema?: Record<string, unknown>,
    entry = CONTEXT_PROBE_ENGINE_ENTRY,
  ): void {
    writeExtension(
      root,
      "demo-search",
      manifest({
        id: "demo-search",
        name: "Demo 搜索",
        provides: ["search"],
        ...(schema === undefined ? {} : { config_schema: schema }),
      }),
      entry,
    );
  }

  it("未配置 config 时注入补齐默认值的 pluginConfig", async () => {
    const root = tempRoot();
    writeSearchPlugin(root, SEARCH_SCHEMA);

    const loaded = await loadExtensions(root);
    expect(loaded.errors).toEqual([]);

    const probe = await readContextProbe(loaded.engines[0]!);
    expect(probe.config).toEqual({ limit: 5, label: "default" });
    expect(probe.configFrozen).toBe(true);
    expect(loaded.engines[0]!.runtime!.kind).toBe("search");
  });

  it("用户配置覆盖 schema 默认值", async () => {
    const root = tempRoot();
    writeSearchPlugin(root, SEARCH_SCHEMA);

    const loaded = await loadExtensions(root, {
      extensionConfig: { "demo-search": { config: { limit: 9 } } },
    });

    const probe = await readContextProbe(loaded.engines[0]!);
    expect(probe.config).toEqual({ limit: 9, label: "default" });
  });

  it("配置非法时跳过插件并记录字段名", async () => {
    const root = tempRoot();
    writeSearchPlugin(root, SEARCH_SCHEMA);

    let imported = false;
    const loaded = await loadExtensions(root, {
      extensionConfig: { "demo-search": { config: { limit: "not-a-number" } } },
      importModule: async (url) => {
        imported = true;
        return import(url);
      },
    });

    expect(imported).toBe(false);
    expect(loaded.engines).toEqual([]);
    expect(loaded.fetch).toEqual([]);
    expect(loaded.errors).toHaveLength(1);
    expect(loaded.errors[0]).toMatchObject({
      id: "demo-search",
      error: expect.stringContaining("插件配置无效"),
    });
    expect(loaded.errors[0]!.error).toContain("limit");
  });

  it("未声明 schema 但有 config 时原样透传", async () => {
    const root = tempRoot();
    writeSearchPlugin(root);

    const raw = { nested: { a: 1 }, list: [1, 2, 3] };
    const loaded = await loadExtensions(root, {
      extensionConfig: { "demo-search": { config: raw } },
    });

    const probe = await readContextProbe(loaded.engines[0]!);
    expect(probe.config).toEqual(raw);
    expect(probe.configFrozen).toBe(true);
    expect(probe.nestedFrozen).toBe(true);
  });

  it("只在 engineId 下写 config 时插件拿不到", async () => {
    const root = tempRoot();
    writeSearchPlugin(root);

    const loaded = await loadExtensions(root, {
      extensionConfig: { "gateway.search:demo": { config: { marker: "x" } } },
    });

    const probe = await readContextProbe(loaded.engines[0]!);
    expect(probe.config).toBeNull();
    // 仍可正常提供原来的路由与运行时。
    expect(loaded.engines[0]!.routing(ctx)).toEqual(["category:demo"]);
  });

  it("未声明 schema 且 config 为空对象时不注入 pluginConfig（settings 风格）", async () => {
    const root = tempRoot();
    writeSearchPlugin(root);

    const loaded = await loadExtensions(root, {
      // settings 经 zod 后 config 默认是 {}；空对象不应触发包装。
      extensionConfig: { "demo-search": { routing: {}, config: {} } },
    });

    const provider = loaded.engines[0]!;
    const runtime = provider.runtime!;
    if (runtime.kind !== "search") throw new Error("expected search runtime");
    expect(runtime.plan("anything", ctx)).toBeUndefined();
    const probe = await readContextProbe(provider);
    expect(probe.config).toBeNull();
    expect(probe.configFrozen).toBeNull();
  });
});

describe("fetch 插件的配置与密钥注入", () => {
  it("enabled 与 fetch 都能读到 pluginConfig", async () => {
    const root = tempRoot();
    writeExtension(root, "demo-fetch", manifest(), CONFIG_FETCH_ENTRY);

    const loaded = await loadExtensions(root, {
      extensionConfig: { "demo-fetch": { config: { marker: "m1", disabled: false } } },
    });

    const plugin = loaded.fetch[0]!;
    expect(plugin.enabled!({} as never)).toBe(true);
    await expect(plugin.fetch(new URL("https://example.com/a"), {} as never)).resolves.toMatchObject({
      ok: true,
      finalUrl: "https://example.com/m1/none",
    });

    const off = await loadExtensions(root, {
      extensionConfig: { "demo-fetch": { config: { disabled: true } } },
    });
    expect(off.fetch[0]!.enabled!({} as never)).toBe(false);
  });

  it("match 不受配置影响", async () => {
    const root = tempRoot();
    writeExtension(root, "demo-fetch", manifest(), CONFIG_FETCH_ENTRY);

    const loaded = await loadExtensions(root, {
      extensionConfig: {
        "demo-fetch": {
          config: { disabled: true, marker: "https://other.com/", hostname: 42 },
        },
      },
    });

    const plugin = loaded.fetch[0]!;
    expect(plugin.match(new URL("https://example.com/a"))).toBe(true);
    expect(plugin.match(new URL("https://other.com/a"))).toBe(false);
    // 同一个坏配置确实被注入到了 enabled，说明包装生效但 match 未参与。
    expect(plugin.enabled!({} as never)).toBe(false);
  });

  it("插件能拿到 pluginSecrets（manifest id 键）", async () => {
    const root = tempRoot();
    writeExtension(root, "demo-fetch", manifest(), CONFIG_FETCH_ENTRY);

    const loaded = await loadExtensions(root, {
      extensionSecrets: { "demo-fetch": { cookie: "manifest-cookie" } },
    });

    await expect(loaded.fetch[0]!.fetch(new URL("https://example.com/a"), {} as never)).resolves
      .toMatchObject({ finalUrl: "https://example.com/none/manifest-cookie" });
  });

  it("未声明 schema 且 config 为空对象时不注入 pluginConfig（settings 风格）", async () => {
    const root = tempRoot();
    writeExtension(root, "demo-fetch", manifest(), ABSENCE_FETCH_ENTRY);

    const loaded = await loadExtensions(root, {
      // settings 经 zod 后 config 默认是 {}；空对象不应触发包装或注入。
      extensionConfig: { "demo-fetch": { routing: {}, config: {} } },
    });

    const plugin = loaded.fetch[0]!;
    expect(plugin.enabled!({} as never)).toBe(true);
    // 原本没有 available，也不能凭空补一个。
    expect(plugin.available).toBeUndefined();
    const result = await plugin.fetch(new URL("https://example.com/a"), {} as never);
    expect(result.finalUrl).toBe("undefined");
  });

  it("未声明 schema 但 config 非空时原样注入", async () => {
    const root = tempRoot();
    writeExtension(root, "demo-fetch", manifest(), CONFIG_FETCH_ENTRY);

    const loaded = await loadExtensions(root, {
      extensionConfig: { "demo-fetch": { config: { marker: "m2" } } },
    });

    await expect(loaded.fetch[0]!.fetch(new URL("https://example.com/a"), {} as never)).resolves
      .toMatchObject({ finalUrl: "https://example.com/m2/none" });
  });
});

describe("密钥只认 manifest id", () => {
  it("旧的 engineId 键不再注入，只认 extensions.<manifest id>.<name>", async () => {
    const root = tempRoot();
    writeExtension(
      root,
      "demo-search",
      manifest({ id: "demo-search", name: "Demo 搜索", provides: ["search"] }),
      CONTEXT_PROBE_ENGINE_ENTRY,
    );

    const legacy = await loadExtensions(root, {
      extensionSecrets: { "gateway.search:demo": { cookie: "legacy-value" } },
    });
    const legacyProbe = await readContextProbe(legacy.engines[0]!);
    expect(legacyProbe.secrets).toBeNull();

    const current = await loadExtensions(root, {
      extensionSecrets: {
        "gateway.search:demo": { cookie: "legacy-value", token: "legacy-token" },
        "demo-search": { cookie: "manifest-value" },
      },
    });
    const currentProbe = await readContextProbe(current.engines[0]!);
    expect(currentProbe.secrets).toEqual({ cookie: "manifest-value" });
    expect(currentProbe.secretsFrozen).toBe(true);
  });

  it("search 的 secret: 依赖只看 manifest id 密钥", async () => {
    const root = tempRoot();
    const entry = CONTEXT_PROBE_ENGINE_ENTRY.replace(
      '  available: () => true,',
      '  available: () => true,\n  requires: ["secret:cookie"],',
    );
    writeExtension(
      root,
      "demo-search",
      manifest({ id: "demo-search", name: "Demo 搜索", provides: ["search"] }),
      entry,
    );

    const ctx = { config: {}, secrets: {} } as const;
    const none = await loadExtensions(root);
    expect(none.engines[0]!.available(ctx)).toBe(false);

    const viaManifest = await loadExtensions(root, {
      extensionSecrets: { "demo-search": { cookie: "manifest-cookie" } },
    });
    expect(viaManifest.engines[0]!.available(ctx)).toBe(true);

    const viaLegacy = await loadExtensions(root, {
      extensionSecrets: { "gateway.search:demo": { cookie: "legacy-cookie" } },
    });
    expect(viaLegacy.engines[0]!.available(ctx)).toBe(false);
  });
});

describe("V2 runtime", () => {
  it("V2 fetch 从 fetch_channels 前缀派生 platform", async () => {
    const root = tempRoot();
    writeExtension(
      root,
      "demo-v2",
      manifest({
        id: "demo-v2",
        api_version: 2,
        fetch_channels: [{ id: "example:cli" }, { id: "example:http" }],
      }),
      [
        "export const fetch = {",
        "  match: () => true,",
        "  async fetch() { return { ok: true }; },",
        "};",
      ].join("\n"),
    );

    const loaded = await loadExtensions(root);
    expect(loaded.errors).toEqual([]);
    expect(loaded.fetch[0]!.platform).toBe("example");
  });

  it("入口 platform 优先于 fetch_channels 前缀", async () => {
    const root = tempRoot();
    writeExtension(
      root,
      "demo-v2",
      manifest({
        id: "demo-v2",
        api_version: 2,
        fetch_channels: [{ id: "example:cli" }],
      }),
      FETCH_ENTRY,
    );

    const loaded = await loadExtensions(root);
    expect(loaded.fetch[0]!.platform).toBe("example");
  });

  it("V2 search 用 search_engines 补 displayName", async () => {
    const root = tempRoot();
    const entry = ENGINE_ENTRY.replace('  displayName: "Demo 搜索",\n', "");
    writeExtension(
      root,
      "demo-search",
      manifest({
        id: "demo-search",
        name: "Manifest 名称",
        api_version: 2,
        provides: ["search"],
        search_engines: [{ id: "gateway.search:demo", name: "Manifest 搜索" }],
      }),
      entry,
    );

    const loaded = await loadExtensions(root);
    expect(loaded.errors).toEqual([]);
    expect(loaded.engines[0]!.displayName).toBe("Manifest 搜索");
  });

  it("V2 backends 注入 pluginBackends（ids / dir / state）", async () => {
    const root = tempRoot();
    const entry = [
      "export const fetch = {",
      "  match: () => true,",
      "  async fetch(url, ctx) {",
      "    const backends = ctx.pluginBackends;",
      "    return {",
      "      ok: true,",
      "      finalUrl: JSON.stringify({",
      "        ids: backends?.ids ?? null,",
      "        dir: backends?.dir('demo-api') ?? null,",
      "        state: backends?.state('demo-api') ?? null,",
      "      }),",
      "    };",
      "  },",
      "};",
    ].join("\n");
    writeExtension(
      root,
      "demo-v2",
      manifest({
        id: "demo-v2",
        api_version: 2,
        backends: [{ id: "demo-api", name: "Demo API" }],
      }),
      entry,
    );

    const dataDir = extensionDataDir(root, "demo-v2");
    fs.mkdirSync(path.join(dataDir, "backends", "demo-api"), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "backends.json"),
      JSON.stringify({
        "demo-api": { installed: true, enabled: true, version: "1.2.3" },
      }),
      "utf8",
    );

    const loaded = await loadExtensions(root);
    const result = await loaded.fetch[0]!.fetch(new URL("https://example.com/a"), {} as never);
    const info = JSON.parse(result.finalUrl!);

    expect(info.ids).toEqual(["demo-api"]);
    expect(info.dir).toBe(backendInstallDir(root, "demo-v2", "demo-api"));
    expect(info.state).toEqual({
      installed: true,
      enabled: true,
      version: "1.2.3",
      path: backendInstallDir(root, "demo-v2", "demo-api"),
    });
  });

  it("V2 search 的 available 能读 pluginBackends 状态", async () => {
    const root = tempRoot();
    const entry = [
      "export const engine = {",
      '  id: "gateway.search:demo",',
      '  group: "gateway.search",',
      '  name: "demo",',
      '  available: (ctx) => ctx.pluginBackends?.state("demo-api")?.installed === true,',
      "  runtime: {",
      '    kind: "search",',
      "    plan: () => undefined,",
      "    search: async () => ({ ok: false, error: { kind: 'api', message: 'x' }, latencyMs: 0 }),",
      "  },",
      "};",
    ].join("\n");
    writeExtension(
      root,
      "demo-search",
      manifest({
        id: "demo-search",
        api_version: 2,
        provides: ["search"],
        backends: [{ id: "demo-api", name: "Demo API" }],
      }),
      entry,
    );

    const ctx = { config: {}, secrets: {} } as const;
    const missing = await loadExtensions(root);
    expect(missing.engines[0]!.available(ctx)).toBe(false);

    const dataDir = extensionDataDir(root, "demo-search");
    fs.mkdirSync(path.join(dataDir, "backends", "demo-api"), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "backends.json"),
      JSON.stringify({ "demo-api": { installed: true, enabled: true } }),
      "utf8",
    );

    const installed = await loadExtensions(root);
    expect(installed.engines[0]!.available(ctx)).toBe(true);
  });

  it("没有 backends 时不注入 pluginBackends", async () => {
    const root = tempRoot();
    writeExtension(root, "demo-fetch", manifest(), [
      "export const fetch = {",
      "  match: () => true,",
      "  async fetch(url, ctx) {",
      "    return { ok: true, finalUrl: String(ctx.pluginBackends === undefined) };",
      "  },",
      "};",
    ].join("\n"));

    const loaded = await loadExtensions(root);
    const result = await loaded.fetch[0]!.fetch(new URL("https://example.com/a"), {} as never);
    expect(result.finalUrl).toBe("true");
  });
});
