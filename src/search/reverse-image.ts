import { normalizeUrlKey, resultEngines } from "./clean.js";
import type { SearxngResult } from "./searxng.js";

/**
 * 反向图搜（以图搜图）的**网关侧附加源**（ADR-0010）。
 *
 * 触发类别（默认 `search_by_image`）由两边共同满足：searxng 侧由 tineye 引擎
 * 承担（`settings.yml` 给引擎声明该类别即可，网关不点名引擎），网关侧再并发
 * 扇出 trace.moe。两边产出统一成 `SearxngResult` 线格式后按 URL 去重合并，
 * 之后进现有排序尾部 —— 网关不新增源级路由，也不做跨源融合打分。
 *
 * 契约：「图就是 query」。searxng 的 `online_url_search` 只在 query 里出现
 * `http(s)://…` 时触发，trace.moe 也从同一处取图片 URL，因此**同一个 query**
 * 就是图片 URL 本身；本模块不做任何额外输入字段。
 */

/** 从 query 里抠图片 URL：与 searxng `online_url_search` 的 `search_syntax.http` 同形。 */
export const IMAGE_URL_RE = /https?:\/\/[^ ]*/;

export function extractImageUrl(query: string): string | undefined {
  const m = IMAGE_URL_RE.exec(query ?? "");
  return m ? m[0] : undefined;
}

// ── trace.moe（api.trace.moe，免 key） ──
// 文档: https://soruly.github.io/trace.moe-api/
// 限制: 免费额度按 IP 计（100 次/日）、并发 1；ToS 禁商用转售。
// 参数只用了实测确认过的 `url` 与 `anilistInfo`（后者带回标题/站点链接）。

export interface TraceMoeTitle {
  native?: string;
  romaji?: string;
  chinese?: string;
  english?: string;
}

export interface TraceMoeAnime {
  id?: number;
  idMal?: number;
  title?: TraceMoeTitle;
  siteUrl?: string;
  format?: string;
  isAdult?: boolean;
}

export interface TraceMoeMatch {
  /** `anilistInfo=1` 时是对象；不带该参数时是纯数字 id。 */
  anilist?: TraceMoeAnime | number;
  filename?: string;
  episode?: number | string | null;
  from?: number;
  at?: number;
  to?: number;
  duration?: number;
  similarity?: number;
  /** 匹配帧的预览视频（mp4）。 */
  video?: string;
  /** 匹配帧的预览图（jpeg）。 */
  image?: string;
}

export interface TraceMoeResponse {
  /** 每日配额上限。 */
  quota?: number;
  quotaUsed?: number;
  frameCount?: number;
  /** 业务错误（HTTP 200 也可能是错误，如 "Invalid image url"）。 */
  error?: string;
  result?: TraceMoeMatch[];
}

export interface TraceMoeError {
  kind: "timeout" | "http" | "network" | "invalid_json" | "api";
  status?: number;
  message: string;
}

export type TraceMoeCall =
  | { ok: true; results: SearxngResult[]; latencyMs: number; quota?: number; quotaUsed?: number }
  | { ok: false; error: TraceMoeError };

/** 秒 → `mm:ss` / `hh:mm:ss`。 */
function formatTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function animeTitle(title: TraceMoeTitle | undefined): string | undefined {
  for (const t of [title?.chinese, title?.romaji, title?.native, title?.english]) {
    if (typeof t === "string" && t.trim().length > 0) return t.trim();
  }
  return undefined;
}

/** 文件名去扩展名（仅作标题兜底）。 */
function stripExtension(filename: string | undefined): string | undefined {
  if (!filename) return undefined;
  const t = filename.replace(/\.[a-z0-9]{2,5}$/i, "").trim();
  return t.length > 0 ? t : undefined;
}

