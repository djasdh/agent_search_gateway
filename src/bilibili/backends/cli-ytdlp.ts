/** Bilibili 后端：yt-dlp CLI，提供详情与媒体直链（`-g` 只打印 URL）。 */
import type { GatewayConfig } from "../../config.js";
import type { Logger } from "../../logger.js";
import { runCli } from "../cli.js";
import { cliFailure } from "../errors.js";
import { asString, lastJsonObject, num, str, strArray, type Json } from "../json.js";
import {
  BiliError, type BiliArticle, type BiliBackend, type BiliCapability, type BiliCommentPage,
  type BiliDetail, type BiliProbe, type BiliRef, type BiliStream, type MediaKind,
} from "../types.js";

export const YTDLP_ID = "cli-ytdlp";

function lastNonEmptyLine(text: string): string | undefined {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0).at(-1);
}

function toIso(value: unknown): string | undefined {
  let ms: number;
  if (typeof value === "number" && Number.isFinite(value)) ms = value < 1e12 ? value * 1000 : value;
  else if (typeof value === "string") ms = Date.parse(value);
  else return undefined;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;
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
  if (comment !== undefined) stat.comment = comment;
  return Object.keys(stat).length > 0 ? stat : undefined;
}

function formatFor(kind: MediaKind, quality: string): string {
  if (kind === "audio") return "ba";
  const height = /\d{3,4}/.exec(quality)?.[0];
  return height ? `bv*[height<=${height}]` : "bv*";
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
    supports: (cap: BiliCapability) => cap === "detail" || cap === "media",

    async probe(): Promise<BiliProbe> {
      const parts = probeCommand.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        const loggedIn = Boolean(cookiesFile);
        return { ok: true, loggedIn, maxQuality: loggedIn ? "1080p" : "480p" };
      }
      const result = await runCli(parts[0]!, parts.slice(1), timeoutMs);
      return result.failed ? { ok: true, loggedIn: false, maxQuality: "480p" } : { ok: true, loggedIn: true, maxQuality: "1080p" };
    },

    async detail(ref: BiliRef): Promise<BiliDetail> {
      const result = await run(["--dump-json", "--skip-download", "--no-warnings", ...baseArgs(), ref.raw]);
      if (result.failed) throw cliFailure(result, command, "video info");
      const info = lastJsonObject(result.stdout);
      if (!info) throw new BiliError("BILI_UNAVAILABLE", "video info：yt-dlp 没有输出可解析的 JSON");
      const title = str(info, "title") ?? "";
      const duration = num(info, "duration");
      const bvid = inferBvid(ref, info.id, info.webpage_url);
      const fallback = ref.raw.startsWith("http") ? ref.raw : bvid ? `https://www.bilibili.com/video/${bvid}` : ref.raw;
      return {
        bvid, aid: ref.aid, title, desc: str(info, "description") ?? "",
        owner: { mid: toMid(info.uploader_id), name: str(info, "uploader") },
        pubdate: toIso(info.timestamp), duration, stat: statOf(info), cover: str(info, "thumbnail"),
        tags: strArray(info.tags), pages: [{ page: ref.page, title, duration }],
        url: str(info, "webpage_url") ?? fallback,
      };
    },

    async media(ref: BiliRef, opts: { kind: MediaKind; quality: string }): Promise<BiliStream> {
      const format = formatFor(opts.kind, opts.quality || config.bilibili.quality);
      const result = await run(["-g", "-f", format, "--no-playlist", ...baseArgs(), ref.raw]);
      if (result.failed) throw cliFailure(result, command, "media");
      const url = lastNonEmptyLine(result.stdout);
      if (!url) throw new BiliError("BILI_UNAVAILABLE", "media：yt-dlp 没有返回直链");
      return { url, contentType: opts.kind === "audio" ? "audio/mp4" : "video/mp4", quality: opts.kind === "video" ? opts.quality || undefined : undefined };
    },

    async comments(): Promise<BiliCommentPage> {
      throw new BiliError("BILI_CAPABILITY_UNSUPPORTED", "cli-ytdlp 不支持该动作");
    },
    async article(): Promise<BiliArticle> {
      throw new BiliError("BILI_CAPABILITY_UNSUPPORTED", "cli-ytdlp 不支持该动作");
    },
  };
}
