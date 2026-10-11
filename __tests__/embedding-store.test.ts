import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCorpusStore } from "../src/search/embedding/store.js";
import { normalize } from "../src/utils/vector.js";

const dirs: string[] = [];
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "corpus-test-"));
  dirs.push(d);
  return join(d, "corpus.db");
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const v = (a: number[]) => normalize(Float32Array.from(a));

describe("CorpusStore (sqlite-vec)", () => {
  it("dim<=0 返回 null", () => {
    expect(createCorpusStore({ path: tmpDb(), namespace: "ns", dim: 0, ttlMs: 1000 })).toBeNull();
  });

  it("put/get 往返，未命中返回空", () => {
    const s = createCorpusStore({ path: tmpDb(), namespace: "openai:m@4", dim: 4, ttlMs: 100000 })!;
    s.put([{ url: "u1", title: "t", content: "c", fetchedAt: 1, vec: v([1, 0, 0, 0]) }]);
    const got = s.get(["u1", "nope"]);
    expect(got.has("u1")).toBe(true);
    expect(Array.from(got.get("u1")!)).toEqual([1, 0, 0, 0]);
    expect(got.has("nope")).toBe(false);
    s.close();
  });

  it("knn 按相似度降序，相同向量相似度≈1", () => {
    const s = createCorpusStore({ path: tmpDb(), namespace: "openai:m@4", dim: 4, ttlMs: 100000 })!;
    s.put([
      { url: "near", title: "N", content: "", fetchedAt: 1, vec: v([1, 0, 0, 0]) },
      { url: "far", title: "F", content: "", fetchedAt: 1, vec: v([0, 1, 0, 0]) },
    ]);
    const hits = s.knn(v([1, 0, 0, 0]), 2);
    expect(hits.map((h) => h.entry.url)).toEqual(["near", "far"]);
    expect(hits[0].similarity).toBeCloseTo(1, 4);
    expect(hits[0].entry.title).toBe("N");
    s.close();
  });

  it("同 url 覆盖更新内容与向量", () => {
    const s = createCorpusStore({ path: tmpDb(), namespace: "openai:m@4", dim: 4, ttlMs: 100000 })!;
    s.put([{ url: "u", title: "old", content: "old", fetchedAt: 1, vec: v([1, 0, 0, 0]) }]);
    s.put([{ url: "u", title: "new", content: "new", fetchedAt: 2, vec: v([0, 1, 0, 0]) }]);
    expect(s.stats().entries).toBe(1);
    expect(Array.from(s.get(["u"]).get("u")!)).toEqual([0, 1, 0, 0]);
    expect(s.knn(v([0, 1, 0, 0]), 1)[0].entry.title).toBe("new");
    s.close();
  });

  it("gc 删除过期条目", () => {
    const s = createCorpusStore({ path: tmpDb(), namespace: "ns", dim: 4, ttlMs: 1000 })!;
    s.put([{ url: "u", title: "", content: "", fetchedAt: 1, vec: v([1, 0, 0, 0]) }]);
    expect(s.gc(Date.now() + 5000)).toBe(1);
    expect(s.stats().entries).toBe(0);
    s.close();
  });

  it("命名空间隔离：不同命名空间互不可见", () => {
    const path = tmpDb();
    const a = createCorpusStore({ path, namespace: "p:m@4:A", dim: 4, ttlMs: 100000 })!;
    const b = createCorpusStore({ path, namespace: "p:m@4:B", dim: 4, ttlMs: 100000 })!;
    a.put([{ url: "u", title: "t", content: "c", fetchedAt: 1, vec: v([1, 0, 0, 0]) }]);
    expect(b.get(["u"]).size).toBe(0);
    expect(b.stats().entries).toBe(0);
    expect(b.knn(v([1, 0, 0, 0]), 5)).toHaveLength(0);
    expect(b.stats().namespaces.sort()).toEqual(["p:m@4:A", "p:m@4:B"]);
    a.close();
    b.close();
  });
});
