/**
 * 取件插件注册表默认实例。
 *
 * `directFetch` 入口先查此表：命中即交给插件（跳过 SSRF 与 generic 重定向链），
 * 未命中才走通用抓取。新增内置插件时只在这里注册，核心路径不改。
 * 当前注册：`cnki`（知网取件，见 ADR-0009）、`bilibili`（B 站视频/专栏自动摘要）、
 * `weibo`（微博取件，单 CLI 后端 OpenCLI + 图片 CDN 自动匹配）。
 */
import { bilibiliPlugin } from "../../bilibili/index.js";
import { weiboPlugin } from "../../weibo/index.js";
import { cnkiPlugin } from "./cnki.js";
import { createFetchPluginRegistry } from "./registry.js";
import type { FetchPlugin, FetchPluginContext } from "./types.js";

export type {
  FetchPlugin,
  FetchPluginContext,
  FetchPluginRequirement,
  FetchPluginResult,
} from "./types.js";

export const fetchPluginRegistry = createFetchPluginRegistry([
  cnkiPlugin,
  bilibiliPlugin,
  weiboPlugin,
]);

/** 返回接管该 URL 的插件（已统一过滤 `enabled`，按注册顺序取第一个命中者）。 */
export function findPlugin(url: URL, ctx: FetchPluginContext): FetchPlugin | undefined {
  return fetchPluginRegistry.find(url, ctx);
}

/** 已注册插件的规范 ID（供 health / 日志使用）。 */
export function registeredPlugins(): string[] {
  return fetchPluginRegistry.list().map((plugin) => plugin.id);
}
