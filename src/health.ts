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

export interface HealthReport {
  gateway: { version: string; uptimeSec: number };
  searxng: BackendProbe;
  flaresolverr: BackendProbe;
  embedding?: { status: "up" | "down"; model?: string; dim?: number };
  corpus?: { namespace: string; entries: number };
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
  const [searxng, flaresolverr] = await Promise.all([
    probe(config.searxngUrl),
    probe(config.flaresolverrUrl),
  ]);
  const report: HealthReport = {
    gateway: {
      version: "0.1.0",
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    },
    searxng,
    flaresolverr,
  };
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
