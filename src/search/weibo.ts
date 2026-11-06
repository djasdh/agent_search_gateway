/**
 * 微博搜索/热搜源（ADR-0014）：网关侧文本源，直接调 OpenCLI，
 * 不经过 searxng，也不把 `weibo` 类别转发给 searxng。
 */

import { Semaphore } from "../utils/semaphore.js";
import { runOpencli } from "../weibo/cli.js";
import { WeiboError } from "../weibo/types.js";
import type { SearxngResult } from "./searxng.js";

export interface WeiboSearchOptions {
  limit: number;
  timeoutMs: number;
  /** 空结果重试次数（不含首次）；微博搜索页面异步加载，首跑经常为空。 */
  retry: number;
  cacheTtlMs: number;
}

export interface WeiboSourceError {
  kind: "timeout" | "network" | "api" | "auth";
  message: string;
}

export type WeiboSourceResult =
  | { ok: true; results: SearxngResult[]; latencyMs: number }
  | { ok: false; error: WeiboSourceError; latencyMs: number };

const CACHE_MAX = 100;
const RETRY_DELAY_MS = 1000;
const CLI_TIMEOUT_SLACK_MS = 5000;

/** 微博 CLI 是浏览器操作，串行执行，避免多个搜索同时抢一个登录态。 */
const cliSem = new Semaphore(1);

interface CacheEntry {
  at: number;
  value: WeiboSourceResult;
}

const cache = new Map<string, CacheEntry>();

function cacheGet(key: string, ttlMs: number): WeiboSourceResult | undefined {
  if (ttlMs <= 0) return undefined;
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > ttlMs) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key: string, value: WeiboSourceResult): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), value });
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const str = (row: Record<string, unknown>, key: string): string => {
  const value = row[key];
  return typeof value === "string" ? value : "";
};

const num = (row: Record<string, unknown>, key: string): number | undefined => {
  const value = row[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

/** 去掉微博 URL 上的跟踪参数（search 结果常带 refer_flag）。 */
export function stripWeiboRefer(url: string): string {
  try {
    const u = new URL(url);
    for (const key of ["refer_flag", "refer_from", "from", "sudaref"]) u.searchParams.delete(key);
    return u.toString();
  } catch {
    return url;
  }
}

function rankScore(rank: number): number {
  return Math.max(0.5, 1 - (rank - 1) * 0.02);
}

/** `weibo search` 行 → 通用搜索结果。 */
export function mapWeiboSearchRows(raw: unknown, limit: number): SearxngResult[] {
  if (!Array.isArray(raw)) return [];
  const out: SearxngResult[] = [];
  for (let i = 0; i < raw.length && out.length < limit; i++) {
    const row = asRecord(raw[i]);
    if (!row) continue;
    const url = stripWeiboRefer(str(row, "url"));
    const text = str(row, "title");
    if (!url || !text) continue;
    const rank = num(row, "rank") ?? i + 1;
    const author = str(row, "author");
    const time = str(row, "time");
    out.push({
      url,
      title: `${author ? `@${author}：` : ""}${text.slice(0, 60)}`,
      content: [text, author ? `作者：${author}` : "", time ? `时间：${time}` : ""].filter(Boolean).join("\n\n"),
      engine: "weibo",
      score: rankScore(rank),
    });
  }
  return out;
}

/** `weibo hot` 行 → 通用搜索结果。 */
export function mapWeiboHotRows(raw: unknown, limit: number): SearxngResult[] {
  if (!Array.isArray(raw)) return [];
  const out: SearxngResult[] = [];
  for (let i = 0; i < raw.length && out.length < limit; i++) {
    const row = asRecord(raw[i]);
    if (!row) continue;
    const url = str(row, "url");
    const word = str(row, "word");
    if (!url || !word) continue;
    const rank = num(row, "rank") ?? i + 1;
    const hotValue = num(row, "hot_value");
    const category = str(row, "category");
    const label = str(row, "label");
    out.push({
      url,
      title: `#${rank} ${word}${hotValue ? `（热度 ${hotValue}）` : ""}`,
      content: [category, label].filter(Boolean).join("｜"),
      engine: "weibo_hot",
      score: rankScore(rank),
    });
  }
  return out;
}

function mapError(err: unknown): WeiboSourceError {
  if (err instanceof WeiboError) {
    if (err.code === "WEIBO_TIMEOUT") return { kind: "timeout", message: err.message };
    if (err.code === "WEIBO_AUTH_REQUIRED") return { kind: "auth", message: err.message };
    return { kind: "api", message: err.message };
  }
  return { kind: "network", message: err instanceof Error ? err.message : String(err) };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** OpenCLI 的“没有结果”既可能是退出码 66，也可能是 NOT_FOUND 信封。 */
function isNoResult(err: unknown): boolean {
  if (!(err instanceof WeiboError)) return false;
  if (err.code === "WEIBO_EMPTY") return true;
  return /NOT_FOUND|No Weibo search results|No Weibo posts/i.test(err.message);
}

interface RunOptions {
  args: string[];
  what: string;
  opts: WeiboSearchOptions;
  map: (raw: unknown, limit: number) => SearxngResult[];
}

/** 执行 + 空结果重试；重试耗尽仍为空时返回空列表而不是错误。 */
async function runWeiboSource(
  command: string,
  run: RunOptions,
): Promise<WeiboSourceResult> {
  const start = Date.now();
  for (let attempt = 0; attempt <= run.opts.retry; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS);
    try {
      const raw = await runOpencli<unknown>(
        command,
        run.args,
        run.opts.timeoutMs + CLI_TIMEOUT_SLACK_MS,
        run.what,
      );
      return {
        ok: true,
        results: run.map(raw, run.opts.limit),
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      if (isNoResult(err) && attempt < run.opts.retry) continue;
      if (isNoResult(err)) {
        return { ok: true, results: [], latencyMs: Date.now() - start };
      }
      return { ok: false, error: mapError(err), latencyMs: Date.now() - start };
    }
  }
  // 逻辑上不可达：循环要么返回、要么抛错。
  return { ok: true, results: [], latencyMs: Date.now() - start };
}

/** 关键词搜索：只搜微博帖子。 */
export async function searchWeibo(
  query: string,
  opts: WeiboSearchOptions,
  command: string,
): Promise<WeiboSourceResult> {
  const key = `search|${query}|${opts.limit}`;
  const cached = cacheGet(key, opts.cacheTtlMs);
  if (cached) return cached;

  const release = await cliSem.acquire();
  try {
    const result = await runWeiboSource(command, {
      args: ["weibo", "search", query, "--limit", String(opts.limit)],
      what: "weibo search",
      opts,
      map: mapWeiboSearchRows,
    });
    if (result.ok) cacheSet(key, result);
    return result;
  } finally {
    release();
  }
}

/** 热搜榜：不需要关键词。 */
export async function searchWeiboHot(
  opts: WeiboSearchOptions,
  command: string,
): Promise<WeiboSourceResult> {
  const key = `hot|${opts.limit}`;
  const cached = cacheGet(key, opts.cacheTtlMs);
  if (cached) return cached;

  const release = await cliSem.acquire();
  try {
    const result = await runWeiboSource(command, {
      args: ["weibo", "hot", "--limit", String(opts.limit)],
      what: "weibo hot",
      opts,
      map: mapWeiboHotRows,
    });
    if (result.ok) cacheSet(key, result);
    return result;
  } finally {
    release();
  }
}
