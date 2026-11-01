/** Bilibili 抓取：共享类型与错误。对外只走 fetch，动作由 URL 的 bili= 选择。 */

export type BiliAction = "detail" | "comments" | "comments_search" | "media" | "article";
export type BiliCapability = "detail" | "comments" | "media" | "article";
export type MediaKind = "video" | "audio";

export interface BiliRef {
  bvid?: string;
  aid?: number;
  /** 分 P，1 起。 */
  page: number;
  /** 专栏 cv 号（纯数字）。 */
  cv?: string;
  /** 原始输入，后端可直接透传。 */
  raw: string;
}

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

export interface BiliProbe {
  ok: boolean;
  loggedIn: boolean;
  maxQuality?: string;
  hint?: string;
  error?: string;
}

/** 一次路由尝试，随结果返回给 agent。 */
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
  | "BILI_DOWNLOAD_FAIL"
  | "BILI_INVALID_URL"
  | "BILI_PARTIAL";

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
  media(ref: BiliRef, opts: { kind: MediaKind; quality: string }): Promise<BiliStream>;
  article(ref: BiliRef): Promise<BiliArticle>;
}

export interface BiliCommentStore {
  upsertPage(input: { bvid: string; page: number; items: BiliComment[]; hasMore: boolean }): void;
  syncState(bvid: string): { nextPage: number; finished: boolean };
  search(bvid: string, keyword: string, opts?: { mid?: number; limit?: number }): BiliComment[];
  count(bvid: string): number;
  close(): void;
}

export type BiliDispatch =
  | { kind: "text"; text: string; contentType: string }
  | { kind: "media"; stream: BiliStream };
