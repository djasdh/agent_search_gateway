import { describe, expect, it } from "vitest";
import {
  distanceToSimilarity,
  dot,
  fromVectorBytes,
  normalize,
  toVectorJson,
} from "../src/utils/vector.js";

describe("vector utils", () => {
  it("normalize 得到单位向量", () => {
    const v = normalize(new Float32Array([3, 4]));
    expect(Math.hypot(v[0], v[1])).toBeCloseTo(1, 6);
    expect(v[0]).toBeCloseTo(0.6, 6);
    expect(v[1]).toBeCloseTo(0.8, 6);
  });

  it("normalize 对零向量原样返回", () => {
    const z = new Float32Array([0, 0, 0]);
    expect(normalize(z)).toEqual(z);
  });

  it("归一化向量点积即 cosine", () => {
    const a = normalize(new Float32Array([1, 0, 0]));
    const b = normalize(new Float32Array([1, 1, 0]));
    expect(dot(a, b)).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it("toVectorJson 生成 sqlite-vec 可绑定的文本", () => {
    expect(toVectorJson(new Float32Array([1, 0.5, -1]))).toBe("[1,0.5,-1]");
  });

  it("fromVectorBytes 还原 float32 向量", () => {
    const src = new Float32Array([0.25, -0.5, 1, 0]);
    const bytes = new Uint8Array(src.buffer.slice(0));
    const back = fromVectorBytes(bytes);
    expect(Array.from(back)).toEqual([0.25, -0.5, 1, 0]);
  });

  it("distanceToSimilarity 把 cosine 距离转相似度", () => {
    expect(distanceToSimilarity(0)).toBe(1);
    expect(distanceToSimilarity(1)).toBe(0);
  });
});
