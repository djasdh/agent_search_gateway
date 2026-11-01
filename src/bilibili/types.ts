/**
 * Bilibili 抓取的共享类型（多后端转发）。
 *
 * 对外只有 fetch 一个入口，动作由 URL 的 `bili=` 参数决定；
 * 内部按能力路由到不同后端（CLI / 托管 HTTP 服务），核心层不实现任何 B 站接口。
 */

/** URL 上可用的动作。 */
export type BiliAction = "detail" | "comments" | "comments_search" | "media" | "article";

/** 需要后端提供的能力（media 由 kind 区分视频/音频，仍算一种能力）。 */
export type BiliCapability = "detail" | "comments" | "media" | "article";

export type MediaKind = "video" | "audio";

/** 从 URL 解析出的目标。b23.tv 短链在解析阶段已展开。 */
export interface BiliRef {
  /** 视频 BV 号（视频类动作必填）。 */
  bvid?: string;
  /** 视频 av 号（部分后端需要）。 */
  aid?: number;
  /** 分 P，1 起。 */
  page: number;
  /** 专栏 cv 号（纯数字）。 */
  cv?: string;
  /** 原始输入（URL 或 ID），用于后端直接透传。 */
  raw: string;
}

/** 归一化后的视频详情。字段缺失时保留 undefined，不编造。 */
export interface BiliDetail {
  bvid: string;
  aid?: number;
  title: string;
  desc: string;
  owner: { mid?: number; name?: string };
  pubdate?: string;
  duration?: number;
  zone?: { tid?: number; name?: string };
  stat?: Record<string, number>;
  cover?: string;
  tags?: string[];
  pages: Array<{ page: number; cid?: number; title?: string; duration?: number }>;
  url: string;
}

/** 单条评论；楼中楼挂在 replies。 */
export interface BiliComment {
  rpid: number;
  root?: number | null;
  parent?: number | null;
  mid: number;
  uname: string;
  content: string;
  like: number;
  ctime: number;
  replies?: BiliComment[];
}

export interface BiliCommentPage {
  bvid: string;
  page: number;
  total?: number;
  hasMore: boolean;
  nextPage?: number;
  items: BiliComment[];
}

/** 直链描述。插件拿到后自己下载，不把 URL 暴露给 agent。 */
export interface BiliStream {
  url: string;
  contentType: string;
  size?: number;
  quality?: string;
}

export interface BiliArticle {
  cv: string;
  title?: string;
  content: string;
  meta?: Record<string, unknown>;
}

/** 登录态探测结果；hint 由后端自己给，核心层不写死。 */
export interface BiliProbe {
  ok: boolean;
  loggedIn: boolean;
  maxQuality?: string;
  hint?: string;
  error?: string;
}

export type BiliErrorCode =
  | "BILI_UNAVAILABLE"
  | "BILI_AUTH_REQUIRED"
  | "BILI_CAPABILITY_UNSUPPORTED"
  | "BILI_RISK_CONTROL"
  | "BILI_DOWNLOAD_FAIL"
  | "BILI_INVALID_URL"
  | "BILI_PARTIAL";

/** 后端/路由抛出的统一错误。service 层会把 code 放到返回文本开头。 */
export class BiliError extends Error {
  constructor(
    readonly code: BiliErrorCode,
    message: string,
    readonly hint?: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BiliError";
  }
}

/** 一个后端必须实现的最小集合；不支持的能力不会被路由到。 */
export interface BiliBackend {
  readonly id: string;
  supports(cap: BiliCapability): boolean;
  probe(ref?: BiliRef): Promise<BiliProbe>;
  detail(ref: BiliRef): Promise<BiliDetail>;
  comments(ref: BiliRef, opts: { page: number; sort: "hot" | "time" }): Promise<BiliCommentPage>;
  media(ref: BiliRef, opts: { kind: MediaKind; quality: string }): Promise<BiliStream>;
  article(ref: BiliRef): Promise<BiliArticle>;
}

/** 一次路由尝试的记录，返回给 agent 便于判断换后端/重试。 */
export interface BiliAttempt {
  backend: string;
  ok: boolean;
  code?: string;
  error?: string;
}

/** 评论本地库（node:sqlite）契约。 */
export interface BiliCommentStore {
  upsertPage(input: {
    bvid: string;
    page: number;
    items: BiliComment[];
    hasMore: boolean;
  }): void;
  syncState(bvid: string): { nextPage: number; finished: boolean };
  search(
    bvid: string,
    keyword: string,
    opts?: { mid?: number; limit?: number },
  ): BiliComment[];
  count(bvid: string): number;
  close(): void;
}

/** 插件 dispatch 的返回：文本类动作直接给文本，媒体给直链。 */
export type BiliDispatch =
  | { kind: "text"; text: string; contentType: string }
  | { kind: "media"; stream: BiliStream };
