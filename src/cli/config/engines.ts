/**
 * 统一引擎目录的兼容门面：实现拆到 `src/cli/engines/`。
 *
 * 对外保留旧的导出名与语义，命令层与测试继续从这里导入。
 */

export type {
  EngineKind,
  EngineSource,
  EngineGroup,
  EngineRecord,
} from "../engines/types.js";

import type { EngineRecord } from "../engines/types.js";

export type EngineInfo = EngineRecord;

export type SetEnginesResult = { changed: string[] };

export { readLocalEngines, listEngines, setEngines, parseEngineRef } from "../engines/catalog.js";
