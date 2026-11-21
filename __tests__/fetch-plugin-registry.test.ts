import { describe, expect, it, vi } from "vitest";
import {
  createFetchProviderRegistry,
  fetchProviderRegistry,
  findProvider,
  registeredProviders,
} from "../src/fetch/plugins/index.js";
import type {
  FetchProvider,
  FetchProviderContext,
  FetchProviderResult,
} from "../src/fetch/plugins/types.js";
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

function ctx(overrides: DeepPartial<Settings> = {}): FetchProviderContext {
  const settings = makeSettings(overrides);
  const secrets = makeSecrets();
  return {
    settings: { fetch: settings.fetch },
    secrets: {},
    getSecret: (path) => getSecretAtPath(secrets, path),
  };
}

function fakeProvider(
  id: string,
  match: (url: URL) => boolean,
  extra: Partial<FetchProvider> = {},
): FetchProvider {
  return {
    id,
    platform: id,
    name: id,
    displayName: id,
    capabilities: [],
    match,
    async fetch(): Promise<FetchProviderResult> {
      return { ok: true, status: 200, contentType: "text/plain", bytes: Buffer.from("ok") };
    },
    ...extra,
  };
}

describe("FetchProviderRegistry", () => {
  it("按注册顺序返回第一个命中者", () => {
    const first = fakeProvider("first", () => true);
    const second = fakeProvider("second", () => true);
    const registry = createFetchProviderRegistry([first, second]);
    expect(registry.find(new URL("https://example.com/"), ctx())?.id).toBe("first");
    expect(registry.list().map((p) => p.id)).toEqual(["first", "second"]);
  });

  it("重复 id 构造时直接抛错", () => {
    expect(() =>
      createFetchProviderRegistry([fakeProvider("dup", () => true), fakeProvider("dup", () => true)]),
    ).toThrow(/重复/);
  });

  it("enabled=false 的 provider 被跳过", () => {
    const disabled = fakeProvider("disabled", () => true, { enabled: () => false });
    const enabled = fakeProvider("enabled", () => true);
    const registry = createFetchProviderRegistry([disabled, enabled]);
    expect(registry.find(new URL("https://example.com/"), ctx())?.id).toBe("enabled");
  });

  it("match 抛错不影响后续 provider", () => {
    const broken = fakeProvider("broken", () => {
      throw new Error("boom");
    });
    const ok = fakeProvider("ok", () => true);
    const registry = createFetchProviderRegistry([broken, ok]);
    expect(registry.find(new URL("https://example.com/"), ctx())?.id).toBe("ok");
  });

  it("enabled 抛错也视为跳过", () => {
    const broken = fakeProvider("broken", () => true, {
      enabled: () => {
        throw new Error("boom");
      },
    });
    const ok = fakeProvider("ok", () => true);
    const registry = createFetchProviderRegistry([broken, ok]);
    expect(registry.find(new URL("https://example.com/"), ctx())?.id).toBe("ok");
  });

  it("核心不再内置平台 provider", () => {
    expect(registeredProviders()).toEqual([]);
    expect(fetchProviderRegistry.list()).toEqual([]);
  });
});

describe("createFetchProviderRegistry 外部扩展合并", () => {
  it("外部 provider 按加载顺序注册", () => {
    const external = fakeProvider("weibo", () => true, {
      displayName: "外部微博",
      capabilities: ["post"],
    });

    const registry = createFetchProviderRegistry([external]);

    expect(registry.list().map((provider) => provider.id)).toEqual(["weibo"]);
    expect(registry.list()[0]).toBe(external);
    expect(registry.find(new URL("https://example.com/"), ctx())).toBe(external);
  });

  it("多个外部 provider 保持加载顺序，findProvider 反映默认注册表", () => {
    const first = fakeProvider("demo", () => true);
    const second = fakeProvider("another", () => true);
    const registry = createFetchProviderRegistry([first, second]);

    expect(registry.list().map((provider) => provider.id)).toEqual(["demo", "another"]);
    expect(registry.find(new URL("https://example.com/"), ctx())?.id).toBe("demo");
    // 默认注册表没有注入外部 provider，findProvider 不应命中。
    expect(findProvider(new URL("https://example.com/"), ctx())).toBeUndefined();
  });

  it("没有外部 provider 时注册表为空", () => {
    const registry = createFetchProviderRegistry([]);
    expect(registry.list()).toEqual([]);
    expect(registry.find(new URL("https://example.com/"), ctx())).toBeUndefined();
  });

  it("外部 provider 自身 id 重复时构造抛错", () => {
    expect(() =>
      createFetchProviderRegistry([fakeProvider("dup", () => true), fakeProvider("dup", () => true)]),
    ).toThrow(/重复/);
  });
});

describe("directFetch provider 回退", () => {
  it("禁用 Bilibili 后不再走 provider 分支，改走通用抓取", async () => {
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
