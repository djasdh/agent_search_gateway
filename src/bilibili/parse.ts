/** URL → 结构化请求。只做解析；b23.tv 短链需要一次重定向展开。 */

import type { GatewayConfig } from "../config.js";
import { BiliError } from "./types.js";
import type { BiliAction, BiliRef, MediaKind } from "./types.js";

export interface ParsedBili {
  action: BiliAction;
  ref: BiliRef;
  page: number;
  sort: "hot" | "time";
  all: boolean;
  query?: string;
  quality: string;
  kind?: MediaKind;
}

const ALIASES: Record<string, { action: BiliAction; kind?: MediaKind }> = {
  detail: { action: "detail" },
  comments: { action: "comments" },
  comments_search: { action: "comments_search" },
  media: { action: "media" },
  video: { action: "media", kind: "video" },
  audio: { action: "media", kind: "audio" },
  article: { action: "article" },
};

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function hostOf(hostname: string, suffix: string): boolean {
  const host = hostname.toLowerCase();
  return host === suffix || host.endsWith(`.${suffix}`);
}

export function isBilibiliUrl(u: URL): boolean {
  return hostOf(u.hostname, "bilibili.com") || hostOf(u.hostname, "b23.tv");
}

function invalid(message: string, hint?: string): BiliError {
  return new BiliError("BILI_INVALID_URL", message, hint);
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

export function parseBiliRequest(u: URL, config: GatewayConfig): ParsedBili {
  if (!isBilibiliUrl(u)) throw invalid(`不是 Bilibili 地址：${u.hostname}`);
  if (hostOf(u.hostname, "b23.tv")) throw invalid("b23.tv 短链需先展开");

  const raw = (u.searchParams.get("bili") ?? "").trim();
  const alias = ALIASES[raw];
  if (!alias) {
    throw invalid(`bili 参数无效：${raw || "(缺失)"}`, "可选：detail|comments|comments_search|video|audio|media|article");
  }

  const bvid = /\/video\/(BV[0-9A-Za-z]{10})/.exec(u.pathname)?.[1];
  const aidText = /\/video\/av(\d+)/i.exec(u.pathname)?.[1];
  const cv = /\/read\/cv(\d+)/i.exec(u.pathname)?.[1];
  const page = Number.parseInt(u.searchParams.get("p") ?? "1", 10) || 1;
  const quality = (u.searchParams.get("quality") ?? "").trim() || config.bilibili.quality;

  if (alias.action === "article") {
    if (!cv) throw invalid(`article 需要专栏地址（/read/cv<数字>）`);
  } else if (!bvid && !aidText) {
    throw invalid(`${alias.action} 需要视频地址（/video/BV... 或 /video/av...）`);
  }
  if (alias.action === "comments_search" && !bvid) {
    throw invalid("comments_search 需要 BV 号（本地库按 BV 存）");
  }

  const kind: MediaKind | undefined =
    alias.action === "media"
      ? alias.kind ?? (u.searchParams.get("kind") === "audio" ? "audio" : "video")
      : undefined;

  const commentPage = alias.action === "comments" ? Number.parseInt(u.searchParams.get("page") ?? "1", 10) || 1 : page;
  const query = (u.searchParams.get("q") ?? "").trim();
  if (alias.action === "comments_search" && !query) throw invalid("comments_search 需要 q 参数");

  return {
    action: alias.action,
    ref: { bvid, aid: aidText ? Number.parseInt(aidText, 10) : undefined, page, cv, raw: u.toString() },
    page: commentPage,
    sort: u.searchParams.get("sort") === "time" ? "time" : "hot",
    all: u.searchParams.get("all") === "1",
    query: query || undefined,
    quality,
    kind,
  };
}
