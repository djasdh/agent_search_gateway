/**
 * Bilibili 抓取后端：yt-dlp CLI。
 *
 * 提供视频详情与媒体直链（`-g` 只打印 URL，不下载）。
 * 与 kukemc 后端互补：详情字段较少，但能拿播放地址；评论/专栏不支持。
 */
import { execFile } from "node:child_process";
import type { GatewayConfig } from "../../config.js";
import type { Logger } from "../../logger.js";
import {
  BiliError,
  type BiliArticle,
  type BiliBackend,
  type BiliCapability,
  type BiliCommentPage,
  type BiliDetail,
  type BiliProbe,
  type BiliRef,
  type BiliStream,
  type MediaKind,
} from "../types.js";

export const YTDLP_ID = "cli-ytdlp";

/** CLI 单次输出上限（详情 JSON 可能较大）。 */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

interface CliResult {
  stdout: string;
  stderr: string;
  /** 退出码非 0（业务失败）；进程级故障（ENOENT/超时）直接 reject。 */
  failed: boolean;
  error?: string;
}

/** execFile 回调里的 stdout/stderr 在指定 utf8 时是字符串，这里兜底 Buffer。 */
function toText(value: string | Buffer | null | undefined): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : value.toString("utf8");
}

function runCli(command: string, args: string[], timeoutMs: number): Promise<CliResult> {
  return new Promise<CliResult>((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER_BYTES, encoding: "utf8", windowsHide: true },
      (err, stdout, stderr) => {
        const out = toText(stdout);
        const errText = toText(stderr);
        if (!err) {
          resolve({ stdout: out, stderr: errText, failed: false });
          return;
        }

        const e = err as {
          code?: string | number;
          killed?: boolean;
          message?: string;
        };
        if (e.code === "ENOENT") {
          reject(
            new BiliError(
              "BILI_UNAVAILABLE",
              `spawn ${command} ENOENT`,
              "检查 bilibili.cli_ytdlp.command 配置",
            ),
          );
          return;
        }
        if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          reject(
            new BiliError(
              "BILI_UNAVAILABLE",
              `${command} 输出超过 ${MAX_BUFFER_BYTES} 字节上限`,
            ),
          );
          return;
        }
        if (e.code === "ETIMEDOUT" || e.killed) {
          reject(
            new BiliError(
              "BILI_UNAVAILABLE",
              `${command} 执行超时（${timeoutMs}ms）`,
              "可调大 bilibili.cli_ytdlp.timeout_ms",
            ),
          );
          return;
        }

        resolve({ stdout: out, stderr: errText, failed: true, error: e.message });
      },
    );
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 最后一行非空输出（`-g` 可能同时打印多行，取最终直链）。 */
function lastNonEmptyLine(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length > 0 ? lines[lines.length - 1] : undefined;
}

function tailOf(text: string): string {
  const line = lastNonEmptyLine(text);
  if (!line) return "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** `--dump-json` 正常输出一行完整 JSON；这里从后往前找可解析对象。 */
function parseLastJsonObject(text: string): Record<string, unknown> | undefined {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* 该行不是完整 JSON，继续往前找 */
    }
  }

  // 兜底：格式化输出（跨多行）时取整段最后一个对象。
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end + 1));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

/**
 * 失败映射：先看登录标记，再看风控标记。
 * 注意 B 站 `-101` 是「账号未登录」，归到 AUTH_REQUIRED；403/412 才是风控拦截。
 */
function mapFailure(result: CliResult): BiliError {
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  const tail = tailOf(result.stderr) || tailOf(result.stdout) || result.error || "未知错误";

  if (/log\s*in|login|sign\s*in|not\s+logged|需要登录|登录|-101/.test(text)) {
    return new BiliError(
      "BILI_AUTH_REQUIRED",
      `yt-dlp 需要登录态：${tail}`,
      "配置 bilibili.cli_ytdlp.cookies_file 或先登录 yt-dlp 后重试",
    );
  }
  if (/403|412|风控|risk|precondition|forbidden/.test(text)) {
    return new BiliError(
      "BILI_RISK_CONTROL",
      `B 站风控/拒绝访问：${tail}`,
      "稍后重试或更换网络出口",
    );
  }
  return new BiliError("BILI_UNAVAILABLE", `yt-dlp 执行失败：${tail}`);
}

/** 质量串 → yt-dlp 格式选择器；`best`/未知值回落到最高画质。 */
function parseQuality(raw: string): { selector: string; label: string } {
  const quality = (raw ?? "").trim().toLowerCase();
  if (quality === "" || quality === "best") {
    return { selector: "bv*", label: "best" };
  }
  const match = /^(\d{3,4})p?$/.exec(quality);
  if (match) {
    return { selector: `bv*[height<=${match[1]}]`, label: `${match[1]}p` };
  }
  return { selector: "bv*", label: "best" };
}

