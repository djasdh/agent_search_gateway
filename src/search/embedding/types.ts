/** embedding 与语料库的共享类型。 */

/** 向量。约定：落库前已做 L2 归一化（见 utils/vector.ts）。 */
export type Vector = Float32Array;

/** 嵌入用途；query 与 passage 可能套不同前缀（由模型 profile 决定）。 */
export type EmbedKind = "query" | "passage";

export interface EmbedError {
  kind: "timeout" | "http" | "network" | "invalid" | "dim_mismatch";
  message: string;
  status?: number;
}

/** 批量嵌入结果，vectors 与入参 texts 顺序一一对应。 */
export type EmbedResult =
  | { ok: true; vectors: Vector[]; dim: number }
  | { ok: false; error: EmbedError };

/** 语料库条目：以规范化 URL 为主键。 */
export interface CorpusEntry {
  url: string;
  title: string;
  content: string;
  fetchedAt: number;
}

export interface CorpusHit {
  entry: CorpusEntry;
  similarity: number;
}
