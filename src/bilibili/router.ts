/**
 * Bilibili 多后端路由。
 *
 * 按 `bilibili.routes.<cap>` 的顺序构造后端，只尝试 `supports(cap)` 的实现；
 * 每次尝试前先问登录态缓存，失败的后端不会中断链路，整条尝试链会随结果返回，
 * 方便 agent 判断"该换后端还是该补登录态"。
 */
import type { GatewayConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { createHttpBackend, HTTP_ID } from "./backends/http.js";
import { createKukemcBackend, KUKEMC_ID } from "./backends/cli-kukemc.js";
import { createYtdlpBackend, YTDLP_ID } from "./backends/cli-ytdlp.js";
import { ProbeCache } from "./probe.js";
import { BiliError } from "./types.js";
import type {
  BiliArticle,
  BiliAttempt,
  BiliBackend,
  BiliCapability,
  BiliCommentPage,
  BiliDetail,
  BiliRef,
  BiliStream,
  MediaKind,
} from "./types.js";

type BackendFactory = (config: GatewayConfig, logger?: Logger) => BiliBackend;

export interface BiliRouter {
  detail(ref: BiliRef): Promise<{ value: BiliDetail; attempts: BiliAttempt[] }>;
  comments(
    ref: BiliRef,
    opts: { page: number; sort: "hot" | "time" },
  ): Promise<{ value: BiliCommentPage; attempts: BiliAttempt[] }>;
  media(
    ref: BiliRef,
    opts: { kind: MediaKind; quality: string },
  ): Promise<{ value: BiliStream; attempts: BiliAttempt[] }>;
  article(ref: BiliRef): Promise<{ value: BiliArticle; attempts: BiliAttempt[] }>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 把 1080p/720p/best 归一成可比较的数字；未登录通常只能拿 480p。 */
function qualityRank(quality: string): number {
  const m = /^(\d{3,4})p$/i.exec(quality.trim());
  if (m) return Number.parseInt(m[1]!, 10);
  return quality.trim() === "best" ? 10000 : 1080;
}

export function createRouter(config: GatewayConfig, logger?: Logger): BiliRouter {
  const factories: Record<string, BackendFactory> = {
    [KUKEMC_ID]: createKukemcBackend,
    [YTDLP_ID]: createYtdlpBackend,
    [HTTP_ID]: createHttpBackend,
  };

  /** 后端实例按 id 复用：HTTP 后端可能拉起常驻服务，不能每次请求重建。 */
  const backends = new Map<string, BiliBackend>();
  const probes = new ProbeCache(config.bilibili.authProbeTtlMs);

  function getBackend(id: string): BiliBackend | undefined {
    const factory = factories[id];
    if (!factory) return undefined;
    const existing = backends.get(id);
    if (existing) return existing;
    const created = factory(config, logger);
    backends.set(id, created);
    return created;
  }

  async function run<T>(
    cap: BiliCapability,
    ref: BiliRef,
    call: (backend: BiliBackend) => Promise<T>,
    opts: { needsLogin?: boolean } = {},
  ): Promise<{ value: T; attempts: BiliAttempt[] }> {
    const attempts: BiliAttempt[] = [];
    const candidates: BiliBackend[] = [];
    const seen = new Set<string>();

    for (const id of config.bilibili.routes[cap]) {
      if (seen.has(id)) continue;
      seen.add(id);

      let backend: BiliBackend | undefined;
      try {
        backend = getBackend(id);
      } catch (err) {
        attempts.push({
          backend: id,
          ok: false,
          code: "BILI_UNAVAILABLE",
          error: `后端初始化失败：${errorMessage(err)}`,
        });
        continue;
      }
      if (!backend) {
        attempts.push({
          backend: id,
          ok: false,
          code: "BILI_UNAVAILABLE",
          error: `未知后端 id：${id}`,
        });
        continue;
      }
      // 不支持该能力的后端直接跳过，不算一次尝试
      if (!backend.supports(cap)) {
        logger?.debug(`bilibili: 后端 ${id} 不支持 ${cap}，跳过`);
        continue;
      }
      candidates.push(backend);
    }

    let last: BiliError | undefined;
    /** 全链路失败时优先返回"缺登录态"，它比"后端不可用"更可执行。 */
    let lastAuth: BiliError | undefined;

    for (const backend of candidates) {
      try {
        const probe = await probes.check(backend, ref);
        // 探测本身失败（命令没装/服务连不上）：记录后换下一个后端
        if (!probe.ok) {
          const detail = probe.error ?? "登录态探测未通过";
          last = new BiliError("BILI_UNAVAILABLE", `${backend.id} 不可用：${detail}`);
          attempts.push({
            backend: backend.id,
            ok: false,
            code: "BILI_UNAVAILABLE",
            error: detail,
          });
          continue;
        }

        // 只有本次动作确实需要登录时才拦截：详情、评论首页匿名也能拿
        if (opts.needsLogin && !probe.loggedIn) {
          const reason = probe.hint ?? "后端未登录";

          // 唯一可用后端没登录：直接抛认证错误，让 agent 去补登录态而不是继续重试
          if (candidates.length === 1) {
            throw new BiliError(
              "BILI_AUTH_REQUIRED",
              `${backend.id} 不可用：${reason}`,
              probe.hint,
              { backend: backend.id },
            );
          }

          attempts.push({
            backend: backend.id,
            ok: false,
            code: "BILI_AUTH_REQUIRED",
            error: reason,
          });
          continue;
        }

        const value = await call(backend);
        return { value, attempts };
      } catch (err) {
        const wrapped =
          err instanceof BiliError
            ? err
            : new BiliError("BILI_UNAVAILABLE", `后端 ${backend.id} 异常：${errorMessage(err)}`);
        last = wrapped;
        if (wrapped.code === "BILI_AUTH_REQUIRED") lastAuth = wrapped;
        attempts.push({
          backend: backend.id,
          ok: false,
          code: wrapped.code,
          error: wrapped.message,
        });
      }
    }

    // 全链路失败：优先报缺登录态（可执行），否则沿用最后一个错误
    const final = lastAuth ?? last;
    throw new BiliError(
      final?.code ?? "BILI_UNAVAILABLE",
      final?.message ?? "Bilibili 后端均不可用（未配置可用路由）",
      final?.hint,
      { attempts },
    );
  }

  return {
    detail(ref) {
      return run("detail", ref, (b) => b.detail(ref));
    },
    comments(ref, opts) {
      // 第 2 页起 B 站要求登录；首页匿名可取
      return run("comments", ref, (b) => b.comments(ref, opts), { needsLogin: opts.page > 1 });
    },
    media(ref, opts) {
      // 未登录通常只能拿 480p；要求更高画质时先卡登录态，避免发一次注定失败的请求
      return run("media", ref, (b) => b.media(ref, opts), {
        needsLogin: qualityRank(opts.quality) > 480,
      });
    },
    article(ref) {
      // 游客态只返回 432 字预览，全文必须登录
      return run("article", ref, (b) => b.article(ref), { needsLogin: true });
    },
  };
}
