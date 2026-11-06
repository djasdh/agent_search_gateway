/** 微博图片 CDN 下载：带 Referer，wx 前缀失败时回退 tvax。 */

import type { GatewayConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { WeiboError } from "./types.js";

const DEFAULT_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface ImageDownloadResult {
  bytes: Buffer;
  contentType: string;
  finalUrl: string;
}

/** `wx1.sinaimg.cn` → `tvax1.sinaimg.cn`；非 wx 前缀返回 undefined。 */
function tvaxOf(url: URL): URL | undefined {
  const m = /^wx(\d)\.sinaimg\.cn$/i.exec(url.hostname);
  if (!m) return undefined;
  const next = new URL(url.toString());
  next.hostname = `tvax${m[1]}.sinaimg.cn`;
  return next;
}

async function fetchOnce(
  url: URL,
  config: GatewayConfig,
  logger?: Logger,
): Promise<ImageDownloadResult> {
  const max = config.weibo.images.maxBytes;
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(config.weibo.images.timeoutMs),
      headers: {
        referer: config.weibo.images.referer,
        "user-agent": config.fetchUserAgent || DEFAULT_UA,
        accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
    });
  } catch (err) {
    const name = (err as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new WeiboError("WEIBO_IMAGE_FAIL", `微博图片下载超时（>${config.weibo.images.timeoutMs}ms）`);
    }
    throw new WeiboError(
      "WEIBO_IMAGE_FAIL",
      `微博图片下载失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new WeiboError("WEIBO_IMAGE_FAIL", `微博图片 HTTP ${res.status}`);
  }

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("image/")) {
    await res.body?.cancel().catch(() => undefined);
    throw new WeiboError("WEIBO_IMAGE_FAIL", `微博图片返回了非图片类型：${contentType || "unknown"}`);
  }

  const declared = Number.parseInt(res.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new WeiboError("WEIBO_IMAGE_FAIL", `微博图片超过大小上限（${declared} > ${max}）`);
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    throw new WeiboError(
      "WEIBO_IMAGE_FAIL",
      `微博图片读取失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (bytes.length > max) {
    throw new WeiboError("WEIBO_IMAGE_FAIL", `微博图片超过大小上限（${bytes.length} > ${max}）`);
  }

  logger?.debug(`weibo image: ${url.toString()} -> ${bytes.length} bytes (${contentType})`);
  return { bytes, contentType, finalUrl: res.url || url.toString() };
}

export async function downloadWeiboImage(
  url: URL,
  config: GatewayConfig,
  logger?: Logger,
): Promise<ImageDownloadResult> {
  try {
    return await fetchOnce(url, config, logger);
  } catch (err) {
    const fallback = config.weibo.images.retryTvax ? tvaxOf(url) : undefined;
    if (!fallback) throw err;
    logger?.debug(`weibo image: retry via ${fallback.hostname}`);
    return await fetchOnce(fallback, config, logger);
  }
}
