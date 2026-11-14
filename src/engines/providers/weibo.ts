/** 微博引擎 provider：网关侧文本源（帖子搜索 + 热搜），不经过 searxng。 */

import type { EngineProvider, EngineProviderContext } from "../provider.js";
import { asObject, nonEmptyString, numberOr } from "../values.js";
import { hasCategory } from "../../search/category.js";
import { searchWeibo, searchWeiboHot } from "../../search/weibo.js";

const DEFAULT_COMMAND = "opencli";

function commandOf(ctx: EngineProviderContext): string {
  const raw = asObject(asObject(ctx.config.weibo).cli).command;
  // 只有「缺省」才回落到 opencli；显式空串表示未配置可用命令。
  if (raw === undefined) return DEFAULT_COMMAND;
  return typeof raw === "string" ? raw.trim() : "";
}

function searchWeiboConfig(ctx: EngineProviderContext): Record<string, unknown> {
  return asObject(asObject(ctx.config.search).weibo);
}

function categoriesOf(ctx: EngineProviderContext): { category: string; hotCategory: string } {
  const weibo = searchWeiboConfig(ctx);
  return {
    category: nonEmptyString(weibo.category) ?? "weibo",
    hotCategory: nonEmptyString(weibo.hot_category) ?? "weibo_hot",
  };
}

export const weiboProvider: EngineProvider = {
  id: "gateway.search:weibo",
  group: "gateway.search",
  name: "weibo",
  kind: "gateway",
  displayName: "微博",
  authHint: "在 Chrome 登录 weibo.com 后重试。",
  requires: ["config:weibo.enabled"],
  enabledPath: ["search", "weibo", "enabled"],
  routing: (ctx) => {
    const { category, hotCategory } = categoriesOf(ctx);
    return [`category:${category}`, `category:${hotCategory}`];
  },
  available: (ctx) => {
    if (asObject(ctx.config.weibo).enabled !== true) return false;
    return commandOf(ctx).length > 0;
  },
  enabled: (ctx) => searchWeiboConfig(ctx).enabled === true,
  runtime: {
    kind: "search",
    plan(categories, ctx) {
      const { category, hotCategory } = categoriesOf(ctx);
      const hot = hasCategory(categories, hotCategory);
      const only = !hot && hasCategory(categories, category);
      return hot || only ? { hot } : undefined;
    },
    search(query, options, ctx) {
      const config = searchWeiboConfig(ctx);
      const opts = {
        limit: options.limit,
        timeoutMs: numberOr(config.timeout_ms, 30_000),
        retry: numberOr(config.retry, 1),
        cacheTtlMs: numberOr(config.cache_ttl_ms, 60_000),
      };
      const command = commandOf(ctx);
      return options.hot ? searchWeiboHot(opts, command) : searchWeibo(query, opts, command);
    },
  },
};
