import type { BrowserPool } from "./pool.js";
import type { Logger } from "../logger.js";
import { assertPublicHttpUrl } from "../fetch/ssrf.js";
import type { BrowserSettings, SsrfSettings } from "../settings/index.js";

/** fetch 路由③ 渲染所需的设置切片。 */
export interface RenderSettings {
  browser: BrowserSettings;
  ssrf: SsrfSettings;
}

export interface RenderResult {
  ok: boolean;
  html?: string;
  finalUrl?: string;
  errorMessage?: string;
}

/**
 * fetch 路由③：用 playwright 渲染页面（复杂 SPA）。
 * - goto(networkidle) 等 JS 加载
 * - 可选 wait_for_selector（配置），等异步内容出现
 * - 提取渲染后 HTML
 */
export async function renderWithPlaywright(
  pool: BrowserPool,
  deps: RenderSettings,
  logger: Logger,
  url: string,
): Promise<RenderResult> {
  if (!pool.enabled) {
    return { ok: false, errorMessage: "浏览器功能未启用（browser.enabled=false）" };
  }
  // SSRF：浏览器渲染会自行解析并访问 URL（含重定向），导航前校验
  const check = await assertPublicHttpUrl(url, {
    exemptCidrs: deps.ssrf.private_ip_exempt_cidrs,
    enabled: deps.ssrf.block_private_ips,
  });
  if (!check.ok) {
    return {
      ok: false,
      errorMessage:
        check.reason === "private_ip" ? `SSRF 防护：拒绝内网地址 ${url}` : `非法 URL: ${url}`,
    };
  }
  try {
    const { page } = await pool.acquireSession();
    await page.goto(url, { waitUntil: "networkidle", timeout: deps.browser.timeout_ms });

    const sel = deps.browser.wait_for_selector;
    if (sel && sel.trim().length > 0) {
      try {
        await page.waitForSelector(sel.trim(), { timeout: deps.browser.timeout_ms });
      } catch {
        logger.debug(`wait_for_selector 超时: ${sel}`);
      }
    }

    const html = await page.content();
    const finalUrl = page.url();
    return { ok: true, html, finalUrl };
  } catch (err) {
    return { ok: false, errorMessage: err instanceof Error ? err.message : String(err) };
  }
}
