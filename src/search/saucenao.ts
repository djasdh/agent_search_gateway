import type { SearxngResult } from "./searxng.js";
import { classifyFetchError, type ImageInput, type SourceCall } from "./sources.js";

/**
 * SauceNAO 附加源（ADR-0012）：**插画 / 同人图出处**（Pixiv / Danbooru / Twitter …）。
 *
 * 官方 JSON API（需注册拿 `api_key`；**匿名 key 不允许 API 调用**，实测返回
 * `{"header":{"status":-1,"message":"The anonymous account type does not permit API usage."}}`）：
 *
 *   POST https://saucenao.com/search.php?<params>      ← 参数走查询串（URL 输入也走 POST）
 *     output_type=2 / db=999(全库) / numres / minsim / hide=0 / api_key
 *     输入：url=<图片URL>（查询参数）  或  multipart 字段 file=<bytes>（本地直传，不经图床）
 *   响应：
 *     { header: { status, short_remaining, long_remaining, ... },
 *       results: [ { header: { similarity:"93.3", thumbnail, index_id, index_name, hidden },
 *                    data: { title|material|jp_name, author|member_name|…, ext_urls[],
 *                            pixiv_id?, pawoo_id?/pawoo_user_acct?, getchu_id?, source, … } } ] }
 *
 * 免费账号限额：**150 次/天、4 次/30 秒**（字段名与限额出处：官方 API 文档 +
 * kitUIN/PicImageSearch `engines/saucenao.py` / `model/saucenao.py`，MIT）。
 */

export interface SaucenaoOptions {
  /** 空 = 该源不启用（调用方负责判断）。 */
  apiKey: string;
  timeoutMs: number;
  maxResults: number;
  /** 相似度下限 0–100，用来挡低分噪音（默认 30）。 */
  minsim: number;
  baseUrl?: string;
}

interface SauceItemHeader {
  similarity?: string | number;
  thumbnail?: string;
  index_id?: number;
  index_name?: string;
  hidden?: number;
  [k: string]: unknown;
}

export interface SaucenaoItem {
  header?: SauceItemHeader;
  data?: Record<string, unknown>;
}

export interface SaucenaoResponse {
  header?: Record<string, unknown>;
  results?: SaucenaoItem[];
}

/** data 里的标题字段优先级（与参考实现一致）。 */
const TITLE_KEYS = ["title", "material", "jp_name", "eng_name", "source", "created_at"];
/** data 里的作者字段优先级。 */
const AUTHOR_KEYS = [
  "author",
  "member_name",
  "creator",
  "twitter_user_handle",
  "pawoo_user_display_name",
  "author_name",
  "user_name",
  "artist",
  "company",
];

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

function pickTitle(data: Record<string, unknown>): string | undefined {
  for (const k of TITLE_KEYS) {
    const s = asString(data[k]);
    if (s) return s;
  }
  return undefined;
}

