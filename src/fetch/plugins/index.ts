/**
 * 取件插件注册表默认实例。
 *
 * `directFetch` 入口先查此表：命中即交给插件（跳过 SSRF 与 generic 重定向链），
 * 未命中才走通用抓取。核心不内置平台实现；平台能力由 `data/extensions`
 * 下的外部插件提供，启动时注入合并后的注册表。
 */
import { createFetchPluginRegistry, type FetchPluginRegistry } from "./registry.js";
import type { FetchPlugin, FetchPluginContext } from "./types.js";

export type {
  FetchPlugin,
  FetchPluginContext,
  FetchPluginRequirement,
  FetchPluginResult,
} from "./types.js";

/** 内置抓取插件：核心不再内置平台实现，保留空数组供测试/兼容使用。 */
export const builtinPlugins: readonly FetchPlugin[] = [];

export const fetchPluginRegistry = createFetchPluginRegistry(builtinPlugins);

/** 合并外部插件并做重复 id 校验。 */
export function createFetchRegistry(external: readonly FetchPlugin[]): FetchPluginRegistry {
  return createFetchPluginRegistry(external);
}

/** 返回接管该 URL 的插件（已统一过滤 `enabled`，按注册顺序取第一个命中者）。 */
export function findPlugin(url: URL, ctx: FetchPluginContext): FetchPlugin | undefined {
  return fetchPluginRegistry.find(url, ctx);
}

/** 已注册插件的规范 ID（供 health / 日志使用）。 */
export function registeredPlugins(): string[] {
  return fetchPluginRegistry.list().map((plugin) => plugin.id);
}
