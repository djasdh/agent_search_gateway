/**
 * 登录态探测的进程级缓存。
 *
 * 探测一次 CLI/HTTP 后端往往要 spawn 进程或发一次请求，成本不低；
 * 同一后端在 TTL 内直接复用上次结果。缓存键只有后端 id（`invalidate` 也按 id），
 * 因此后端实现应保证 `probe(ref)` 的结论不随单个视频变化。
 */
import type { BiliBackend, BiliProbe, BiliRef } from "./types.js";

interface CacheEntry {
  probe: BiliProbe;
  /** 写入缓存的时间戳（ms）。 */
  at: number;
}

export class ProbeCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = Math.max(0, ttlMs);
  }

  async check(backend: BiliBackend, ref?: BiliRef): Promise<BiliProbe> {
    const now = Date.now();
    const hit = this.entries.get(backend.id);
    if (hit && now - hit.at < this.ttlMs) return hit.probe;

    let probe: BiliProbe;
    try {
      probe = await backend.probe(ref);
    } catch (err) {
      // 抛错（如命令暂时不存在）不写缓存：下一次调用应能重新探测，避免把瞬时故障钉死一个 TTL。
      return {
        ok: false,
        loggedIn: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    this.entries.set(backend.id, { probe, at: Date.now() });
    return probe;
  }

  invalidate(backendId: string): void {
    this.entries.delete(backendId);
  }
}
