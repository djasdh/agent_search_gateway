/**
 * 取件 provider 注册表。
 *
 * `find` 按注册顺序找第一个命中者：
 * 1. `enabled(ctx)` 存在且返回 false → 跳过（回退通用抓取）；
 * 2. `match(url)` 返回 false → 跳过；
 * 3. `enabled` / `match` 抛错 → 跳过（不影响后续 provider 与通用路径）。
 *
 * `available(ctx)` 只服务维护面，不参与 `find`。
 */
import type { FetchProvider, FetchProviderContext } from "./types.js";

export interface FetchProviderRegistry {
  find(url: URL, ctx: FetchProviderContext): FetchProvider | undefined;
  list(): readonly FetchProvider[];
}

export function createFetchProviderRegistry(
  providers: readonly FetchProvider[],
): FetchProviderRegistry {
  const seen = new Set<string>();
  for (const provider of providers) {
    if (seen.has(provider.id)) throw new Error(`重复的抓取 provider id: ${provider.id}`);
    seen.add(provider.id);
  }

  const ordered: readonly FetchProvider[] = [...providers];

  return {
    find(url: URL, ctx: FetchProviderContext): FetchProvider | undefined {
      for (const provider of ordered) {
        try {
          if (provider.enabled && !provider.enabled(ctx)) continue;
          if (!provider.match(url)) continue;
        } catch {
          continue;
        }
        return provider;
      }
      return undefined;
    },
    list(): readonly FetchProvider[] {
      return ordered;
    },
  };
}