function toMid(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/** timestamp（秒）→ ISO；也兼容毫秒和可解析字符串。 */
function toIso(value: unknown): string | undefined {
  let ms: number;
  if (typeof value === "number" && Number.isFinite(value)) {
    ms = value < 1e12 ? value * 1000 : value;
  } else if (typeof value === "string") {
    const parsed = Date.parse(value);
    ms = Number.isFinite(parsed) ? parsed : Number.NaN;
  } else {
    ms = Number.NaN;
  }
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return list.length > 0 ? list : undefined;
}

function mapStat(info: Record<string, unknown>): Record<string, number> | undefined {
  const stat: Record<string, number> = {};
  const view = asNumber(info.view_count);
  if (view !== undefined) stat.view = view;
  const like = asNumber(info.like_count);
  if (like !== undefined) stat.like = like;
  const comment = asNumber(info.comment_count);
  if (comment !== undefined) stat.comment = comment;
  return Object.keys(stat).length > 0 ? stat : undefined;
}

/** 从 ref / yt-dlp 的 id / 页面 URL 里推 BV 号。 */
function inferBvid(ref: BiliRef, info: Record<string, unknown>): string {
  if (ref.bvid) return ref.bvid;
  const candidates = [asString(info.id), asString(info.webpage_url), ref.raw];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const match = /BV[0-9A-Za-z]{10}/.exec(candidate);
    if (match) return match[0];
  }
  return "";
}

export function createYtdlpBackend(config: GatewayConfig, logger?: Logger): BiliBackend {
  const { command, cookiesFile, probeCommand, timeoutMs } = config.bilibili.cliYtdlp;

  function baseArgs(): string[] {
    const args: string[] = [];
    if (cookiesFile) args.push("--cookies", cookiesFile);
    return args;
  }

  async function run(args: string[]): Promise<CliResult> {
    logger?.debug(`bilibili cli-ytdlp: ${command} ${args.join(" ")}`);
    return runCli(command, args, timeoutMs);
  }

  return {
    id: YTDLP_ID,

    supports(cap: BiliCapability): boolean {
      return cap === "detail" || cap === "media";
    },

    async probe(): Promise<BiliProbe> {
      const trimmed = probeCommand.trim();
      if (!trimmed) {
        const loggedIn = Boolean(cookiesFile);
        return {
          ok: true,
          loggedIn,
          maxQuality: loggedIn ? "1080p" : "480p",
        };
      }

      const parts = trimmed.split(/\s+/);
      const probeBin = parts[0]!;
      const probeArgs = parts.slice(1);
      try {
        const result = await runCli(probeBin, probeArgs, timeoutMs);
        if (!result.failed) {
          return { ok: true, loggedIn: true, maxQuality: "1080p" };
        }
        return {
          ok: true,
          loggedIn: false,
          maxQuality: "480p",
          hint: "yt-dlp 未登录：配置 bilibili.cli_ytdlp.cookies_file 或检查 probe_command",
        };
      } catch (err) {
        return {
          ok: false,
          loggedIn: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async detail(ref: BiliRef): Promise<BiliDetail> {
      const result = await run([
        "--dump-json",
        "--skip-download",
        "--no-warnings",
        ...baseArgs(),
        ref.raw,
      ]);
      if (result.failed) throw mapFailure(result);

      const info = parseLastJsonObject(result.stdout);
      if (!info) {
        throw new BiliError(
          "BILI_UNAVAILABLE",
          `yt-dlp 未输出可解析的详情 JSON${tailOf(result.stderr) ? `（${tailOf(result.stderr)}）` : ""}`,
        );
      }

      const bvid = inferBvid(ref, info);
      const title = asString(info.title) ?? "";
      const duration = asNumber(info.duration);
      const webpageUrl = asString(info.webpage_url);
      const fallbackUrl = ref.raw.startsWith("http")
        ? ref.raw
        : bvid
          ? `https://www.bilibili.com/video/${bvid}`
          : ref.raw;

      return {
        bvid,
        aid: ref.aid,
        title,
        desc: asString(info.description) ?? "",
        owner: {
          mid: toMid(info.uploader_id),
          name: asString(info.uploader),
        },
        pubdate: toIso(info.timestamp),
        duration,
        stat: mapStat(info),
        cover: asString(info.thumbnail),
        tags: toStringArray(info.tags),
        pages: [{ page: ref.page, title, duration }],
        url: webpageUrl ?? fallbackUrl,
      };
    },

    async comments(
      _ref: BiliRef,
      _opts: { page: number; sort: "hot" | "time" },
    ): Promise<BiliCommentPage> {
      throw new BiliError(
        "BILI_CAPABILITY_UNSUPPORTED",
        `${YTDLP_ID} 不支持 comments`,
      );
    },

    async media(
      ref: BiliRef,
      opts: { kind: MediaKind; quality: string },
    ): Promise<BiliStream> {
      const quality = parseQuality(opts.quality || config.bilibili.quality);
      const format = opts.kind === "audio" ? "ba" : quality.selector;

      const result = await run([
        "-g",
        "-f",
        format,
        "--no-playlist",
        ...baseArgs(),
        ref.raw,
      ]);
      if (result.failed) throw mapFailure(result);

      const url = lastNonEmptyLine(result.stdout);
      if (!url || !/^https?:\/\//i.test(url)) {
        throw new BiliError(
          "BILI_UNAVAILABLE",
          `yt-dlp 未返回有效直链${tailOf(result.stderr) ? `（${tailOf(result.stderr)}）` : ""}`,
        );
      }

      return {
        url,
        contentType: opts.kind === "audio" ? "audio/mp4" : "video/mp4",
        quality: opts.kind === "video" ? quality.label : undefined,
      };
    },

    async article(_ref: BiliRef): Promise<BiliArticle> {
      throw new BiliError(
        "BILI_CAPABILITY_UNSUPPORTED",
        `${YTDLP_ID} 不支持 article`,
      );
    },
  };
}
