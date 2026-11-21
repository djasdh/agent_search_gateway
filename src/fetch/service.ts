import type { Logger } from "../logger.js";
import type { BrowserPool } from "../browser/pool.js";
import { renderWithPlaywright } from "../browser/render.js";
import { ErrorCodes, withCode } from "../utils/errors.js";
import { FetchCache, type RenderMode } from "./cache.js";
import { baseContentType, formatBytes, renderTextBody } from "./convert.js";
import { analyzeJsShell, countVisibleChars } from "./content.js";
import { parseDataImage } from "./data-uri.js";
import { directFetch, type DirectFetchResult } from "./direct.js";
import { createFlareSolverrClient, type FlareSolverrClient } from "./flaresolverr.js";
import { htmlToMarkdown } from "./html2md.js";
import { pdfToText } from "./pdf.js";
import type { FetchStore } from "./store.js";
import type { FetchProviderRegistry } from "./plugins/registry.js";
import {
  ssrfOf,
  type BrowserSettings,
  type FetchPluginSecrets,
  type FetchPluginSettings,
  type FetchSettings,
  type FlaresolverrSettings,
} from "../settings/index.js";

/** fetch 的浏览器渲染策略；默认 auto（内容判空后自动升级）。 */
export type FetchRenderMode = "auto" | "always" | "never";

export interface FetchParams {
  url: string;
  maxChars?: number;
  render?: FetchRenderMode;
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
    /** 进程级合并后的注册表（含外部扩展）；缺省用内置注册表。 */
    registry?: FetchProviderRegistry;
  };
}

function shouldUpgradeToFlareSolverr(
  flaresolverr: FlaresolverrSettings,
  direct: DirectFetchResult,
): boolean {
  if (!flaresolverr.enabled) return false;
  if (direct.ok) return false;
  if (direct.errorKind === "http" && direct.status !== undefined) {
    return flaresolverr.trigger_status.includes(direct.status);
  }
  return false;
}

/** max_chars 参数钳制上限：防止 agent 传超大值把整页塞进 LLM context */
const MAX_OUTPUT_CHARS_LIMIT = 200000;

/** 截断标记；capOutput 用它兜住标题、PDF 头、渲染注释等“预算外”文本。 */
const TRUNCATION_MARKER = "\n\n…(内容已截断)";
/** 只有 limit 至少能放下标记 + 一点正文时才追加标记，否则直接硬切。 */
const MIN_MARKER_LIMIT = TRUNCATION_MARKER.length + 10;

const RENDER_NOTE = "\n\n> 注：此页面通过浏览器渲染获取。";

/** 内嵌 data: 图片的落盘上限：单张 2MB、单次 10MB / 20 张。 */
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_IMAGE_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_INLINE_IMAGES = 20;

function clampMaxChars(v: number | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (v <= 0) return undefined;
  return Math.min(v, MAX_OUTPUT_CHARS_LIMIT);
}

/**
 * 把最终输出硬性压到 limit 以内。
 *
 * 内部各路径（PDF/HTML/文本转换）只截正文，标题、PDF 头、渲染注释、截断提示都算在
 * 预算之外；这里做最后兜底，保证 `text.length <= limit`。
 * limit 太小放不下标记时直接切，绝不返回空字符串（limit >= 1 至少 1 个字符）。
 */
