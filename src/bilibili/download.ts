/**
 * Bilibili 媒体直链下载。
 *
 * 插件拿到 `BiliStream` 后由这里把内容读进内存（上限可配），再交给 fetch 服务落盘。
 * 安全上做两层校验：先按 SSRF 规则解析域名/IP，再要求 hostname 落在 B 站 CDN 白名单内；
 * 重定向后的最终地址同样复查白名单，避免 CDN 302 到内网或第三方。
 */
import type { GatewayConfig } from "../config.js";
import { assertPublicHttpUrl, normalizeHostname } from "../fetch/ssrf.js";
import type { Logger } from "../logger.js";
import { BiliError, type BiliStream } from "./types.js";

/** B 站对非浏览器 UA 更激进地返回 403/412，这里固定用桌面浏览器 UA。 */
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

/**
 * 极简信号量（约十行）：限制进程内同时进行的 CDN 下载数。
 * 释放时直接把名额交给队首等待者，避免 active 先减后加造成瞬时超限。
 */
class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.active--;
  }
}

/** 每个并发上限一个信号量；配置按调用传入，模块级复用避免每次请求重建。 */
const semaphores = new Map<number, Semaphore>();

function semaphoreFor(limit: number): Semaphore {
  const size = Math.max(1, Math.floor(limit));
  let sem = semaphores.get(size);
  if (!sem) {
    sem = new Semaphore(size);
    semaphores.set(size, sem);
  }
  return sem;
}

/** hostname 等于白名单后缀，或以 `.后缀` 结尾。 */
function isAllowedHost(hostname: string, allowedHosts: string[]): boolean {
  const host = normalizeHostname(hostname);
  if (!host) return false;
  return allowedHosts.some((raw) => {
    const suffix = normalizeHostname(raw);
    if (!suffix) return false;
    return host === suffix || host.endsWith(`.${suffix}`);
  });
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function invalidUrlReason(reason?: "invalid_url" | "protocol" | "private_ip"): string {
  switch (reason) {
    case "protocol":
      return "直链仅支持 http(s)";
    case "private_ip":
      return "直链解析到内网地址（SSRF 防护）";
    default:
      return "直链不是合法 URL";
  }
}

/** 超限错误：BiliErrorCode 里没有 TOO_LARGE，统一用 BILI_DOWNLOAD_FAIL。 */
function tooLargeError(limit: number, actual: number): BiliError {
  const detail = actual > 0 ? `当前大小 ${actual} 字节` : "响应体更大";
  return new BiliError(
    "BILI_DOWNLOAD_FAIL",
    `媒体超过下载上限 ${limit} 字节（${detail}），` +
      "上限取 bilibili.download.max_bytes 与 fetch.max_download_bytes 的较小值",
  );
}

/** 丢弃响应体，释放连接（失败不影响主错误）。 */
async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* 已消费/已中止的流取消失败可忽略 */
  }
}

export async function downloadStream(
  stream: BiliStream,
  config: GatewayConfig,
  logger?: Logger,
): Promise<{ bytes: Buffer; contentType: string }> {
  const conf = config.bilibili.download;

  const check = await assertPublicHttpUrl(stream.url, {
    enabled: !conf.allowPrivateCdn,
    exemptCidrs: config.fetchPrivateIpExemptCidrs,
  });
  if (!check.ok) {
    throw new BiliError("BILI_INVALID_URL", `拒绝下载：${invalidUrlReason(check.reason)}`);
  }

  let target: URL;
  try {
    target = new URL(stream.url);
  } catch {
    throw new BiliError("BILI_INVALID_URL", "拒绝下载：直链不是合法 URL");
  }
  if (!isAllowedHost(target.hostname, conf.allowedHosts)) {
    throw new BiliError(
      "BILI_INVALID_URL",
      `拒绝下载：${target.hostname} 不在 bilibili.download.allowed_hosts 白名单内`,
    );
  }

  const limit = Math.max(1, Math.min(conf.maxBytes, config.fetchMaxDownloadBytes));
  const sem = semaphoreFor(conf.maxConcurrent);
  await sem.acquire();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), conf.timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch(target, {
        headers: {
          "User-Agent": BROWSER_UA,
          Referer: "https://www.bilibili.com",
        },
        signal: controller.signal,
        redirect: "follow",
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new BiliError("BILI_DOWNLOAD_FAIL", `下载超时（bilibili.download.timeout_ms=${conf.timeoutMs}）`);
      }
      throw new BiliError("BILI_DOWNLOAD_FAIL", `下载请求失败：${errorMessage(err)}`);
    }

    // 跟随重定向后可能落到白名单之外，按最终地址复查一次。
    if (res.url) {
      let finalHost = "";
      try {
        finalHost = new URL(res.url).hostname;
      } catch {
        finalHost = "";
      }
      if (!finalHost || !isAllowedHost(finalHost, conf.allowedHosts)) {
        await discard(res);
        throw new BiliError("BILI_INVALID_URL", `拒绝下载：重定向到白名单外的主机 ${finalHost || res.url}`);
      }
    }

    if (res.status === 403 || res.status === 412) {
      await discard(res);
      throw new BiliError(
        "BILI_RISK_CONTROL",
        `CDN 返回 HTTP ${res.status}，可能触发 B 站风控`,
        "稍后重试或更换网络出口",
      );
    }
    if (!res.ok) {
      await discard(res);
      throw new BiliError("BILI_DOWNLOAD_FAIL", `CDN 返回 HTTP ${res.status}`);
    }

    const lengthHeader = res.headers.get("content-length");
    const declared = lengthHeader === null ? Number.NaN : Number(lengthHeader);
    if (Number.isFinite(declared) && declared > limit) {
      await discard(res);
      throw tooLargeError(limit, declared);
    }

    const reader = res.body?.getReader();
    if (!reader) {
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.byteLength > limit) throw tooLargeError(limit, bytes.byteLength);
      const contentType = resolveContentType(stream.contentType, res);
      logger?.debug(`bilibili download: ${target.hostname} ${bytes.byteLength} bytes → ${contentType}`);
      return { bytes, contentType };
    }

    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        size += value.byteLength;
        if (size > limit) {
          controller.abort();
          await reader.cancel().catch(() => {});
          throw tooLargeError(limit, size);
        }
        chunks.push(Buffer.from(value));
      }
    } catch (err) {
      if (err instanceof BiliError) throw err;
      if (controller.signal.aborted) {
        throw new BiliError("BILI_DOWNLOAD_FAIL", `下载超时（bilibili.download.timeout_ms=${conf.timeoutMs}）`);
      }
      throw new BiliError("BILI_DOWNLOAD_FAIL", `下载中断：${errorMessage(err)}`);
    }

    const bytes = Buffer.concat(chunks);
    const contentType = resolveContentType(stream.contentType, res);
    logger?.debug(`bilibili download: ${target.hostname} ${bytes.byteLength} bytes → ${contentType}`);
    return { bytes, contentType };
  } finally {
    clearTimeout(timer);
    sem.release();
  }
}

/** 直链声明的类型优先，其次响应头，最后兜底二进制。 */
function resolveContentType(streamContentType: string | undefined, res: Response): string {
  const own = typeof streamContentType === "string" ? streamContentType.trim() : "";
  if (own) return own;
  const fromHeader = res.headers.get("content-type")?.trim();
  return fromHeader && fromHeader.length > 0 ? fromHeader : "application/octet-stream";
}
