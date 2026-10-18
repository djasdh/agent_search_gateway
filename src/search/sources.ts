import type { SearxngResult } from "./searxng.js";

/**
 * 反向图搜「附加源」的统一契约（ADR-0012）。
 *
 * 每个源（trace.moe / SauceNAO / 百度识图…）无论底层是 URL 还是文件上传、
 * 是官方 API 还是抓网页，都收敛成同一形状：要么给出 `SearxngResult[]` 候选，
 * 要么给出一个结构化错误。service 侧据此并发扇出、逐源降级、合并去重。
 */

/** 源错误分类（与 searxng 调用同风格；`api` = HTTP 200 但业务报错）。 */
export interface SourceError {
  kind: "timeout" | "http" | "network" | "invalid_json" | "api";
  status?: number;
  message: string;
}

/** 源侧剩余额度（目前仅 SauceNAO 提供：每 30 秒 / 每日）。 */
export interface SourceRemaining {
  short?: number;
  long?: number;
}

export interface SourceCallOk {
  ok: true;
  results: SearxngResult[];
  latencyMs: number;
  /** 配额上限（trace.moe 的每日额度）——仅用于提示。 */
  quota?: number;
  quotaUsed?: number;
  /** 剩余额度（SauceNAO）。 */
  remaining?: SourceRemaining;
}

export interface SourceCallFail {
  ok: false;
  error: SourceError;
}

export type SourceCall = SourceCallOk | SourceCallFail;

/** 交给附加源的「图」：公网 URL，或本地字节（后者不经图床直传）。 */
export type ImageInput =
  | { kind: "url"; url: string }
  | { kind: "bytes"; bytes: Uint8Array; filename: string; mime: string };

/** `fetch` 抛错 → 统一错误分类（超时 vs 网络）。 */
export function classifyFetchError(err: unknown, timeoutMs: number, label: string): SourceError {
  const name = (err as Error)?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return { kind: "timeout", message: `${label} 请求超时 (>${timeoutMs}ms)` };
  }
  return { kind: "network", message: err instanceof Error ? err.message : String(err) };
}
