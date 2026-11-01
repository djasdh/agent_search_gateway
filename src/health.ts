import type { GatewayConfig } from "./config.js";

export interface BackendProbe {
  status: "up" | "down";
  latencyMs: number;
  error?: string;
}

export interface SemanticHealth {
  embeddingUp: boolean;
  model?: string;
  dim?: number;
  corpus?: { namespace: string; entries: number };
}

export interface BilibiliHealth {
  enabled: boolean;
  routes: { detail: string[]; comments: string[]; media: string[]; article: string[] };
  /** http 后端的连通性；未启用或探测失败时缺省。 */
  http?: {
    status: "up" | "down";
    latencyMs: number;
    loggedIn?: boolean;
    error?: string;
  };
}

export interface HealthReport {
  gateway: { version: string; uptimeSec: number };
  searxng: BackendProbe;
  flaresolverr: BackendProbe;
  embedding?: { status: "up" | "down"; model?: string; dim?: number };
  corpus?: { namespace: string; entries: number };
  bilibili?: BilibiliHealth;
}

/** Bilibili http 后端的健康探测：只读 /health，不触发进程拉起。 */
async function probeBilibiliHttp(baseUrl: string): Promise<BilibiliHealth["http"]> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/health`, {
      signal: controller.signal,
      redirect: "manual",
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) return { status: "down", latencyMs, error: `HTTP ${res.status}` };
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; loggedIn?: boolean; error?: string }
      | null;
    if (body && body.ok === false) {
      return { status: "down", latencyMs, error: body.error ?? "health ok=false" };
    }
    return { status: "up", latencyMs, loggedIn: body?.loggedIn };
  } catch (err) {
    return {
      status: "down",
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probe(url: string, timeoutMs = 3000): Promise<BackendProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "manual",
    });
    const latencyMs = Date.now() - start;
    return { status: res.ok ? "up" : "down", latencyMs, error: `HTTP ${res.status}` };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    return { status: "down", latencyMs, error: message };
  } finally {
    clearTimeout(timer);
  }
}

export async function getHealth(
  config: GatewayConfig,
  startedAt: number,
  semantic?: SemanticHealth,
): Promise<HealthReport> {
  const [searxng, flaresolverr, biliHttp] = await Promise.all([
    probe(config.searxngUrl),
    probe(config.flaresolverrUrl),
    config.bilibili?.enabled ? probeBilibiliHttp(config.bilibili.http.baseUrl) : undefined,
  ]);
  const report: HealthReport = {
    gateway: {
      version: "0.1.0",
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    },
    searxng,
    flaresolverr,
  };
  if (config.bilibili?.enabled) {
    report.bilibili = {
      enabled: true,
      routes: config.bilibili.routes,
      ...(biliHttp ? { http: biliHttp } : {}),
    };
  }
  if (config.embeddingEnabled) {
    report.embedding = {
      status: semantic?.embeddingUp ? "up" : "down",
      model: semantic?.model,
      dim: semantic?.dim,
    };
    if (semantic?.corpus) report.corpus = semantic.corpus;
  }
  return report;
}
