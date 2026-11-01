/**
 * Bilibili 抓取后端：kukemc 系 CLI（`bili`）。
 *
 * 只通过 `execFile` 传参数数组（绝不拼接 shell），CLI 统一输出
 * `{"ok":true,"data":...}` / `{"ok":false,"error":{code,message,hint}}`。
 * 该后端提供详情与评论；媒体/专栏由别的后端负责。
 */
import { execFile } from "node:child_process";
import type { GatewayConfig } from "../../config.js";
import type { Logger } from "../../logger.js";
import {
  BiliError,
  type BiliArticle,
  type BiliBackend,
  type BiliCapability,
  type BiliComment,
  type BiliCommentPage,
  type BiliDetail,
  type BiliProbe,
  type BiliRef,
  type BiliStream,
  type MediaKind,
} from "../types.js";

export const KUKEMC_ID = "cli-kukemc";

/** CLI 单次输出上限（评论楼中楼可能较大）。 */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** 评论每页条数（B 站评论分页固定 20/页，用于推算 hasMore）。 */
const COMMENTS_PAGE_SIZE = 20;

/** 楼中楼递归深度上限，防御异常深的嵌套。 */
const MAX_REPLY_DEPTH = 5;

const LOGIN_HINT = "运行 bili auth login 扫码登录";

interface KukemcEnvelope {
  ok?: unknown;
  data?: unknown;
  error?: unknown;
}

interface CliOutput {
  stdout: string;
  stderr: string;
}

/** execFile 回调里的 stdout/stderr 在指定 utf8 时是字符串，这里兜底 Buffer。 */
function toText(value: string | Buffer | null | undefined): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : value.toString("utf8");
}

/**
 * 执行 CLI。业务错误（退出码非 0 但 stdout/stderr 有 JSON）仍 resolve，
 * 由调用方解析 `ok:false`；进程级故障（找不到命令/超时/输出过大）才 reject。
 */
function runCli(command: string, args: string[], timeoutMs: number): Promise<CliOutput> {
  return new Promise<CliOutput>((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER_BYTES, encoding: "utf8", windowsHide: true },
      (err, stdout, stderr) => {
        const out = toText(stdout);
        const errText = toText(stderr);
        if (!err) {
          resolve({ stdout: out, stderr: errText });
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
              "检查 bilibili.cli_kukemc.command 配置",
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
              "可调大 bilibili.cli_kukemc.timeout_ms",
            ),
          );
          return;
        }

        // 多数 CLI 用非 0 退出码表达业务失败，stdout/stderr 里仍有 JSON 信封。
        if (out.trim() || errText.trim()) {
          resolve({ stdout: out, stderr: errText });
          return;
        }
        reject(
          new BiliError(
            "BILI_UNAVAILABLE",
            `${command} 执行失败：${e.message ?? "未知错误"}`,
          ),
        );
      },
    );
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asNullableNumber(value: unknown): number | null {
  return asNumber(value) ?? null;
}

/** 时间字段：ISO 字符串转毫秒时间戳；也兼容秒/毫秒数字。 */
function toEpochMs(value: unknown): number {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  return 0;
}

/** pubdate 按 CLI 契约已是 ISO，原样透传（缺失/非字符串则不编造）。 */
function toIso(value: unknown): string | undefined {
  return asString(value);
}

/** 取 stdout 里的 JSON 对象（容忍前后日志行）。 */
function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  return text.slice(start, end + 1);
}

/** 错误信息摘要：最后一行，最多 200 字符。 */
function tailOf(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .pop();
  if (!line) return "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

function errorFields(raw: unknown): { code: string; message: string; hint: string | undefined } {
  const err = asRecord(raw);
  return {
    code: asString(err.code) ?? "",
    message: asString(err.message) ?? "未知错误",
    hint: asString(err.hint),
  };
}

function errorText(raw: unknown): string {
  const { message, hint } = errorFields(raw);
  return hint ? `${message}（${hint}）` : message;
}

/** `ok:false` 信封 → BiliError；登录类错误单独映射。 */
function mapEnvelopeError(raw: unknown): BiliError {
  const { code, message, hint } = errorFields(raw);
  const detail = hint ? `${message}（${hint}）` : message;
  if (code === "not_logged_in" || code === "auth_expired") {
    return new BiliError("BILI_AUTH_REQUIRED", detail, hint ?? LOGIN_HINT, { code });
  }
  return new BiliError("BILI_UNAVAILABLE", detail, hint, { code: code || undefined });
}

function parseEnvelope(stdout: string, stderr: string, what: string): KukemcEnvelope {
  const json = extractJsonObject(stdout) ?? extractJsonObject(stderr);
  if (!json) {
    const tail = tailOf(stderr) || tailOf(stdout);
    throw new BiliError(
      "BILI_UNAVAILABLE",
      `${what}：命令未返回 JSON${tail ? `（${tail}）` : ""}`,
    );
  }
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as KukemcEnvelope;
  } catch {
    throw new BiliError("BILI_UNAVAILABLE", `${what}：JSON 解析失败（${tailOf(json)}）`);
  }
}

/** 解信封并返回 data；`ok:false` 直接抛 BiliError。 */
function unwrapData(stdout: string, stderr: string, what: string): Record<string, unknown> {
  const env = parseEnvelope(stdout, stderr, what);
  if (env.ok !== true) throw mapEnvelopeError(env.error);
  const data = env.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new BiliError("BILI_UNAVAILABLE", `${what}：返回缺少 data`);
  }
  return data as Record<string, unknown>;
}

