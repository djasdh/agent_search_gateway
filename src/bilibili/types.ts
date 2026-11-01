/** Bilibili 抓取：共享类型与错误。对外只走 fetch，按 URL 类型自动判定。 */

export type BiliAction = "video" | "comments" | "comments_search" | "article";
export type BiliCapability = "detail" | "comments" | "audio" | "article";

export interface BiliRef {
  bvid?: string;
  aid?: number;
  /** 分 P，1 起。 */
  page: number;
  /** 专栏 cv 号（纯数字）。 */
  cv?: string;
  /** 规范化后的页面 URL，后端可直接透传。 */
  raw: string;
}

export interface BiliPage {
  page: number;
  title: string;
}

export interface BiliDetail {
  bvid: string;
  aid?: number;
  title: string;
  desc: string;
  owner: { mid?: number; name?: string };
  stat?: Record<string, number>;
  cover?: string;
  pages: BiliPage[];
  currentPage: number;
  pageCount: number;
}

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
  /** 本地库 key：视频 BV...，专栏 cv123。 */
  bvid: string;
  page: number;
  total?: number;
  hasMore: boolean;
  nextPage?: number;
  items: BiliComment[];
}

export interface BiliAudio {
  url: string;
}

export interface BiliArticle {
  cv: string;
  title?: string;
  content: string;
  meta?: Record<string, unknown>;
}

export interface BiliProbe {
  ok: boolean;
  loggedIn: boolean;
  hint?: string;
  error?: string;
}

/** 一次路由尝试，只进日志，不返回给 agent。 */
export interface BiliAttempt {
  backend: string;
  ok: boolean;
  code?: string;
  error?: string;
}

export type BiliErrorCode =
  | "BILI_UNAVAILABLE"
  | "BILI_AUTH_REQUIRED"
  | "BILI_CAPABILITY_UNSUPPORTED"
  | "BILI_RISK_CONTROL"
  | "BILI_INVALID_URL";

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

/** CLI 子进程的统一结果；错误映射只认这个形状。 */
export interface CliResult {
  failed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** spawn 失败时的错误码（如 ENOENT）；正常退出为 undefined。 */
  spawnError?: string;
  stdout: string;
  stderr: string;
}

export interface BiliBackend {
  readonly id: string;
  supports(cap: BiliCapability): boolean;
  probe(ref?: BiliRef): Promise<BiliProbe>;
  detail(ref: BiliRef): Promise<BiliDetail>;
  comments(ref: BiliRef, opts: { page: number; sort: "hot" | "time" }): Promise<BiliCommentPage>;
  audio(ref: BiliRef): Promise<BiliAudio>;
  article(ref: BiliRef): Promise<BiliArticle>;
}

export interface BiliCommentStore {
  upsertPage(input: { bvid: string; page: number; items: BiliComment[]; hasMore: boolean }): void;
  syncState(bvid: string): { nextPage: number; finished: boolean };
  search(bvid: string, keyword: string, opts?: { mid?: number; limit?: number }): BiliComment[];
  count(bvid: string): number;
  close(): void;
}

/** 对外的视频摘要；字段名用 snake_case，直接 JSON 返回。 */
export interface BiliVideoSummary {
  kind: "video";
  title: string;
  url: string;
  audio_url: string | null;
  audio_error?: string;
  cover_url?: string;
  detail: {
    desc: string;
    owner: { mid?: number; name?: string };
    stat: Record<string, number>;
    current_page: number;
    page_count: number;
    pages: BiliPage[];
  };
  comments_url: string;
}

export interface BiliArticleSummary {
  kind: "article";
  title: string;
  url: string;
  audio_url: null;
  cover_url?: string;
  detail: { content: string };
  comments_url: string;
}
