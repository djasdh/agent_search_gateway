import type { GatewayConfig } from "../../config.js";
import type { Logger } from "../../logger.js";
import { BiliError } from "../types.js";
import type {
  BiliArticle,
  BiliBackend,
  BiliCapability,
  BiliComment,
  BiliCommentPage,
  BiliDetail,
  BiliErrorCode,
  BiliProbe,
  BiliRef,
  BiliStream,
  MediaKind,
} from "../types.js";
import { ManagedProcess } from "../process.js";

/**
 * 托管 HTTP 后端。
 *
 * 与后端服务的契约（GET，JSON）：
 *   /health   → { ok, loggedIn, maxQuality? }
 *   /detail   ? target=<原始输入>
 *   /comments ? target=&page=&sort=
 *   /playurl  ? target=&kind=video|audio&quality=&p=
 *   /article  ? cv=
 *
 * 响应可以是 `{ ok: true, data: ... }` / `{ ok: false, error: { code, message, hint } }`，
 * 也可以直接返回数据对象（无 ok 包装）。后端只负责抓取和归一化，核心层不做 B 站接口调用。
 *
 * 进程策略：
 * - 构造时不启动；首次请求前调用 ensureReady；
 * - `command` 非空 → ManagedProcess 拉起并健康门禁；
 * - `command` 为空 → 视为常驻服务，只探活一次（失败的下次请求会重试）。
 */

export const HTTP_ID = "http";

const BILI_ERROR_CODES: readonly BiliErrorCode[] = [
  "BILI_UNAVAILABLE",
  "BILI_AUTH_REQUIRED",
  "BILI_CAPABILITY_UNSUPPORTED",
  "BILI_RISK_CONTROL",
  "BILI_DOWNLOAD_FAIL",
  "BILI_INVALID_URL",
  "BILI_PARTIAL",
];

type JsonObject = Record<string, unknown>;
type QueryValue = string | number | undefined;

