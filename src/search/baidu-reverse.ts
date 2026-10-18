import type { SearxngResult } from "./searxng.js";
import { classifyFetchError, type ImageInput, type SourceCall } from "./sources.js";

/**
 * 百度识图附加源（ADR-0012）：**中文 / 国内图**反查。
 *
 * 无官方 API，走抓网页三步（已在本机实测跑通；字段名出处：kitUIN/PicImageSearch
 * `engines/baidu.py` / `model/baidu.py`，MIT）：
 *
 *   ① POST https://graph.baidu.com/upload    header `Acs-Token: ""`
 *        multipart：from=pc、image=<bytes>    → {"status":0,"msg":"Success","data":{"url":"…"}}
 *   ② GET  data.url → HTML，内含 `window.cardData = [...]`
 *   ③ 解析 cardData：
 *        cardName=="same"    → tplData.list[]{ url, image_src }  完全相同图
 *        cardName=="simipic" → tplData.firstUrl → GET → {data:{list:[{thumbUrl,fromUrl,width,height}]}} 相似图
 *
 * ⚠️ 抓取实现：百度改版 / 风控即失效。失败只报结构化错误，不拖垮其它源。
 * 注：本机实测发现 **纯 IPv6 出口会被百度 Reject**；网关的 `fetch`（undici 的
 * Happy Eyeballs）会挑 IPv4，正常。用 curl 调试时需加 `-4`。
 */

export interface BaiduReverseOptions {
  timeoutMs: number;
  maxResults: number;
  /** 图片大小上限（URL 输入时要先下载）。 */
  maxBytes: number;
  /** 覆盖服务基址（仅测试用）。 */
  baseUrl?: string;
}

export interface BaiduCard {
  cardName?: string;
  tplData?: Record<string, unknown>;
  [k: string]: unknown;
}

