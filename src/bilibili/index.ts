/** Bilibili fetch 插件：URL 的 bili= 选动作，内部按能力路由到 CLI/HTTP 后端。 */

import { resolve } from "node:path";
import type { GatewayConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { FetchPlugin, FetchPluginContext, FetchPluginResult } from "../fetch/plugins/types.js";
import { downloadStream } from "./download.js";
import { isBilibiliUrl, parseBiliRequest, resolveShortLink } from "./parse.js";
import { createRouter } from "./router.js";
import type { BiliRouter } from "./router.js";
import { createCommentStore } from "./store.js";
import { BiliError } from "./types.js";
import type { BiliAttempt, BiliCommentStore, MediaKind } from "./types.js";

const BUDGET_MS = 60_000;
const routers = new WeakMap<GatewayConfig, BiliRouter>();
const stores = new Map<string, BiliCommentStore>();

function routerFor(config: GatewayConfig, logger?: Logger): BiliRouter {
  let r = routers.get(config);
  if (!r) routers.set(config, (r = createRouter(config, logger)));
  return r;
}

function storeFor(config: GatewayConfig, logger?: Logger): BiliCommentStore {
  const key = resolve(config.bilibili.commentDb);
  let s = stores.get(key);
  if (!s) stores.set(key, (s = createCommentStore(config.bilibili.commentDb, logger)));
  return s;
}

const text = (body: string, contentType: string, finalUrl: string): FetchPluginResult => ({
  ok: true, status: 200, contentType, finalUrl, bytes: Buffer.from(body, "utf8"),
});

const fail = (code: string, message: string, finalUrl?: string): FetchPluginResult => ({
  ok: false, finalUrl, errorCode: code, errorMessage: message,
});

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function formatAttempts(attempts: BiliAttempt[]): string {
  return attempts.length === 0
    ? ""
    : `\n\n尝试记录：\n${attempts.map((a) => `- ${a.backend}：${a.ok ? "ok" : `[${a.code ?? "UNKNOWN"}] ${a.error ?? ""}`}`).join("\n")}`;
}

function attemptsOf(err: BiliError): BiliAttempt[] {
  const raw = err.detail?.attempts;
  return Array.isArray(raw) ? (raw as BiliAttempt[]) : [];
}

async function comments(parsed: ReturnType<typeof parseBiliRequest>, url: URL, config: GatewayConfig, logger?: Logger) {
  const bvid = parsed.ref.bvid!;
  const router = routerFor(config, logger);
  const store = storeFor(config, logger);
  const maxPages = parsed.all ? config.bilibili.comments.maxPagesPerCall : 1;
  const deadline = Date.now() + BUDGET_MS;
  const attempts: BiliAttempt[] = [];
  let cursor = parsed.page;
  let fetched = 0;
  let count = 0;
  let total: number | undefined;
  let hasMore = false;
  let nextPage: number | undefined;

  while (fetched < maxPages) {
    if (fetched > 0 && Date.now() >= deadline) break;
    let page: Awaited<ReturnType<BiliRouter["comments"]>>;
    try {
      page = await router.comments(parsed.ref, { page: cursor, sort: parsed.sort });
    } catch (err) {
      if (fetched === 0) throw err;
      if (err instanceof BiliError) attempts.push(...(attemptsOf(err).length ? attemptsOf(err) : [{ backend: "(route)", ok: false, code: err.code, error: err.message }]));
      break;
    }
    attempts.push(...page.attempts);
    store.upsertPage({ bvid: page.value.bvid || bvid, page: cursor, items: page.value.items, hasMore: page.value.hasMore });
    fetched++;
    count += page.value.items.length;
    total = page.value.total ?? total;
    hasMore = page.value.hasMore;
    nextPage = hasMore ? page.value.nextPage ?? cursor + 1 : undefined;
    if (!parsed.all || !hasMore || !nextPage || nextPage <= cursor) break;
    cursor = nextPage;
  }

  const payload = { bvid, page: parsed.page, count, total: total ?? store.count(bvid), fetched, has_more: hasMore, next_page: nextPage, attempts };
  return text(JSON.stringify(payload, null, 2), "application/json", url.toString());
}

async function handle(parsed: ReturnType<typeof parseBiliRequest>, url: URL, config: GatewayConfig, logger?: Logger) {
  const router = routerFor(config, logger);
  switch (parsed.action) {
    case "comments_search": {
      const items = storeFor(config, logger).search(parsed.ref.bvid!, parsed.query!, {
        mid: Number(url.searchParams.get("mid")) || undefined,
        limit: config.bilibili.comments.searchLimit,
      });
      return text(JSON.stringify({ bvid: parsed.ref.bvid, keyword: parsed.query, count: items.length, items }, null, 2), "application/json", url.toString());
    }
    case "comments":
      return comments(parsed, url, config, logger);
    case "detail": {
      const { value, attempts } = await router.detail(parsed.ref);
      return text(JSON.stringify({ ...value, attempts }, null, 2), "application/json", url.toString());
    }
    case "article": {
      const { value } = await router.article(parsed.ref);
      return text(`# ${value.title?.trim() || `cv${value.cv}`}\n\n${value.content.trim()}`, "text/markdown", url.toString());
    }
    case "media": {
      const kind: MediaKind = parsed.kind ?? "video";
      const { value } = await router.media(parsed.ref, { kind, quality: parsed.quality });
      const got = await downloadStream(value, config, logger);
      return { ok: true, status: 200, contentType: got.contentType, finalUrl: url.toString(), bytes: got.bytes };
    }
  }
}

async function fetchBilibili(url: URL, ctx: FetchPluginContext): Promise<FetchPluginResult> {
  const { config, logger } = ctx;
  if (!config.bilibili?.enabled) return fail("BILI_UNAVAILABLE", "bilibili 插件未启用（bilibili.enabled=false）。", url.toString());
  try {
    const short = url.hostname === "b23.tv" || url.hostname.endsWith(".b23.tv");
    const target = short ? await resolveShortLink(url) : url;
    for (const [k, v] of url.searchParams) if (!target.searchParams.has(k)) target.searchParams.set(k, v);
    return await handle(parseBiliRequest(target, config), target, config, logger);
  } catch (err) {
    if (err instanceof BiliError) {
      const hint = err.hint ? `\n处理：${err.hint}` : "";
      return fail(err.code, err.message + hint + formatAttempts(attemptsOf(err)), url.toString());
    }
    logger?.debug(`bilibili: 未预期异常 ${errorText(err)}`);
    return fail("BILI_UNAVAILABLE", `Bilibili 抓取失败：${errorText(err)}`, url.toString());
  }
}

export const bilibiliPlugin: FetchPlugin = {
  name: "bilibili",
  match: (url) => isBilibiliUrl(url) && url.searchParams.has("bili"),
  fetch: fetchBilibili,
};

export function closeBilibiliStores(): void {
  for (const store of stores.values()) store.close();
  stores.clear();
}
