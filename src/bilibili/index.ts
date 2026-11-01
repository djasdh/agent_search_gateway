/**
 * Bilibili 取件插件入口。
 *
 * 所有动作都走 fetch：URL 上的 `bili=` 选动作，插件内部按能力路由到
 * CLI / 托管 HTTP 后端。文本类动作直接回 bytes（JSON / Markdown），
 * 媒体动作下载后回 bytes，由 fetch 服务统一落盘。
 */
import type { GatewayConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { FetchPlugin, FetchPluginContext, FetchPluginResult } from "../fetch/plugins/types.js";
import { resolve } from "node:path";
import { downloadStream } from "./download.js";
import { isBilibiliUrl, parseBiliRequest, resolveShortLink } from "./parse.js";
import type { ParsedBili } from "./parse.js";
import { createRouter } from "./router.js";
import type { BiliRouter } from "./router.js";
import { createCommentStore } from "./store.js";
import { BiliError } from "./types.js";
import type {
  BiliAttempt,
  BiliCommentPage,
  BiliCommentStore,
  MediaKind,
} from "./types.js";

/** all=1 单次 fetch 的总时间预算；超时后返回已拉到的页并给 next_page。 */
const ALL_COMMENTS_BUDGET_MS = 60_000;

/** 进程内共享：同一配置复用路由（HTTP 后端可能拉起常驻服务）。 */
const routers = new WeakMap<GatewayConfig, BiliRouter>();
/** 同一 sqlite 路径只开一个连接。 */
const stores = new Map<string, BiliCommentStore>();

function getRouter(config: GatewayConfig, logger?: Logger): BiliRouter {
  let router = routers.get(config);
  if (!router) {
    router = createRouter(config, logger);
    routers.set(config, router);
  }
  return router;
}

function getStore(config: GatewayConfig, logger?: Logger): BiliCommentStore {
  const key = resolve(config.bilibili.commentDb);
  let store = stores.get(key);
  if (!store) {
    store = createCommentStore(config.bilibili.commentDb, logger);
    stores.set(key, store);
  }
  return store;
}

function isShortLink(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === "b23.tv" || host.endsWith(".b23.tv");
}

function textResult(text: string, contentType: string, finalUrl: string): FetchPluginResult {
  return {
    ok: true,
    status: 200,
    contentType,
    finalUrl,
    bytes: Buffer.from(text, "utf8"),
  };
}

function fail(code: string, message: string, finalUrl?: string): FetchPluginResult {
  return { ok: false, finalUrl, errorCode: code, errorMessage: message };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 把尝试链拼进错误文本，便于 agent 判断换后端还是补登录态。 */
function formatAttempts(attempts: BiliAttempt[]): string {
  if (attempts.length === 0) return "";
  const lines = attempts.map(
    (a) => `- ${a.backend}：${a.ok ? "ok" : `[${a.code ?? "UNKNOWN"}] ${a.error ?? ""}`}`,
  );
  return `\n\n尝试记录：\n${lines.join("\n")}`;
}

function attemptsOf(err: BiliError): BiliAttempt[] {
  const raw = err.detail?.attempts;
  return Array.isArray(raw) ? (raw as BiliAttempt[]) : [];
}

/** 短链展开后把动作参数补回落点 URL（b23.tv 的 Location 通常不带查询串）。 */
function mergeParams(source: URL, target: URL): URL {
  for (const [key, value] of source.searchParams) {
    if (!target.searchParams.has(key)) target.searchParams.set(key, value);
  }
  return target;
}

function parseOptionalMid(url: URL): number | undefined {
  const raw = url.searchParams.get("mid");
  if (raw === null || raw.trim() === "") return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function handleCommentSearch(
  parsed: ParsedBili,
  url: URL,
  config: GatewayConfig,
  logger?: Logger,
): FetchPluginResult {
  const bvid = parsed.ref.bvid;
  if (!bvid) {
    throw new BiliError("BILI_INVALID_URL", "comments_search 需要 BV 号");
  }
  const keyword = parsed.query ?? "";
  const store = getStore(config, logger);
  const items = store.search(bvid, keyword, {
    mid: parseOptionalMid(url),
    limit: config.bilibili.comments.searchLimit,
  });

  const payload = {
    bvid,
    keyword,
    count: items.length,
    items,
  };
  return textResult(JSON.stringify(payload, null, 2), "application/json", url.toString());
}

async function handleComments(
  parsed: ParsedBili,
  url: URL,
  config: GatewayConfig,
  logger?: Logger,
): Promise<FetchPluginResult> {
  const bvid = parsed.ref.bvid;
  if (!bvid) {
    throw new BiliError("BILI_INVALID_URL", "comments 需要 BV 号（本地评论库以 BV 号为主键）");
  }

  const router = getRouter(config, logger);
  const store = getStore(config, logger);

  const maxPages = parsed.all ? config.bilibili.comments.maxPagesPerCall : 1;
  const deadline = Date.now() + ALL_COMMENTS_BUDGET_MS;

  const attempts: BiliAttempt[] = [];
  let cursor = parsed.page;
  let fetched = 0;
  let count = 0;
  let total: number | undefined;
  let hasMore = false;
  let nextPage: number | undefined;

  while (fetched < maxPages) {
    if (fetched > 0 && Date.now() >= deadline) break;

    let page: { value: BiliCommentPage; attempts: BiliAttempt[] };
    try {
      page = await router.comments(parsed.ref, { page: cursor, sort: parsed.sort });
    } catch (err) {
      // 第一页就失败：整体失败；已有部分结果时保留成果并停在这里
      if (fetched === 0) throw err;
      if (err instanceof BiliError) {
        const nested = attemptsOf(err);
        if (nested.length > 0) attempts.push(...nested);
        else attempts.push({ backend: "(route)", ok: false, code: err.code, error: err.message });
      } else {
        attempts.push({
          backend: "(route)",
          ok: false,
          code: "BILI_UNAVAILABLE",
          error: errorMessage(err),
        });
      }
      break;
    }

    attempts.push(...page.attempts);
    const value = page.value;
    const pageBvid = value.bvid || bvid;
    store.upsertPage({
      bvid: pageBvid,
      page: cursor,
      items: value.items,
      hasMore: value.hasMore,
    });

    fetched++;
    count += value.items.length;
    if (value.total !== undefined) total = value.total;

    hasMore = value.hasMore;
    nextPage = value.hasMore ? value.nextPage ?? cursor + 1 : undefined;

    if (!parsed.all || !hasMore || nextPage === undefined || nextPage <= cursor) break;
    cursor = nextPage;
  }

  if (total === undefined) total = store.count(bvid);

  const payload = {
    bvid,
    page: parsed.page,
    count,
    total,
    fetched,
    has_more: hasMore,
    next_page: hasMore ? nextPage : undefined,
    attempts,
  };
  return textResult(JSON.stringify(payload, null, 2), "application/json", url.toString());
}

async function handleDetail(
  parsed: ParsedBili,
  url: URL,
  config: GatewayConfig,
  logger?: Logger,
): Promise<FetchPluginResult> {
  const router = getRouter(config, logger);
  const { value, attempts } = await router.detail(parsed.ref);
  return textResult(
    JSON.stringify({ ...value, attempts }, null, 2),
    "application/json",
    url.toString(),
  );
}

async function handleArticle(
  parsed: ParsedBili,
  url: URL,
  config: GatewayConfig,
  logger?: Logger,
): Promise<FetchPluginResult> {
  const router = getRouter(config, logger);
  const { value } = await router.article(parsed.ref);
  const title = value.title?.trim() || `cv${value.cv}`;
  const body = value.content.trim();
  return textResult(`# ${title}\n\n${body}`, "text/markdown", url.toString());
}

async function handleMedia(
  parsed: ParsedBili,
  url: URL,
  config: GatewayConfig,
  logger?: Logger,
): Promise<FetchPluginResult> {
  const router = getRouter(config, logger);
  const kind: MediaKind = parsed.kind ?? "video";
  const { value } = await router.media(parsed.ref, { kind, quality: parsed.quality });
  const downloaded = await downloadStream(value, config, logger);

  return {
    ok: true,
    status: 200,
    contentType: downloaded.contentType,
    finalUrl: url.toString(),
    bytes: downloaded.bytes,
  };
}

async function fetchBilibili(url: URL, ctx: FetchPluginContext): Promise<FetchPluginResult> {
  const { config, logger } = ctx;

  if (!config.bilibili?.enabled) {
    return fail("BILI_UNAVAILABLE", "bilibili 插件未启用（bilibili.enabled=false）。", url.toString());
  }

  try {
    let target = url;
    if (isShortLink(url)) {
      target = mergeParams(url, await resolveShortLink(url));
    }

    const parsed = parseBiliRequest(target, config);

    switch (parsed.action) {
      case "comments_search":
        return handleCommentSearch(parsed, target, config, logger);
      case "comments":
        return await handleComments(parsed, target, config, logger);
      case "detail":
        return await handleDetail(parsed, target, config, logger);
      case "article":
        return await handleArticle(parsed, target, config, logger);
      case "media":
        return await handleMedia(parsed, target, config, logger);
    }
  } catch (err) {
    if (err instanceof BiliError) {
      const message = err.message + (err.hint ? `\n处理：${err.hint}` : "") + formatAttempts(attemptsOf(err));
      return fail(err.code, message, url.toString());
    }
    logger?.debug(`bilibili plugin: 未预期异常 ${errorMessage(err)}`);
    return fail("BILI_UNAVAILABLE", `Bilibili 取件失败：${errorMessage(err)}`, url.toString());
  }
}

export const bilibiliPlugin: FetchPlugin = {
  name: "bilibili",
  match(url: URL): boolean {
    return isBilibiliUrl(url) && url.searchParams.has("bili");
  },
  fetch: fetchBilibili,
};

/** 便于测试/诊断：清空评论库连接（fetched 数据仍在磁盘上）。 */
export function closeBilibiliStores(): void {
  for (const store of stores.values()) store.close();
  stores.clear();
}
