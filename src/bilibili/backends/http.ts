import type { GatewayConfig } from "../../config.js";
import type { Logger } from "../../logger.js";
import { httpFailure } from "../errors.js";
import { asArray, asRecord, asString, num, numRecord, pick, str } from "../json.js";
import { ManagedProcess } from "../process.js";
import {
  BiliError, type BiliArticle, type BiliAudio, type BiliBackend, type BiliCapability,
  type BiliComment, type BiliCommentPage, type BiliDetail, type BiliPage, type BiliProbe,
  type BiliRef,
} from "../types.js";

/** HTTP 后端：契约见 README，响应兼容 `{ok:true,data}` 与直接数据对象。 */
export const HTTP_ID = "http";
type Query = Record<string, string | number | undefined>;

function mapProbe(raw: unknown): BiliProbe {
  const src = asRecord(raw);
  return {
    ok: src?.ok !== false,
    loggedIn: (src?.loggedIn ?? src?.logged_in) === true,
    hint: str(src, "hint"),
  };
}

function mapPages(raw: unknown): BiliPage[] {
  return (Array.isArray(raw) ? raw : []).map((item, index) => {
    const page = asRecord(item) ?? {};
    return { page: num(page, "page", "p") ?? index + 1, title: str(page, "title", "part") ?? "" };
  });
}

function mapDetail(raw: unknown, ref: BiliRef): BiliDetail {
  const outer = asRecord(raw) ?? {};
  const src = asRecord(outer.detail) ?? outer;
  const owner = asRecord(src.owner) ?? {};
  const bvid = str(src, "bvid", "bv_id") ?? ref.bvid ?? "";
  const pages = mapPages(src.pages);
  if (pages.length === 0) pages.push({ page: ref.page, title: str(src, "title") ?? "" });
  return {
    bvid,
    aid: num(src, "aid", "avid"),
    title: str(src, "title") ?? "",
    desc: str(src, "desc", "description") ?? "",
    owner: { mid: num(owner, "mid", "uid"), name: str(owner, "name", "uname") },
    stat: numRecord(pick(src, "stat", "stats")),
    cover: str(src, "cover", "pic"),
    pages,
    currentPage: ref.page,
    pageCount: pages.length,
  };
}

function mapComment(raw: unknown): BiliComment {
  const src = asRecord(raw) ?? {};
  const member = asRecord(pick(src, "member", "user")) ?? {};
  const content = pick(src, "content");
  const replies = pick(src, "replies");
  return {
    rpid: num(src, "rpid", "id") ?? 0,
    root: num(src, "root", "root_id") ?? null,
    parent: num(src, "parent", "parent_id") ?? null,
    mid: num(member, "mid", "uid") ?? num(src, "mid") ?? 0,
    uname: str(member, "uname", "name") ?? str(src, "uname") ?? "",
    content: asString(content) ?? str(asRecord(content), "message") ?? str(src, "message") ?? "",
    like: num(src, "like", "like_count") ?? 0,
    ctime: num(src, "ctime", "create_time") ?? 0,
    replies: Array.isArray(replies) ? replies.map(mapComment) : undefined,
  };
}

function mapCommentPage(raw: unknown, ref: BiliRef, fallback: number): BiliCommentPage {
  const src = asRecord(raw) ?? {};
  const items = Array.isArray(src.items) ? src.items : Array.isArray(src.replies) ? src.replies : [];
  const page = num(src, "page", "p") ?? fallback;
  const next = num(src, "nextPage", "next_page");
  const more = pick(src, "hasMore", "has_more");
  return {
    bvid: str(src, "bvid") ?? (ref.bvid ?? (ref.cv ? `cv${ref.cv}` : "")),
    page,
    total: num(src, "total", "total_count"),
    hasMore: typeof more === "boolean" ? more : next !== undefined ? next > page : false,
    nextPage: next,
    items: items.map(mapComment),
  };
}

function mapAudio(raw: unknown): BiliAudio {
  const outer = asRecord(raw) ?? {};
  const src = asRecord(outer.audio) ?? outer;
  const dash = asRecord(src.dash) ?? asRecord(outer.dash);
  const stream = asRecord(asArray(dash?.audio)[0]);
  const durl = asRecord(asArray(src.durl)[0]);
  const url = str(src, "url", "baseUrl", "base_url", "play_url")
    ?? str(stream, "baseUrl", "base_url", "url")
    ?? str(durl, "url");
  if (!url) throw new BiliError("BILI_UNAVAILABLE", "Bilibili HTTP 后端未返回音频直链");
  return { url };
}

const cvOf = (raw: string): string | undefined => /cv(\d+)/i.exec(raw)?.[1] ?? (/^\d+$/.test(raw.trim()) ? raw.trim() : undefined);

