import { describe, expect, it } from "vitest";
import { mmrSelect, registeredDomain, registeredDomainOfUrl } from "../src/search/embedding/diversity.js";
import type { Vector } from "../src/search/embedding/types.js";

function vec(...xs: number[]): Vector {
  return Float32Array.from(xs);
}

describe("registeredDomain (eTLD+1)", () => {
  it("普通多级子域归并到注册域", () => {
    expect(registeredDomain("zhuanlan.zhihu.com")).toBe("zhihu.com");
    expect(registeredDomain("zhihu.com")).toBe("zhihu.com");
    expect(registeredDomain("m.php.cn")).toBe("php.cn");
    expect(registeredDomain("movie.douban.com")).toBe("douban.com");
    expect(registeredDomain("blog.csdn.net")).toBe("csdn.net");
    expect(registeredDomain("doc.rust-lang.org")).toBe("rust-lang.org");
  });

  it("两级公共后缀取再上一级", () => {
    expect(registeredDomain("stats.gov.cn")).toBe("stats.gov.cn");
    expect(registeredDomain("moe.gov.cn")).toBe("moe.gov.cn");
    expect(registeredDomain("www.bbc.co.uk")).toBe("bbc.co.uk");
    expect(registeredDomain("a.b.example.co.uk")).toBe("example.co.uk");
  });

  it("大小写/尾点/端口/IP/单标签稳健", () => {
    expect(registeredDomain("WWW.Zhihu.COM.")).toBe("zhihu.com");
    expect(registeredDomain("127.0.0.1")).toBe("127.0.0.1");
    expect(registeredDomain("localhost")).toBe("localhost");
    expect(registeredDomainOfUrl("https://zhuanlan.zhihu.com/p/123?x=1")).toBe("zhihu.com");
    expect(registeredDomainOfUrl("not a url")).toBe("not a url");
  });
});

describe("mmrSelect", () => {
  const dom = (c: { d: string }): string => c.d;

  it("λ=0.5 时优先选与已选不相似的文档（MMR 去冗余）", () => {
    const cands = [
      { score: 1.0, vec: vec(1, 0, 0, 0), d: "a.com" },
      { score: 0.9, vec: vec(1, 0, 0, 0), d: "a.com" }, // 与 A 完全相同（余弦 1）
      { score: 0.5, vec: vec(0, 1, 0, 0), d: "b.com" }, // 与 A 余弦 0
    ];
    const out = mmrSelect(cands, 2, { mmrLambda: 0.5, maxPerDomain: 10 }, dom);
    expect(out.map((c) => c.d)).toEqual(["a.com", "b.com"]);
  });

  it("λ=1 退化为纯相关性排序", () => {
    const cands = [
      { score: 1.0, vec: vec(1, 0, 0, 0), d: "a.com" },
      { score: 0.9, vec: vec(1, 0, 0, 0), d: "a.com" },
      { score: 0.5, vec: vec(0, 1, 0, 0), d: "b.com" },
    ];
    const out = mmrSelect(cands, 2, { mmrLambda: 1, maxPerDomain: 10 }, dom);
    expect(out.map((c) => c.score)).toEqual([1.0, 0.9]);
  });

  it("同域上限生效：超过上限则跳过同域候选", () => {
    const cands = [
      { score: 1.0, vec: vec(1, 0, 0, 0), d: "x.com" },
      { score: 0.9, vec: vec(0, 1, 0, 0), d: "x.com" },
      { score: 0.8, vec: vec(0, 0, 1, 0), d: "x.com" },
      { score: 0.1, vec: vec(0, 0, 0, 1), d: "y.com" },
    ];
    const out = mmrSelect(cands, 3, { mmrLambda: 0.7, maxPerDomain: 2 }, dom);
    // 前两条来自 x.com，第三条因 x.com 达上限改选 y.com
    expect(out.map((c) => c.d)).toEqual(["x.com", "x.com", "y.com"]);
  });

  it("全部剩余候选都被同域上限挡住时提前结束（可能少于 limit）", () => {
    const cands = [
      { score: 1.0, vec: vec(1, 0, 0, 0), d: "x.com" },
      { score: 0.9, vec: vec(0, 1, 0, 0), d: "x.com" },
      { score: 0.8, vec: vec(0, 0, 1, 0), d: "x.com" },
    ];
    const out = mmrSelect(cands, 3, { mmrLambda: 0.7, maxPerDomain: 2 }, dom);
    expect(out).toHaveLength(2);
  });

  it("无向量候选稳健（只看相关性），候选不足 limit 时原样返回", () => {
    const cands = [
      { score: 0.9, d: "a.com" },
      { score: 0.5, d: "b.com" },
    ];
    expect(mmrSelect(cands, 10, { mmrLambda: 0.7, maxPerDomain: 3 }, dom)).toHaveLength(2);
    expect(mmrSelect([], 5, { mmrLambda: 0.7, maxPerDomain: 3 }, dom)).toHaveLength(0);
  });
});