function pickAuthor(data: Record<string, unknown>): string | undefined {
  for (const k of AUTHOR_KEYS) {
    const v = data[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
    if (Array.isArray(v)) {
      const parts = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
      if (parts.length > 0) return parts.join(", ");
    }
  }
  return undefined;
}

/** 出处页 URL：按平台 id 构造，退到 ext_urls[0]。 */
function pickUrl(data: Record<string, unknown>): string | undefined {
  if (typeof data.pixiv_id === "number" || asString(data.pixiv_id)) {
    return `https://www.pixiv.net/artworks/${String(data.pixiv_id)}`;
  }
  if (asString(data.pawoo_id) && asString(data.pawoo_user_acct)) {
    return `https://pawoo.net/@${String(data.pawoo_user_acct)}/${String(data.pawoo_id)}`;
  }
  if (asString(data.getchu_id)) {
    return `https://www.getchu.com/soft.phtml?id=${String(data.getchu_id)}`;
  }
  const exts = data.ext_urls;
  if (Array.isArray(exts)) {
    for (const u of exts) {
      const s = asString(u);
      if (s) return s;
    }
  }
  return undefined;
}

/** 单条 SauceNAO 结果 → 线格式；相似度低于 `minsim` 或没有可用 URL 时丢弃。 */
function itemToResult(item: SaucenaoItem, minsim: number): SearxngResult | undefined {
  const header = item.header ?? {};
  const data = item.data ?? {};
  const similarity = Number(header.similarity);
  if (!Number.isFinite(similarity) || similarity < minsim) return undefined;

  const thumbnail = asString(header.thumbnail);
  const url = pickUrl(data) ?? thumbnail;
  if (!url) return undefined;

  const indexName = asString(header.index_name);
  const author = pickAuthor(data);
  const title = pickTitle(data) ?? indexName ?? "SauceNAO 匹配";
  const detail: string[] = [`相似度 ${similarity.toFixed(1)}%`];
  if (indexName) detail.push(indexName);
  if (author) detail.push(`作者 ${author}`);

  return {
    url,
    title,
    content: detail.join(" · "),
    engine: "saucenao",
    score: similarity / 100,
    img_src: thumbnail,
    thumbnail_src: thumbnail,
    category: "search_by_image",
  };
}

/** SauceNAO 响应 → 候选：按相似度降序取前 N（去重交给 `unionResults`）。 */
export function saucenaoToResults(resp: SaucenaoResponse, maxResults: number, minsim: number): SearxngResult[] {
  const items = Array.isArray(resp.results) ? resp.results : [];
  return items
    .map((it) => itemToResult(it, minsim))
    .filter((r): r is SearxngResult => r !== undefined)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, Math.max(0, maxResults));
}

function toInt(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}

/**
 * 调 SauceNAO API。失败不抛裸异常，返回结构化错误（与其它附加源同形）。
 * URL 输入 → `url=` 查询参数；本地图 → multipart 字段 `file`（直传，不经图床）。
 */
export async function searchSaucenao(opts: SaucenaoOptions, input: ImageInput): Promise<SourceCall> {
  const base = (opts.baseUrl ?? "https://saucenao.com").replace(/\/+$/, "");
  const params = new URLSearchParams();
  params.set("output_type", "2");
  params.set("db", "999");
  params.set("numres", String(Math.max(1, Math.min(40, opts.maxResults))));
  params.set("minsim", String(opts.minsim));
  params.set("hide", "0");
  if (opts.apiKey) params.set("api_key", opts.apiKey);

  let body: FormData | undefined;
  if (input.kind === "url") {
    params.set("url", input.url);
  } else {
    const form = new FormData();
    form.append("file", new Blob([input.bytes as BlobPart], { type: input.mime }), input.filename);
    body = form;
  }

  const start = Date.now();
  try {
    const res = await fetch(`${base}/search.php?${params.toString()}`, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(opts.timeoutMs),
      redirect: "follow",
    });
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      return { ok: false, error: { kind: "http", status: res.status, message: `SauceNAO HTTP ${res.status}` } };
    }
    let data: SaucenaoResponse;
    try {
      data = (await res.json()) as SaucenaoResponse;
    } catch {
      return { ok: false, error: { kind: "invalid_json", message: "SauceNAO 返回非 JSON" } };
    }
    const header = data.header ?? {};
    const status = toInt(header.status);
    // status < 0：key 无效 / 匿名不允许 / 超额等业务拒绝
    if (status !== undefined && status < 0) {
      const msg = asString(header.message) ?? `status=${status}`;
      return { ok: false, error: { kind: "api", message: `SauceNAO 拒绝：${msg}` } };
    }
    return {
      ok: true,
      results: saucenaoToResults(data, opts.maxResults, opts.minsim),
      latencyMs,
      remaining: { short: toInt(header.short_remaining), long: toInt(header.long_remaining) },
    };
  } catch (err) {
    return { ok: false, error: classifyFetchError(err, opts.timeoutMs, "SauceNAO") };
  }
}
