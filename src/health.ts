import type { EmbeddingSettings, FlaresolverrSettings, SearxngSettings } from "./settings/index.js";
import { GATEWAY_VERSION } from "./version.js";

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

export interface HealthReport {
  gateway: { version: string; uptimeSec: number };
  searxng: BackendProbe;
  flaresolverr: BackendProbe;
  embedding?: { status: "up" | "down"; model?: string; dim?: number };
  corpus?: { namespace: string; entries: number };
}

/** 健康检查只关心各后端地址与 embedding 开关。 */
export interface HealthSettings {
  searxng: SearxngSettings;
  flaresolverr: FlaresolverrSettings;
  embedding: EmbeddingSettings;
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
    if (res.ok) return { status: "up", latencyMs };
    return { status: "down", latencyMs, error: `HTTP ${res.status}` };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
    const code = cause && typeof cause === "object" && typeof cause.code === "string" ? cause.code : "";
    return { status: "down", latencyMs, error: code ? `${message} (${code})` : message };
  } finally {
    clearTimeout(timer);
  }
}

export async function getHealth(
  deps: HealthSettings,
  startedAt: number,
  semantic?: SemanticHealth,
): Promise<HealthReport> {
  const [searxng, flaresolverr] = await Promise.all([
    probe(deps.searxng.url),
    probe(deps.flaresolverr.url),
  ]);
  const report: HealthReport = {
    gateway: {
      version: GATEWAY_VERSION,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    },
    searxng,
    flaresolverr,
  };
  if (deps.embedding.enabled) {
    report.embedding = {
      status: semantic?.embeddingUp ? "up" : "down",
      model: semantic?.model,
      dim: semantic?.dim,
    };
    if (semantic?.corpus) report.corpus = semantic.corpus;
  }
  return report;
}
