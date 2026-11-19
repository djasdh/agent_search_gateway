import type { z } from "zod";
import type {
  adFilterSchema,
  browserSchema,
  corpusSchema,
  embeddingSchema,
  fetchSchema,
  flaresolverrSchema,
  gatewaySchema,
  loggingSchema,
  rerankSchema,
  searchSchema,
  searxngSchema,
  settingsSchema,
} from "./schema.js";

export type Settings = z.infer<typeof settingsSchema>;
export type GatewaySettings = z.infer<typeof gatewaySchema>;
export type LoggingSettings = z.infer<typeof loggingSchema>;
export type SearxngSettings = z.infer<typeof searxngSchema>;
export type FlaresolverrSettings = z.infer<typeof flaresolverrSchema>;
export type SearchSettings = z.infer<typeof searchSchema>;
export type RerankSettings = z.infer<typeof rerankSchema>;
export type AdFilterSettings = z.infer<typeof adFilterSchema>;
export type AdFilterLevel = AdFilterSettings["level"];
export type FetchSettings = z.infer<typeof fetchSchema>;
export type BrowserSettings = z.infer<typeof browserSchema>;
export type ScreenshotSettings = BrowserSettings["screenshot"];
export type EmbeddingSettings = z.infer<typeof embeddingSchema>;
export type CorpusSettings = z.infer<typeof corpusSchema>;

/** 跨组件共享的 SSRF 配置（来自 fetch 段，但浏览器/渲染/FlareSolverr 也需要）。 */
export type SsrfSettings = Pick<FetchSettings, "block_private_ips" | "private_ip_exempt_cidrs">;

/** 取件插件可见的设置切片（插件按需自取）。 */
export interface FetchPluginSettings {
  fetch: FetchSettings;
}

/** 取件插件可见的密钥切片；扩展密钥走 `pluginSecrets`。 */
export type FetchPluginSecrets = Record<string, never>;
