import { describe, expect, it, vi } from "vitest";
import { fetchPluginRegistry, createFetchRegistry, registeredPlugins } from "../src/fetch/plugins/index.js";
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
  const settings = makeSettings(overrides);
  const secrets = makeSecrets();
  return {
    settings: { fetch: settings.fetch },
    secrets: {},
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

  it("核心不再内置平台插件", () => {
    expect(registeredPlugins()).toEqual([]);
    expect(fetchPluginRegistry.list()).toEqual([]);
  });
});

describe("createFetchRegistry 外部插件合并", () => {
  it("外部插件按加载顺序注册", () => {
    const external = fakePlugin("weibo", () => true, {
      displayName: "外部微博",
      capabilities: ["post"],
    });

    const registry = createFetchRegistry([external]);

    expect(registry.list().map((plugin) => plugin.id)).toEqual(["weibo"]);
    expect(registry.list()[0]).toBe(external);
    expect(registry.find(new URL("https://example.com/"), ctx())).toBe(external);
  });

  it("多个外部插件保持加载顺序", () => {
    const first = fakePlugin("demo", () => true);
    const second = fakePlugin("another", () => true);
    const registry = createFetchRegistry([first, second]);

    expect(registry.list().map((plugin) => plugin.id)).toEqual(["demo", "another"]);
    expect(registry.find(new URL("https://example.com/"), ctx())?.id).toBe("demo");
  });

  it("没有外部插件时注册表为空", () => {
    const registry = createFetchRegistry([]);
    expect(registry.list()).toEqual([]);
    expect(registry.find(new URL("https://example.com/"), ctx())).toBeUndefined();
  });

  it("外部插件自身 id 重复时构造抛错", () => {
    expect(() => createFetchRegistry([fakePlugin("dup", () => true), fakePlugin("dup", () => true)])).toThrow(
      /重复/,
    );
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
