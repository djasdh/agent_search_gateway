/**
 * 取件插件注册表。
 *
 * `directFetch` 入口先查此表：命中即交给插件（跳过 SSRF 与 generic 重定向链），
 * 未命中才走通用抓取。**当前为空**——CNKI 取件插件在 S7 加入
 * （见 docs/cnki-channel.md §5 改动点 8）。
 *
 * 新增插件时只在这里注册，核心路径不改。
 */
import type { FetchPlugin } from "./types.js";

export type { FetchPlugin, FetchPluginContext, FetchPluginResult } from "./types.js";

const plugins: FetchPlugin[] = [];

/** 返回接管该 URL 的插件（按注册顺序取第一个命中者）。 */
export function findPlugin(url: URL): FetchPlugin | undefined {
  for (const p of plugins) {
    try {
      if (p.match(url)) return p;
    } catch {
      /* 插件 match 抛错视为不接管，不影响通用路径 */
    }
  }
  return undefined;
}

/** 已注册插件名（供 health / 日志使用）。 */
export function registeredPlugins(): string[] {
  return plugins.map((p) => p.name);
}
