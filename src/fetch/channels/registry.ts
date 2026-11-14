/**
 * 通道注册表（静态元数据）。
 *
 * 通道 ID 统一为 `platform:channel`；别名只用于输入兼容。
 * 运行时实际执行仍由插件内部实现，这里只描述通道身份与能力。
 */
import type { FetchChannel } from "./types.js";

export const BILIBILI_KUKEMC: FetchChannel = {
  id: "bilibili:kukemc",
  platform: "bilibili",
  channel: "kukemc",
  displayName: "kukemc",
  kind: "cli",
  capabilities: ["detail", "comments"],
  aliases: ["bili", "cli-kukemc"],
};

export const BILIBILI_YTDLP: FetchChannel = {
  id: "bilibili:ytdlp",
  platform: "bilibili",
  channel: "ytdlp",
  displayName: "yt-dlp",
  kind: "cli",
  capabilities: ["detail", "audio"],
  aliases: ["ytdlp", "cli-ytdlp"],
};

export const BILIBILI_ARTICLE: FetchChannel = {
  id: "bilibili:article",
  platform: "bilibili",
  channel: "article",
  displayName: "article",
  kind: "http",
  capabilities: ["detail", "comments", "audio", "article"],
  aliases: ["article", "bilibili:http"],
};

export const WEIBO_OPENCLI: FetchChannel = {
  id: "weibo:opencli",
  platform: "weibo",
  channel: "opencli",
  displayName: "OpenCLI",
  kind: "cli",
  capabilities: ["post", "comments", "user", "user-posts", "image"],
  aliases: ["opencli", "weibo"],
};

export const CNKI_HTTP: FetchChannel = {
  id: "cnki:http",
  platform: "cnki",
  channel: "http",
  displayName: "CNKI HTTP",
  kind: "http",
  capabilities: ["pdf"],
  aliases: ["cnki"],
};

export const CHANNELS: readonly FetchChannel[] = [
  BILIBILI_KUKEMC,
  BILIBILI_YTDLP,
  BILIBILI_ARTICLE,
  WEIBO_OPENCLI,
  CNKI_HTTP,
];

const BY_ID = new Map<string, FetchChannel>();
const BY_ALIAS = new Map<string, FetchChannel>();
for (const channel of CHANNELS) {
  BY_ID.set(channel.id.toLowerCase(), channel);
  for (const alias of channel.aliases ?? []) BY_ALIAS.set(alias.trim().toLowerCase(), channel);
}

/** 按规范 ID 精确查通道。 */
export function channelById(id: string): FetchChannel | undefined {
  return BY_ID.get(id.trim().toLowerCase());
}

/** 把用户输入（规范 ID 或别名）归一化为通道；未知返回 undefined。 */
export function normalizeChannel(input: string): FetchChannel | undefined {
  const key = input.trim().toLowerCase();
  return BY_ID.get(key) ?? BY_ALIAS.get(key);
}
