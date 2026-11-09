/** 微博 URL 解析：普通页面/短链 → 抓取动作；sinaimg CDN → 图片附件。 */

import type { WeiboSettings } from "../settings/index.js";
import { WeiboError, type WeiboAction, type WeiboRef } from "./types.js";

const SHORT_HOST = "t.cn";
const IMAGE_HOST_SUFFIX = "sinaimg.cn";
const IMAGE_PATH = /\/(large|bmiddle|thumbnail|orj1080|mw690|original)\//i;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const hostIs = (host: string, suffix: string): boolean =>
  host === suffix || host.endsWith(`.${suffix}`);

/** 微博页面/短链域（不含图片 CDN）。 */
export function isWeiboUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return hostIs(host, "weibo.com") || hostIs(host, "weibo.cn") || host === SHORT_HOST;
}

/** 微博图片 CDN：只接管图片路径，避免误伤同域的 CSS/JS。 */
export function isWeiboImageUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (!hostIs(host, IMAGE_HOST_SUFFIX)) return false;
  const path = url.pathname;
  return IMAGE_PATH.test(path) || IMAGE_EXT.test(path);
}

function validateAction(raw: string): WeiboAction {
  if (raw === "post" || raw === "comments" || raw === "user" || raw === "user-posts") return raw;
  throw new WeiboError(
    "WEIBO_INVALID",
    `不支持的微博动作：${raw}`,
    "本轮只支持 post / comments / user / user-posts",
  );
}

function baseRef(url: URL): WeiboRef | undefined {
  const segs = url.pathname.split("/").filter(Boolean);
  if (segs.length === 0) return undefined;

  if (segs[0] === "detail" || segs[0] === "status") {
    const id = segs[1];
    return id ? { action: "post", id } : undefined;
  }
  if (segs[0] === "u") {
    const uid = segs[1];
    return uid ? { action: "user", uid } : undefined;
  }
  if (segs[0] === "n") {
    const name = segs[1];
    return name ? { action: "user", screenName: decodeURIComponent(name) } : undefined;
  }
  if (segs.length >= 2 && /^\d+$/.test(segs[0]!)) {
    return { action: "post", uid: segs[0], mblogid: segs[1] };
  }
  if (segs.length === 1 && /^\d+$/.test(segs[0]!)) {
    return { action: "user", uid: segs[0] };
  }
  return undefined;
}