interface JsonResponse {
  status: number;
  body: unknown;
  text: string;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

/** 取第一个非 null/undefined 的字段。 */
function pick(src: JsonObject, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = src[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim().length > 0 ? value : undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function str(src: JsonObject, ...keys: string[]): string | undefined {
  return asString(pick(src, ...keys));
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function num(src: JsonObject, ...keys: string[]): number | undefined {
  return asNumber(pick(src, ...keys));
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true" || lower === "1") return true;
    if (lower === "false" || lower === "0") return false;
  }
  return undefined;
}

function bool(src: JsonObject, ...keys: string[]): boolean | undefined {
  return asBoolean(pick(src, ...keys));
}

/** 时间字段：字符串原样保留；数字按 B 站惯例当作秒级时间戳转 ISO。 */
function asDateString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value;
  const seconds = asNumber(value);
  if (seconds === undefined) return undefined;
  const ms = seconds > 1e12 ? seconds : seconds * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function asNumberRecord(value: unknown): Record<string, number> | undefined {
  if (!isObject(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    const parsed = asNumber(raw);
    if (parsed !== undefined) out[key] = parsed;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim().length > 0) {
      out.push(item);
    } else if (isObject(item)) {
      const tag = asString(pick(item, "tag_name", "name", "title", "tag"));
      if (tag !== undefined) out.push(tag);
    }
  }
  return out;
}

function normalizeErrorCode(raw: string | undefined): BiliErrorCode | undefined {
  if (!raw) return undefined;
  const upper = raw.trim().toUpperCase();
  if (upper.length === 0) return undefined;
  const full = upper.startsWith("BILI_") ? upper : `BILI_${upper}`;
  return BILI_ERROR_CODES.includes(full as BiliErrorCode) ? (full as BiliErrorCode) : undefined;
}

function extractMessage(body: JsonObject): string | undefined {
  if (isObject(body.error)) {
    const message = asString(body.error.message);
    if (message) return message;
  }
  return asString(body.message) ?? asString(body.error);
}

/** 后端业务错误（`{ ok:false, error:{...} }`）→ BiliError。 */
function errorFromEnvelope(body: JsonObject, path: string): BiliError {
  const error = asObject(body.error);
  const rawCode = asString(error.code) ?? asString(body.code);
  const message =
    asString(error.message) ??
    asString(body.message) ??
    asString(body.error) ??
    `Bilibili HTTP 后端返回失败（${path}）`;
  const hint = asString(error.hint) ?? asString(body.hint);
  const detail: Record<string, unknown> = { path };
  if (rawCode) detail.backendCode = rawCode;
  return new BiliError(normalizeErrorCode(rawCode) ?? "BILI_UNAVAILABLE", message, hint, detail);
}

/** HTTP 状态码 → 统一错误码。 */
function httpStatusError(status: number, body: unknown, path: string): BiliError {
  const backendMessage = isObject(body) ? extractMessage(body) : undefined;
  const suffix = backendMessage ? `：${backendMessage.slice(0, 300)}` : "";
  const detail: Record<string, unknown> = { path, status };

  if (status === 401 || status === 403) {
    return new BiliError(
      "BILI_AUTH_REQUIRED",
      `Bilibili HTTP 后端鉴权失败（HTTP ${status}${suffix}）`,
      "请检查 bilibili.http.token，或确认后端的 B 站登录态",
      detail,
    );
  }
  if (status === 412) {
    return new BiliError(
      "BILI_RISK_CONTROL",
      `Bilibili 触发风控（HTTP 412${suffix}）`,
      "稍后重试，或降低请求频率/更换出口 IP",
      detail,
    );
  }
  if (status === 404) {
    return new BiliError(
      "BILI_UNAVAILABLE",
      `Bilibili HTTP 后端不支持该能力或资源不存在（HTTP 404${suffix}）`,
      "该后端可能未实现此接口",
      detail,
    );
  }
  return new BiliError(
    "BILI_UNAVAILABLE",
    `Bilibili HTTP 后端请求失败（HTTP ${status}${suffix}）`,
    undefined,
    detail,
  );
}

/** 兼容 `{ok:true,data}` 与直接数据对象两种响应。 */
function unwrapEnvelope<T>(body: unknown, path: string): T {
  if (isObject(body) && body.ok === false) throw errorFromEnvelope(body, path);
  if (isObject(body) && body.ok === true && "data" in body) return body.data as T;
  return body as T;
}

function extractCv(raw: string): string | undefined {
  const matched = /cv(\d+)/i.exec(raw);
  if (matched) return matched[1];
  const trimmed = raw.trim();
  return /^\d+$/.test(trimmed) ? trimmed : undefined;
}

function mapProbe(raw: unknown): BiliProbe {
  const src = asObject(raw);
  const ok = bool(src, "ok") ?? true;
  const loggedIn = bool(src, "loggedIn", "logged_in", "login") ?? false;
  const maxQuality = str(src, "maxQuality", "max_quality", "quality");
  const hint = str(src, "hint");
  const probe: BiliProbe = { ok, loggedIn };
  if (maxQuality !== undefined) probe.maxQuality = maxQuality;
  if (hint !== undefined) probe.hint = hint;
  return probe;
}

function mapDetail(raw: unknown, ref: BiliRef): BiliDetail {
  const outer = asObject(raw);
  // 部分后端会把详情再包一层 detail；合并时以更具体的一层为准。
  const src = isObject(outer.detail) ? { ...outer, ...outer.detail } : outer;

  const bvid = str(src, "bvid", "bv_id", "bvid_str") ?? ref.bvid ?? "";
  const aid = num(src, "aid", "avid", "av");
  const title = str(src, "title") ?? "";
  const desc = str(src, "desc", "description", "intro") ?? "";

  const ownerRaw = pick(src, "owner", "author", "up", "up_info");
  const ownerObj = asObject(ownerRaw);
  const owner: BiliDetail["owner"] = {};
  const ownerMid =
    num(ownerObj, "mid", "uid") ?? (isObject(ownerRaw) ? undefined : num(src, "mid", "uid"));
  const ownerName =
    str(ownerObj, "name", "uname") ??
    (typeof ownerRaw === "string" ? asString(ownerRaw) : undefined) ??
    str(src, "author", "up_name", "uname");
  if (ownerMid !== undefined) owner.mid = ownerMid;
  if (ownerName !== undefined) owner.name = ownerName;

  const zoneObj = asObject(src.zone);
  const zone: NonNullable<BiliDetail["zone"]> = {};
  const tid = num(zoneObj, "tid", "id") ?? num(src, "tid");
  const zoneName = str(zoneObj, "name", "tname") ?? str(src, "tname", "zone_name");
  if (tid !== undefined) zone.tid = tid;
  if (zoneName !== undefined) zone.name = zoneName;

  const pagesRaw = pick(src, "pages", "page_list", "video_pages");
  const pages: BiliDetail["pages"] = [];
  if (Array.isArray(pagesRaw)) {
    pagesRaw.forEach((item, index) => {
      const pageSrc = asObject(item);
      const page: BiliDetail["pages"][number] = {
        page: num(pageSrc, "page", "page_no", "page_number", "p") ?? index + 1,
      };
      const cid = num(pageSrc, "cid");
      if (cid !== undefined) page.cid = cid;
      const pageTitle = str(pageSrc, "title", "part", "name");
      if (pageTitle !== undefined) page.title = pageTitle;
      const pageDuration = num(pageSrc, "duration");
      if (pageDuration !== undefined) page.duration = pageDuration;
      pages.push(page);
    });
  }

  const detail: BiliDetail = { bvid, title, desc, owner, pages, url: "" };
  const url = str(src, "url", "link") ?? (bvid ? `https://www.bilibili.com/video/${bvid}` : "");
  detail.url = url;

  if (aid !== undefined) detail.aid = aid;
  const pubdate = asDateString(pick(src, "pubdate", "pub_time", "ctime", "publish_time"));
  if (pubdate !== undefined) detail.pubdate = pubdate;
  const duration = num(src, "duration");
  if (duration !== undefined) detail.duration = duration;
  if (Object.keys(zone).length > 0) detail.zone = zone;
  const stat = asNumberRecord(pick(src, "stat", "stats"));
  if (stat !== undefined) detail.stat = stat;
  const cover = str(src, "cover", "pic", "pic_url");
  if (cover !== undefined) detail.cover = cover;
  const tags = asStringArray(pick(src, "tags", "tag_list"));
  if (tags !== undefined) detail.tags = tags;

  return detail;
}

function mapComment(raw: unknown): BiliComment {
  const src = asObject(raw);
  const member = asObject(pick(src, "member", "user"));
  const contentRaw = pick(src, "content");
  const contentObj = asObject(contentRaw);

  const comment: BiliComment = {
    rpid: num(src, "rpid", "id", "rpid_str") ?? 0,
    mid: num(member, "mid", "uid") ?? num(src, "mid", "uid") ?? 0,
    uname: str(member, "uname", "name") ?? str(src, "uname", "name", "user_name") ?? "",
    content:
      str(contentObj, "message") ??
      (typeof contentRaw === "string" ? asString(contentRaw) : undefined) ??
      str(src, "message") ??
      "",
    like: num(src, "like", "like_count") ?? 0,
    ctime: num(src, "ctime", "create_time", "time") ?? 0,
  };

  const root = num(src, "root", "root_id");
  if (root !== undefined) comment.root = root;
  const parent = num(src, "parent", "parent_id");
  if (parent !== undefined) comment.parent = parent;

  const replies = pick(src, "replies");
  if (Array.isArray(replies)) comment.replies = replies.map(mapComment);
  return comment;
}

function mapCommentPage(raw: unknown, ref: BiliRef, opts: { page: number }): BiliCommentPage {
  const src = asObject(raw);
  const itemsRaw = Array.isArray(src.items)
    ? src.items
    : Array.isArray(src.replies)
      ? src.replies
      : Array.isArray(raw)
        ? raw
        : [];

  const page = num(src, "page", "p") ?? opts.page;
  const total = num(src, "total", "total_count", "count");
  const nextPage = num(src, "nextPage", "next_page");
  const hasMore =
    bool(src, "hasMore", "has_more") ?? (nextPage !== undefined ? nextPage > page : false);

  const result: BiliCommentPage = {
    bvid: str(src, "bvid") ?? ref.bvid ?? "",
    page,
    hasMore,
    items: itemsRaw.map(mapComment),
  };
  if (total !== undefined) result.total = total;
  if (nextPage !== undefined) result.nextPage = nextPage;
  return result;
}

function mapStream(raw: unknown, kind: MediaKind): BiliStream {
  const outer = asObject(raw);
  // 兼容 data 里再按 kind 包一层（{ video: {...} } / { audio: {...} }）。
  const src = isObject(outer[kind]) ? { ...outer, ...outer[kind] } : outer;

  let url = str(src, "url", "baseUrl", "base_url", "play_url");
  if (url === undefined && Array.isArray(src.durl)) {
    url = str(asObject(src.durl[0]), "url", "base_url");
  }
  if (url === undefined) {
    throw new BiliError(
      "BILI_UNAVAILABLE",
      "Bilibili HTTP 后端未返回播放地址",
      "该视频可能需要登录，或后端 /playurl 实现不完整",
    );
  }

  const stream: BiliStream = {
    url,
    contentType: str(src, "contentType", "content_type", "mimeType", "mime", "type") ?? "",
  };
  const size = num(src, "size", "contentLength", "content_length");
  if (size !== undefined) stream.size = size;
  const quality = str(src, "quality", "qualityLabel", "quality_label");
  if (quality !== undefined) stream.quality = quality;
  return stream;
}

function mapArticle(raw: unknown, ref: BiliRef): BiliArticle {
  const outer = asObject(raw);
  const src = isObject(outer.article) ? { ...outer, ...outer.article } : outer;

  const article: BiliArticle = {
    cv: str(src, "cv", "cvid", "cv_id") ?? ref.cv ?? extractCv(ref.raw) ?? "",
    content: str(src, "content", "body", "text") ?? "",
  };
  const title = str(src, "title");
  if (title !== undefined) article.title = title;
  const meta = isObject(src.meta) ? src.meta : undefined;
  if (meta !== undefined) article.meta = meta;
  return article;
}

class HttpBackend implements BiliBackend {
  readonly id = HTTP_ID;

  private readonly baseUrl: string;
  private readonly token: string;
  private readonly requestTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly managed: ManagedProcess | null;
  private readonly logger?: Logger;

  private healthProbed = false;
  private healthProbe: Promise<void> | null = null;

  constructor(config: GatewayConfig, logger?: Logger) {
    const http = config.bilibili.http;
    this.baseUrl = http.baseUrl;
    this.token = http.token;
    this.requestTimeoutMs = http.requestTimeoutMs;
    this.startupTimeoutMs = http.startupTimeoutMs;
    this.logger = logger;
    this.managed =
      http.command.length > 0
        ? new ManagedProcess({
            command: http.command,
            env: { BILI_HTTP_TOKEN: http.token },
            logger,
          })
        : null;
  }

  supports(_cap: BiliCapability): boolean {
    // HTTP 后端按契约声明支持全部能力；具体某次请求是否可用由路由/后端决定。
    return true;
  }

  async probe(): Promise<BiliProbe> {
    try {
      await this.ensureReady();
      const res = await this.fetchJson("/health", {});
      if (res.status < 200 || res.status >= 300) {
        throw httpStatusError(res.status, res.body, "/health");
      }
      if (res.body === undefined) {
        throw new BiliError("BILI_UNAVAILABLE", "Bilibili HTTP 后端 /health 返回了非 JSON 响应");
      }
      return mapProbe(unwrapEnvelope<unknown>(res.body, "/health"));
    } catch (err) {
      return {
        ok: false,
        loggedIn: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async detail(ref: BiliRef): Promise<BiliDetail> {
    const data = await this.request<unknown>("/detail", { target: ref.raw });
    return mapDetail(data, ref);
  }

  async comments(
    ref: BiliRef,
    opts: { page: number; sort: "hot" | "time" },
  ): Promise<BiliCommentPage> {
    const data = await this.request<unknown>("/comments", {
      target: ref.raw,
      page: opts.page,
      sort: opts.sort,
    });
    return mapCommentPage(data, ref, { page: opts.page });
  }

  async media(ref: BiliRef, opts: { kind: MediaKind; quality: string }): Promise<BiliStream> {
    const data = await this.request<unknown>("/playurl", {
      target: ref.raw,
      kind: opts.kind,
      quality: opts.quality,
      p: ref.page,
    });
    return mapStream(data, opts.kind);
  }

  async article(ref: BiliRef): Promise<BiliArticle> {
    const data = await this.request<unknown>("/article", {
      cv: ref.cv ?? extractCv(ref.raw) ?? "",
    });
    return mapArticle(data, ref);
  }

  async dispose(): Promise<void> {
    await this.managed?.dispose();
  }

  /** 首次请求前的就绪检查：托管模式走进程启动，常驻模式只探活一次。 */
  private async ensureReady(): Promise<void> {
    if (this.managed) {
      await this.managed.ensureStarted(`${this.baseUrl}/health`, this.startupTimeoutMs);
      return;
    }
    if (this.healthProbed) return;
    if (!this.healthProbe) {
      this.healthProbe = this.checkHealth()
        .then(() => {
          this.healthProbed = true;
        })
        .finally(() => {
          this.healthProbe = null;
        });
    }
    await this.healthProbe;
  }

  private async checkHealth(): Promise<void> {
    const res = await this.fetchJson("/health", {});
    if (res.status < 200 || res.status >= 300) {
      throw httpStatusError(res.status, res.body, "/health");
    }
    if (isObject(res.body) && res.body.ok === false) {
      throw errorFromEnvelope(res.body, "/health");
    }
  }

  private async request<T>(path: string, params: Record<string, QueryValue>): Promise<T> {
    await this.ensureReady();
    const res = await this.fetchJson(path, params);
    if (res.status < 200 || res.status >= 300) {
      throw httpStatusError(res.status, res.body, path);
    }
    if (res.body === undefined) {
      throw new BiliError(
        "BILI_UNAVAILABLE",
        `Bilibili HTTP 后端返回了无法解析的响应（${path}）`,
        undefined,
        { preview: res.text.slice(0, 200) },
      );
    }
    return unwrapEnvelope<T>(res.body, path);
  }

  private buildUrl(path: string, params: Record<string, QueryValue>): string {
    const url = new URL(`${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async fetchJson(
    path: string,
    params: Record<string, QueryValue>,
  ): Promise<JsonResponse> {
    const url = this.buildUrl(path, params);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.token.length > 0) headers.authorization = `Bearer ${this.token}`;

      const res = await fetch(url, { headers, signal: controller.signal });
      const text = await res.text();

      let body: unknown;
      if (text.trim().length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = undefined;
        }
      }
      return { status: res.status, body, text };
    } catch (err) {
      if (controller.signal.aborted) {
        throw new BiliError(
          "BILI_UNAVAILABLE",
          `请求 Bilibili HTTP 后端超时（${this.requestTimeoutMs}ms，${path}）`,
          "可适当调大 bilibili.http.request_timeout_ms",
          { path, timeoutMs: this.requestTimeoutMs },
        );
      }
      throw new BiliError(
        "BILI_UNAVAILABLE",
        `无法连接 Bilibili HTTP 后端（${path}）: ${err instanceof Error ? err.message : String(err)}`,
        "请确认 bilibili.http.base_url 可达，或配置 bilibili.http.command 由插件托管启动",
        { path },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createHttpBackend(
  config: GatewayConfig,
  logger?: Logger,
): BiliBackend & { dispose(): Promise<void> } {
  return new HttpBackend(config, logger);
}
