/**
 * 引擎对象统一抽象：一次 list/plan 在各存储适配器间共享的契约。
 *
 * - 公共类型（kind / group / record）在 `src/engines/types.ts`，CLI 与运行期共用；
 * - `EngineStore` 只负责「读列表」与「算写入计划」，不直接落盘。
 */

import type { LoadedDocument } from "../config/gateway.js";
import type { SearxngEngineState } from "../config/searxng.js";
import type { RootPaths } from "../root.js";
import type { EngineGroup, EngineRecord } from "../../engines/types.js";

export type {
  EngineKind,
  EngineSource,
  EngineGroup,
  EngineRecord,
} from "../../engines/types.js";

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
