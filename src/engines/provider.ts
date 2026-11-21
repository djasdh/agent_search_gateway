/**
 * 网关原生引擎的 provider 协议：CLI（元数据）与运行期（调用）共用同一份定义。
 *
 * 新增一个网关原生引擎 = 新建 `providers/<name>.ts` + 在 `registry.ts` 加一行，
 * CLI 的 `asg engines` 与运行期搜索分发都会自动看到它。
 */

import type { PluginBackends } from "../extensions/paths.js";
import type { Logger } from "../logger.js";
import type { ImageInput, SourceCall } from "../search/sources.js";
import type { SearxngResult } from "../search/searxng.js";
import type { EngineGroup, EngineKind } from "./types.js";

export interface EngineProviderContext {
  /** 与 gateway.yaml 同形的配置切片。CLI 传原始 configPlain；运行期传 { search, weibo }。 */
  config: Record<string, unknown>;
  /** 与 secrets.yaml 同形的密钥切片。 */
  secrets: Record<string, unknown>;
  /** 第三方 search 插件的私有配置（extensions.<manifest id>.config，已补默认值）。 */
  pluginConfig?: Readonly<Record<string, unknown>>;
  /** 第三方 search 插件密钥（extensions.<id>.<name>，已解析，空值不注入）。 */
  pluginSecrets?: Record<string, string>;
  /** 第三方 search 插件自己安装的后端；V2 manifest 声明 backends 时注入。 */
  pluginBackends?: PluginBackends;
  logger?: Logger;
}

export interface GatewaySearchPlan {
  /** true = 热搜/热榜类查询，不需要关键词。 */
  hot: boolean;
}

export interface GatewaySearchOptions {
  hot: boolean;
  limit: number;
}

export interface GatewaySearchError {
  kind: "timeout" | "network" | "api" | "auth" | "invalid";
  message: string;
}

export type GatewaySearchResult =
  | { ok: true; results: SearxngResult[]; latencyMs: number }
  | { ok: false; error: GatewaySearchError; latencyMs: number };

export interface ReverseImageRuntime {
  kind: "reverse_image";
  search(input: ImageInput, ctx: EngineProviderContext): Promise<SourceCall>;
}

export interface GatewayUpstreamOptions {
  limit: number;
  minScore?: number;
  language?: string;
  safeSearch?: string;
}

/**
 * 通用上游：与 searxng 并发的「通用搜索」源。
 *
 * `minScore` 由 provider 在源内处理：raw 按官方分过滤，harness 无原始分时忽略；
 * 服务层不对上游结果做全局 minScore 过滤。
 */
export interface GatewayUpstreamRuntime {
  kind: "upstream";
  search(
    query: string,
    options: GatewayUpstreamOptions,
    ctx: EngineProviderContext,
  ): Promise<GatewaySearchResult>;
}

export interface GatewaySearchRuntime {
  kind: "search";
  /** 类别命中时返回计划；不命中返回 undefined。 */
  plan(categories: string | undefined, ctx: EngineProviderContext): GatewaySearchPlan | undefined;
  search(
    query: string,
    options: GatewaySearchOptions,
    ctx: EngineProviderContext,
  ): Promise<GatewaySearchResult>;
}

export type EngineRuntime = ReverseImageRuntime | GatewaySearchRuntime | GatewayUpstreamRuntime;

export interface EngineProvider {
  /** `${group}:${name}` */
  id: string;
  /** 第三方 search 插件对应的 manifest id（安装目录名）；内置 provider 不设置。 */
  pluginId?: string;
  group: EngineGroup;
  name: string;
  kind: EngineKind;
  displayName: string;
  routing(ctx: EngineProviderContext): string[];
  requires?: string[];
  /**
   * 0.4.0+ 优先使用的依赖声明；0.3.x 仍读 `requires`。
   * 与 `requires` 并存是官方 weibo 0.2.2 的过渡形态。
   */
  requiresV2?: readonly string[];
  /** 前置条件是否满足（密钥 / 上游能力开关）；不包含引擎自身的 enabled。 */
  available(ctx: EngineProviderContext): boolean;
  /** 引擎自身的启用状态；缺省视为 true（如以图搜图源由 sources 数组决定）。 */
  enabled?(ctx: EngineProviderContext): boolean;
  /** gateway.search / gateway.upstream 源的启用布尔值在 gateway.yaml 中的路径；由 GatewayStore 写回。 */
  enabledPath?: readonly string[];
  /**
   * 0.4.0+ 优先使用的启用路径；0.3.x 仍读 `enabledPath`。
   * 与 `enabledPath` 并存是官方 weibo 0.2.2 的过渡形态。
   */
  enabledPathV2?: readonly string[];
  runtime?: EngineRuntime;
  /** auth 错误时追加的提示，如微博需要登录。 */
  authHint?: string;
}
