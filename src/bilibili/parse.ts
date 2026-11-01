/**
 * Bilibili 请求解析。
 *
 * 对外只有 fetch 一个入口，动作由 URL 的 `bili=` 参数选择；本模块只做
 * 「URL → 结构化请求」的纯解析，不发任何 B 站接口请求（唯一例外是 b23.tv
 * 短链展开，必须靠 HTTP 重定向拿落点）。
 */
import type { GatewayConfig } from "../config.js";
import { BiliError } from "./types.js";
import type { BiliAction, BiliRef, MediaKind } from "./types.js";

export interface ParsedBili {
  action: BiliAction;
  ref: BiliRef;
  /** 视频分 P（1 起）。 */
  page: number;
  /** 评论排序。 */
  sort: "hot" | "time";
  /** comments 动作的 all=1：尽量一次拉完。 */
  all: boolean;
  /** comments_search 的检索词。 */
  query?: string;
  /** 期望画质。 */
  quality: string;
  /** media 动作取视频还是音频；兼容 `bili=video|audio` 与 `bili=media&kind=`。 */
  kind?: MediaKind;
}

/** 站点后缀（含子域）。 */
const BILI_HOST = "bilibili.com";
const SHORT_HOST = "b23.tv";

/** 短链最多跟随的跳数。 */
const MAX_SHORT_HOPS = 5;

/** `bili=` 的取值 → 内部动作；video/audio 是 media 的简写。 */
const ACTION_ALIASES: Record<string, { action: BiliAction; kind?: MediaKind }> = {
  detail: { action: "detail" },
  comments: { action: "comments" },
  comments_search: { action: "comments_search" },
  media: { action: "media" },
  video: { action: "media", kind: "video" },
  audio: { action: "media", kind: "audio" },
  article: { action: "article" },
};

const VIDEO_ACTIONS: readonly BiliAction[] = ["detail", "comments", "comments_search", "media"];

