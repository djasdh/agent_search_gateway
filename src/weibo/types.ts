/** 微博取件：动作、错误与结果类型。单 CLI 后端（OpenCLI），不做多后端路由。 */

export type WeiboAction = "post" | "comments" | "user" | "user-posts";

export type WeiboErrorCode =
  | "WEIBO_UNAVAILABLE"
  | "WEIBO_INVALID"
  | "WEIBO_EMPTY"
  | "WEIBO_AUTH_REQUIRED"
  | "WEIBO_BRIDGE_DOWN"
  | "WEIBO_TIMEOUT"
  | "WEIBO_CONFIG"
  | "WEIBO_BAD_JSON"
  | "WEIBO_IMAGE_FAIL";

export interface WeiboRef {
  action: WeiboAction;
  /** numeric idstr 或 mblogid，视动作而定。 */
  id?: string;
  mblogid?: string;
  uid?: string;
  screenName?: string;
  limit?: number;
  /** 时间段抓取：已解析成绝对日期（YYYY-MM-DD，Asia/Shanghai）。 */
  start?: string;
  end?: string;
  /** 原始 `days` 参数；仅用于缓存 key 与日志。 */
  days?: number;
  /** 本次返回的微博条数上限。 */
  maxItems?: number;
  includeRetweets?: boolean;
}

/** user-posts 的单条微博（列名与 OpenCLI 输出保持一致）。 */
export interface WeiboPost {
  id?: string;
  mblogid?: string;
  author?: string;
  uid?: string;
  text?: string;
  time?: string;
  reposts?: number;
  comments?: number;
  likes?: number;
  picCount?: number;
  url?: string;
}

export interface WeiboImage {
  url: string;
  large?: string;
  width?: number;
  height?: number;
}

export class WeiboError extends Error {
  constructor(
    public readonly code: WeiboErrorCode,
    message: string,
    public readonly hint?: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "WeiboError";
  }
}

export type { CliResult } from "../fetch/channels/types.js";
