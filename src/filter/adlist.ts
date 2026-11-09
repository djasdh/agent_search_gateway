import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { AdFilterSettings } from "../settings/index.js";
import { HOSTS_SOURCES } from "./domain-filter.js";
import type { Logger } from "../logger.js";

/**
 * 拉取 StevenBlack hosts 到本地。失败不抛异常（保留本地缓存，供 buildDomainFilter 兜底）。
 * 返回是否成功。
 */
export async function fetchAdList(adFilter: AdFilterSettings): Promise<boolean> {
  if (!adFilter.enabled || adFilter.level === "off") return false;
  const src = HOSTS_SOURCES[adFilter.level];
  if (!src) return false;

  const dir = dirname(adFilter.hosts_file);
  mkdirSync(dir, { recursive: true });

  try {
    const res = await fetch(src, { redirect: "follow", signal: AbortSignal.timeout(60000) });
    if (!res.ok) return false;
    const text = await res.text();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(adFilter.hosts_file, text, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** hosts 文件是否缺失或过期（超过 auto_update_interval_ms 未更新） */
export function isAdListStale(adFilter: AdFilterSettings): boolean {
  if (!existsSync(adFilter.hosts_file)) return true;
  try {
    const mtime = statSync(adFilter.hosts_file).mtimeMs;
    return Date.now() - mtime > adFilter.auto_update_interval_ms;
  } catch {
    return true;
  }
}

/**
 * 启动时确保 adlist 最新：缺失或过期则异步拉取。
 * 异步执行，不阻塞服务启动；失败仅记录日志（继续用本地/空列表）。
 */
export function ensureAdList(adFilter: AdFilterSettings, logger: Logger): void {
  if (!adFilter.enabled || adFilter.level === "off") return;
  if (!isAdListStale(adFilter)) return;

  logger.info(`adlist 缺失或过期，后台拉取 ${adFilter.level}...`);
  void fetchAdList(adFilter).then((ok) => {
    if (ok) {
      logger.info(`adlist 已更新: ${adFilter.hosts_file}`);
    } else {
      logger.warn("adlist 拉取失败，使用本地/空列表");
    }
  });
}

/**
 * 天级自动拉取调度器：按 auto_update_interval_ms 周期检查并拉取 adlist。
 * 拉取成功且内容有变化时回调 onRefresh（由调用方重建广告过滤集）。
 * 返回停止函数（优雅关闭时调用）。
 */
export function startAdListScheduler(
  adFilter: AdFilterSettings,
  logger: Logger,
  onRefresh: () => void,
): () => void {
  if (!adFilter.enabled || adFilter.level === "off" || !adFilter.auto_update) {
    return () => {};
  }

  const intervalMs = adFilter.auto_update_interval_ms;
  const timer = setInterval(() => {
    if (!isAdListStale(adFilter)) return;
    logger.info(`adlist 定期检查：过期，拉取 ${adFilter.level}...`);
    void fetchAdList(adFilter).then((ok) => {
      if (ok) {
        logger.info(`adlist 已更新: ${adFilter.hosts_file}`);
        onRefresh();
      } else {
        logger.warn("adlist 定期拉取失败");
      }
    });
  }, intervalMs);
  timer.unref?.();

  return () => clearInterval(timer);
}
