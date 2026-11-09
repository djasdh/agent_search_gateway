/** 按能力把请求路由到后端：顺序尝试、聚合失败原因、登录态 60s 缓存。 */

import type { Logger } from "../logger.js";
import { createHttpBackend, HTTP_ID } from "./backends/http.js";
import { createKukemcBackend, KUKEMC_ID } from "./backends/cli-kukemc.js";
import { createYtdlpBackend, YTDLP_ID } from "./backends/cli-ytdlp.js";
import { BiliError } from "./types.js";
import type { BilibiliSettings } from "../settings/index.js";
import type {
  BiliArticle, BiliAttempt, BiliAudio, BiliBackend, BiliCapability, BiliCommentPage,
  BiliDetail, BiliProbe, BiliRef,
} from "./types.js";

export interface BiliRouter {
  detail(ref: BiliRef): Promise<{ value: BiliDetail; attempts: BiliAttempt[] }>;
  comments(ref: BiliRef, o: { page: number; sort: "hot" | "time" }): Promise<{ value: BiliCommentPage; attempts: BiliAttempt[] }>;
  audio(ref: BiliRef): Promise<{ value: BiliAudio; attempts: BiliAttempt[] }>;
  article(ref: BiliRef): Promise<{ value: BiliArticle; attempts: BiliAttempt[] }>;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createRouter(bilibili: BilibiliSettings, httpToken: string, logger?: Logger): BiliRouter {
  const factories = {
    [KUKEMC_ID]: createKukemcBackend,
    [YTDLP_ID]: createYtdlpBackend,
    [HTTP_ID]: createHttpBackend,
  } as Record<string, (b: BilibiliSettings, token: string, l?: Logger) => BiliBackend>;
  const backends = new Map<string, BiliBackend>();
  const probes = new Map<string, { at: number; probe: BiliProbe }>();

  function backend(id: string): BiliBackend | undefined {
    const cached = backends.get(id);
    if (cached) return cached;
    const factory = factories[id];
    if (!factory) return undefined;
    const created = factory(bilibili, httpToken, logger);
    backends.set(id, created);
    return created;
  }

  async function probe(b: BiliBackend, ref: BiliRef): Promise<BiliProbe> {
    const hit = probes.get(b.id);
    if (hit && Date.now() - hit.at < bilibili.auth_probe_ttl_ms) return hit.probe;
    const result = await b.probe(ref);
    probes.set(b.id, { at: Date.now(), probe: result });
    return result;
  }

  async function run<T>(
    cap: BiliCapability,
    ref: BiliRef,
    call: (b: BiliBackend) => Promise<T>,
    needsLogin = false,
  ): Promise<{ value: T; attempts: BiliAttempt[] }> {
    const attempts: BiliAttempt[] = [];
    const candidates: BiliBackend[] = [];
    for (const id of bilibili.routes[cap]) {
      const b = backend(id);
      if (!b) {
        attempts.push({ backend: id, ok: false, code: "BILI_UNAVAILABLE", error: `未知后端 id：${id}` });
      } else if (b.supports(cap)) {
        candidates.push(b);
      }
    }

    let last: BiliError | undefined;
    let lastAuth: BiliError | undefined;
    for (const b of candidates) {
      try {
        const p = await probe(b, ref);
        if (!p.ok) {
          last = new BiliError("BILI_UNAVAILABLE", `${b.id} 不可用：${p.error ?? "探测失败"}`);
          attempts.push({ backend: b.id, ok: false, code: last.code, error: last.message });
          continue;
        }
        if (needsLogin && !p.loggedIn) {
          const hint = p.hint ?? "后端未登录";
          if (candidates.length === 1) {
            throw new BiliError("BILI_AUTH_REQUIRED", `${b.id} 不可用：${hint}`, p.hint);
          }
          lastAuth = new BiliError("BILI_AUTH_REQUIRED", `${b.id} 不可用：${hint}`, p.hint);
          attempts.push({ backend: b.id, ok: false, code: lastAuth.code, error: hint });
          continue;
        }
        return { value: await call(b), attempts };
      } catch (err) {
        const wrapped = err instanceof BiliError
          ? err
          : new BiliError("BILI_UNAVAILABLE", `后端 ${b.id} 异常：${message(err)}`);
        if (wrapped.code === "BILI_AUTH_REQUIRED") {
          lastAuth = wrapped;
          probes.delete(b.id);
        }
        last = wrapped;
        attempts.push({ backend: b.id, ok: false, code: wrapped.code, error: wrapped.message });
      }
    }

    const final = lastAuth ?? last;
    throw new BiliError(
      final?.code ?? "BILI_UNAVAILABLE",
      final?.message ?? "Bilibili 后端均不可用（未配置路由）",
      final?.hint,
      { attempts },
    );
  }

  return {
    detail: (ref) => run("detail", ref, (b) => b.detail(ref)),
    comments: (ref, o) => run("comments", ref, (b) => b.comments(ref, o), o.page > 1),
    audio: (ref) => run("audio", ref, (b) => b.audio(ref)),
    article: (ref) => run("article", ref, (b) => b.article(ref)),
  };
}
