/** Bilibili 后端：kukemc 系 CLI（`bili`），只提供详情与评论。 */
import type { GatewayConfig } from "../../config.js";
import type { Logger } from "../../logger.js";
import { envelope, runCli } from "../cli.js";
import { cliFailure } from "../errors.js";
import { asArray, asRecord, num, numRecord, str } from "../json.js";
import {
  BiliError, type BiliArticle, type BiliBackend, type BiliCapability, type BiliComment,
  type BiliCommentPage, type BiliDetail, type BiliProbe, type BiliRef, type BiliStream,
} from "../types.js";

export const KUKEMC_ID = "cli-kukemc";
const PAGE_SIZE = 20;
const MAX_REPLY_DEPTH = 5;
const LOGIN_HINT = "运行 bili auth login 扫码登录";

function toEpochMs(value: unknown): number {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  return 0;
}

function mapComment(raw: unknown, depth = 0): BiliComment | null {
  const item = asRecord(raw);
  const rpid = num(item, "rpid");
  if (!item || rpid === undefined) return null;
  const user = asRecord(item.user);
  const comment: BiliComment = {
    rpid, root: num(item, "root") ?? null, parent: num(item, "parent") ?? null,
    mid: num(user, "mid") ?? 0, uname: str(user, "name") ?? "", content: str(item, "content") ?? "",
    like: num(item, "like") ?? 0, ctime: toEpochMs(item.time),
  };
  if (depth < MAX_REPLY_DEPTH) {
    const replies = asArray(item.replies)
      .map((reply) => mapComment(reply, depth + 1))
      .filter((reply): reply is BiliComment => reply !== null);
    if (replies.length > 0) comment.replies = replies;
  }
  return comment;
}

function mapPages(raw: unknown): BiliDetail["pages"] {
  return asArray(raw).map((value, index) => {
    const page = asRecord(value);
    return { page: num(page, "page") ?? index + 1, cid: num(page, "cid"), title: str(page, "title"), duration: num(page, "duration") };
  });
}

export function createKukemcBackend(config: GatewayConfig, logger?: Logger): BiliBackend {
  const { command, timeoutMs } = config.bilibili.cliKukemc;
  const run = (args: string[]) => {
    logger?.debug(`bilibili cli-kukemc: ${command} ${args.join(" ")}`);
    return runCli(command, args, timeoutMs);
  };

  return {
    id: KUKEMC_ID,
    supports: (cap: BiliCapability) => cap === "detail" || cap === "comments",

    async probe(): Promise<BiliProbe> {
      try {
        const result = await run(["auth", "status", "--compact"]);
        if (result.failed) throw cliFailure(result, command, "auth status");
        const data = envelope(result.stdout, result.stderr, "auth status");
        return data.logged_in === true ? { ok: true, loggedIn: true } : { ok: true, loggedIn: false, hint: LOGIN_HINT };
      } catch (err) {
        if (err instanceof BiliError && err.code === "BILI_AUTH_REQUIRED") return { ok: true, loggedIn: false, hint: LOGIN_HINT };
        return { ok: false, loggedIn: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async detail(ref: BiliRef): Promise<BiliDetail> {
      const result = await run(["video", "info", ref.raw, "--compact"]);
      if (result.failed) throw cliFailure(result, command, "video info");
      const data = envelope(result.stdout, result.stderr, "video info");
      const bvid = str(data, "bvid") ?? ref.bvid ?? "";
      const owner = asRecord(data.owner);
      const zone = asRecord(data.zone);
      const tid = num(zone, "tid");
      const zoneName = str(zone, "name");
      const fallback = ref.raw.startsWith("http") ? ref.raw : `https://www.bilibili.com/video/${bvid}`;
      return {
        bvid, aid: num(data, "aid") ?? ref.aid, title: str(data, "title") ?? "", desc: str(data, "desc") ?? "",
        owner: { mid: num(owner, "mid"), name: str(owner, "name") },
        pubdate: str(data, "pubdate"), duration: num(data, "duration"),
        zone: tid !== undefined || zoneName !== undefined ? { tid, name: zoneName } : undefined,
        stat: numRecord(data.stat), pages: mapPages(data.pages), url: str(data, "url") ?? fallback,
      };
    },

    async comments(ref: BiliRef, opts: { page: number; sort: "hot" | "time" }): Promise<BiliCommentPage> {
      const result = await run(["comment", "list", ref.raw, "--page", String(opts.page), "--sort", opts.sort, "--compact"]);
      if (result.failed) throw cliFailure(result, command, "comment list");
      const data = envelope(result.stdout, result.stderr, "comment list");
      const page = num(data, "page") ?? opts.page;
      const total = num(data, "total");
      const items = asArray(data.items).map((item) => mapComment(item)).filter((item): item is BiliComment => item !== null);
      return {
        bvid: ref.bvid ?? str(data, "bvid") ?? "", page, total,
        hasMore: total !== undefined ? page * PAGE_SIZE < total : items.length > 0,
        nextPage: page + 1, items,
      };
    },

    async media(): Promise<BiliStream> {
      throw new BiliError("BILI_CAPABILITY_UNSUPPORTED", "cli-kukemc 不支持该动作");
    },
    async article(): Promise<BiliArticle> {
      throw new BiliError("BILI_CAPABILITY_UNSUPPORTED", "cli-kukemc 不支持该动作");
    },
  };
}
