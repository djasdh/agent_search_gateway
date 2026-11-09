/** 微博取件插件：单 CLI 后端（OpenCLI）；图片 CDN 自动接管。 */

import type { WeiboSettings } from "../settings/index.js";
import type { Logger } from "../logger.js";
import type { FetchPlugin, FetchPluginContext, FetchPluginResult } from "../fetch/plugins/types.js";
import { normalizePostRows, runOpencli } from "./cli.js";
import { downloadWeiboImage } from "./images.js";
import {
  addDays,
  isWeiboImageUrl,
  isWeiboUrl,
  parseWeiboRequest,
  resolveShortLink,
  splitDateRange,
} from "./parse.js";
import { WeiboError, type WeiboAction, type WeiboImage, type WeiboPost, type WeiboRef } from "./types.js";

const CACHE_MAX = 200;
const cache = new Map<string, { at: number; value: FetchPluginResult }>();
const SHORT_LINK_TIMEOUT_MS = 10000;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const str = (data: Record<string, unknown>, key: string): string | undefined => {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const num = (data: Record<string, unknown>, key: string): number | undefined => {
  const value = data[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

function toImages(raw: unknown): WeiboImage[] {
  if (typeof raw === "string") {
    try {
      return toImages(JSON.parse(raw));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  const out: WeiboImage[] = [];
  for (const item of raw) {
    const image = asRecord(item);
    const url = image ? str(image, "url") : undefined;
    if (!url) continue;
    out.push({
      url,
      large: image ? str(image, "large") : undefined,
      width: image ? num(image, "width") : undefined,
      height: image ? num(image, "height") : undefined,
    });
  }
  return out;
}

function renderPost(data: Record<string, unknown>): string {
  const author = str(data, "author") ?? "微博";
  const url = str(data, "url") ?? "";
  const lines: string[] = [`# ${author}`, "", str(data, "text") ?? ""];

  const retweetedText = str(data, "retweeted_text");
  if (retweetedText) {
    const from = str(data, "retweeted_from") ?? "原微博";
    lines.push("", `> 转发自 ${from}：`, `> ${retweetedText.replace(/\n/g, "\n> ")}`);
  }

  const pics = [...toImages(data.pic_urls), ...toImages(data.retweeted_pic_urls)];
  // 优先原图（large）；缺失时回退缩略图。
  for (const pic of pics) lines.push("", `![](${pic.large || pic.url})`);

  const stats: string[] = [];
  const reposts = num(data, "reposts");
  const comments = num(data, "comments");
  const likes = num(data, "likes");
  if (reposts !== undefined) stats.push(`转发：${reposts}`);
  if (comments !== undefined) stats.push(`评论：${comments}`);
  if (likes !== undefined) stats.push(`赞：${likes}`);
  const createdAt = str(data, "created_at");
  if (createdAt) stats.push(`时间：${createdAt}`);
  const source = str(data, "source");
  if (source) stats.push(`来源：${source}`);
  if (stats.length > 0) lines.push("", ...stats.map((line) => `- ${line}`));

  const picCount = num(data, "pic_count");
  if (picCount && pics.length === 0) {
    lines.push("", `- 图片：${picCount} 张（未取到外链，检查 OpenCLI post override 是否已安装）`);
  }

  if (url) lines.push("", `[原文](${url})`);
  return lines.join("\n");
}

function refTarget(ref: WeiboRef): string {
  return ref.id ?? ref.mblogid ?? ref.uid ?? ref.screenName ?? "";
}

/** OpenCLI user-posts 单次上限；时间段抓取固定按这个粒度拉取。 */
const USER_POSTS_PAGE = 100;

function toPost(raw: unknown): WeiboPost | undefined {
  const row = asRecord(raw);
  if (!row) return undefined;
  const post: WeiboPost = {
    id: str(row, "id"),
    mblogid: str(row, "mblogid"),
    author: str(row, "author"),
    uid: str(row, "uid"),
    text: str(row, "text"),
    time: str(row, "time"),
    reposts: num(row, "reposts"),
    comments: num(row, "comments"),
    likes: num(row, "likes"),
    picCount: num(row, "pic_count"),
    url: str(row, "url"),
  };
  return post.mblogid || post.id || post.url || post.text ? post : undefined;
}

function postEpoch(post: WeiboPost): number {
  if (!post.time) return 0;
  const parsed = Date.parse(post.time);
  return Number.isNaN(parsed) ? 0 : parsed;
}

const shanghaiDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const shanghaiTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function dateLabel(epoch: number): string {
  return epoch > 0 ? shanghaiDate.format(new Date(epoch)) : "";
}

function timeLabel(epoch: number): string {
  return epoch > 0 ? shanghaiTime.format(new Date(epoch)) : "";
}

interface CollectCtx {
  command: string;
  timeoutMs: number;
  target: string;
  includeRetweets: boolean;
  maxCalls: number;
  deadline: number;
  calls: number;
  cappedDays: Set<string>;
  truncated: boolean;
  logger?: Logger;
}

/**
 * 递归二分区间抓取：整段调用一次；返回满 100 条说明可能被截断，则二分继续。
 * 这样低频博主只需 1 次调用，高频博主只细分需要的子区间。
 */
async function collectRange(ctx: CollectCtx, start: string, end: string): Promise<WeiboPost[]> {
  if (ctx.calls >= ctx.maxCalls || Date.now() > ctx.deadline) {
    ctx.truncated = true;
    return [];
  }

  const args = [
    "weibo",
    "user-posts",
    ctx.target,
    "--limit",
    String(USER_POSTS_PAGE),
    "--start",
    start,
    "--end",
    end,
  ];
  if (ctx.includeRetweets) args.push("--include-retweets");

  ctx.calls++;
  let raw: unknown;
  try {
    raw = await runOpencli(ctx.command, args, ctx.timeoutMs, "weibo user-posts", ctx.logger);
  } catch (err) {
    // 空区间是正常情况（日期范围内没有微博），不应让整次抓取失败。
    if (err instanceof WeiboError && err.code === "WEIBO_EMPTY") return [];
    throw err;
  }

  const rows = Array.isArray(raw) ? raw.map(toPost).filter((post): post is WeiboPost => !!post) : [];
  if (rows.length < USER_POSTS_PAGE) return rows;
  if (start === end) {
    // adapter 只支持日期粒度，单日超过 100 条时无法继续细分。
    ctx.cappedDays.add(start);
    return rows;
  }

  const mid = splitDateRange(start, end);
  const left = await collectRange(ctx, start, mid);
  const right = await collectRange(ctx, addDays(mid, 1), end);
  return [...left, ...right];
}

function dedupePosts(posts: WeiboPost[]): WeiboPost[] {
  const seen = new Set<string>();
  const out: WeiboPost[] = [];
  for (const post of posts) {
    const key = post.mblogid || post.id || post.url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(post);
  }
  return out;
}

function escapeLabel(s: string): string {
  return s.replace(/[[\]]/g, (m) => `\\${m}`);
}

function postTitle(post: WeiboPost): string {
  const first = (post.text ?? "").split("\n")[0]?.trim() ?? "";
  if (!first) return "微博";
  return first.length > 40 ? `${first.slice(0, 40)}…` : first;
}

interface RenderPostsMeta {
  target: string;
  start: string;
  end: string;
  calls: number;
  cappedDays: string[];
  truncated: boolean;
  itemsTruncated: boolean;
  maxItems: number;
  maxChars: number;
}

function renderUserPosts(posts: WeiboPost[], meta: RenderPostsMeta): string {
  const author = posts.find((p) => p.author)?.author ?? meta.target;
  const lines: string[] = [`# @${author} · ${meta.start} ~ ${meta.end}`, ""];

  if (posts.length === 0) {
    lines.push("该时间段内没有抓到微博。");
    return lines.join("\n");
  }

  lines.push(`共 ${posts.length} 条，${meta.calls} 次抓取。`);

  const groups = new Map<string, WeiboPost[]>();
  for (const post of posts) {
    const key = dateLabel(postEpoch(post)) || "时间未知";
    const list = groups.get(key);
    if (list) list.push(post);
    else groups.set(key, [post]);
  }

  for (const [day, items] of groups) {
    lines.push("", `## ${day}`);
    for (const post of items) {
      const epoch = postEpoch(post);
      const time = timeLabel(epoch) || "时间未知";
      const title = escapeLabel(postTitle(post));
      const head = post.url ? `### ${time} · [${title}](${post.url})` : `### ${time} · ${title}`;
      lines.push("", head);

      const stats: string[] = [];
      if (post.likes !== undefined) stats.push(`赞 ${post.likes}`);
      if (post.comments !== undefined) stats.push(`评 ${post.comments}`);
      if (post.reposts !== undefined) stats.push(`转 ${post.reposts}`);
      if (post.picCount) stats.push(`图 ${post.picCount}`);
      if (stats.length > 0) lines.push("", stats.join(" · "));

      const text = post.text ?? "";
      if (text.trim() !== "") {
        const body = text.length > meta.maxChars ? `${text.slice(0, meta.maxChars)}…` : text;
        lines.push("", body);
      }
    }
  }

  const notes: string[] = [];
  if (meta.cappedDays.length > 0) {
    notes.push(
      `以下日期达到单日 ${USER_POSTS_PAGE} 条上限，可能不完整：${meta.cappedDays.join("、")}（adapter 只支持日期粒度）。`,
    );
  }
  if (meta.truncated) {
    notes.push("已达到抓取预算，结果可能不完整；可缩小时间段或调大 weibo.user_posts.max_calls/budget_ms。");
  }
  if (meta.itemsTruncated) {
    notes.push(`已按 max_items=${meta.maxItems} 截断，仅保留最新 ${meta.maxItems} 条。`);
  }
  if (notes.length > 0) lines.push("", ...notes.map((n) => `> ${n}`));
  return lines.join("\n");
}

async function fetchUserPosts(
  ref: WeiboRef,
  weibo: WeiboSettings,
  logger?: Logger,
): Promise<string> {
  const target = refTarget(ref);
  const start = ref.start;
  const end = ref.end;
  if (!start || !end) throw new WeiboError("WEIBO_INVALID", "缺少时间段", "使用 days=7 或 start/end");

  const ctx: CollectCtx = {
    command: weibo.cli.command,
    timeoutMs: weibo.cli.timeout_ms,
    target,
    includeRetweets: !!ref.includeRetweets,
    maxCalls: weibo.user_posts.max_calls,
    deadline: Date.now() + weibo.user_posts.budget_ms,
    calls: 0,
    cappedDays: new Set(),
    truncated: false,
    logger,
  };

  const rows = await collectRange(ctx, start, end);
  const sorted = dedupePosts(rows).sort((a, b) => postEpoch(b) - postEpoch(a));
  const maxItems = ref.maxItems ?? weibo.user_posts.max_items;
  const posts = sorted.slice(0, maxItems);

  return renderUserPosts(posts, {
    target,
    start,
    end,
    calls: ctx.calls,
    cappedDays: [...ctx.cappedDays].sort(),
    truncated: ctx.truncated,
    itemsTruncated: sorted.length > maxItems,
    maxItems,
    maxChars: weibo.user_posts.max_chars,
  });
}

async function numericId(
  ref: WeiboRef,
  weibo: WeiboSettings,
  logger?: Logger,
): Promise<string> {
  const raw = ref.id ?? ref.mblogid;
  if (!raw) throw new WeiboError("WEIBO_INVALID", "缺少微博 id");
  if (/^\d+$/.test(raw)) return raw;

  // comments 只接受 numeric idstr；mblogid 先通过 post 换一次。
  const data = normalizePostRows(
    await runOpencli(
      weibo.cli.command,
      ["weibo", "post", raw],
      weibo.cli.timeout_ms,
      "weibo post",
      logger,
    ),
  );
  const id = str(data, "id");
  if (id && /^\d+$/.test(id)) return id;
  throw new WeiboError(
    "WEIBO_INVALID",
    `无法把 mblogid ${raw} 转成数字 id`,
    "改用 m.weibo.cn/detail/<数字> 链接",
  );
}

async function runAction(
  ref: WeiboRef,
  weibo: WeiboSettings,
  logger?: Logger,
): Promise<{ contentType: string; body: string }> {
  const command = weibo.cli.command;
  const timeout = weibo.cli.timeout_ms;
  const argsOf = (action: WeiboAction): string[] => {
    switch (action) {
      case "post":
        return ["weibo", "post", refTarget(ref)];
      case "comments":
        return ["weibo", "comments", ref.id ?? ref.mblogid ?? "", "--limit", String(ref.limit ?? weibo.defaults.comments_limit)];
      case "user":
        return ["weibo", "user", refTarget(ref)];
      case "user-posts": {
        const args = ["weibo", "user-posts", refTarget(ref), "--limit", String(ref.limit ?? weibo.defaults.user_posts_limit)];
        if (ref.start) args.push("--start", ref.start);
        if (ref.end) args.push("--end", ref.end);
        if (ref.includeRetweets) args.push("--include-retweets");
        return args;
      }
    }
  };

  // 时间段抓取自己管理切片/预算，不走单次 CLI 调用。
  if (ref.action === "user-posts") {
    return { contentType: "text/markdown", body: await fetchUserPosts(ref, weibo, logger) };
  }

  let args = argsOf(ref.action);
  if (ref.action === "comments") {
    args = ["weibo", "comments", await numericId(ref, weibo, logger), "--limit", String(ref.limit ?? weibo.defaults.comments_limit)];
  }

  const raw = await runOpencli(command, args, timeout, `weibo ${ref.action}`, logger);
  if (ref.action === "post") {
    return { contentType: "text/markdown", body: renderPost(normalizePostRows(raw)) };
  }
  return { contentType: "application/json", body: JSON.stringify(raw, null, 2) };
}

function cacheKey(ref: WeiboRef): string {
  return [
    ref.action,
    refTarget(ref),
    ref.limit ?? "",
    ref.start ?? "",
    ref.end ?? "",
    ref.days ?? "",
    ref.maxItems ?? "",
    ref.includeRetweets ? "1" : "0",
  ].join("|");
}

function cacheGet(key: string, ttlMs: number): FetchPluginResult | undefined {
  if (ttlMs <= 0) return undefined;
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > ttlMs) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key: string, value: FetchPluginResult): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), value });
}