/** 未登录 CDN 也认的 UA，仅用于短链跳转。 */
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function isHostOf(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

/** bilibili.com 或其子域。 */
function isBilibiliHost(hostname: string): boolean {
  return isHostOf(hostname.toLowerCase(), BILI_HOST);
}

/** b23.tv 或其子域。 */
function isShortHost(hostname: string): boolean {
  return isHostOf(hostname.toLowerCase(), SHORT_HOST);
}

function invalid(message: string, hint?: string): BiliError {
  return new BiliError("BILI_INVALID_URL", message, hint);
}

function resolveAction(value: string): { action: BiliAction; kind?: MediaKind } | undefined {
  return ACTION_ALIASES[value];
}

/** 解析正整数参数；缺失或非法时回退默认值。 */
function positiveInt(raw: string | null, fallback: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function isBilibiliUrl(u: URL): boolean {
  return isBilibiliHost(u.hostname) || isShortHost(u.hostname);
}

/**
 * 展开 b23.tv 短链。
 *
 * 用 `redirect: "manual"` 逐跳跟（HEAD 在部分 CDN 上会被拒），每跳都校验
 * 落点；最终必须落在 bilibili.com 子域，否则视为非法目标。
 */
export async function resolveShortLink(u: URL, timeoutMs = 8000): Promise<URL> {
  let current = u;

  for (let hop = 0; hop < MAX_SHORT_HOPS; hop++) {
    if (isBilibiliHost(current.hostname)) return current;
    if (!isShortHost(current.hostname)) {
      throw invalid(`短链落点不是 bilibili.com：${current.hostname}`);
    }

    let res: Response;
    try {
      res = await fetch(current, {
        method: "GET",
        redirect: "manual",
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BiliError("BILI_UNAVAILABLE", `b23.tv 短链解析失败：${msg}`);
    }
    // 只关心 Location，响应体直接丢弃
    await res.body?.cancel().catch(() => {});

    const location = res.headers.get("location");
    if (!location) {
      throw invalid(`b23.tv 短链未返回跳转（HTTP ${res.status}）`);
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw invalid(`b23.tv 短链跳转地址非法：${location}`);
    }
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw invalid(`短链落点协议不支持：${next.protocol}`);
    }
    current = next;
  }

  if (!isBilibiliHost(current.hostname)) {
    throw invalid(`b23.tv 短链跳转超过 ${MAX_SHORT_HOPS} 次仍未落到 bilibili.com`);
  }
  return current;
}

/**
 * 解析 `bili=` 动作与目标 ID。
 *
 * 视频类动作要求 BV 号或 av 号；article 要求 cv 号（/read/cv123）。
 * comments_search 只查本地库，必须能确定 BV 号。
 */
export function parseBiliRequest(u: URL, config: GatewayConfig): ParsedBili {
  if (!isBilibiliUrl(u)) {
    throw invalid(`不是 Bilibili 地址：${u.hostname}`);
  }
  if (isShortHost(u.hostname)) {
    throw invalid("b23.tv 短链需先展开再解析", "请直接传 b23.tv 链接给 fetch，由插件自动展开。");
  }

  const actionRaw = (u.searchParams.get("bili") ?? "").trim();
  const resolved = resolveAction(actionRaw);
  if (!resolved) {
    throw invalid(
      `bili 参数无效：${actionRaw || "(缺失)"}`,
      "可选值：detail | comments | comments_search | video | audio | media | article",
    );
  }
  const action = resolved.action;
  const kind: MediaKind | undefined =
    action === "media"
      ? resolved.kind ?? (u.searchParams.get("kind") === "audio" ? "audio" : "video")
      : undefined;

  const path = u.pathname;
  const bvMatch = /\/video\/(BV[0-9A-Za-z]{10})/.exec(path);
  const avMatch = /\/video\/av(\d+)/i.exec(path);
  const cvMatch = /\/read\/cv(\d+)/i.exec(path);

  const bvid = bvMatch?.[1];
  const aid = avMatch ? Number.parseInt(avMatch[1]!, 10) : undefined;
  const cv = cvMatch?.[1];
  const page = positiveInt(u.searchParams.get("p"), 1);

  const qualityParam = u.searchParams.get("quality");
  const quality = qualityParam && qualityParam.trim() !== "" ? qualityParam.trim() : config.bilibili.quality;

  if (action === "article") {
    if (!cv) {
      throw invalid(`article 动作需要专栏地址（/read/cv<数字>）：${path}`);
    }
  } else if (VIDEO_ACTIONS.includes(action)) {
    if (!bvid && aid === undefined) {
      throw invalid(`${action} 动作需要视频地址（/video/BV... 或 /video/av...）：${path}`);
    }
  }

  if (action === "comments_search") {
    if (!bvid) {
      throw invalid("comments_search 只查本地评论库，需要 BV 号（av 号无法定位本地库）");
    }
    const q = (u.searchParams.get("q") ?? "").trim();
    if (q === "") {
      throw invalid("comments_search 需要 q 参数（检索词）");
    }
    return {
      action,
      ref: { bvid, aid, page, cv, raw: u.toString() },
      page,
      sort: "hot",
      all: false,
      query: q,
      quality,
      kind,
    };
  }

  if (action === "comments") {
    const sortRaw = u.searchParams.get("sort");
    const sort: "hot" | "time" = sortRaw === "time" ? "time" : "hot";
    const commentPage = positiveInt(u.searchParams.get("page"), 1);
    return {
      action,
      ref: { bvid, aid, page, cv, raw: u.toString() },
      page: commentPage,
      sort,
      all: u.searchParams.get("all") === "1",
      quality,
      kind,
    };
  }

  return {
    action,
    ref: { bvid, aid, page, cv, raw: u.toString() },
    page,
    sort: "hot",
    all: false,
    quality,
    kind,
  };
}
