import type { Logger } from "../logger.js";
import type { BrowserPool } from "../browser/pool.js";
import { renderWithPlaywright } from "../browser/render.js";
import { ErrorCodes, withCode } from "../utils/errors.js";
import { FetchCache, type RenderMode } from "./cache.js";
import { baseContentType, formatBytes, renderTextBody } from "./convert.js";
import { directFetch, type DirectFetchResult } from "./direct.js";
import { createFlareSolverrClient, type FlareSolverrClient } from "./flaresolverr.js";
import { htmlToMarkdown } from "./html2md.js";
import { pdfToText } from "./pdf.js";
import type { FetchStore } from "./store.js";
import {
  ssrfOf,
  type BrowserSettings,
  type FetchPluginSecrets,
  type FetchPluginSettings,
  type FetchSettings,
  type FlaresolverrSettings,
} from "../settings/index.js";

export interface FetchParams {
  url: string;
  maxChars?: number;
}

export interface FetchOutcome {
  ok: boolean;
  code?: (typeof ErrorCodes)[keyof typeof ErrorCodes];
  text: string;
}

export interface FetchService {
  fetch(params: FetchParams): Promise<FetchOutcome>;
}

/** createFetchService 所需设置切片。 */
export interface FetchServiceDeps {
  fetch: FetchSettings;
  flaresolverr: FlaresolverrSettings;
  browser: BrowserSettings;
  /** `/files/<id>` 的对外基址（由根节点按 gateway.host/port 计算）。 */
  files_base_url: string;
  plugins: {
    settings: FetchPluginSettings;
    secrets: FetchPluginSecrets;
    getSecret: (path: string) => string | undefined;
  };
}

/** 空壳 JS 判定：HTML 很短且含 script src（疑似 SPA 壳）或含 CF 挑战特征 */
function isShellJs(html: string): boolean {
  if (html.length > 2000) return false;
  const lower = html.toLowerCase();
  const hasScript = /<script[^>]*\ssrc=/.test(lower);
  const cfFeatures = /cf-challenge|just a moment|challenge-platform|cf-browser-verification|_cf_chl/.test(lower);
  return hasScript || cfFeatures;
}

function shouldUpgradeToFlareSolverr(
  flaresolverr: FlaresolverrSettings,
  direct: DirectFetchResult,
): boolean {
  if (!flaresolverr.enabled) return false;
  if (direct.ok) {
    return flaresolverr.fallback_on_empty && direct.html !== undefined && isShellJs(direct.html);
  }
  if (direct.errorKind === "http" && direct.status !== undefined) {
    return flaresolverr.trigger_status.includes(direct.status);
  }
  return false;
}

/** max_chars 参数钳制上限：防止 agent 传超大值把整页塞进 LLM context */
const MAX_OUTPUT_CHARS_LIMIT = 200000;

function clampMaxChars(v: number | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (v <= 0) return undefined;
  return Math.min(v, MAX_OUTPUT_CHARS_LIMIT);
}

