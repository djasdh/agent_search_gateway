import { describe, expect, it } from "vitest";
import type { CleanedResult } from "../src/search/clean.js";
import { mergeAndRank } from "../src/search/embedding/semantic.js";
import type { EmbedResult } from "../src/search/embedding/types.js";
import { FakeCorpusStore, FakeEmbeddingProvider } from "./helpers/fakes.js";

function up(url: string, title = url, content = ""): CleanedResult {
  return { title, url, content, engines: [] };
}

describe("mergeAndRank", () => {
  it("provider/corpus 缺失时降级并保持顺序", async () => {
    const upstream = [up("a"), up("b")];
    const r = await mergeAndRank("q", upstream, 10, { provider: null, corpus: null, recallK: 5 });
    expect(r.degraded).toBe(true);
    expect(r.results.map((x) => x.url)).toEqual(["a", "b"]);
  });

  it("embedding 失败时降级", async () => {
    const provider = new FakeEmbeddingProvider(4, true);
    const corpus = new FakeCorpusStore();
    const r = await mergeAndRank("q", [up("a"), up("b")], 10, { provider, corpus, recallK: 5 });
    expect(r.degraded).toBe(true);
    expect(r.results.map((x) => x.url)).toEqual(["a", "b"]);
  });

  it("语料召回条目按相似度置顶，并标注 origin/fetchedAt", async () => {
    const provider = new FakeEmbeddingProvider(4);
    const corpus = new FakeCorpusStore();
    corpus.put([{ url: "hit", title: "H", content: "", fetchedAt: 123, vec: provider.vecFor("q") }]);
    const r = await mergeAndRank("q", [up("a", "A", "aaa"), up("b", "B", "bbb")], 10, { provider, corpus, recallK: 5 });
    expect(r.degraded).toBe(false);
    expect(r.results[0].url).toBe("hit");
    expect(r.results[0].origin).toBe("corpus");
    expect(r.results[0].fetchedAt).toBe(123);
    expect(r.results.find((x) => x.url === "a")!.origin).toBe("upstream");
  });

  it("命中语料的 url 不重复嵌入，复用向量", async () => {
    const provider = new FakeEmbeddingProvider(4);
    const corpus = new FakeCorpusStore();
    corpus.put([{ url: "uA", title: "A", content: "aaa", fetchedAt: 1, vec: provider.vecFor("A\naaa") }]);
    await mergeAndRank("q", [up("uA", "A", "aaa"), up("uB", "B", "bbb")], 10, { provider, corpus, recallK: 5 });
    // calls[0]=query；calls[1]=仅未命中的 uB
    expect(provider.calls[1]).toEqual(["B\nbbb"]);
  });

  it("传入 queryEmbed 时复用预启动结果，不再重复发起 query 嵌入", async () => {
    const provider = new FakeEmbeddingProvider(4);
    const corpus = new FakeCorpusStore();
    const queryEmbed = provider.embed(["q"], "query"); // 编排层预启动
    const r = await mergeAndRank("q", [up("a", "A", "aaa")], 10, { provider, corpus, recallK: 5, queryEmbed });
    expect(r.degraded).toBe(false);
    // 仅两次 embed：预启动的 query + 一次 passage 补算（未重复发起 query）
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]).toEqual(["q"]);
    expect(provider.calls[1]).toEqual(["A\naaa"]);
  });

  it("queryEmbed 失败时整体降级，且不再自行嵌入 query", async () => {
    const provider = new FakeEmbeddingProvider(4);
    const corpus = new FakeCorpusStore();
    const queryEmbed: Promise<EmbedResult> = Promise.resolve({
      ok: false,
      error: { kind: "network", message: "down" },
    });
    const r = await mergeAndRank("q", [up("a"), up("b")], 10, { provider, corpus, recallK: 5, queryEmbed });
    expect(r.degraded).toBe(true);
    expect(r.results.map((x) => x.url)).toEqual(["a", "b"]);
    expect(provider.calls).toHaveLength(0);
  });

  it("按 URL 去重，上游优先", async () => {
    const provider = new FakeEmbeddingProvider(4);
    const corpus = new FakeCorpusStore();
    corpus.put([{ url: "a", title: "fromCorpus", content: "", fetchedAt: 1, vec: provider.vecFor("q") }]);
    const r = await mergeAndRank("q", [up("a", "fromUpstream", "x")], 10, { provider, corpus, recallK: 5 });
    expect(r.results.filter((x) => x.url === "a")).toHaveLength(1);
    expect(r.results[0].origin).toBe("upstream");
  });

  it("结果 slice 到 limit", async () => {
    const provider = new FakeEmbeddingProvider(4);
    const corpus = new FakeCorpusStore();
    const r = await mergeAndRank("q", [up("a"), up("b"), up("c")], 2, { provider, corpus, recallK: 5 });
    expect(r.results).toHaveLength(2);
  });

  it("diversity.enabled=false 与不传 diversity 的顺序严格一致", async () => {
    const mk = () => {
      const provider = new FakeEmbeddingProvider(4);
      return { provider, corpus: new FakeCorpusStore() };
    };
    const a = mk();
    const b = mk();
    const upstream = [up("https://x.com/1", "A"), up("https://x.com/2", "B"), up("https://y.com/1", "C")];
    const base = await mergeAndRank("q", upstream, 10, { provider: a.provider, corpus: a.corpus, recallK: 5 });
    const off = await mergeAndRank("q", upstream, 10, {
      provider: b.provider,
      corpus: b.corpus,
      recallK: 5,
      diversity: { enabled: false, mmrLambda: 0.7, maxPerDomain: 3 },
    });
    expect(off.results.map((r) => r.url)).toEqual(base.results.map((r) => r.url));
  });

  it("diversity 开启 + 同域上限：返回结果各注册域互不相同", async () => {
    const provider = new FakeEmbeddingProvider(4);
    const corpus = new FakeCorpusStore();
    const upstream = [
      up("https://x.com/1", "X1"),
      up("https://x.com/2", "X2"),
      up("https://x.com/3", "X3"),
      up("https://y.com/1", "Y1"),
      up("https://z.com/1", "Z1"),
    ];
    const r = await mergeAndRank("q", upstream, 10, {
      provider,
      corpus,
      recallK: 5,
      diversity: { enabled: true, mmrLambda: 0.7, maxPerDomain: 1 },
    });
    expect(r.results.length).toBe(3); // x/y/z 各一条，x.com 超出被裁
  });

  it("authority.enabled=false 与不传 authority 的顺序严格一致", async () => {
    const mk = () => {
      const provider = new FakeEmbeddingProvider(4);
      return { provider, corpus: new FakeCorpusStore() };
    };
    const a = mk();
    const b = mk();
    const upstream = [up("https://x.com/1", "A"), up("https://y.com/2", "B"), up("https://z.com/3", "C")];
    const base = await mergeAndRank("q", upstream, 10, { provider: a.provider, corpus: a.corpus, recallK: 5 });
    const off = await mergeAndRank("q", upstream, 10, {
      provider: b.provider,
      corpus: b.corpus,
      recallK: 5,
      authority: { enabled: false, weight: 1.0 },
    });
    expect(off.results.map((r) => r.url)).toEqual(base.results.map((r) => r.url));
  });

  it("authority weight=0 时顺序等于纯 cosine（min-max 单调不改序）", async () => {
    const mk = () => {
      const provider = new FakeEmbeddingProvider(4);
      return { provider, corpus: new FakeCorpusStore() };
    };
    const a = mk();
    const b = mk();
    const upstream = [up("https://zhuanlan.zhihu.com/1", "A"), up("https://kubernetes.io/2", "B"), up("https://x.com/3", "C")];
    const base = await mergeAndRank("q", upstream, 10, { provider: a.provider, corpus: a.corpus, recallK: 5 });
    const zero = await mergeAndRank("q", upstream, 10, {
      provider: b.provider,
      corpus: b.corpus,
      recallK: 5,
      authority: { enabled: true, weight: 0 },
    });
    expect(zero.results.map((r) => r.url)).toEqual(base.results.map((r) => r.url));
  });

  it("authority 开启：相关分并列时按权威重排（官方 > 未知 > UGC）", async () => {
    const provider = new FakeEmbeddingProvider(4);
    const corpus = new FakeCorpusStore();
    // 三段正文完全相同 → 向量/相关分完全并列，排序由 authority 决定
    const upstream = [
      up("https://zhuanlan.zhihu.com/1", "Same", "Same content"),
      up("https://docs.python.org/3/", "Same", "Same content"),
      up("https://example.com/1", "Same", "Same content"),
    ];
    const r = await mergeAndRank("q", upstream, 10, {
      provider,
      corpus,
      recallK: 5,
      authority: { enabled: true, weight: 1.0 },
    });
    expect(r.results.map((x) => x.url)).toEqual([
      "https://docs.python.org/3/",
      "https://example.com/1",
      "https://zhuanlan.zhihu.com/1",
    ]);
  });

  it("authority(0.5) + diversity(λ=1, cap3) 组合：先综合分排序，再按同域上限选择", async () => {
    const provider = new FakeEmbeddingProvider(4);
    const corpus = new FakeCorpusStore();
    // 全部同正文 → 相关分并列（归一化后均 1）；排序只由 0.5·auth 决定。
    // zhihu.com 放 4 条（auth 0.35），验证先按综合分序、再被同域上限截到 3 条。
    const upstream = [
      up("https://zhuanlan.zhihu.com/1", "Same", "Same content"),
      up("https://zhuanlan.zhihu.com/2", "Same", "Same content"),
      up("https://zhuanlan.zhihu.com/3", "Same", "Same content"),
      up("https://zhuanlan.zhihu.com/4", "Same", "Same content"),
      up("https://docs.python.org/3/", "Same", "Same content"),
      up("https://example.com/1", "Same", "Same content"),
    ];
    const r = await mergeAndRank("q", upstream, 10, {
      provider,
      corpus,
      recallK: 5,
      authority: { enabled: true, weight: 0.5 },
      diversity: { enabled: true, mmrLambda: 1.0, maxPerDomain: 3 },
    });
    // 官方 0.95 > 未知 0.5 > UGC 0.35（λ=1 时 MMR 项失效，只剩同域上限）
    expect(r.results.map((x) => x.url)).toEqual([
      "https://docs.python.org/3/",
      "https://example.com/1",
      "https://zhuanlan.zhihu.com/1",
      "https://zhuanlan.zhihu.com/2",
      "https://zhuanlan.zhihu.com/3",
    ]);
    expect(r.results).toHaveLength(5); // 第 4 条 zhihu 被同域上限截掉
  });
});
