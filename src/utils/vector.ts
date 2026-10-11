/**
 * 向量工具。
 *
 * 约定：向量在落库与比较前做 L2 归一化，此时点积即 cosine。
 * 之所以不依赖 vec0 的 cosine 度量做归一化，是为了让「复用未命中」和
 * 「跨实现比较」在任何后端下都一致。
 */

/** L2 归一化；零向量或非法范数原样返回（避免除零）。 */
export function normalize(vec: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (norm === 0 || !Number.isFinite(norm)) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

/** 点积。对已归一化向量即为 cosine。 */
export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/** 转为 sqlite-vec 可绑定的 JSON 文本（`[1,0,0,0]`）。 */
export function toVectorJson(vec: Float32Array): string {
  return `[${Array.from(vec).join(",")}]`;
}

/**
 * 还原 vec0 读出的向量：`embedding` 列类型为 Uint8Array（float32 小端）。
 * 先复制一份，保证 byteOffset 对齐且不依赖外部 buffer 生命周期。
 */
export function fromVectorBytes(bytes: Uint8Array): Float32Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

/** vec0 cosine 距离 → 相似度（越大越相似）。 */
export function distanceToSimilarity(distance: number): number {
  return 1 - distance;
}
