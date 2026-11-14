/**
 * 引擎对象统一抽象：一次 list/plan 在各存储适配器间共享的契约。
 *
 * - `EngineGroup` 是引擎的归属：searxng 引擎、网关以图搜图源、网关文本源；
 * - `EngineRecord` 是面向用户的一条引擎视图（id 稳定为 `${group}:${name}`）；
 * - `EngineStore` 只负责「读列表」与「算写入计划」，不直接落盘。
 */

import type { LoadedDocument } from "../config/gateway.js";
import type { SearxngEngineState } from "../config/searxng.js";
import type { RootPaths } from "../root.js";

export type EngineKind = "searxng" | "gateway";

/** 仅 `list --all`：该引擎来自本地文件还是 searxng 默认全量列表。 */
export type EngineSource = "default" | "local";

export type EngineGroup = "searxng" | "gateway.reverse_image" | "gateway.search";

export interface EngineRecord {
  /** `${group}:${name}` */
  id: string;
  group: EngineGroup;
  name: string;
  kind: EngineKind;
  enabled: boolean;
  available: boolean;
  routing: string[];
  requires?: string[];
  source?: EngineSource;
}

export interface EngineChange {
  group: EngineGroup;
  name: string;
  enabled: boolean;
}

export interface EngineWrite {
  path: string;
  text: string;
}

export interface EnginePlan {
  /** 实际发生变化的 canonical id。 */
  changed: string[];
  writes: EngineWrite[];
}

export interface EngineContext {
  paths: RootPaths;
  config: LoadedDocument;
  configPlain: Record<string, unknown>;
  secrets: Record<string, unknown>;
  searxng: SearxngEngineState[];
  searxngUrl: string;
}

export interface EngineStore {
  /** "searxng" | "gateway.yaml" */
  readonly id: string;
  readonly groups: readonly EngineGroup[];
  list(ctx: EngineContext): EngineRecord[];
  listAll?(ctx: EngineContext): Promise<EngineRecord[]>;
  plan(changes: readonly EngineChange[], ctx: EngineContext): EnginePlan;
}
