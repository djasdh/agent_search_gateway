import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { GatewayConfig } from "../config.js";
import type { Logger } from "../logger.js";

export class BrowserPoolError extends Error {}

export interface BrowserSession {
  page: Page;
  lastActiveAt: number;
}

/** 简单信号量 */
class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private max: number) {}
  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return this.release;
    }
    await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    return this.release;
  }
  private release = (): void => {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  };
}

/**
 * playwright 浏览器实例池。
 * - 懒加载：首次调用才启动 Chromium
 * - TTL：空闲 idle_ttl_ms 无操作自动关闭（省内存）
 * - pool_size 限制同时启动的浏览器数
 * - engine: camoufox 预留（当前仅 chromium，camoufox 需后续接入）
 */
export class BrowserPool {
  private browsers: Browser[] = [];
  private context: BrowserContext | null = null;
  private currentPage: Page | null = null;
  private lastActiveAt = 0;
  private ttlTimer: ReturnType<typeof setTimeout> | null = null;
  private sem: Semaphore;
  private closed = false;

  constructor(
    private config: GatewayConfig,
    private logger: Logger,
  ) {
    this.sem = new Semaphore(config.browserMaxConcurrent);
  }

  get enabled(): boolean {
    return this.config.browserEnabled;
  }

  private launchOptions(): Parameters<typeof chromium.launch>[0] {
    const opts: Parameters<typeof chromium.launch>[0] = {
      headless: this.config.browserHeadless,
      args: [
        "--no-zygote",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--mute-audio",
      ],
    };
    if (this.config.browserProxyServer) {
      opts.proxy = {
        server: this.config.browserProxyServer,
        username: this.config.browserProxyUsername || undefined,
        password: this.config.browserProxyPassword || undefined,
      };
    }
    return opts;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.closed) throw new BrowserPoolError("浏览器池已关闭");
    if (this.browsers.length > 0) return this.browsers[0];
    if (this.config.browserEngine === "camoufox") {
      throw new BrowserPoolError("camoufox 引擎尚未接入（预留）。当前请使用 chromium。");
    }
    this.logger.debug("启动 playwright chromium...");
    const browser = await chromium.launch(this.launchOptions());
    this.browsers.push(browser);
    return browser;
  }

  private resetTtl(): void {
    if (this.ttlTimer) clearTimeout(this.ttlTimer);
    this.ttlTimer = setTimeout(() => {
      void this.closeIdle();
    }, this.config.browserIdleTtlMs);
    this.ttlTimer.unref?.();
  }

  private async closeIdle(): Promise<void> {
    if (this.closed || this.browsers.length === 0) return;
    const idle = Date.now() - this.lastActiveAt >= this.config.browserIdleTtlMs;
    if (!idle) {
      this.resetTtl();
      return;
    }
    this.logger.debug("浏览器空闲超时，关闭实例...");
    await this.closeAll();
  }

  /** 获取一个 page（会话）。TTL 复位。并发受信号量保护。 */
  async acquireSession(): Promise<BrowserSession> {
    const release = await this.sem.acquire();
    try {
      const browser = await this.ensureBrowser();
      if (!this.context) {
        this.context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      }
      if (!this.currentPage || this.currentPage.isClosed()) {
        this.currentPage = await this.context.newPage();
      }
      this.lastActiveAt = Date.now();
      this.resetTtl();
      return { page: this.currentPage, lastActiveAt: this.lastActiveAt };
    } finally {
      release();
    }
  }

  /** 关闭当前会话页面（browser_close 工具用） */
  async closeSession(): Promise<void> {
    if (this.currentPage && !this.currentPage.isClosed()) {
      await this.currentPage.close().catch(() => {});
    }
    this.currentPage = null;
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    if (this.ttlTimer) clearTimeout(this.ttlTimer);
    this.ttlTimer = null;
    for (const b of this.browsers) {
      await b.close().catch(() => {});
    }
    this.browsers = [];
    this.context = null;
    this.currentPage = null;
    this.closed = false; // 允许重新创建
  }

  isRunning(): boolean {
    return this.browsers.length > 0;
  }
}