const fail = (err: WeiboError, finalUrl?: string): FetchPluginResult => {
  const hint = err.hint ? `\n处理：${err.hint}` : "";
  return { ok: false, finalUrl, errorCode: err.code, errorMessage: err.message + hint };
};

const textResult = (body: string, contentType: string, finalUrl: string): FetchPluginResult => ({
  ok: true,
  status: 200,
  contentType,
  finalUrl,
  bytes: Buffer.from(body, "utf8"),
});

async function fetchWeibo(url: URL, ctx: FetchPluginContext): Promise<FetchPluginResult> {
  const { settings, logger } = ctx;
  const weibo = settings.weibo;

  if (isWeiboImageUrl(url)) {
    if (!weibo.enabled || !weibo.images.enabled) {
      return fail(new WeiboError("WEIBO_UNAVAILABLE", "微博图片抓取未启用（weibo.enabled/weibo.images.enabled=false）", url.toString()));
    }
    try {
      const image = await downloadWeiboImage(url, weibo, settings.fetch.user_agent, logger);
      return {
        ok: true,
        status: 200,
        contentType: image.contentType,
        finalUrl: image.finalUrl,
        bytes: image.bytes,
      };
    } catch (err) {
      if (err instanceof WeiboError) return fail(err, url.toString());
      return fail(new WeiboError("WEIBO_IMAGE_FAIL", err instanceof Error ? err.message : String(err)), url.toString());
    }
  }

  if (!weibo.enabled) {
    return fail(new WeiboError("WEIBO_UNAVAILABLE", "微博插件未启用（weibo.enabled=false）", url.toString()));
  }

  try {
    const target = url.hostname.toLowerCase() === "t.cn" ? await resolveShortLink(url, SHORT_LINK_TIMEOUT_MS) : url;
    // t.cn 的 ?weibo= 不会出现在最终 URL 上，解析后补回去。
    if (target !== url) {
      for (const [key, value] of url.searchParams) {
        if (!target.searchParams.has(key)) target.searchParams.set(key, value);
      }
    }
    const ref = parseWeiboRequest(target, weibo);
    const key = cacheKey(ref);
    const cached = cacheGet(key, weibo.cache_ttl_ms);
    if (cached) return cached;

    const { contentType, body } = await runAction(ref, weibo, logger);
    const result = textResult(body, contentType, target.toString());
    cacheSet(key, result);
    return result;
  } catch (err) {
    if (err instanceof WeiboError) {
      logger?.debug(`weibo: ${err.code} ${err.message}`);
      return fail(err, url.toString());
    }
    logger?.debug(`weibo: 未预期异常 ${err instanceof Error ? err.message : String(err)}`);
    return fail(
      new WeiboError("WEIBO_UNAVAILABLE", `微博抓取失败：${err instanceof Error ? err.message : String(err)}`),
      url.toString(),
    );
  }
}

export const weiboPlugin: FetchPlugin = {
  name: "weibo",
  match: (url, settings) => {
    // 默认关闭时不接管任何 URL，保证关闭后行为与改动前一致。
    if (settings && !settings.weibo.enabled) return false;
    return isWeiboImageUrl(url) || (isWeiboUrl(url) && url.searchParams.has("weibo"));
  },
  fetch: fetchWeibo,
};
