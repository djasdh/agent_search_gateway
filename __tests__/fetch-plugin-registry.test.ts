import { describe, expect, it, vi } from "vitest";
import { fetchPluginRegistry, registeredPlugins } from "../src/fetch/plugins/index.js";
import { createFetchPluginRegistry } from "../src/fetch/plugins/registry.js";
import type { FetchPlugin, FetchPluginContext, FetchPluginResult } from "../src/fetch/plugins/types.js";
import { directFetch } from "../src/fetch/direct.js";
import { getSecretAtPath } from "../src/settings/index.js";
import {
  deepMerge,
  directDeps,
  makeSecrets,
  makeSettings,
  type DeepPartial,
} from "./helpers/settings.js";
import type { Settings } from "../src/settings/index.js";

function ctx(overrides: DeepPartial<Settings> = {}): FetchPluginContext {
  const settings = makeSettings(
    deepMerge({ bilibili: { enabled: true }, weibo: { enabled: true } }, overrides),
  );
  const secrets = makeSecrets();
  return {
    settings: { fetch: settings.fetch, bilibili: settings.bilibili, weibo: settings.weibo },
    secrets: { bilibili: { http: { token: secrets.bilibili.http.token } } },
    getSecret: (path) => getSecretAtPath(secrets, path),
  };
}

function fakePlugin(
  id: string,
  match: (url: URL) => boolean,
  extra: Partial<FetchPlugin> = {},
): FetchPlugin {
  return {
    id,
    platform: id,
    name: id,
    displayName: id,
    capabilities: [],
    match,
    async fetch(): Promise<FetchPluginResult> {
      return { ok: true, status: 200, contentType: "text/plain", bytes: Buffer.from("ok") };
    },
    ...extra,
  };
}

describe("FetchPluginRegistry", () => {
  it("按注册顺序返回第一个命中者", () => {
    const first = fakePlugin("first", () => true);
    const second = fakePlugin("second", () => true);
    const registry = createFetchPluginRegistry([first, second]);
    expect(registry.find(new URL("https://example.com/"), ctx())?.id).toBe("first");
    expect(registry.list().map((p) => p.id)).toEqual(["first", "second"]);
  });

  it("重复 id 构造时直接抛错", () => {
    expect(() => createFetchPluginRegistry([fakePlugin("dup", () => true), fakePlugin("dup", () => true)])).toThrow(
      /重复/,
    );
  });

  it("enabled=false 的插件被跳过", () => {
    const disabled = fakePlugin("disabled", () => true, { enabled: () => false });
    const enabled = fakePlugin("enabled", () => true);
    const registry = createFetchPluginRegistry([disabled, enabled]);
    expect(registry.find(new URL("https://example.com/"), ctx())?.id).toBe("enabled");
  });

  it("match 抛错不影响后续插件", () => {
    const broken = fakePlugin("broken", () => {
      throw new Error("boom");
    });
    const ok = fakePlugin("ok", () => true);
    const registry = createFetchPluginRegistry([broken, ok]);
    expect(registry.find(new URL("https://example.com/"), ctx())?.id).toBe("ok");
  });

  it("enabled 抛错也视为跳过", () => {
    const broken = fakePlugin("broken", () => true, {
      enabled: () => {
        throw new Error("boom");
      },
    });
    const ok = fakePlugin("ok", () => true);
    const registry = createFetchPluginRegistry([broken, ok]);
    expect(registry.find(new URL("https://example.com/"), ctx())?.id).toBe("ok");
  });

  it("禁用 Bilibili / 微博后 find 返回 undefined", () => {
    const disabled = ctx({ bilibili: { enabled: false }, weibo: { enabled: false } });
    expect(fetchPluginRegistry.find(new URL("https://www.bilibili.com/video/BV1xx411c7mD"), disabled)).toBeUndefined();
    expect(fetchPluginRegistry.find(new URL("https://weibo.com/1/AbC?weibo=post"), disabled)).toBeUndefined();
    expect(fetchPluginRegistry.find(new URL("https://wx1.sinaimg.cn/large/a.jpg"), disabled)).toBeUndefined();

    const enabled = ctx();
    expect(fetchPluginRegistry.find(new URL("https://www.bilibili.com/video/BV1xx411c7mD"), enabled)?.id).toBe(
      "bilibili",
    );
    expect(fetchPluginRegistry.find(new URL("https://weibo.com/1/AbC?weibo=post"), enabled)?.id).toBe("weibo");
  });

  it("内置插件元数据一致（id/platform/capabilities/requires）", () => {
    expect(registeredPlugins()).toEqual(["cnki", "bilibili", "weibo"]);
    const plugins = fetchPluginRegistry.list();
    expect(plugins.map((p) => p.id)).toEqual(["cnki", "bilibili", "weibo"]);
    for (const plugin of plugins) {
      expect(plugin.platform).toBe(plugin.id);
      expect(plugin.name).toBe(plugin.id);
      expect(plugin.displayName.length).toBeGreaterThan(0);
      expect(Array.isArray(plugin.capabilities)).toBe(true);
      expect(plugin.requires === undefined || Array.isArray(plugin.requires)).toBe(true);
    }

    const bilibili = plugins.find((p) => p.id === "bilibili")!;
    expect(bilibili.displayName).toBe("Bilibili");
    expect(bilibili.aliases).toContain("bili");
    expect(bilibili.settingsKey).toBe("bilibili");
    expect(bilibili.capabilities).toEqual(["video", "article", "comments"]);
    expect(bilibili.requires).toEqual([
      { type: "backend", anyOf: ["bilibili:kukemc", "bilibili:ytdlp", "bilibili:article"] },
      { type: "secret", path: "secrets.bilibili.http.token", optional: true },
    ]);

    const weibo = plugins.find((p) => p.id === "weibo")!;
    expect(weibo.displayName).toBe("微博");
    expect(weibo.capabilities).toEqual(["post", "comments", "user", "user-posts", "image"]);
    expect(weibo.requires).toEqual([
      { type: "command", path: "weibo.cli.command", default: "opencli" },
      { type: "backend", anyOf: ["weibo:opencli"] },
    ]);

    const cnki = plugins.find((p) => p.id === "cnki")!;
    expect(cnki.displayName).toBe("知网");
    expect(cnki.capabilities).toEqual(["pdf"]);
    expect(cnki.requires).toEqual([]);
  });
});

describe("directFetch 插件回退", () => {
  it("禁用 Bilibili 后不再走插件分支，改走通用抓取", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("stub network"));
    try {
      const settings = makeSettings(
        deepMerge({ bilibili: { enabled: false }, fetch: { block_private_ips: false } }, {}),
      );
      const result = await directFetch(
        directDeps(settings),
        "https://www.bilibili.com/video/BV1xx411c7mD",
      );
      expect(result.plugin).toBeUndefined();
      expect(result.ok).toBe(false);
      expect(result.errorKind).toBe("network");
      expect(result.errorMessage).toContain("stub network");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
