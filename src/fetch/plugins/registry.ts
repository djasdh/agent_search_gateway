/**
 * 取件插件注册表。
 *
 * `find` 按注册顺序找第一个命中者：
 * 1. `enabled(ctx)` 存在且返回 false → 跳过（回退通用抓取）；
 * 2. `match(url)` 返回 false → 跳过；
 * 3. `enabled` / `match` 抛错 → 跳过（不影响后续插件与通用路径）。
 *
 * `available(ctx)` 只服务维护面，不参与 `find`。
 */
import type { FetchPlugin, FetchPluginContext } from "./types.js";

export interface FetchPluginRegistry {
  find(url: URL, ctx: FetchPluginContext): FetchPlugin | undefined;
  list(): readonly FetchPlugin[];
}

export function createFetchPluginRegistry(plugins: readonly FetchPlugin[]): FetchPluginRegistry {
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (seen.has(plugin.id)) throw new Error(`重复的抓取插件 id: ${plugin.id}`);
    seen.add(plugin.id);
  }

  const ordered: readonly FetchPlugin[] = [...plugins];

  return {
    find(url: URL, ctx: FetchPluginContext): FetchPlugin | undefined {
      for (const plugin of ordered) {
        try {
          if (plugin.enabled && !plugin.enabled(ctx)) continue;
          if (!plugin.match(url)) continue;
        } catch {
          continue;
        }
        return plugin;
      }
      return undefined;
    },
    list(): readonly FetchPlugin[] {
      return ordered;
    },
  };
}
