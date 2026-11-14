/**
 * 网关原生引擎的 provider 协议：CLI（元数据）与运行期（调用）共用同一份定义。
 *
 * 新增一个网关原生引擎 = 新建 `providers/<name>.ts` + 在 `registry.ts` 加一行，
 * CLI 的 `asg engines` 与运行期搜索分发都会自动看到它。
 */

import type { Logger } from "../logger.js";
import type { ImageInput, SourceCall } from "../search/sources.js";
import type { SearxngResult } from "../search/searxng.js";
import type { EngineGroup, EngineKind } from "./types.js";

export interface EngineProviderContext {
  /** 与 gateway.yaml 同形的配置切片。CLI 传原始 configPlain；运行期传 { search, weibo }。 */
  config: Record<string, unknown>;
  /** 与 secrets.yaml 同形的密钥切片。 */
  secrets: Record<string, unknown>;
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

export type EngineRuntime = ReverseImageRuntime | GatewaySearchRuntime;

export interface EngineProvider {
  /** `${group}:${name}` */
  id: string;
  group: EngineGroup;
  name: string;
  kind: EngineKind;
  displayName: string;
  routing(ctx: EngineProviderContext): string[];
  requires?: string[];
  /** 前置条件是否满足（密钥 / 上游能力开关）；不包含引擎自身的 enabled。 */
  available(ctx: EngineProviderContext): boolean;
  /** 引擎自身的启用状态；缺省视为 true（如以图搜图源由 sources 数组决定）。 */
  enabled?(ctx: EngineProviderContext): boolean;
  /** gateway.search 源的启用布尔值在 gateway.yaml 中的路径；由 GatewayStore 写回。 */
  enabledPath?: readonly string[];
  runtime?: EngineRuntime;
  /** auth 错误时追加的提示，如微博需要登录。 */
  authHint?: string;
}
