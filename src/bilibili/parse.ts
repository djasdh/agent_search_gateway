/** URL → 结构化请求。按路径判定视频/专栏，按 hash 判定评论区；b23.tv 先展开。 */

import { BiliError } from "./types.js";
import type { BiliAction, BiliRef } from "./types.js";

export interface ParsedBili {
  action: BiliAction;
  ref: BiliRef;
  page: number;
  sort: "hot" | "time";
  query?: string;
}

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function hostOf(hostname: string, suffix: string): boolean {
  const host = hostname.toLowerCase();
  return host === suffix || host.endsWith(`.${suffix}`);
}

export function isBilibiliUrl(u: URL): boolean {
  return hostOf(u.hostname, "bilibili.com") || hostOf(u.hostname, "b23.tv");
}

export function isShortLink(u: URL): boolean {
  return hostOf(u.hostname, "b23.tv");
}

/** 只看路径：视频页或专栏页。 */
export function isBiliContentUrl(u: URL): boolean {
  return /^\/video\/(?:BV[0-9A-Za-z]{10}|av\d+)/i.test(u.pathname)
    || /^\/read\/cv\d+/i.test(u.pathname);
}

function invalid(message: string, hint?: string): BiliError {
  return new BiliError("BILI_INVALID_URL", message, hint);
}

export function videoUrl(bvid: string | undefined, aid: number | undefined, page: number): string {
  const base = bvid
    ? `https://www.bilibili.com/video/${bvid}`
    : `https://www.bilibili.com/video/av${aid ?? ""}`;
  return page > 1 ? `${base}?p=${page}` : base;
}

export function articleUrl(cv: string): string {
  return `https://www.bilibili.com/read/cv${cv}`;
}

/** b23.tv 短链逐跳展开，落点必须是 bilibili.com 子域。 */
export async function resolveShortLink(u: URL, timeoutMs = 8000): Promise<URL> {
  let current = u;
  for (let hop = 0; hop < 5; hop++) {
    if (hostOf(current.hostname, "bilibili.com")) return current;
    if (!hostOf(current.hostname, "b23.tv")) throw invalid(`短链落点不是 bilibili.com：${current.hostname}`);
    let res: Response;
    try {
      res = await fetch(current, {
        redirect: "manual",
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new BiliError("BILI_UNAVAILABLE", `b23.tv 解析失败：${err instanceof Error ? err.message : err}`);
    }
    await res.body?.cancel().catch(() => {});
    const location = res.headers.get("location");
    if (!location) throw invalid(`b23.tv 未返回跳转（HTTP ${res.status}）`);
    try {
      current = new URL(location, current);
    } catch {
      throw invalid(`b23.tv 跳转地址非法：${location}`);
    }
  }
  throw invalid("b23.tv 跳转次数过多");
}

export function parseBiliRequest(u: URL): ParsedBili {
  if (!isBilibiliUrl(u)) throw invalid(`不是 Bilibili 地址：${u.hostname}`);
  if (isShortLink(u)) throw invalid("b23.tv 短链需先展开");

  const bvid = /\/video\/(BV[0-9A-Za-z]{10})/.exec(u.pathname)?.[1];
  const aidText = /\/video\/av(\d+)/i.exec(u.pathname)?.[1];
  const cv = /\/read\/cv(\d+)/i.exec(u.pathname)?.[1];
  if (!bvid && !aidText && !cv) {
    throw invalid(`不支持的 B 站地址：${u.pathname}`, "只接管视频页（/video/BV...、/video/av...）与专栏页（/read/cv...）");
  }

  // hash 里也可能带 query，如 #reply?q=关键词
  const hash = u.hash.replace(/^#/, "");
  const [hashPath, hashQuery = ""] = hash.split("?");
  const hashParams = new URLSearchParams(hashQuery);
  const param = (key: string): string | null => u.searchParams.get(key) ?? hashParams.get(key);

  const kind = cv ? "article" : "video";
  const wantsComments = hashPath === "reply" || hashPath === "comment";
  const query = (param("q") ?? "").trim();
  const action: BiliAction = wantsComments
    ? query
      ? "comments_search"
      : "comments"
    : kind === "article"
      ? "article"
      : "video";

  const page = Number.parseInt(param("p") ?? "1", 10) || 1;
  const aid = aidText ? Number.parseInt(aidText, 10) : undefined;
  const sort = param("sort") === "time" ? "time" : "hot";

  return {
    action,
    ref: {
      bvid,
      aid,
      page,
      cv,
      raw: cv ? articleUrl(cv) : videoUrl(bvid, aid, page),
    },
    page,
    sort,
    query: query || undefined,
  };
}