interface BaiduSimipicDetail {
  data?: { list?: unknown };
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** 从结果页 HTML 里抠出 `window.cardData` 数组；结构变化时返回 undefined。 */
export function extractBaiduCardData(html: string): BaiduCard[] | undefined {
  const m = /window\.cardData\s*=\s*(\[[\s\S]*?\])\s*;/.exec(html);
  if (!m) return undefined;
  try {
    const parsed: unknown = JSON.parse(m[1]);
    return Array.isArray(parsed) ? (parsed as BaiduCard[]) : undefined;
  } catch {
    return undefined;
  }
}

/** 完全相同图（same.list[]）→ 线格式。 */
function sameItemToResult(it: Record<string, unknown>): SearxngResult | undefined {
  const img = asString(it.image_src) ?? asString(it.imageSrc);
  const url = asString(it.url) ?? asString(it.fromUrl);
  if (!img && !url) return undefined;
  const host = hostOf(url);
  return {
    url: url ?? img,
    title: asString(it.title) ?? (host ? `图片来源：${host}` : "百度识图：完全相同"),
    content: "百度识图 · 完全相同",
    engine: "baidu",
    // 百度不提供相似度（PicImageSearch 亦已废弃该字段）→ 给「完全相同图」一个强分，
    // 只为让它在统一排序里不至于永远垫底；不是跨源融合打分（见 ADR-0012）。
    score: 1,
    img_src: img,
    thumbnail_src: img,
    category: "search_by_image",
  };
}

/** 相似图（simipic 详情 data.list[]）→ 线格式。 */
function similarItemToResult(it: Record<string, unknown>): SearxngResult | undefined {
  const img =
    asString(it.thumbUrl) ?? asString(it.image_src) ?? asString(it.middleUrl) ?? asString(it.objUrl);
  const url = asString(it.fromUrl) ?? asString(it.url);
  if (!img && !url) return undefined;
  const w = typeof it.width === "number" ? it.width : undefined;
  const h = typeof it.height === "number" ? it.height : undefined;
  const resolution = w !== undefined && h !== undefined ? `${w} x ${h}` : undefined;
  const host = hostOf(url);
  const title = (Array.isArray(it.title) ? asString(it.title[0]) : asString(it.title)) ??
    (host ? `相似图：${host}` : "百度识图：相似图");
  return {
    url: url ?? asString(it.objUrl) ?? img,
    title,
    content: "百度识图 · 相似图",
    engine: "baidu",
    // 「相似图」给中位分（同上，仅为排序可比的约定）
    score: 0.5,
    img_src: img,
    thumbnail_src: img,
    resolution,
    category: "search_by_image",
  };
}

/** cardData + 相似图详情 → 候选（完全相同图在前，相似图在后）。 */
export function baiduToResults(
  cards: BaiduCard[],
  simipicDetail: BaiduSimipicDetail | undefined,
  maxResults: number,
): SearxngResult[] {
  const out: SearxngResult[] = [];

  const same = cards.find((c) => c.cardName === "same")?.tplData;
  const sameList = same && Array.isArray((same as { list?: unknown }).list) ? (same as { list: unknown[] }).list : [];
  for (const it of sameList) {
    if (!it || typeof it !== "object") continue;
    const r = sameItemToResult(it as Record<string, unknown>);
    if (r) out.push(r);
  }

  const list = simipicDetail?.data?.list;
  if (Array.isArray(list)) {
    for (const it of list) {
      if (!it || typeof it !== "object") continue;
      const r = similarItemToResult(it as Record<string, unknown>);
      if (r) out.push(r);
    }
  }

  return out.slice(0, Math.max(0, maxResults));
}

/**
 * 跑百度识图三步。URL 输入时先把图下载成字节（百度只吃文件上传）。
 * 失败不抛裸异常，返回结构化错误。
 */
export async function searchBaiduReverse(opts: BaiduReverseOptions, input: ImageInput): Promise<SourceCall> {
  const start = Date.now();
  const base = (opts.baseUrl ?? "https://graph.baidu.com").replace(/\/+$/, "");

  let bytes: Uint8Array;
  let filename: string;
  let mime: string;
  if (input.kind === "bytes") {
    bytes = input.bytes;
    filename = input.filename;
    mime = input.mime;
  } else {
    try {
      const r = await fetch(input.url, { signal: AbortSignal.timeout(opts.timeoutMs), redirect: "follow" });
      if (!r.ok) {
        return { ok: false, error: { kind: "http", status: r.status, message: `百度识图：下载待查图片 HTTP ${r.status}` } };
      }
      const buf = new Uint8Array(await r.arrayBuffer());
      if (opts.maxBytes > 0 && buf.byteLength > opts.maxBytes) {
        return {
          ok: false,
          error: { kind: "api", message: `百度识图：图片 ${buf.byteLength} 字节，超过上限 ${opts.maxBytes}` },
        };
      }
      bytes = buf;
      filename = "image";
      mime = (r.headers.get("content-type") ?? "image/jpeg").split(";")[0]?.trim() || "image/jpeg";
    } catch (err) {
      return { ok: false, error: classifyFetchError(err, opts.timeoutMs, "百度识图（下载图片）") };
    }
  }

  try {
    // ① 上传
    const form = new FormData();
    form.append("from", "pc");
    form.append("image", new Blob([bytes as BlobPart], { type: mime }), filename);
    const upRes = await fetch(`${base}/upload`, {
      method: "POST",
      headers: { "Acs-Token": "" },
      body: form,
      signal: AbortSignal.timeout(opts.timeoutMs),
      redirect: "follow",
    });
    if (!upRes.ok) {
      return { ok: false, error: { kind: "http", status: upRes.status, message: `百度识图上传 HTTP ${upRes.status}` } };
    }
    let up: { status?: number; msg?: string; data?: { url?: string } };
    try {
      up = (await upRes.json()) as typeof up;
    } catch {
      return { ok: false, error: { kind: "invalid_json", message: "百度识图上传返回非 JSON" } };
    }
    const dataUrl = up.data?.url;
    if (typeof dataUrl !== "string" || dataUrl.length === 0) {
      const msg = [up.status !== undefined ? `status=${up.status}` : "", up.msg ?? ""].filter(Boolean).join(" ");
      return { ok: false, error: { kind: "api", message: `百度识图上传被拒（${msg || "无 data.url"}）` } };
    }

    // ② 结果页 → cardData
    const pageRes = await fetch(dataUrl, { signal: AbortSignal.timeout(opts.timeoutMs), redirect: "follow" });
    if (!pageRes.ok) {
      return { ok: false, error: { kind: "http", status: pageRes.status, message: `百度识图结果页 HTTP ${pageRes.status}` } };
    }
    const html = await pageRes.text();
    const cards = extractBaiduCardData(html);
    if (!cards) {
      return { ok: false, error: { kind: "api", message: "百度识图结果页结构变化（未找到 cardData）" } };
    }
    if (cards.some((c) => c.cardName === "noresult")) {
      return { ok: true, results: [], latencyMs: Date.now() - start };
    }

    // ③ 相似图详情（失败不影响已拿到的 same 结果）
    let detail: BaiduSimipicDetail | undefined;
    const simipic = cards.find((c) => c.cardName === "simipic")?.tplData;
    const firstUrl = asString(simipic?.firstUrl);
    if (firstUrl) {
      try {
        const dRes = await fetch(firstUrl, { signal: AbortSignal.timeout(opts.timeoutMs), redirect: "follow" });
        if (dRes.ok) detail = (await dRes.json()) as BaiduSimipicDetail;
      } catch {
        // 忽略：same 结果仍然可用
      }
    }

    return { ok: true, results: baiduToResults(cards, detail, opts.maxResults), latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, error: classifyFetchError(err, opts.timeoutMs, "百度识图") };
  }
}
