import type { GatewayConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { baseContentType, classifyContentType, formatBytes } from "./convert.js";
import { findPlugin } from "./plugins/index.js";
import type { FetchPluginResult } from "./plugins/types.js";
import { isPrivateHost } from "./ssrf.js";

const DEFAULT_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

export type FetchErrorKind =
  | "invalid_url"
  | "blocked_private_ip"
  | "timeout"
  | "http"
  | "network"
  | "too_large"
  | "not_html"
  | "unsupported_type"
  | "empty";

/** 拿到手的内容大类：html 走 markdown，text 轻转换，binary（含 PDF）交 service 分派。 */
export type DirectPayloadKind = "html" | "text" | "binary";

export interface DirectFetchResult {
  ok: boolean;
  status?: number;
  contentType?: string;
  finalUrl?: string;
  kind?: DirectPayloadKind;
  /** kind=html */
  html?: string;
  /** kind=text */
  text?: string;
  /** kind=binary（PDF 也走这里，由 service 决定抽正文还是落盘） */
  bytes?: Buffer;
  truncated?: boolean;
  /** 命中的取件插件名（可观测）。 */
  plugin?: string;
  errorKind?: FetchErrorKind;
  errorMessage?: string;
}

const MAX_REDIRECTS = 5;

/** TextDecoder 支持的常见 charset 别名（大小写不敏感） */
const KNOWN_CHARSETS = new Set([
  "utf-8", "utf8", "gbk", "gb2312", "gb18030", "big5", "shift_jis", "shift-jis",
  "euc-jp", "euc-kr", "iso-8859-1", "iso-8859-2", "iso-8859-15", "latin1",
  "windows-1250", "windows-1251", "windows-1252", "windows-1256", "koi8-r",
  "us-ascii", "ascii", "utf-16le", "utf-16be",
]);

/**
 * 从 HTML 头部探测 charset：很多老站（尤其中文站）只在
 * <meta charset> / <meta http-equiv> 声明，HTTP header 没有。
 * 返回 null 表示未声明（调用方回退 header/utf-8）。
 */
function sniffHtmlCharset(buf: Buffer): string | null {
  // charset 声明基本都在前 4KB；ascii 片段即可匹配
  const head = buf.subarray(0, 4096).toString("latin1");
  // <meta charset="gbk"> / <meta charset=gbk>
  let m = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head);
  if (!m) {
    // <meta http-equiv="Content-Type" content="text/html; charset=gbk">
    m = /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+)/i.exec(head);
  }
  if (!m) return null;
  const cs = m[1]!.toLowerCase();
  return KNOWN_CHARSETS.has(cs) ? cs : null;
}

/** 解码 body：header charset 优先，缺失时嗅探 <meta charset>（老中文站常见）。 */
function decodeBody(buf: Buffer, contentType: string, sniff: boolean): string {
  let charset = /charset=([\w-]+)/i.exec(contentType)?.[1];
  if (!charset && sniff) charset = sniffHtmlCharset(buf) ?? undefined;
  const decoder = new TextDecoder((charset ?? "utf-8") as BufferEncoding, { fatal: false });
  return decoder.decode(buf);
}

/**
 * 校验 URL 是否允许抓取：协议必须 http/https，且（启用时）hostname 非内网。
 * 初始 URL 与每次重定向目标都调用 —— 防止 302 跳转绕过 SSRF 检查直达内网。
 */
async function checkUrlAllowed(
  config: GatewayConfig,
  url: URL,
): Promise<
  | { ok: true }
  | { ok: false; errorKind: "invalid_url" | "blocked_private_ip"; errorMessage: string }
> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, errorKind: "invalid_url", errorMessage: `仅支持 http/https: ${url.toString()}` };
  }
  if (config.fetchBlockPrivateIps) {
    let privateHost = false;
    try {
      privateHost = await isPrivateHost(url.hostname, {
        exemptCidrs: config.fetchPrivateIpExemptCidrs,
      });
    } catch {
      /* 解析失败按非私有处理，交由请求阶段决定 */
    }
    if (privateHost) {
      return {
        ok: false,
        errorKind: "blocked_private_ip",
        errorMessage: `SSRF 防护：拒绝内网地址 ${url.hostname}`,
      };
    }
  }
  return { ok: true };
}

