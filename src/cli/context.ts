/** 命令上下文与统一返回类型。 */

import type { Reporter } from "./output.js";

export interface CommandResult {
  data: unknown;
  /** 人类可读输出；缺省时打印 JSON。 */
  human?: string;
  /** 覆盖 result.ok；doctor 之类的“报告型”命令用。 */
  ok?: boolean;
  /** 覆盖进程退出码；未提供时为 0。 */
  exitCode?: number;
}

export interface Ctx {
  root: string;
  reporter: Reporter;
  /** 子命令之后的原始参数，由各命令自行解析。 */
  rest: string[];
}

export type CommandFn = (ctx: Ctx) => Promise<CommandResult>;
