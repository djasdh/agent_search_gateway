/**
 * CNKI（知网）取件插件。
 *
 * 职责（ADR-0007 / ADR-0009 / D22）：插件自管 headers、cookies、会话与逐跳重定向，
 * 完成**全部**网络请求；网关只把返回的 `bytes` 落盘并给出本地路径 + `/files/<id>`。
 *
 * 流程：
 * - 会话每次现开：`GenerateClientID` 拿 clientId → md5 签名 → `IpLoginFlushPo`
 *   拿 `LID`（下载必需）；响应体是 `({...})` 非标准 JSON，本插件只取
 *   `Set-Cookie`，不解析响应体。
 * - 摘要页的 `#pdfDown` / `#cajDown` 指向 `bar.cnki.net/bar/download/order?id=…`，
 *   跟随重定向最终到 `docdown.cnki.net/docdown/fulltext/download`。
 * - 部分文献没有 PDF 版：`#pdfDown` 会跳到 `bar/htmlread.html`，因此必须按
 *   `%PDF` 魔数判定产物。
 */
import { createHash } from "node:crypto";
import type { GatewayConfig } from "../../config.js";
import type { Logger } from "../../logger.js";
import type { FetchPlugin, FetchPluginContext, FetchPluginResult } from "./types.js";

/** 端点。测试通过改写此对象指向本地桩服务器（见 `__tests__/cnki-plugin.test.ts`）。 */
export const endpoints = {
  clientId: "https://recsys.cnki.net/RCDService/api/UtilityOpenApi/GenerateClientID",
  login: "https://login.cnki.net/TopLoginCore/api/loginapi/IpLoginFlushPo",
  knsBase: "https://kns.cnki.net",
};

/** `login.cnki.net` 前端公开常量（ecpLoginDialogLink.js），非账号密钥。 */
const LOGIN_FRONTEND_CONST = "t8b52yrsoyx66f35tk0p4nubrmrcglv5";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const ABSTRACT_PATH = "/kcms2/article/abstract";

/** 可覆盖策略（仅供测试指向本地桩服务器）。 */
export const policy = {
  /** 允许的知网域名后缀（hostname 等于它或以 `.后缀` 结尾）。 */
  cnkiHostSuffix: "cnki.net",
};

/** 下载允许更慢（大文件下载）；其余请求用网关的 fetch 超时。 */
const DOWNLOAD_MIN_TIMEOUT_MS = 60_000;

const NOT_SUBSCRIBED_MARKERS = ["未订购", "会员中心", "订购该资源", "尚未订购"];
const NO_PDF_MARKERS = ["htmlread", "htmlread.html"];

/** 简易 cookie 容器：插件自管，不跨请求持久化（每次取件都是新会话）。 */
class CookieJar {
  private readonly values = new Map<string, string>();

  store(res: Response): void {
    const lines =
      typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const line of lines) {
      const pair = line.split(";")[0]?.trim() ?? "";
      const eq = pair.indexOf("=");
      if (eq > 0) this.values.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  get(name: string): string | undefined {
    return this.values.get(name);
  }

  header(): string {
    return [...this.values].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

/** `signature = md5(timestamp + nonce + SECRET + sortedParams + clientId)`（去空格）。 */
function sign(clientId: string): { timestamp: number; nonce: string; signature: string } {
  const timestamp = Date.now();
  // 前端把 Math.random 改写成 seed => Math.sin(seed).toString().substr(6)
  const nonce = Math.sin(timestamp).toString().substring(6);
  const raw = `${timestamp}${nonce}${LOGIN_FRONTEND_CONST}${clientId}`.replace(/ /g, "");
  return { timestamp, nonce, signature: createHash("md5").update(raw).digest("hex") };
}

function isCnkiHost(url: URL): boolean {
  const host = url.hostname;
  return host === policy.cnkiHostSuffix || host.endsWith(`.${policy.cnkiHostSuffix}`);
}

/** 取第一个带 marker 的 `<a>` 标签的 href（属性顺序无关）。 */
function extractAnchorHref(html: string, marker: string): string | undefined {
  for (const tag of html.match(/<a\b[^>]*>/gi) ?? []) {
    if (!tag.includes(marker)) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (href) {
      return href
        .replace(/&amp;/g, "&")
        .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
        .trim();
    }
  }
  return undefined;
}

async function cnkiFetch(
  url: string,
  jar: CookieJar,
  timeoutMs: number,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("User-Agent", UA);
  headers.set("Referer", `${endpoints.knsBase}/`);
  if (jar.header()) headers.set("Cookie", jar.header());
  return await fetch(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
}

/** 读满响应体，超过 `maxBytes` 立即中止（不把超大文件读进内存）。 */
async function readLimited(
  res: Response,
  maxBytes: number,
): Promise<{ bytes: Buffer; tooLarge: boolean }> {
  const declared = Number(res.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return { bytes: Buffer.alloc(0), tooLarge: true };
  }

  const reader = res.body?.getReader();
  if (!reader) return { bytes: Buffer.alloc(0), tooLarge: false };

  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return { bytes: Buffer.alloc(0), tooLarge: true };
    }
    chunks.push(Buffer.from(value));
  }
  return { bytes: Buffer.concat(chunks), tooLarge: false };
}

/** 零凭据 IP 登录；成功返回会话 cookie，失败返回 undefined。 */
async function openSession(
  jar: CookieJar,
  config: GatewayConfig,
  logger?: Logger,
): Promise<boolean> {
  const timeout = Math.max(config.fetchTimeoutMs, 10_000);
  try {
    const res = await cnkiFetch(endpoints.clientId, jar, timeout);
    jar.store(res);
    const body = (await res.json()) as { Data?: string };
    const clientId = body?.Data;
    if (!clientId) {
      logger?.debug("cnki plugin: GenerateClientID 未返回 Data");
      return false;
    }

    // 前端把 clientId 写进 Ecp_ClientId cookie，并作为 ClientID 头发送
    const { timestamp, nonce, signature } = sign(clientId);
    const loginRes = await cnkiFetch(endpoints.login, jar, timeout, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        timestamp: String(timestamp),
        nonce,
        signature,
        appID: "LoginWap",
        ClientID: clientId,
      },
      body: "{}",
    });
    jar.store(loginRes);
    await loginRes.text().catch(() => ""); // 响应体是 `({...})`，只用于释放连接

    if (!jar.get("LID")) {
      logger?.debug("cnki plugin: IP 登录未返回 LID（出口可能不在机构网段）");
      return false;
    }
    return true;
  } catch (err) {
    logger?.debug(`cnki plugin: 会话失败 ${String(err)}`);
    return false;
  }
}

