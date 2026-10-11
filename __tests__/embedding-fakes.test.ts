import { describe, expect, it } from "vitest";
import { FakeCorpusStore, FakeEmbeddingProvider } from "./helpers/fakes.js";

describe("FakeEmbeddingProvider", () => {
  it("向量顺序与入参一致，且记录调用", async () => {
    const p = new FakeEmbeddingProvider(4);
    const r = await p.embed(["a", "b"], "passage");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.vectors).toHaveLength(2);
    expect(p.calls).toEqual([["a", "b"]]);
    expect(await p.dim()).toBe(4);
  });

  it("fail 模式返回结构化错误而不抛异常", async () => {
    const p = new FakeEmbeddingProvider(4, true);
    const r = await p.embed(["x"], "query");
    expect(r.ok).toBe(false);
    expect((await p.probe()).ok).toBe(false);
  });
});

describe("FakeCorpusStore", () => {
  it("put/get 往返且按 url 覆盖", () => {
    const s = new FakeCorpusStore();
    const vec = new Float32Array([1, 0, 0, 0]);
    s.put([{ url: "u1", title: "t", content: "c", fetchedAt: 1, vec }]);
    expect(s.get(["u1"]).get("u1")).toBe(vec);
    expect(s.get(["missing"]).size).toBe(0);
  });

  it("knn 按相似度降序，命中相近向量", () => {
    const p = new FakeEmbeddingProvider(4);
    const s = new FakeCorpusStore();
    s.put([
      { url: "near", title: "", content: "", fetchedAt: 1, vec: p.vecFor("hello") },
      { url: "far", title: "", content: "", fetchedAt: 1, vec: new Float32Array([0, 0, 0, 1]) },
    ]);
    const hits = s.knn(p.vecFor("hello"), 2);
    expect(hits[0].entry.url).toBe("near");
    expect(hits[0].similarity).toBeCloseTo(1, 6);
  });

  it("gc 删除过期条目", () => {
    const s = new FakeCorpusStore("ns", 1000);
    s.put([{ url: "u", title: "", content: "", fetchedAt: 1, vec: new Float32Array([1, 0, 0, 0]) }]);
    expect(s.stats().entries).toBe(1);
    expect(s.gc(Date.now() + 5000)).toBe(1);
    expect(s.stats().entries).toBe(0);
  });
});