/** 流式读到 limit 字节；超限截断并标注（调用方据此决定报错还是留残片）。 */
async function readLimited(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  limit: number,
): Promise<{ buf: Buffer; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > limit) {
      chunks.push(value.subarray(0, Math.max(0, limit - (received - value.byteLength))));
      return { buf: Buffer.concat(chunks), truncated: true };
    }
    chunks.push(value);
  }
  return { buf: Buffer.concat(chunks), truncated: false };
}

/** 命中取件插件时的分支：插件自管请求与重定向，网关只看产物。 */
async function fetchViaPlugin(
  plugin: NonNullable<ReturnType<typeof findPlugin>>,
  url: URL,
  config: GatewayConfig,
  logger?: Logger,
): Promise<DirectFetchResult> {
  const base = { plugin: plugin.name, finalUrl: url.toString() } as const;
  let r: FetchPluginResult;
  try {
    r = await plugin.fetch(url, { config, logger });
  } catch (err) {
    return {
      ok: false,
      ...base,
      errorKind: "network",
      errorMessage: `插件抛错: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const finalUrl = r.finalUrl ?? url.toString();
  if (!r.ok) {
    const status = r.status;
    const errorKind: FetchErrorKind = status !== undefined && status >= 400 ? "http" : "network";
    const detail = r.errorMessage ?? "取件失败";
    return {
      ok: false,
      plugin: plugin.name,
      status,
      contentType: r.contentType,
      finalUrl,
      errorKind,
      errorMessage: r.errorCode ? `[${r.errorCode}] ${detail}` : `插件 ${plugin.name}: ${detail}`,
    };
  }

  if (r.html !== undefined) {
    return {
      ok: true,
      plugin: plugin.name,
      status: r.status,
      contentType: r.contentType ?? "text/html",
      finalUrl,
      kind: "html",
      html: r.html,
    };
  }

  if (r.bytes && r.bytes.length > 0) {
    const contentType = r.contentType ?? "application/octet-stream";
    const categorized = classifyContentType(contentType);
    if (categorized === "html") {
      return {
        ok: true,
        plugin: plugin.name,
        status: r.status,
        contentType,
        finalUrl,
        kind: "html",
        html: decodeBody(r.bytes, contentType, true),
      };
    }
    if (categorized === "text") {
      return {
        ok: true,
        plugin: plugin.name,
        status: r.status,
        contentType,
        finalUrl,
        kind: "text",
        text: decodeBody(r.bytes, contentType, true),
      };
    }
    return {
      ok: true,
      plugin: plugin.name,
      status: r.status,
      contentType,
      finalUrl,
      kind: "binary",
      bytes: r.bytes,
    };
  }

  return {
    ok: false,
    ...base,
    errorKind: "unsupported_type",
    errorMessage: `插件 ${plugin.name} 未返回可识别产物`,
  };
}

/**
 * 直接 HTTP 抓取目标 URL。
 * - 先查取件插件注册表，命中即交给插件（跳过 SSRF 与通用重定向链）
 * - 通用路径按 Content-Type 分派：html / text（轻转换在 service 层）/ 其余二进制
 * - SSRF 防护：blockPrivateIps=true 时拒绝私网主机（初始 URL 与每跳重定向）
 * - 跟随重定向（≤MAX_REDIRECTS）；二进制超 max_download_bytes 直接报 too_large
 */
export async function directFetch(
  config: GatewayConfig,
  urlStr: string,
  logger?: Logger,
): Promise<DirectFetchResult> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return { ok: false, errorKind: "invalid_url", errorMessage: `非法 URL: ${urlStr}` };
  }

  // 取件插件优先（ADR-0007 D5）：匹配表由插件提供，网关无条件信任
  const plugin = findPlugin(url);
  if (plugin) {
    logger?.debug(`fetch plugin matched: ${plugin.name} ${url.toString()}`);
    return await fetchViaPlugin(plugin, url, config, logger);
  }

  // SSRF 防护（初始 URL；重定向目标在循环内同样检查）
  const initialCheck = await checkUrlAllowed(config, url);
  if (!initialCheck.ok) {
    return { ok: false, errorKind: initialCheck.errorKind, errorMessage: initialCheck.errorMessage };
  }

  const ua = config.fetchUserAgent && config.fetchUserAgent.length > 0 ? config.fetchUserAgent : DEFAULT_UA;

  let currentUrl = url;
  let truncated = false;
  let status = 0;
  let contentType = "";

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.fetchTimeoutMs);
    try {
      const res = await fetch(currentUrl.toString(), {
        signal: controller.signal,
        redirect: "manual",
        headers: {
          "User-Agent": ua,
          // 按需协商：不再只报 HTML，让服务端可以回 PDF / 纯文本 / JSON
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/pdf;q=0.9,application/json;q=0.9,*/*;q=0.5",
        },
      });
      status = res.status;
      contentType = res.headers.get("content-type") ?? "";

      // 重定向：先校验目标协议/内网，再继续（防 SSRF 跳板）
      if (status >= 300 && status < 400) {
        const loc = res.headers.get("location");
        if (!loc) {
          return { ok: false, errorKind: "http", status, errorMessage: `重定向无 location (${status})` };
        }
        let nextUrl: URL;
        try {
          nextUrl = new URL(loc, currentUrl);
        } catch {
          return { ok: false, errorKind: "invalid_url", status, errorMessage: `重定向 location 非法: ${loc}` };
        }
        const nextCheck = await checkUrlAllowed(config, nextUrl);
        if (!nextCheck.ok) {
          return {
            ok: false,
            errorKind: nextCheck.errorKind,
            errorMessage: `${nextCheck.errorMessage}（重定向目标 ${nextUrl.hostname}）`,
          };
        }
        currentUrl = nextUrl;
        continue;
      }

      if (status < 200 || status >= 300) {
        return { ok: false, errorKind: "http", status, errorMessage: `HTTP ${status}` };
      }

      const categorized = classifyContentType(contentType);
      const isTextual = categorized === "html" || categorized === "text";
      const limit = isTextual ? config.fetchMaxBytes : config.fetchMaxDownloadBytes;

      // 二进制/PDF：有 Content-Length 时先预检，超上限直接拒绝（不下载、不占连接）
      if (!isTextual) {
        const rawLen = res.headers.get("content-length");
        const declaredLen = rawLen === null ? Number.NaN : Number(rawLen);
        if (Number.isFinite(declaredLen) && declaredLen > config.fetchMaxDownloadBytes) {
          await res.body?.cancel().catch(() => {});
          return {
            ok: false,
            errorKind: "too_large",
            status,
            contentType,
            finalUrl: currentUrl.toString(),
            errorMessage: `文件约 ${formatBytes(declaredLen)}，超过上限 ${formatBytes(config.fetchMaxDownloadBytes)}（max_download_bytes）`,
          };
        }
      }

      const reader = res.body?.getReader();
      if (!reader) {
        return { ok: false, errorKind: "empty", errorMessage: "响应无内容" };
      }
      const { buf, truncated: wasTruncated } = await readLimited(reader, limit);
      await reader.cancel().catch(() => {});
      truncated = wasTruncated;

      // 二进制超上限（无 Content-Length 的兜底路径）：截断的文件是残片，直接报错不落盘
      if (!isTextual && truncated) {
        return {
          ok: false,
          errorKind: "too_large",
          status,
          contentType,
          finalUrl: currentUrl.toString(),
          errorMessage: `文件超过 ${formatBytes(config.fetchMaxDownloadBytes)} 上限（max_download_bytes）`,
        };
      }

      if (buf.length === 0 && !isTextual) {
        return {
          ok: false,
          errorKind: "empty",
          status,
          contentType,
          finalUrl: currentUrl.toString(),
          errorMessage: "响应体为空",
        };
      }

      if (categorized === "html") {
        return {
          ok: true,
          status,
          contentType,
          finalUrl: currentUrl.toString(),
          kind: "html",
          html: decodeBody(buf, contentType, true),
          truncated,
        };
      }

      if (categorized === "text") {
        return {
          ok: true,
          status,
          contentType,
          finalUrl: currentUrl.toString(),
          kind: "text",
          text: decodeBody(buf, contentType, true),
          truncated,
        };
      }

      return {
        ok: true,
        status,
        contentType: baseContentType(contentType) || "application/octet-stream",
        finalUrl: currentUrl.toString(),
        kind: "binary",
        bytes: buf,
      };
    } catch (err) {
      const e = err as Error;
      if (e.name === "AbortError") {
        return { ok: false, errorKind: "timeout", errorMessage: `抓取超时 (>${config.fetchTimeoutMs}ms)` };
      }
      return { ok: false, errorKind: "network", errorMessage: e.message };
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, errorKind: "http", status, errorMessage: "重定向次数超限" };
}
