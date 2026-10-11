import type { EmbedKind, EmbedResult, CorpusEntry, CorpusHit, Vector } from "../../src/search/embedding/types.js";
import type { EmbeddingProvider } from "../../src/search/embedding/provider.js";
import type { CorpusStore } from "../../src/search/embedding/store.js";
import { dot, normalize } from "../../src/utils/vector.js";

/** 确定性假 embedding：向量由文本字符派生，记录每次调用便于断言。 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = "fake";
  readonly model = "fake-model";
  /** 每次 embed 的入参，用于断言「只调用一次 / 复用未重复调用」。 */
  calls: string[][] = [];
  probeCalls = 0;

  constructor(
    private d = 4,
    private fail = false,
  ) {}

  async dim(): Promise<number> {
    return this.d;
  }

  async embed(texts: string[], kind: EmbedKind): Promise<EmbedResult> {
    void kind;
    if (this.fail) {
      return { ok: false, error: { kind: "network", message: "fake embedding down" } };
    }
    this.calls.push([...texts]);
    return { ok: true, vectors: texts.map((t) => this.vecFor(t)), dim: this.d };
  }

  async probe(): Promise<{ ok: boolean; dim?: number; detail?: string }> {
    this.probeCalls += 1;
    return this.fail ? { ok: false, detail: "fake down" } : { ok: true, dim: this.d };
  }

  /** 文本 → 归一化向量（同一文本恒定）。 */
  vecFor(text: string): Float32Array {
    const v = new Float32Array(this.d);
    for (let i = 0; i < text.length; i++) v[i % this.d] += text.charCodeAt(i) + 1;
    if (v.every((x) => x === 0)) v[0] = 1;
    return normalize(v);
  }
}

/** 内存语料库，用于单测；行为对齐 CorpusStore 契约。 */
export class FakeCorpusStore implements CorpusStore {
  readonly namespace: string;
  private map = new Map<string, { entry: CorpusEntry; vec: Vector; expiresAt: number }>();
  private names = new Set<string>();

  constructor(
    namespace = "fake:fake-model@4",
    private ttlMs = 1_000_000,
  ) {
    this.namespace = namespace;
    this.names.add(namespace);
  }

  get(urls: string[]): Map<string, Vector> {
    const out = new Map<string, Vector>();
    const now = Date.now();
    for (const u of urls) {
      const e = this.map.get(u);
      if (e && now <= e.expiresAt) out.set(u, e.vec);
    }
    return out;
  }

  put(entries: Array<CorpusEntry & { vec: Vector }>): void {
    const now = Date.now();
    for (const { vec, ...entry } of entries) {
      this.map.set(entry.url, { entry, vec, expiresAt: now + this.ttlMs });
    }
  }

  knn(query: Vector, k: number): CorpusHit[] {
    const now = Date.now();
    const hits: CorpusHit[] = [];
    for (const e of this.map.values()) {
      if (now > e.expiresAt) continue;
      hits.push({ entry: e.entry, similarity: dot(query, e.vec) });
    }
    hits.sort((a, b) => b.similarity - a.similarity);
    return hits.slice(0, k);
  }

  gc(now: number): number {
    let removed = 0;
    for (const [url, e] of this.map) {
      if (now > e.expiresAt) {
        this.map.delete(url);
        removed += 1;
      }
    }
    return removed;
  }

  stats(): { namespace: string; entries: number; namespaces: string[] } {
    return { namespace: this.namespace, entries: this.map.size, namespaces: [...this.names] };
  }

  close(): void {
    this.map.clear();
  }
}