/** 单条 trace.moe 匹配 → `SearxngResult` 线格式。 */
function toSearxngResult(m: TraceMoeMatch): SearxngResult {
  const anime = typeof m.anilist === "object" && m.anilist !== null ? m.anilist : undefined;
  const animeId = anime?.id ?? (typeof m.anilist === "number" ? m.anilist : undefined);

  const episode = m.episode === null || m.episode === undefined ? undefined : String(m.episode);
  const base = animeTitle(anime?.title) ?? stripExtension(m.filename) ?? "动画截图匹配";
  const detail: string[] = [];
  if (typeof m.similarity === "number") detail.push(`相似度 ${(m.similarity * 100).toFixed(1)}%`);
  if (episode) detail.push(`第 ${episode} 集`);
  if (typeof m.at === "number") detail.push(`出现于 ${formatTime(m.at)}`);
  const fallbackName = stripExtension(m.filename);
  if (fallbackName && fallbackName !== base) detail.push(`文件名 ${m.filename}`);

  return {
    // 来源页：优先 AniList 条目页；无 AniList 信息时退到匹配帧的预览视频。
    url: anime?.siteUrl ?? (animeId ? `https://anilist.co/anime/${animeId}` : m.video ?? m.image),
    title: episode ? `${base} · 第 ${episode} 集` : base,
    content: detail.join(" · "),
    engine: "tracemoe",
    score: typeof m.similarity === "number" ? m.similarity : undefined,
    img_src: m.image,
    thumbnail_src: m.image,
    category: "search_by_image",
  };
}

/**
 * trace.moe 响应 → 候选列表：按相似度降序取前 N。
 *
 * 同一帧常被多个压制组各自收录（similarity 相同、AniList id 相同），后续
 * `unionResults`/`cleanResults` 会按 URL 去重，因此这里只需保证**高分在前**，
 * 让去重后留下的是最像的那条。
 */
export function traceMoeToResults(resp: TraceMoeResponse, maxResults: number): SearxngResult[] {
  const matches = Array.isArray(resp.result) ? resp.result : [];
  return matches
    .filter((m) => typeof m?.image === "string" && m.image.length > 0)
    .slice()
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
    .slice(0, Math.max(0, maxResults))
    .map(toSearxngResult);
}

/**
 * 按 query 里的图片 URL 调 trace.moe。失败不抛裸异常，返回结构化错误
 * （与 `searchSearxng` 同风格），调用方据此决定是否附提示。
 */
export async function searchTraceMoe(
  baseUrl: string,
  timeoutMs: number,
  imageUrl: string,
  maxResults: number,
): Promise<TraceMoeCall> {
  const params = new URLSearchParams();
  params.set("url", imageUrl);
  params.set("anilistInfo", "1");
  const url = `${baseUrl.replace(/\/+$/, "")}/search?${params.toString()}`;

  const start = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      return { ok: false, error: { kind: "http", status: res.status, message: `trace.moe HTTP ${res.status}` } };
    }
    let data: TraceMoeResponse;
    try {
      data = (await res.json()) as TraceMoeResponse;
    } catch {
      return { ok: false, error: { kind: "invalid_json", message: "trace.moe 返回非 JSON" } };
    }
    // HTTP 200 带 error：图不可取（下载失败/格式不支持/无特征）等业务错误
    if (typeof data.error === "string" && data.error.length > 0) {
      const quotaNote =
        data.quota && data.quotaUsed !== undefined ? `（配额 ${data.quotaUsed}/${data.quota}）` : "";
      return { ok: false, error: { kind: "api", message: `${data.error}${quotaNote}` } };
    }
    return {
      ok: true,
      results: traceMoeToResults(data, maxResults),
      latencyMs,
      quota: data.quota,
      quotaUsed: data.quotaUsed,
    };
  } catch (err) {
    const aborted = (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";
    return {
      ok: false,
      error: aborted
        ? { kind: "timeout", message: `trace.moe 请求超时 (>${timeoutMs}ms)` }
        : { kind: "network", message: err instanceof Error ? err.message : String(err) },
    };
  }
}

/**
 * 合并多源候选：按规范化 URL 去重，同 URL 的**引擎归属取并集**
 * （写进 `engines[]`，`engine` 保留首个）。顺序稳定：主源在前，附加源在后。
 */
export function unionResults(base: SearxngResult[], extra: SearxngResult[]): SearxngResult[] {
  const out: SearxngResult[] = [];
  const index = new Map<string, number>();
  for (const r of [...base, ...extra]) {
    const key = normalizeUrlKey(String(r.url ?? ""));
    const at = index.get(key);
    if (at === undefined) {
      index.set(key, out.length);
      out.push(r);
      continue;
    }
    const engines = [...new Set([...resultEngines(out[at]), ...resultEngines(r)])];
    out[at] = { ...out[at], engines };
  }
  return out;
}
