import type { Logger } from "../../logger.js";
import { normalize } from "../../utils/vector.js";
import { resolvePrefixes } from "./profiles.js";
import type { EmbedError, EmbedKind, EmbedResult } from "./types.js";

/**
 * 文本向量来源（外部服务），独立于上游 searxng。
 *
 * 实现约定：
 * - `embed` 返回的向量顺序与入参 `texts` 严格一致；成功时维度恒定。
 * - 运行时方法不抛异常，失败以结构化结果返回。
 */
export interface EmbeddingProvider {
  /** provider 身份，进命名空间。 */
  readonly name: string;
  /** 模型标识，进命名空间。 */
  readonly model: string;

  /** 解析模型维度（供向量库建表）。可缓存首次结果。 */
  dim(): Promise<number>;

  /** 批量嵌入；空数组应返回空 vectors。 */
  embed(texts: string[], kind: EmbedKind): Promise<EmbedResult>;

  /** 启动探针：可达性 + 维度；失败不抛异常。 */
  probe(): Promise<{ ok: boolean; dim?: number; detail?: string }>;
}

export interface EmbeddingProviderOptions {
  provider: "openai" | "ollama";
  /** 含版本路径，如 http://host:11434/v1 或 http://host:11434。 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** >0 直接采用；0 = 由首次调用解析。 */
  dim: number;
  timeoutMs: number;
  batchSize: number;
  maxInputChars: number;
  /** 非空则覆盖内置 profile。 */
  queryPrefix?: string;
  passagePrefix?: string;
}

interface BatchResult {
  ok: true;
  vectors: Float32Array[];
}

function truncate(s: string, max: number): string {
  if (max <= 0 || s.length <= max) return s;
  return s.slice(0, max);
}

function toVec(raw: number[]): Float32Array {
  return normalize(Float32Array.from(raw));
}

/**
 * 创建 embedding provider。
 * baseUrl 去掉尾部斜杠；openai 走 `{baseUrl}/embeddings`，ollama 走 `{baseUrl}/api/embed`。
 */
export function createEmbeddingProvider(
  opts: EmbeddingProviderOptions,
  logger?: Logger,
): EmbeddingProvider {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const batchSize = Math.max(1, opts.batchSize);
  const prefixes = resolvePrefixes(opts.model, {
    queryPrefix: opts.queryPrefix,
    passagePrefix: opts.passagePrefix,
  });
  let resolvedDim = opts.dim > 0 ? opts.dim : 0;

  function withPrefix(text: string, kind: EmbedKind): string {
    const prefix = kind === "query" ? prefixes.queryPrefix : prefixes.passagePrefix;
    return prefix + truncate(text, opts.maxInputChars);
  }

  async function postJson(url: string, body: unknown): Promise<
    { ok: true; json: unknown } | { ok: false; error: EmbedError }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        return { ok: false, error: { kind: "http", status: res.status, message: `embedding HTTP ${res.status}` } };
      }
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        return { ok: false, error: { kind: "invalid", message: "embedding 返回非 JSON" } };
      }
      return { ok: true, json };
    } catch (err) {
      const aborted = (err as Error)?.name === "AbortError";
      return {
        ok: false,
        error: aborted
          ? { kind: "timeout", message: `embedding 超时 (>${opts.timeoutMs}ms)` }
          : { kind: "network", message: err instanceof Error ? err.message : String(err) },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 单批请求（≤ batchSize 条）。 */
  async function requestBatch(inputs: string[]): Promise<BatchResult | { ok: false; error: EmbedError }> {
    if (opts.provider === "ollama") {
      const r = await postJson(`${baseUrl}/api/embed`, { model: opts.model, input: inputs });
      if (!r.ok) return r;
      const embeddings = (r.json as { embeddings?: number[][] })?.embeddings;
      if (!Array.isArray(embeddings)) {
        return { ok: false, error: { kind: "invalid", message: "ollama 响应缺少 embeddings" } };
      }
      return { ok: true, vectors: embeddings.map(toVec) };
    }

    // openai 兼容
    const r = await postJson(`${baseUrl}/embeddings`, {
      model: opts.model,
      input: inputs,
      encoding_format: "float",
    });
    if (!r.ok) return r;
    const data = (r.json as { data?: Array<{ embedding?: number[]; index?: number }> })?.data;
    if (!Array.isArray(data)) {
      return { ok: false, error: { kind: "invalid", message: "openai 响应缺少 data" } };
    }
    const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors: Float32Array[] = [];
    for (const d of ordered) {
      if (!Array.isArray(d.embedding)) {
        return { ok: false, error: { kind: "invalid", message: "openai 响应缺少 embedding" } };
      }
      vectors.push(toVec(d.embedding));
    }
    return { ok: true, vectors };
  }

  async function embed(texts: string[], kind: EmbedKind): Promise<EmbedResult> {
    if (texts.length === 0) {
      return { ok: true, vectors: [], dim: resolvedDim };
    }
    const inputs = texts.map((t) => withPrefix(t, kind));
    const vectors: Float32Array[] = [];

    for (let i = 0; i < inputs.length; i += batchSize) {
      const r = await requestBatch(inputs.slice(i, i + batchSize));
      if (!r.ok) {
        logger?.debug(`embedding 失败: ${r.error.kind} ${r.error.message}`);
        return r;
      }
      for (const v of r.vectors) {
        if (resolvedDim === 0) {
          resolvedDim = v.length;
        } else if (v.length !== resolvedDim) {
          return {
            ok: false,
            error: { kind: "dim_mismatch", message: `embedding 维度 ${v.length} ≠ 期望 ${resolvedDim}` },
          };
        }
        vectors.push(v);
      }
    }

    return { ok: true, vectors, dim: resolvedDim };
  }

  return {
    name: opts.provider,
    model: opts.model,
    async dim(): Promise<number> {
      if (resolvedDim > 0) return resolvedDim;
      const r = await embed(["dim probe"], "passage");
      if (!r.ok) throw new Error(r.error.message);
      return r.dim;
    },
    embed,
    async probe(): Promise<{ ok: boolean; dim?: number; detail?: string }> {
      const r = await embed(["probe"], "passage");
      return r.ok ? { ok: true, dim: r.dim } : { ok: false, detail: `${r.error.kind}: ${r.error.message}` };
    },
  };
}
