/**
 * 抓取平台规范化（第一步：平台 ID 与通道 ID）。
 *
 * 平台 ID 是稳定的规范标识（`bilibili` / `weibo` / `cnki`），
 * CLI 的旧写法（如 `bili`）与中文别名只作为输入别名接受；
 * 所有对外输出（日志、fetch 结果、后续的 `asg plugins`）统一使用规范 ID。
 */

export type PlatformId = string;

export interface PlatformInfo {
  id: PlatformId;
  displayName: string;
  aliases: readonly string[];
}

export const PLATFORMS: readonly PlatformInfo[] = [
  { id: "bilibili", displayName: "Bilibili", aliases: ["bili", "B站", "哔哩哔哩"] },
  { id: "weibo", displayName: "微博", aliases: ["微博"] },
  { id: "cnki", displayName: "知网", aliases: ["知网"] },
];

/** 别名 → 规范 ID（精确匹配，不做模糊纠错）。 */
const PLATFORM_LOOKUP = new Map<string, PlatformId>();
for (const platform of PLATFORMS) {
  PLATFORM_LOOKUP.set(platform.id.toLowerCase(), platform.id);
  for (const alias of platform.aliases) PLATFORM_LOOKUP.set(alias.trim().toLowerCase(), platform.id);
}

/** 把用户输入（规范 ID 或别名）归一化为平台 ID；未知输入返回 undefined。 */
export function normalizePlatform(input: string): PlatformId | undefined {
  return PLATFORM_LOOKUP.get(input.trim().toLowerCase());
}

/** 按 ID 或别名查平台信息。 */
export function platformInfo(id: string): PlatformInfo | undefined {
  const canonical = normalizePlatform(id);
  if (!canonical) return undefined;
  return PLATFORMS.find((platform) => platform.id === canonical);
}

/** 通道的全局唯一 ID，例如 `bilibili:kukemc`。 */
export function canonicalChannelId(platform: PlatformId, channel: string): string {
  const canonical = normalizePlatform(platform) ?? platform.trim().toLowerCase();
  return `${canonical}:${channel.trim()}`;
}
