/** Bilibili fetch 插件：按 URL 类型自动返回视频/专栏摘要，评论区锚点抓评论。 */

import { resolve } from "node:path";
import type { GatewayConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { FetchPlugin, FetchPluginContext, FetchPluginResult } from "../fetch/plugins/types.js";
import {
  isBiliContentUrl, isBilibiliUrl, isShortLink, parseBiliRequest, resolveShortLink,
} from "./parse.js";
import type { ParsedBili } from "./parse.js";
import { createRouter } from "./router.js";
import type { BiliRouter } from "./router.js";
import { createCommentStore } from "./store.js";
import { BiliError } from "./types.js";
import type {
  BiliArticle, BiliArticleSummary, BiliComment, BiliCommentStore, BiliDetail,
  BiliVideoSummary,
} from "./types.js";

const BUDGET_MS = 60_000;
const SAMPLE_SIZE = 20;
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

/** 对 agent 只暴露错误码含义，不暴露插件名/后端名/尝试链。 */
function publicError(err: BiliError): string {
  const hint = err.hint ? `（${err.hint}）` : "";
  switch (err.code) {
    case "BILI_AUTH_REQUIRED":
      return `需要登录${hint}`;
    case "BILI_RISK_CONTROL":
      return `B 站风控拦截${hint}`;
    case "BILI_CAPABILITY_UNSUPPORTED":
      return `当前后端不支持该动作${hint}`;
    case "BILI_INVALID_URL":
      return err.message;
    default:
      return `Bilibili 后端不可用${hint}`;
  }
}

export function buildVideoSummary(
  detail: BiliDetail,
  ref: { raw: string },
  audioUrl: string | null,
  audioError?: string,
): BiliVideoSummary {
  const summary: BiliVideoSummary = {
    kind: "video",
    title: detail.title,
    url: ref.raw,
    audio_url: audioUrl,
    cover_url: detail.cover,
    detail: {
      desc: detail.desc,
      owner: detail.owner,
      stat: detail.stat ?? {},
      current_page: detail.currentPage,
      page_count: detail.pageCount,
      pages: detail.pages,
    },
    comments_url: `${ref.raw}#reply`,
  };
  if (audioError) summary.audio_error = audioError;
  return summary;
}

export function buildArticleSummary(article: BiliArticle, ref: { raw: string }): BiliArticleSummary {
  const cover = typeof article.meta?.cover === "string" ? article.meta.cover : undefined;
  return {
    kind: "article",
    title: article.title?.trim() || `cv${article.cv}`,
    url: ref.raw,
    audio_url: null,
    cover_url: cover,
    detail: { content: article.content.trim() },
    comments_url: `${ref.raw}#comment`,
  };
}

const targetOf = (parsed: ParsedBili): string =>
  parsed.ref.bvid ?? (parsed.ref.cv ? `cv${parsed.ref.cv}` : parsed.ref.aid ? `av${parsed.ref.aid}` : "");

async function videoSummary(parsed: ParsedBili, config: GatewayConfig, logger?: Logger) {
  const router = routerFor(config, logger);
  const [detailResult, audioResult] = await Promise.allSettled([
    router.detail(parsed.ref),
    router.audio(parsed.ref),
  ]);
  if (detailResult.status === "rejected") throw detailResult.reason;
  const audioUrl = audioResult.status === "fulfilled" ? audioResult.value.value.url : null;
  const audioError = audioResult.status === "rejected"
    ? (audioResult.reason instanceof BiliError ? publicError(audioResult.reason) : "音频直链获取失败")
    : undefined;
  if (audioResult.status === "rejected") logger?.debug(`bilibili audio failed: ${errorText(audioResult.reason)}`);
  const summary = buildVideoSummary(detailResult.value.value, parsed.ref, audioUrl, audioError);
  return text(JSON.stringify(summary, null, 2), "application/json", parsed.ref.raw);
}

async function articleSummary(parsed: ParsedBili, config: GatewayConfig, logger?: Logger) {
  const { value } = await routerFor(config, logger).article(parsed.ref);
  return text(JSON.stringify(buildArticleSummary(value, parsed.ref), null, 2), "application/json", parsed.ref.raw);
}

async function comments(parsed: ParsedBili, config: GatewayConfig, logger?: Logger) {
  const target = targetOf(parsed);
  const store = storeFor(config, logger);

  if (parsed.action === "comments_search") {
    const items = store.search(target, parsed.query!, { limit: config.bilibili.comments.searchLimit });
    const payload = {
      kind: "comments_search", target, q: parsed.query, count: items.length, items,
      ...(items.length === 0 ? { hint: "本地暂无评论，先 fetch 评论区链接抓取全量" } : {}),
    };
    return text(JSON.stringify(payload, null, 2), "application/json", parsed.ref.raw);
  }

  const router = routerFor(config, logger);
  const maxPages = config.bilibili.comments.maxPagesPerFetch;
  const deadline = Date.now() + BUDGET_MS;
  const state = store.syncState(target);
  let cursor = state.finished ? 1 : state.nextPage;
  let pages = 0;
  let fetched = 0;
  let total: number | undefined;
  let hasMore = true;
  let error: string | undefined;
  const sample: BiliComment[] = [];

  while (pages < maxPages && Date.now() < deadline) {
    try {
      const { value } = await router.comments(parsed.ref, { page: cursor, sort: parsed.sort });
      store.upsertPage({ bvid: target, page: cursor, items: value.items, hasMore: value.hasMore });
      pages++;
      fetched += value.items.length;
      if (sample.length < SAMPLE_SIZE) sample.push(...value.items.slice(0, SAMPLE_SIZE - sample.length));
      total = value.total ?? total;
      hasMore = value.hasMore;
      const next = value.nextPage ?? cursor + 1;
      if (!hasMore || next <= cursor) break;
      cursor = next;
    } catch (err) {
      if (pages === 0) throw err;
      error = err instanceof BiliError ? publicError(err) : "评论抓取中断";
      logger?.debug(`bilibili comments failed: ${errorText(err)}`);
      break;
    }
  }

  const payload = {
    kind: "comments",
    target,
    sort: parsed.sort,
    fetched,
    total: total ?? store.count(target),
    complete: !hasMore,
    ...(error ? { error } : {}),
    sample,
  };
  return text(JSON.stringify(payload, null, 2), "application/json", parsed.ref.raw);
}

async function handle(parsed: ParsedBili, config: GatewayConfig, logger?: Logger) {
  switch (parsed.action) {
    case "video":
      return videoSummary(parsed, config, logger);
    case "article":
      return articleSummary(parsed, config, logger);
    case "comments":
    case "comments_search":
      return comments(parsed, config, logger);
  }
}

async function fetchBilibili(url: URL, ctx: FetchPluginContext): Promise<FetchPluginResult> {
  const { config, logger } = ctx;
  if (!config.bilibili?.enabled) return fail("BILI_UNAVAILABLE", "B 站抓取未启用（bilibili.enabled=false）。", url.toString());
  try {
    const target = isShortLink(url) ? await resolveShortLink(url) : new URL(url);
    for (const [k, v] of url.searchParams) if (!target.searchParams.has(k)) target.searchParams.set(k, v);
    if (url.hash && !target.hash) target.hash = url.hash;
    return await handle(parseBiliRequest(target), config, logger);
  } catch (err) {
    if (err instanceof BiliError) {
      logger?.debug(`bilibili failed: ${err.code} ${err.message}`);
      return fail(err.code, publicError(err), url.toString());
    }
    logger?.debug(`bilibili: 未预期异常 ${errorText(err)}`);
    return fail("BILI_UNAVAILABLE", "Bilibili 抓取失败", url.toString());
  }
}

export const bilibiliPlugin: FetchPlugin = {
  name: "bilibili",
  match: (url) => isBilibiliUrl(url) && (isBiliContentUrl(url) || isShortLink(url)),
  fetch: fetchBilibili,
};