function classifyNonPdf(bytes: Buffer, finalUrl: string): { errorCode: string; errorMessage: string } {
  const text = bytes.toString("utf8");
  if (NOT_SUBSCRIBED_MARKERS.some((m) => text.includes(m))) {
    return { errorCode: "NOT_SUBSCRIBED", errorMessage: "当前机构未订购该资源" };
  }
  if (NO_PDF_MARKERS.some((m) => finalUrl.includes(m) || text.includes(m))) {
    return { errorCode: "NO_PDF", errorMessage: "该文献没有 PDF 版（仅 HTML 阅读版）" };
  }
  return { errorCode: "NOT_PDF", errorMessage: "下载结果不是 PDF（可能需要在机构网段内访问）" };
}

async function fetchCnki(url: URL, ctx: FetchPluginContext): Promise<FetchPluginResult> {
  const { config, logger } = ctx;
  const jar = new CookieJar();

  if (!(await openSession(jar, config, logger))) {
    return {
      ok: false,
      finalUrl: url.toString(),
      errorCode: "CNKI_NO_SESSION",
      errorMessage: "知网 IP 登录失败（当前出口可能不在机构网段）",
    };
  }

  // 摘要页 → 先取出下载链接（#pdfDown / #cajDown → bar/download/order?id=…）
  let target = url.toString();
  if (url.pathname.includes(ABSTRACT_PATH)) {
    const page = await cnkiFetch(target, jar, config.fetchTimeoutMs);
    const html = await page.text();
    const href = extractAnchorHref(html, "pdfDown") ?? extractAnchorHref(html, "cajDown");
    if (!href) {
      const hit = NOT_SUBSCRIBED_MARKERS.find((m) => html.includes(m));
      return {
        ok: false,
        status: page.status,
        finalUrl: html ? `${url.toString()}（摘要页无下载链接）` : url.toString(),
        contentType: "text/html",
        errorCode: hit ? "NOT_SUBSCRIBED" : "NO_DOWNLOAD_LINK",
        errorMessage: hit ? "当前机构未订购该资源" : "摘要页里没有找到下载链接",
      };
    }
    target = new URL(href, url).toString();
  }

  const targetUrl = new URL(target);
  if (!isCnkiHost(targetUrl)) {
    return { ok: false, finalUrl: target, errorCode: "BAD_TARGET", errorMessage: `非知网下载地址：${targetUrl.hostname}` };
  }

  const res = await cnkiFetch(target, jar, Math.max(config.fetchTimeoutMs, DOWNLOAD_MIN_TIMEOUT_MS));
  const { bytes, tooLarge } = await readLimited(res, config.fetchMaxDownloadBytes);
  if (tooLarge) {
    return {
      ok: false,
      status: res.status,
      finalUrl: res.url,
      errorCode: "TOO_LARGE",
      errorMessage: `文件超过 ${config.fetchMaxDownloadBytes} 字节上限（fetch.max_download_bytes）`,
    };
  }
  if (bytes.byteLength === 0) {
    return { ok: false, status: res.status, finalUrl: res.url, errorCode: "EMPTY", errorMessage: "下载内容为空" };
  }

  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
    const { errorCode, errorMessage } = classifyNonPdf(bytes, res.url);
    logger?.debug(`cnki plugin: 非 PDF 产物 ${res.url} → ${errorCode}`);
    return { ok: false, status: res.status, finalUrl: res.url, contentType: res.headers.get("content-type") ?? undefined, errorCode, errorMessage };
  }

  logger?.debug(`cnki plugin: 取件成功 ${res.url} (${bytes.byteLength} bytes)`);
  return {
    ok: true,
    status: res.status,
    contentType: "application/pdf",
    finalUrl: res.url,
    bytes,
  };
}

export const cnkiPlugin: FetchPlugin = {
  name: "cnki",
  match(url: URL): boolean {
    if (!isCnkiHost(url)) return false;
    return (
      url.pathname.includes(ABSTRACT_PATH) ||
      url.pathname.startsWith("/zscsdoc/download") ||
      url.pathname.startsWith("/bar/download/order")
    );
  },
  fetch: fetchCnki,
};