export function capOutput(text: string, limit: number | undefined): string {
  if (limit === undefined || text.length <= limit) return text;
  if (limit >= MIN_MARKER_LIMIT) {
    return text.slice(0, limit - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
  }
  return text.slice(0, limit);
}

/**
 * 日志/错误文本里抹掉 URL 凭据（https://user:pass@host/ → https://host/），
 * 防止密码被写进日志。解析失败原样返回（无法安全改写）。
 */
export function redactUrl(u: string): string {
  try {
    const parsed = new URL(u);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return u;
  }
}

interface RenderedHtml {
  text: string;
  /** 不含标题的正文 markdown（用于判断是否有图片/链接等非文本内容）。 */
  markdown: string;
  /** 截断前的正文可见字符数（不含标题）。 */
  contentChars: number;
}

interface BrowserRenderOutcome {
  ok: boolean;
  /** 渲染后的 markdown（不含“浏览器渲染获取”注释，便于比较正文长度）。 */
  text?: string;
  mode?: "playwright" | "flaresolverr";
  errors: string[];
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

  async function renderWithHtml(html: string, baseUrl: string, maxChars?: number): Promise<RenderedHtml> {
    const imageStore = store;
    let inlineImages = 0;
    let inlineBytes = 0;
    const resolveImage = imageStore
      ? (src: string): string | undefined => {
          if (inlineImages >= MAX_INLINE_IMAGES) return undefined;
          const parsed = parseDataImage(src);
          if (!parsed) return undefined;
          if (parsed.bytes.length > MAX_INLINE_IMAGE_BYTES) return undefined;
          if (inlineBytes + parsed.bytes.length > MAX_INLINE_IMAGE_TOTAL_BYTES) return undefined;
          inlineImages += 1;
          inlineBytes += parsed.bytes.length;
          const f = imageStore.put(parsed.bytes, {
            contentType: parsed.contentType,
            sourceUrl: baseUrl,
          });
          return `${deps.files_base_url}${f.url}`;
        }
      : undefined;

    const md = htmlToMarkdown(html, {
      structural: fetchSettings.structural,
      baseUrl,
      maxOutputChars: maxChars ?? fetchSettings.max_output_chars,
      ...(resolveImage ? { resolveImage } : {}),
    });
    if (inlineImages > 0) {
      logger.debug(`fetch inline images stored: ${inlineImages} (${inlineBytes} bytes) ${baseUrl}`);
    }
    const lines: string[] = [];
    if (md.title) lines.push(`# ${md.title}`);
    lines.push("");
    lines.push(md.markdown);
    return { text: lines.join("\n"), markdown: md.markdown, contentChars: md.contentChars };
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
    // 204/205 等空响应体：ok=true 但绝不能返回空字符串，否则 agent 会以为没拿到内容。
    if (full.trim() === "") {
      logger.debug(`fetch empty body (${base || "unknown"}): ${url}`);
      const detail = direct.status !== undefined ? `；HTTP ${direct.status}` : "";
      return { ok: true, text: `（响应体为空${detail}）` };
    }
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

  /**
   * 按偏好顺序尝试 playwright / FlareSolverr，返回第一份非空正文。
   * CF 挑战页即使有少量文字也不算成功，继续下一个引擎。
   */
  async function renderViaBrowser(
    url: string,
    maxChars: number | undefined,
    prefer: "playwright" | "flaresolverr",
  ): Promise<BrowserRenderOutcome> {
    const order: Array<"playwright" | "flaresolverr"> = [];
    if (prefer === "flaresolverr") {
      if (deps.flaresolverr.enabled) order.push("flaresolverr");
      if (browserPool?.enabled) order.push("playwright");
    } else {
      if (browserPool?.enabled) order.push("playwright");
      if (deps.flaresolverr.enabled) order.push("flaresolverr");
    }

    if (order.length === 0) {
      return { ok: false, errors: ["浏览器渲染未启用"] };
    }

    const errors: string[] = [];
    for (const engine of order) {
      const cached = cachedGet(engine, url, maxChars);
      if (cached !== undefined) {
        logger.debug(`fetch cache hit (${engine}): ${url}`);
        return { ok: true, text: cached, mode: engine, errors };
      }

      if (engine === "playwright") {
        logger.debug(`fetch render via playwright: ${url}`);
        const pw = await renderWithPlaywright(
          browserPool!,
          { browser: deps.browser, ssrf },
          logger,
          url,
          { minTextChars: 1 },
        );
        if (pw.ok && pw.html) {
          const md = await renderWithHtml(pw.html, pw.finalUrl ?? url, maxChars);
          const analysis = analyzeJsShell(pw.html, md.contentChars);
          if (md.contentChars > 0 && analysis.reason !== "cf") {
            cachedSet("playwright", url, md.text, maxChars);
            return { ok: true, text: md.text, mode: "playwright", errors };
          }
          errors.push(
            analysis.reason === "cf" ? "playwright: 仍为 Cloudflare 挑战页" : "playwright: 渲染结果无正文",
          );
        } else {
          errors.push(`playwright: ${pw.errorMessage ?? "失败"}`);
        }
        continue;
      }

      logger.debug(`fetch render via FlareSolverr: ${url}`);
      const fs = await fsClient.requestGet(url);
      if (fs.ok) {
        const md = await renderWithHtml(fs.renderedHtml!, fs.finalUrl ?? url, maxChars);
        const analysis = analyzeJsShell(fs.renderedHtml!, md.contentChars);
        if (md.contentChars > 0 && analysis.reason !== "cf") {
          cachedSet("flaresolverr", url, md.text, maxChars);
          return { ok: true, text: md.text, mode: "flaresolverr", errors };
        }
        errors.push(
          analysis.reason === "cf" ? "flaresolverr: 仍为 Cloudflare 挑战页" : "flaresolverr: 渲染结果无正文",
        );
      } else {
        errors.push(`flaresolverr: ${fs.errorMessage ?? fs.errorKind ?? "失败"}`);
      }
    }

    return { ok: false, errors };
  }

  /** 403 / 405 / 429：沿用 FlareSolverr 优先、playwright 兜底。 */
  async function renderBlocked(url: string, maxChars?: number): Promise<FetchOutcome> {
    const rendered = await renderViaBrowser(url, maxChars, "flaresolverr");
    if (rendered.ok && rendered.text) {
      return { ok: true, text: rendered.text + RENDER_NOTE };
    }
    const detail = rendered.errors.length > 0 ? `（${rendered.errors.join("；")}）` : "";
    return {
      ok: false,
      code: ErrorCodes.FETCH_RENDER_FAIL,
      text: withCode(
        ErrorCodes.FETCH_RENDER_FAIL,
        `浏览器渲染失败${detail}。目标站可能有强反爬或网络异常。`,
      ),
    };
  }

  async function runFetch(params: FetchParams): Promise<FetchOutcome> {
    const maxChars = clampMaxChars(params.maxChars);
    const mode: FetchRenderMode = params.render ?? "auto";
    // 入口统一脱敏一次；后续各路径的 URL 都经过 directFetch 的凭据检查，不会带 userinfo。
    const logUrl = redactUrl(params.url);

    // 缓存按模式隔离：auto 缓存“最终选中的结果”，always 只复用渲染结果。
    if (mode === "auto") {
      const hit = cachedGet("auto", params.url, maxChars);
      if (hit !== undefined) {
        logger.debug(`fetch cache hit (auto): ${logUrl}`);
        return { ok: true, text: hit };
      }
    } else if (mode === "never") {
      const hit = cachedGet("direct", params.url, maxChars);
      if (hit !== undefined) {
        logger.debug(`fetch cache hit (direct): ${logUrl}`);
        return { ok: true, text: hit };
      }
    } else {
      const hit =
        cachedGet("playwright", params.url, maxChars) ?? cachedGet("flaresolverr", params.url, maxChars);
      if (hit !== undefined) {
        logger.debug(`fetch cache hit (always): ${logUrl}`);
        return { ok: true, text: hit + RENDER_NOTE };
      }
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

    // ② direct 失败：HTTP 状态命中 trigger_status → 浏览器反爬链路
    if (!direct.ok) {
      if (mode !== "never" && shouldUpgradeToFlareSolverr(deps.flaresolverr, direct)) {
        return await renderBlocked(params.url, maxChars);
      }

      const msg = direct.errorMessage ?? "未知错误";
      // 插件自定义错误码（Bilibili 等）优先，避免被包成 FETCH_NETWORK
      if (direct.errorCode) {
        const pluginCode = direct.errorCode as (typeof ErrorCodes)[keyof typeof ErrorCodes];
        logger.debug(`fetch failed (plugin code ${direct.errorCode}): ${logUrl}`);
        return { ok: false, code: pluginCode, text: withCode(pluginCode, msg) };
      }
      let code: FetchOutcome["code"] = ErrorCodes.FETCH_NETWORK;
      if (direct.errorKind === "blocked_private_ip") code = ErrorCodes.FETCH_BLOCKED;
      else if (direct.errorKind === "not_html") code = ErrorCodes.FETCH_NOT_HTML;
      else if (direct.errorKind === "unsupported_type") code = ErrorCodes.FETCH_UNSUPPORTED_TYPE;
      else if (direct.errorKind === "too_large") code = ErrorCodes.FETCH_TOO_LARGE;
      else if (direct.errorKind === "timeout") code = ErrorCodes.FETCH_TIMEOUT;
      else if (direct.errorKind === "invalid_url") code = ErrorCodes.FETCH_INVALID_URL;
      else if (direct.errorKind === "http" && direct.status !== undefined) code = ErrorCodes.FETCH_HTTP_STATUS;

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
      logger.debug(`fetch failed: ${logUrl} kind=${direct.errorKind} msg=${redactUrl(msg)}`);
      return { ok: false, code, text: withCode(code, `抓取失败（${direct.errorKind}${direct.status ? ` ${direct.status}` : ""}）：${msg}${hint}`) };
    }

    // ④ direct 成功路径（HTML）
    const html = direct.html!;
    const md = await renderWithHtml(html, direct.finalUrl ?? params.url, maxChars);
    const analysis = analyzeJsShell(html, md.contentChars);

    const directLines: string[] = [md.text];
    if (direct.truncated) {
      directLines.push("");
      directLines.push(`> 注：页面超过 ${(fetchSettings.max_bytes / 1024 / 1024).toFixed(1)}MB，内容已截断。`);
    }
    const directFull = directLines.join("\n");

    // 插件自己负责内容；显式 always 也不改写插件结果。
    const wantRender =
      direct.plugin === undefined &&
      (mode === "always" ||
        (mode === "auto" && analysis.likely && deps.flaresolverr.fallback_on_empty));

    if (!wantRender) {
      if (direct.plugin === undefined && mode === "never" && analysis.likely) {
        if (md.markdown.trim().length === 0) {
          const text = withCode(
            ErrorCodes.FETCH_RENDER_FAIL,
            "页面正文为空，疑似依赖 JavaScript 渲染（render=never）。可改用 render=auto 或 render=always。",
          );
          return { ok: false, code: ErrorCodes.FETCH_RENDER_FAIL, text };
        }
        const text = `${directFull}\n\n> 注：页面疑似依赖 JavaScript；如需完整内容请使用 render=auto 或 render=always。`;
        cachedSet("direct", params.url, text, maxChars);
        return { ok: true, text };
      }

      if (direct.plugin === undefined && mode === "auto" && analysis.likely) {
        if (md.markdown.trim().length === 0) {
          const text = withCode(
            ErrorCodes.FETCH_RENDER_FAIL,
            "页面正文为空，疑似依赖 JavaScript；自动渲染已关闭（flaresolverr.fallback_on_empty=false）。可改用 render=always。",
          );
          return { ok: false, code: ErrorCodes.FETCH_RENDER_FAIL, text };
        }
        const text = `${directFull}\n\n> 注：页面疑似依赖 JavaScript，但自动渲染已关闭（flaresolverr.fallback_on_empty=false）。`;
        cachedSet("auto", params.url, text, maxChars);
        return { ok: true, text };
      }

      cachedSet(mode === "auto" ? "auto" : "direct", params.url, directFull, maxChars);
      logger.debug(`fetch done: ${logUrl} (${md.text.length} chars, render=${mode})`);
      return { ok: true, text: directFull };
    }

    // ③ 浏览器渲染：CF 挑战优先 FlareSolverr，普通 JS 空壳优先本地 playwright。
    const prefer = analysis.reason === "cf" ? "flaresolverr" : "playwright";
    const rendered = await renderViaBrowser(params.url, maxChars, prefer);

    if (rendered.ok && rendered.text) {
      const renderedText = rendered.text + RENDER_NOTE;
      const useRendered = countVisibleChars(rendered.text) > countVisibleChars(directFull);
      const chosen = useRendered ? renderedText : directFull;
      // auto 缓存最终结果；always 且 direct 更完整时也写 auto，避免下次重复渲染。
      if (mode === "auto" || !useRendered) {
        cachedSet("auto", params.url, chosen, maxChars);
      }
      logger.debug(
        `fetch done: ${logUrl} (render=${mode}, used=${useRendered ? rendered.mode : "direct"})`,
      );
      return { ok: true, text: chosen };
    }

    // 渲染失败：direct 有正文（含图片/链接等非文本内容）就保留，绝不让“渲染失败”把已有内容吞掉。
    if (md.markdown.trim().length > 0) {
      const detail = rendered.errors.length > 0 ? `（${rendered.errors.join("；")}）` : "";
      const text = `${directFull}\n\n> 注：浏览器渲染失败${detail}，已返回直连内容。`;
      cachedSet(mode === "auto" ? "auto" : "direct", params.url, text, maxChars);
      return { ok: true, text };
    }

    const detail = rendered.errors.length > 0 ? `（${rendered.errors.join("；")}）` : "";
    return {
      ok: false,
      code: ErrorCodes.FETCH_RENDER_FAIL,
      text: withCode(
        ErrorCodes.FETCH_RENDER_FAIL,
        `页面疑似依赖 JavaScript 或需要登录，浏览器渲染后仍无正文${detail}。`,
      ),
    };
  }

  /**
   * 对外入口：所有成功文本都过一遍 capOutput，保证最终长度 ≤ max_chars。
   * 缓存里存的是未（外层）截断的文本，读取时在这里统一 cap。
   */
  async function fetch(params: FetchParams): Promise<FetchOutcome> {
    const outcome = await runFetch(params);
    if (!outcome.ok) return outcome;
    return { ...outcome, text: capOutput(outcome.text, clampMaxChars(params.maxChars)) };
  }

  return { fetch };
}
