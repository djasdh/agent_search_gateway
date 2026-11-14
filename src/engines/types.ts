/**
 * 引擎对象统一抽象（CLI 与运行期共享）：一次 list/plan 的公共类型。
 *
 * - `EngineGroup` 是引擎的归属：searxng 引擎、网关以图搜图源、网关文本源；
 * - `EngineRecord` 是面向用户的一条引擎视图（id 稳定为 `${group}:${name}`）。
 */

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