function limitOf(url: URL, fallback: number, max = 50): number {
  const raw = url.searchParams.get("limit");
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/** Asia/Shanghai 的今天（YYYY-MM-DD）；用户看到的时间段默认按微博所在时区算。 */
export function todayInShanghai(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** 日期字符串加减天数（UTC 计算，避免夏令时/时区漂移）。 */
export function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** 两个 YYYY-MM-DD 之间相差的天数（end - start）。 */
export function daysBetween(start: string, end: string): number {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** 时间段一分为二：返回左半区间的结束日（右半从次日开始）。 */
export function splitDateRange(start: string, end: string): string {
  return addDays(start, Math.floor(daysBetween(start, end) / 2));
}

interface UserPostsRange {
  start: string;
  end: string;
  days?: number;
}

/**
 * 解析时间段参数：
 *   - `days=N`（1–max_days）：最近 N 天，与 start/end 互斥
 *   - `start` / `end`：绝对日期，只给一端时补另一端（默认窗口 default_days）
 *   - 都不给：最近 default_days 天
 * 统一按 Asia/Shanghai 计算，跨度不得超过 max_days。
 */
function userPostsRange(url: URL, weibo: WeiboSettings): UserPostsRange {
  const startRaw = dateOf(url, "start");
  const endRaw = dateOf(url, "end");
  const maxDays = weibo.user_posts.max_days;

  const daysRaw = url.searchParams.get("days");
  let days: number | undefined;
  if (daysRaw !== null && daysRaw.trim() !== "") {
    const n = Number(daysRaw);
    if (!Number.isInteger(n) || n < 1 || n > maxDays) {
      throw new WeiboError("WEIBO_INVALID", `days 必须是 1-${maxDays} 的整数：${daysRaw}`);
    }
    if (startRaw || endRaw) {
      throw new WeiboError("WEIBO_INVALID", "days 不能与 start/end 同时使用");
    }
    days = n;
  }

  const today = todayInShanghai();
  let start: string;
  let end: string;
  if (days !== undefined) {
    end = today;
    start = addDays(today, -(days - 1));
  } else if (startRaw && endRaw) {
    start = startRaw;
    end = endRaw;
  } else if (startRaw) {
    start = startRaw;
    end = today;
  } else if (endRaw) {
    end = endRaw;
    start = addDays(end, -(weibo.user_posts.default_days - 1));
  } else {
    end = today;
    start = addDays(today, -(weibo.user_posts.default_days - 1));
  }

  const span = daysBetween(start, end);
  if (span < 0) {
    throw new WeiboError("WEIBO_INVALID", `start 不能晚于 end：${start} > ${end}`);
  }
  if (span + 1 > maxDays) {
    throw new WeiboError(
      "WEIBO_INVALID",
      `时间段跨度过大（${span + 1} 天，上限 ${maxDays} 天）`,
      "缩小 start/end，或改用 days=N",
    );
  }
  return { start, end, days };
}

function positiveInt(url: URL, key: string, fallback: number): number {
  const raw = url.searchParams.get(key);
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}

function dateOf(url: URL, key: string): string | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null || raw.trim() === "") return undefined;
  if (!DATE.test(raw)) {
    throw new WeiboError("WEIBO_INVALID", `${key} 必须是 YYYY-MM-DD：${raw}`);
  }
  return raw;
}

/** 解析 `?weibo=` 请求；URL 本身推不出动作时抛 WEIBO_INVALID。 */
export function parseWeiboRequest(url: URL, weibo: WeiboSettings): WeiboRef {
  const base = baseRef(url);
  const rawAction = url.searchParams.get("weibo");
  const action: WeiboAction = rawAction ? validateAction(rawAction) : base?.action ?? "post";

  const ref: WeiboRef = { ...(base ?? {}), action };

  if (action === "comments" || action === "post") {
    if (!ref.id && !ref.mblogid) {
      throw new WeiboError("WEIBO_INVALID", "缺少微博 id", "使用 weibo.com/{uid}/{mblogid} 或 m.weibo.cn/detail/{id}");
    }
    if (action === "comments") {
      ref.limit = limitOf(url, weibo.defaults.comments_limit);
    }
  } else if (action === "user") {
    if (!ref.uid && !ref.screenName) {
      throw new WeiboError("WEIBO_INVALID", "缺少用户 id/昵称", "使用 weibo.com/u/{uid} 或 weibo.com/n/{昵称}");
    }
  } else if (action === "user-posts") {
    if (!ref.uid && !ref.screenName) {
      throw new WeiboError("WEIBO_INVALID", "缺少用户 id/昵称", "使用 weibo.com/u/{uid}?weibo=user-posts");
    }
    const range = userPostsRange(url, weibo);
    // OpenCLI adapter 的 limit 上限固定为 100；每次抓取都按 100 调，再按 max_items 截断。
    ref.limit = limitOf(url, weibo.defaults.user_posts_limit, 100);
    ref.start = range.start;
    ref.end = range.end;
    ref.days = range.days;
    // `limit` 是旧参数：显式给 limit、又没给 max_items 时，沿用它作为返回上限。
    const fallbackItems = url.searchParams.has("limit") ? ref.limit : weibo.user_posts.max_items;
    ref.maxItems = Math.min(
      positiveInt(url, "max_items", fallbackItems),
      weibo.user_posts.max_items,
    );
    const include = url.searchParams.get("include_retweets");
    ref.includeRetweets = include === "1" || include === "true";
  }

  return ref;
}

/** t.cn 短链解析：只接受 t.cn 起始，最终必须落到微博页面域。 */
export async function resolveShortLink(url: URL, timeoutMs = 10000): Promise<URL> {
  if (url.hostname.toLowerCase() !== SHORT_HOST) {
    throw new WeiboError("WEIBO_INVALID", `不是微博短链：${url.hostname}`);
  }
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
    });
  } catch (err) {
    throw new WeiboError(
      "WEIBO_UNAVAILABLE",
      `微博短链解析失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  await res.body?.cancel().catch(() => undefined);

  const finalUrl = new URL(res.url || url.toString());
  if (!isWeiboUrl(finalUrl) || finalUrl.hostname.toLowerCase() === SHORT_HOST) {
    throw new WeiboError("WEIBO_INVALID", `微博短链没有落到微博页面：${finalUrl.toString()}`);
  }
  return finalUrl;
}
