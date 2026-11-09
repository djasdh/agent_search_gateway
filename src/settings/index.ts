import { settingsSchema } from "./schema.js";
import type { FetchSettings, Settings, SsrfSettings } from "./types.js";

export { loadSettings, defaultConfigPath, defaultSecretsPath } from "./load.js";
export type { LoadedSettings, LoadSettingsOptions } from "./load.js";
export { defaultSecrets, secretsSchema } from "./secrets.js";
export type { Secrets } from "./secrets.js";
export * from "./types.js";

/** 全默认设置：与 gateway.yaml 全空时加载结果一致；测试和运行共用同一份默认值。 */
export function defaultSettings(): Settings {
  return settingsSchema.parse({});
}

/** 从 fetch 段提取跨组件共享的 SSRF 配置。 */
export function ssrfOf(fetch: FetchSettings): SsrfSettings {
  return {
    block_private_ips: fetch.block_private_ips,
    private_ip_exempt_cidrs: fetch.private_ip_exempt_cidrs,
  };
}
