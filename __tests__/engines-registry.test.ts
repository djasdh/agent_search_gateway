import { describe, expect, it } from "vitest";
import {
  ENGINE_PROVIDERS,
  engineProvider,
  providersForGroup,
} from "../src/engines/registry.js";
import type { EngineProviderContext } from "../src/engines/provider.js";
import { tracemoeProvider } from "../src/engines/providers/tracemoe.js";
import { saucenaoProvider } from "../src/engines/providers/saucenao.js";
import { baiduProvider } from "../src/engines/providers/baidu.js";
import { weiboProvider } from "../src/engines/providers/weibo.js";
import { GATEWAY_SOURCE_SPECS } from "../src/settings/gateway-sources.js";

function ctx(
  config: Record<string, unknown> = {},
  secrets: Record<string, unknown> = {},
): EngineProviderContext {
  return { config, secrets };
}

describe("引擎 provider 注册表", () => {
  it("provider id 唯一", () => {
    const ids = ENGINE_PROVIDERS.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("GATEWAY_SOURCE_SPECS 每个源都有 provider，requires 一致", () => {
    for (const spec of GATEWAY_SOURCE_SPECS) {
      const provider = engineProvider("gateway.reverse_image", spec.name);
      expect(provider, spec.name).toBeDefined();
      expect([...(provider!.requires ?? [])]).toEqual([...spec.requires]);
    }
    expect(providersForGroup("gateway.reverse_image")).toHaveLength(GATEWAY_SOURCE_SPECS.length);
  });

  it("微博 provider 已注册", () => {
    expect(engineProvider("gateway.search", "weibo")).toBe(weiboProvider);
    expect(weiboProvider.id).toBe("gateway.search:weibo");
    expect(weiboProvider.enabledPath).toEqual(["search", "weibo", "enabled"]);
  });
});

describe("provider 元数据", () => {
  it("微博 routing 读取自定义 category / hot_category", () => {
    const providerCtx = ctx({
      search: { weibo: { category: "wb", hot_category: "wb_hot" } },
    });
    expect(weiboProvider.routing(providerCtx)).toEqual(["category:wb", "category:wb_hot"]);
  });

  it("微博 routing 缺省 weibo / weibo_hot", () => {
    expect(weiboProvider.routing(ctx())).toEqual(["category:weibo", "category:weibo_hot"]);
  });

  it("微博 available 只看前置条件，enabled 看 search.weibo.enabled", () => {
    const off = ctx({ weibo: { enabled: true }, search: { weibo: { enabled: false } } });
    expect(weiboProvider.available(off)).toBe(true);
    expect(weiboProvider.enabled?.(off)).toBe(false);

    const on = ctx({ weibo: { enabled: true }, search: { weibo: { enabled: true } } });
    expect(weiboProvider.available(on)).toBe(true);
    expect(weiboProvider.enabled?.(on)).toBe(true);

    expect(weiboProvider.available(ctx())).toBe(false);
    expect(
      weiboProvider.available(ctx({ weibo: { enabled: false }, search: { weibo: { enabled: true } } })),
    ).toBe(false);
  });

  it("微博 available：command 缺省 opencli 可用，显式空串不可用", () => {
    const base = { weibo: { enabled: true }, search: { weibo: { enabled: true } } };
    expect(weiboProvider.available(ctx(base))).toBe(true);
    expect(weiboProvider.available(ctx({ ...base, weibo: { enabled: true, cli: { command: "opencli" } } }))).toBe(
      true,
    );
    expect(weiboProvider.available(ctx({ ...base, weibo: { enabled: true, cli: { command: "  " } } }))).toBe(
      false,
    );
  });

  it("百度 available：缺省 true，baidu.enabled=false 时 false", () => {
    expect(baiduProvider.available(ctx({ search: { reverse_image: {} } }))).toBe(true);
    expect(
      baiduProvider.available(ctx({ search: { reverse_image: { baidu: { enabled: false } } } })),
    ).toBe(false);
    expect(
      baiduProvider.available(ctx({ search: { reverse_image: { baidu: { enabled: true } } } })),
    ).toBe(true);
  });

  it("trace.moe available 恒 true", () => {
    expect(tracemoeProvider.available(ctx())).toBe(true);
    expect(tracemoeProvider.available(ctx({ search: { reverse_image: { enabled: false } } }))).toBe(true);
  });

  it("SauceNAO available 取决于 secrets 中的 api_key", () => {
    expect(saucenaoProvider.available(ctx())).toBe(false);
    expect(
      saucenaoProvider.available(
        ctx({}, { search: { reverse_image: { saucenao: { api_key: "  " } } } }),
      ),
    ).toBe(false);
    expect(
      saucenaoProvider.available(
        ctx({}, { search: { reverse_image: { saucenao: { api_key: "abc" } } } }),
      ),
    ).toBe(true);
  });

  it("反向图搜 provider 的 runtime kind 正确，微博为 search", () => {
    for (const name of ["tracemoe", "saucenao", "baidu"]) {
      expect(engineProvider("gateway.reverse_image", name)!.runtime!.kind).toBe("reverse_image");
    }
    expect(weiboProvider.runtime!.kind).toBe("search");
  });

  it("微博 plan：热搜优先、普通类别命中", () => {
    const providerCtx = ctx({
      search: { weibo: { category: "weibo", hot_category: "weibo_hot" } },
    });
    const runtime = weiboProvider.runtime;
    if (!runtime || runtime.kind !== "search") throw new Error("weibo runtime 必须是 search");
    expect(runtime.plan("weibo_hot", providerCtx)).toEqual({ hot: true });
    expect(runtime.plan("weibo", providerCtx)).toEqual({ hot: false });
    expect(runtime.plan("weibo,weibo_hot", providerCtx)).toEqual({ hot: true });
    expect(runtime.plan("general", providerCtx)).toBeUndefined();
    expect(runtime.plan(undefined, providerCtx)).toBeUndefined();
  });
});
