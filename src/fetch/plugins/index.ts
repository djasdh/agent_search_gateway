/**
 * 取件 provider 注册表默认实例。
 *
 * `directFetch` 入口先查此表：命中即交给 provider（跳过 SSRF 与 generic 重定向链），
 * 未命中才走通用抓取。核心不内置平台实现；平台能力由 `data/extensions`
 * 下的外部扩展提供，启动时注入合并后的注册表。
 */
import {
  createFetchProviderRegistry,
  type FetchProviderRegistry,
} from "./registry.js";
import type { FetchProvider, FetchProviderContext } from "./types.js";

export type {
  FetchProvider,
  FetchProviderContext,
  FetchProviderRequirement,
  FetchProviderResult,
} from "./types.js";
export { createFetchProviderRegistry };
export type { FetchProviderRegistry };

/** 内置抓取 provider：核心不再内置平台实现，保留空数组供测试/兼容使用。 */
export const builtinProviders: readonly FetchProvider[] = [];

export const fetchProviderRegistry = createFetchProviderRegistry(builtinProviders);

/** 返回接管该 URL 的 provider（已统一过滤 `enabled`，按注册顺序取第一个命中者）。 */
export function findProvider(
  url: URL,
  ctx: FetchProviderContext,
): FetchProvider | undefined {
  return fetchProviderRegistry.find(url, ctx);
}

/** 已注册 provider 的规范 ID（供 health / 日志使用）。 */
export function registeredProviders(): string[] {
  return fetchProviderRegistry.list().map((provider) => provider.id);
}