export function createFetchService(
  deps: FetchServiceDeps,
  logger: Logger,
  browserPool?: BrowserPool,
  store?: FetchStore,
  /** 进程级共享的 FlareSolverr 客户端；缺省时自建（单测 / 独立使用）。 */
  flareSolverr?: FlareSolverrClient,
): FetchService {
  const fetchSettings = deps.fetch;
  const ssrf = ssrfOf(fetchSettings);
  const fsClient = flareSolverr ?? createFlareSolverrClient({ flaresolverr: deps.flaresolverr, ssrf });
  const cache = new FetchCache(fetchSettings.cache_max_entries, fetchSettings.cache_ttl_ms);

  async function renderWithHtml(html: string, baseUrl: string, maxChars?: number): Promise<string> {
    const md = htmlToMarkdown(html, {
      structural: fetchSettings.structural,
      baseUrl,
      maxOutputChars: maxChars ?? fetchSettings.max_output_chars,
    });
    const lines: string[] = [];
    if (md.title) lines.push(`# ${md.title}`);
    lines.push("");
    lines.push(md.markdown);
    return lines.join("\n");
  }

  function cachedGet(mode: RenderMode, url: string, maxChars?: number): string | undefined {
    return cache.get(mode, url, maxChars);
  }
  function cachedSet(mode: RenderMode, url: string, text: string, maxChars?: number): void {
    cache.set(mode, url, text, maxChars);
  }

  /** 文本类响应：轻转换（JSON/CSV/XML）后直出。 */
  function renderText(direct: DirectFetchResult, url: string, maxChars?: number): FetchOutcome {
    const base = baseContentType(direct.contentType);
    const rendered = renderTextBody(base, direct.text ?? "", maxChars ?? fetchSettings.max_output_chars);
    const lines = [rendered.text];
    if (direct.truncated) {
      lines.push("");
      lines.push(`> 注：响应体超过 ${(fetchSettings.max_bytes / 1024 / 1024).toFixed(1)}MB，内容已截断。`);
    }
    const full = lines.join("\n");
    // 插件结果不进缓存：评论/直链这类产物会随调用变化，缓存会让续传和直链刷新失效。
    if (!direct.plugin) cachedSet("direct", url, full, maxChars);
    logger.debug(`fetch done (${base}): ${url} (${full.length} chars)`);
    return { ok: true, text: full };
  }

  /**
   * 二进制/PDF：PDF 优先抽正文；抽不到（扫描件/解析失败）或本就是其它二进制 → 落盘 + 双链接。
   * 二进制结果**不进**文本缓存：文件可能被 TTL 清走，缓存里的链接会失效。
   */
  async function renderBinary(direct: DirectFetchResult, url: string, maxChars?: number): Promise<FetchOutcome> {
    const contentType = direct.contentType ?? "application/octet-stream";
    const base = baseContentType(contentType);
    const bytes = direct.bytes ?? Buffer.alloc(0);

    // 取件插件产物 = 明确的「取件」语义：不抽正文，直接落盘给链接（D16 / D22）
    if (base === "application/pdf" && direct.plugin === undefined) {
      const pdf = await pdfToText(bytes);
      if (pdf.ok) {
        const body = pdf.text.trim();
        if (body.length > 0) {
          const limit = maxChars ?? fetchSettings.max_output_chars;
          const clipped = body.length > limit ? `${body.slice(0, limit)}\n\n…(内容已截断)` : body;
          const full = [`# PDF 正文（共 ${pdf.pages} 页）`, "", clipped].join("\n");
          cachedSet("direct", url, full, maxChars);
          logger.debug(`fetch pdf done: ${url} (${pdf.pages}p, ${clipped.length} chars)`);
          return { ok: true, text: full };
        }
        logger.debug(`fetch pdf 无文本层，改为落盘: ${url}`);
      } else {
        logger.warn(`PDF 抽取失败，改为落盘: ${url} (${pdf.error})`);
      }
    }

    if (!store) {
      return {
        ok: false,
        code: ErrorCodes.FETCH_UNSUPPORTED_TYPE,
        text: withCode(
          ErrorCodes.FETCH_UNSUPPORTED_TYPE,
          `非网页内容（${contentType || "未知"}），且未启用产物落盘。`,
        ),
      };
    }

    const f = store.put(bytes, { contentType, sourceUrl: direct.finalUrl ?? url });
    logger.debug(`fetch stored: ${url} -> ${f.path} (${f.size} bytes${f.deduped ? ", deduped" : ""})`);
    return {
      ok: true,
      text: [
        "已下载文件（非网页内容，正文未注入上下文）。",
        "",
        `- 类型：${contentType}`,
        `- 大小：${f.size} 字节`,
        `- sha256：${f.id}`,
        `- 本地路径：${f.path}`,
        `- 下载链接：${deps.files_base_url}${f.url}`,
      ].join("\n"),
    };
  }

  async function fetch(params: FetchParams): Promise<FetchOutcome> {
    const maxChars = clampMaxChars(params.maxChars);

    // 先查 direct 缓存
    const directCached = cachedGet("direct", params.url, maxChars);
    if (directCached !== undefined) {
      logger.debug(`fetch cache hit (direct): ${params.url}`);
      return { ok: true, text: directCached };
    }

    // ① direct
    const direct = await directFetch({ fetch: fetchSettings, plugins: deps.plugins }, params.url, logger);

    // 非 HTML 的直出路径：不走 FlareSolverr / playwright（那些是给 HTML 反爬的）
    if (direct.ok && direct.kind === "binary") {
      return await renderBinary(direct, params.url, maxChars);
    }
    if (direct.ok && direct.kind === "text") {
      return renderText(direct, params.url, maxChars);
    }

    // ② CF 判定：命中才升级到 FlareSolverr
    if (shouldUpgradeToFlareSolverr(deps.flaresolverr, direct)) {
      // 查 FlareSolverr 缓存
      const fsCached = cachedGet("flaresolverr", params.url, maxChars);
      if (fsCached !== undefined) {
        logger.debug(`fetch cache hit (flaresolverr): ${params.url}`);
        return { ok: true, text: fsCached };
      }

      logger.debug(`fetch upgrade to FlareSolverr: ${params.url}`);
      const fs = await fsClient.requestGet(params.url);

      if (fs.ok) {
        const html = fs.renderedHtml!;
        const baseUrl = fs.finalUrl ?? params.url;
        const md = await renderWithHtml(html, baseUrl, maxChars);
        const full = md + (md.endsWith("\n") ? "" : "\n") + "\n> 注：此页面通过浏览器渲染获取。";
        cachedSet("flaresolverr", params.url, full, maxChars);
        return { ok: true, text: full };
      }

      // FlareSolverr 失败 → ③ playwright 兜底（若启用）
      if (browserPool?.enabled) {
        const pwCached = cachedGet("playwright", params.url, maxChars);
        if (pwCached !== undefined) {
          logger.debug(`fetch cache hit (playwright): ${params.url}`);
          return { ok: true, text: pwCached };
        }
        logger.debug(`FlareSolverr 失败，尝试 playwright: ${params.url} (${fs.errorKind})`);
        const pw = await renderWithPlaywright(browserPool, { browser: deps.browser, ssrf }, logger, params.url);
        if (pw.ok && pw.html) {
          const md = await renderWithHtml(pw.html, pw.finalUrl ?? params.url, maxChars);
          const full = md + (md.endsWith("\n") ? "" : "\n") + "\n> 注：此页面通过浏览器渲染获取。";
          cachedSet("playwright", params.url, full, maxChars);
          return { ok: true, text: full };
        }
      }

      const code =
        fs.errorKind === "timeout"
          ? ErrorCodes.FETCH_TIMEOUT
          : fs.errorKind === "blocked"
            ? ErrorCodes.FETCH_BLOCKED
            : ErrorCodes.FETCH_RENDER_FAIL;
      const msg = fs.errorMessage ?? "未知错误";
      logger.debug(`FlareSolverr failed: ${params.url} kind=${fs.errorKind} msg=${msg}`);
      return {
        ok: false,
        code,
        text: withCode(code, `浏览器渲染失败（${fs.errorKind}）：${msg}\n\n目标站可能有强反爬或网络异常。`),
      };
    }

    // ④ direct 成功路径（HTML）
    if (direct.ok) {
      const html = direct.html!;
      const md = await renderWithHtml(html, direct.finalUrl ?? params.url, maxChars);
      const lines: string[] = [md];
      if (direct.truncated) {
        lines.push("");
        lines.push(`> 注：页面超过 ${(fetchSettings.max_bytes / 1024 / 1024).toFixed(1)}MB，内容已截断。`);
      }
      const full = lines.join("\n");
      cachedSet("direct", params.url, full, maxChars);
      logger.debug(`fetch done: ${params.url} (${md.length} chars)`);
      return { ok: true, text: full };
    }

    // direct 失败且不升级 → 返回 direct 错误
    const msg = direct.errorMessage ?? "未知错误";
    // 插件自定义错误码（Bilibili 等）优先，避免被包成 FETCH_NETWORK
    if (direct.errorCode) {
      const pluginCode = direct.errorCode as (typeof ErrorCodes)[keyof typeof ErrorCodes];
      logger.debug(`fetch failed (plugin code ${direct.errorCode}): ${params.url}`);
      return { ok: false, code: pluginCode, text: withCode(pluginCode, msg) };
    }
    let code: FetchOutcome["code"] = ErrorCodes.FETCH_NETWORK;
    if (direct.errorKind === "blocked_private_ip") code = ErrorCodes.FETCH_BLOCKED;
    else if (direct.errorKind === "not_html") code = ErrorCodes.FETCH_NOT_HTML;
    else if (direct.errorKind === "unsupported_type") code = ErrorCodes.FETCH_UNSUPPORTED_TYPE;
    else if (direct.errorKind === "too_large") code = ErrorCodes.FETCH_TOO_LARGE;
    else if (direct.errorKind === "timeout") code = ErrorCodes.FETCH_TIMEOUT;
    else if (direct.errorKind === "invalid_url") code = ErrorCodes.FETCH_INVALID_URL;

    let hint = "";
    if (direct.errorKind === "too_large") {
      hint = `\n\n如需下载请调大 fetch.max_download_bytes（当前上限 ${formatBytes(fetchSettings.max_download_bytes)}）。`;
    } else if (direct.errorKind === "unsupported_type") {
      hint = "\n\n该内容类型无法处理。";
    } else if (direct.errorKind === "blocked_private_ip") {
      hint = "\n\n出于安全考虑已阻止内网地址访问。";
    } else if (direct.errorKind === "timeout") {
      hint = "\n\n目标站响应过慢。";
    }
    logger.debug(`fetch failed: ${params.url} kind=${direct.errorKind} msg=${msg}`);
    return { ok: false, code, text: withCode(code, `抓取失败（${direct.errorKind}${direct.status ? ` ${direct.status}` : ""}）：${msg}${hint}`) };
  }

  return { fetch };
}