function mapStat(raw: unknown): Record<string, number> | undefined {
  const record = asRecord(raw);
  const stat: Record<string, number> = {};
  for (const [key, value] of Object.entries(record)) {
    const num = asNumber(value);
    if (num !== undefined) stat[key] = num;
  }
  return Object.keys(stat).length > 0 ? stat : undefined;
}

function mapPages(raw: unknown): BiliDetail["pages"] {
  return asArray(raw).map((item, index) => {
    const page = asRecord(item);
    return {
      page: asNumber(page.page) ?? index + 1,
      cid: asNumber(page.cid),
      title: asString(page.title),
      duration: asNumber(page.duration),
    };
  });
}

/** 递归映射评论；缺 rpid 的脏数据直接丢弃。 */
function mapComment(raw: unknown, depth = 0): BiliComment | null {
  const item = asRecord(raw);
  const rpid = asNumber(item.rpid);
  if (rpid === undefined) return null;

  const user = asRecord(item.user);
  const comment: BiliComment = {
    rpid,
    root: asNullableNumber(item.root),
    parent: asNullableNumber(item.parent),
    mid: asNumber(user.mid) ?? 0,
    uname: asString(user.name) ?? "",
    content: asString(item.content) ?? "",
    like: asNumber(item.like) ?? 0,
    ctime: toEpochMs(item.time),
  };

  if (depth < MAX_REPLY_DEPTH) {
    const replies = asArray(item.replies)
      .map((reply) => mapComment(reply, depth + 1))
      .filter((reply): reply is BiliComment => reply !== null);
    if (replies.length > 0) comment.replies = replies;
  }
  return comment;
}

export function createKukemcBackend(config: GatewayConfig, logger?: Logger): BiliBackend {
  const command = config.bilibili.cliKukemc.command;
  const timeoutMs = config.bilibili.cliKukemc.timeoutMs;

  async function run(args: string[]): Promise<CliOutput> {
    logger?.debug(`bilibili cli-kukemc: ${command} ${args.join(" ")}`);
    return runCli(command, args, timeoutMs);
  }

  return {
    id: KUKEMC_ID,

    supports(cap: BiliCapability): boolean {
      return cap === "detail" || cap === "comments";
    },

    async probe(): Promise<BiliProbe> {
      try {
        const { stdout, stderr } = await run(["auth", "status", "--compact"]);
        const env = parseEnvelope(stdout, stderr, "auth status");
        if (env.ok === true) {
          const data = asRecord(env.data);
          if (data.logged_in === true) return { ok: true, loggedIn: true };
          return { ok: true, loggedIn: false, hint: LOGIN_HINT };
        }

        const { code } = errorFields(env.error);
        if (code === "not_logged_in" || code === "auth_expired") {
          return { ok: true, loggedIn: false, hint: LOGIN_HINT };
        }
        return { ok: false, loggedIn: false, error: errorText(env.error) };
      } catch (err) {
        return {
          ok: false,
          loggedIn: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async detail(ref: BiliRef): Promise<BiliDetail> {
      const { stdout, stderr } = await run(["video", "info", ref.raw, "--compact"]);
      const data = unwrapData(stdout, stderr, "video info");

      const bvid = asString(data.bvid) ?? ref.bvid;
      if (!bvid) {
        throw new BiliError("BILI_UNAVAILABLE", "video info：返回缺少 bvid");
      }

      const owner = asRecord(data.owner);
      const zone = asRecord(data.zone);
      const zoneTid = asNumber(zone.tid);
      const zoneName = asString(zone.name);
      const fallbackUrl = ref.raw.startsWith("http")
        ? ref.raw
        : `https://www.bilibili.com/video/${bvid}`;

      return {
        bvid,
        aid: asNumber(data.aid) ?? ref.aid,
        title: asString(data.title) ?? "",
        desc: asString(data.desc) ?? "",
        owner: {
          mid: asNumber(owner.mid),
          name: asString(owner.name),
        },
        pubdate: toIso(data.pubdate),
        duration: asNumber(data.duration),
        zone:
          zoneTid !== undefined || zoneName !== undefined
            ? { tid: zoneTid, name: zoneName }
            : undefined,
        stat: mapStat(data.stat),
        pages: mapPages(data.pages),
        url: asString(data.url) ?? fallbackUrl,
      };
    },

    async comments(
      ref: BiliRef,
      opts: { page: number; sort: "hot" | "time" },
    ): Promise<BiliCommentPage> {
      const { stdout, stderr } = await run([
        "comment",
        "list",
        ref.raw,
        "--page",
        String(opts.page),
        "--sort",
        opts.sort,
        "--compact",
      ]);
      const data = unwrapData(stdout, stderr, "comment list");

      const page = asNumber(data.page) ?? opts.page;
      const total = asNumber(data.total);
      const items = asArray(data.items)
        .map((item) => mapComment(item))
        .filter((item): item is BiliComment => item !== null);

      return {
        bvid: ref.bvid ?? asString(data.bvid) ?? "",
        page,
        total,
        hasMore: total !== undefined ? page * COMMENTS_PAGE_SIZE < total : items.length > 0,
        nextPage: page + 1,
        items,
      };
    },

    async media(_ref: BiliRef, _opts: { kind: MediaKind; quality: string }): Promise<BiliStream> {
      throw new BiliError(
        "BILI_CAPABILITY_UNSUPPORTED",
        `${KUKEMC_ID} 不支持 media`,
      );
    },

    async article(_ref: BiliRef): Promise<BiliArticle> {
      throw new BiliError(
        "BILI_CAPABILITY_UNSUPPORTED",
        `${KUKEMC_ID} 不支持 article`,
      );
    },
  };
}
