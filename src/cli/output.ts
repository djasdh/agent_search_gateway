/** 输出层：唯一允许写 stdout 的模块。 */

export type Mode = "human" | "json" | "jsonl";

export interface ErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

export interface ResultPayload {
  schema_version: 1;
  ok: boolean;
  command: string;
  data?: unknown;
  error?: ErrorPayload;
}

export class Reporter {
  readonly mode: Mode;

  constructor(options: { json: boolean; jsonl: boolean }) {
    this.mode = options.jsonl ? "jsonl" : options.json ? "json" : "human";
  }

  /** 最终结果：json 模式恰好一行；human 模式打印可读文本。 */
  result(payload: ResultPayload, human?: string): void {
    if (this.mode === "json") {
      process.stdout.write(`${JSON.stringify(payload)}\n`);
      return;
    }
    if (this.mode === "jsonl") {
      process.stdout.write(`${JSON.stringify(payload)}\n`);
      return;
    }
    if (payload.ok) {
      if (human !== "") process.stdout.write(`${human ?? JSON.stringify(payload.data, null, 2)}\n`);
    } else {
      process.stderr.write(`错误 [${payload.error?.code}]: ${payload.error?.message}\n`);
    }
  }

  /** 长任务事件：仅 jsonl 写 stdout，其余模式写 stderr。 */
  event(event: Record<string, unknown>): void {
    if (this.mode === "jsonl") {
      process.stdout.write(`${JSON.stringify({ type: "event", schema_version: 1, ...event })}\n`);
      return;
    }
    const message = typeof event.message === "string" ? event.message : JSON.stringify(event);
    process.stderr.write(`${message}\n`);
  }

  /** 诊断信息：永远写 stderr，不污染 stdout。 */
  info(message: string): void {
    process.stderr.write(`${message}\n`);
  }

  /** 流式日志行：human 原样写 stdout；jsonl 包成 log 事件；json 模式由调用方改为返回 data。 */
  line(text: string, event: Record<string, unknown> = {}): void {
    if (this.mode === "jsonl") {
      process.stdout.write(
        `${JSON.stringify({ type: "event", schema_version: 1, event: "log", ...event, line: text })}\n`,
      );
      return;
    }
    process.stdout.write(`${text}\n`);
  }
}
