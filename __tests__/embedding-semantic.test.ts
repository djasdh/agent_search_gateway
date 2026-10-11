import { describe, expect, it } from "vitest";
import type { CleanedResult } from "../src/search/clean.js";
import { mergeAndRank } from "../src/search/embedding/semantic.js";
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
});
