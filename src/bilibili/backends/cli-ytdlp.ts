/** Bilibili 后端：yt-dlp CLI，提供详情与音频直链（`-g` 只打印 URL）。 */
import type { GatewayConfig } from "../../config.js";
import type { Logger } from "../../logger.js";
import { runCli } from "../cli.js";
import { cliFailure } from "../errors.js";
import { asArray, asRecord, asString, lastJsonObject, num, str, type Json } from "../json.js";
import {
  BiliError, type BiliArticle, type BiliAudio, type BiliBackend, type BiliCapability,
  type BiliCommentPage, type BiliDetail, type BiliPage, type BiliProbe, type BiliRef,
} from "../types.js";

export const YTDLP_ID = "cli-ytdlp";

function lastNonEmptyLine(text: string): string | undefined {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0).at(-1);
}

function toMid(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return typeof value === "string" && /^\d+$/.test(value) ? Number(value) : undefined;
}

function inferBvid(ref: BiliRef, id: unknown, url: unknown): string {
  for (const candidate of [ref.bvid, asString(id), asString(url), ref.raw]) {
    const match = candidate ? /BV[0-9A-Za-z]{10}/.exec(candidate) : null;
    if (match) return match[0]!;
  }
  return "";
}

function statOf(info: Json): Record<string, number> | undefined {
  const stat: Record<string, number> = {};
  const view = num(info, "view_count");
  if (view !== undefined) stat.view = view;
  const like = num(info, "like_count");
  if (like !== undefined) stat.like = like;
  const comment = num(info, "comment_count");
  if (comment !== undefined) stat.reply = comment;
  return Object.keys(stat).length > 0 ? stat : undefined;
}

/** 多P合集时 yt-dlp 返回 entries；单P只有当前标题。 */
function pagesOf(info: Json, ref: BiliRef, title: string): BiliPage[] {
  const entries = asArray(info.entries);
  if (entries.length > 0) {
    return entries.map((entry, index) => {
      const item = asRecord(entry) ?? {};
      return {
        page: num(item, "playlist_index") ?? index + 1,
        title: str(item, "title") ?? "",
      };
    });
  }
  return [{ page: ref.page, title }];
}

export function createYtdlpBackend(config: GatewayConfig, logger?: Logger): BiliBackend {
  const { command, cookiesFile, probeCommand, timeoutMs } = config.bilibili.cliYtdlp;
  const baseArgs = () => (cookiesFile ? ["--cookies", cookiesFile] : []);
  const run = (args: string[]) => {
    logger?.debug(`bilibili cli-ytdlp: ${command} ${args.join(" ")}`);
    return runCli(command, args, timeoutMs);
  };

  return {
    id: YTDLP_ID,
    supports: (cap: BiliCapability) => cap === "detail" || cap === "audio",

    async probe(): Promise<BiliProbe> {
      const parts = probeCommand.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) return { ok: true, loggedIn: Boolean(cookiesFile) };
      const result = await runCli(parts[0]!, parts.slice(1), timeoutMs);
      return { ok: true, loggedIn: !result.failed };
    },

    async detail(ref: BiliRef): Promise<BiliDetail> {
      const result = await run(["--dump-json", "--skip-download", "--no-warnings", ...baseArgs(), ref.raw]);
      if (result.failed) throw cliFailure(result, command, "video info");
      const info = lastJsonObject(result.stdout);
      if (!info) throw new BiliError("BILI_UNAVAILABLE", "video info：yt-dlp 没有输出可解析的 JSON");
      const title = str(info, "title") ?? "";
      const pages = pagesOf(info, ref, title);
      return {
        bvid: inferBvid(ref, info.id, info.webpage_url),
        aid: ref.aid,
        title,
        desc: str(info, "description") ?? "",
        owner: { mid: toMid(info.uploader_id), name: str(info, "uploader") },
        stat: statOf(info),
        cover: str(info, "thumbnail"),
        pages,
        currentPage: ref.page,
        pageCount: pages.length,
      };
    },

    async audio(ref: BiliRef): Promise<BiliAudio> {
      const result = await run(["-g", "-f", "ba", "--no-playlist", ...baseArgs(), ref.raw]);
      if (result.failed) throw cliFailure(result, command, "audio");
      const url = lastNonEmptyLine(result.stdout);
      if (!url) throw new BiliError("BILI_UNAVAILABLE", "audio：yt-dlp 没有返回直链");
      return { url };
    },

    async comments(): Promise<BiliCommentPage> {
      throw new BiliError("BILI_CAPABILITY_UNSUPPORTED", "cli-ytdlp 不支持评论");
    },
    async article(): Promise<BiliArticle> {
      throw new BiliError("BILI_CAPABILITY_UNSUPPORTED", "cli-ytdlp 不支持专栏");
    },
  };
}