function mapArticle(raw: unknown, ref: BiliRef): BiliArticle {
  const outer = asRecord(raw) ?? {};
  const src = asRecord(outer.article) ?? outer;
  const meta = asRecord(src.meta);
  const cover = str(src, "cover", "banner_url") ?? str(meta, "cover");
  return {
    cv: str(src, "cv", "cvid") ?? ref.cv ?? cvOf(ref.raw) ?? "",
    title: str(src, "title"),
    content: str(src, "content", "body", "text") ?? "",
    meta: cover ? { ...meta, cover } : meta,
  };
}

class HttpBackend implements BiliBackend {
  readonly id = HTTP_ID;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly managed?: ManagedProcess;
  private ready = false;
  private readying: Promise<void> | null = null;

  constructor(config: GatewayConfig, logger?: Logger) {
    const http = config.bilibili.http;
    this.baseUrl = http.baseUrl;
    this.token = http.token;
    this.timeoutMs = http.requestTimeoutMs;
    this.startupTimeoutMs = http.startupTimeoutMs;
    this.managed = http.command.length > 0
      ? new ManagedProcess({ command: http.command, env: http.token ? { BILI_HTTP_TOKEN: http.token } : undefined, logger })
      : undefined;
  }

  supports(_cap: BiliCapability): boolean { return true; }

  async probe(): Promise<BiliProbe> {
    try {
      return mapProbe(await this.request("/health", {}));
    } catch (err) {
      return { ok: false, loggedIn: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async detail(ref: BiliRef): Promise<BiliDetail> {
    return mapDetail(await this.request("/detail", { target: ref.raw }), ref);
  }

  async comments(ref: BiliRef, opts: { page: number; sort: "hot" | "time" }): Promise<BiliCommentPage> {
    return mapCommentPage(
      await this.request("/comments", { target: ref.raw, page: opts.page, sort: opts.sort }),
      ref,
      opts.page,
    );
  }

  async audio(ref: BiliRef): Promise<BiliAudio> {
    return mapAudio(await this.request("/playurl", { target: ref.raw, kind: "audio", p: ref.page }));
  }

  async article(ref: BiliRef): Promise<BiliArticle> {
    return mapArticle(await this.request("/article", { cv: ref.cv ?? cvOf(ref.raw) ?? "" }), ref);
  }

  dispose(): Promise<void> { return this.managed?.dispose() ?? Promise.resolve(); }

  private async ensureReady(): Promise<void> {
    if (this.managed) {
      await this.managed.ensureStarted(`${this.baseUrl}/health`, this.startupTimeoutMs);
      return;
    }
    if (this.ready) return;
    if (!this.readying) {
      this.readying = this.send("/health", {}).then((res) => {
        if (!res.ok || asRecord(res.body)?.ok === false) throw httpFailure(res.status, res.body, "/health");
        this.ready = true;
      }).finally(() => { this.readying = null; });
    }
    await this.readying;
  }

  private async request(path: string, params: Query): Promise<unknown> {
    await this.ensureReady();
    const res = await this.send(path, params);
    if (!res.ok) throw httpFailure(res.status, res.body, path);
    if (res.body === undefined) throw new BiliError("BILI_UNAVAILABLE", `Bilibili HTTP 后端返回了非 JSON 响应（${path}）`);
    const body = asRecord(res.body);
    if (body?.ok === false) throw httpFailure(res.status, res.body, path);
    return body?.ok === true && "data" in body ? body.data : res.body;
  }

  private async send(path: string, params: Query): Promise<{ ok: boolean; status: number; body: unknown }> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.token) headers.authorization = `Bearer ${this.token}`;
      const res = await fetch(url, { headers, signal: controller.signal });
      const text = await res.text();
      let body: unknown;
      try { body = text.trim() ? JSON.parse(text) : undefined; } catch { body = undefined; }
      return { ok: res.status >= 200 && res.status < 300, status: res.status, body };
    } catch (err) {
      if (controller.signal.aborted) throw new BiliError("BILI_UNAVAILABLE", `请求 Bilibili HTTP 后端超时（${this.timeoutMs}ms，${path}）`, "可调大 bilibili.http.request_timeout_ms");
      throw new BiliError("BILI_UNAVAILABLE", `无法连接 Bilibili HTTP 后端（${path}）：${err instanceof Error ? err.message : String(err)}`, "请确认 bilibili.http.base_url 可达，或配置 bilibili.http.command 托管启动");
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createHttpBackend(config: GatewayConfig, logger?: Logger): BiliBackend & { dispose(): Promise<void> } {
  return new HttpBackend(config, logger);
}
