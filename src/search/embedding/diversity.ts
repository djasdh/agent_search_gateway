import { dot } from "../../utils/vector.js";
import type { Vector } from "./types.js";

/**
 * 重排层的「多样性」：MMR 贪心去冗余 + 同注册域上限。
 *
 * 复用语义层已算好的向量：rel 用现有 cosine（即候选的 score），
 * doc-doc 用同一向量点积（见 utils/vector.ts：落库前已 L2 归一化）。
 */

/**
 * 两级公共后缀（够用的启发式，覆盖常见 ccTLD；不引入 PSL 全量依赖）。
 * key 为「二级后缀」形态，命中时注册域取再上一级标签。
 */
const MULTI_LEVEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk", "sch.uk",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp", "ad.jp", "ed.jp", "gr.jp", "lg.jp",
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn", "ac.cn",
  "com.au", "net.au", "org.au", "gov.au", "edu.au",
  "com.hk", "org.hk", "net.hk", "edu.hk", "gov.hk",
  "com.tw", "org.tw", "net.tw", "edu.tw", "gov.tw",
  "co.kr", "or.kr", "ne.kr", "go.kr", "ac.kr",
  "com.sg", "org.sg", "net.sg", "edu.sg", "gov.sg",
  "co.in", "net.in", "org.in", "gov.in", "ac.in", "edu.in",
  "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz",
  "co.za", "org.za", "net.za", "gov.za", "ac.za",
  "com.br", "net.br", "org.br", "gov.br",
  "com.mx", "org.mx", "gob.mx", "edu.mx",
  "com.ar", "com.tr", "com.ru", "co.il", "com.ua", "co.th", "com.my",
]);

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * 注册域（eTLD+1）启发式。
 *
 * - `zhuanlan.zhihu.com` → `zhihu.com`；`m.php.cn` → `php.cn`
 * - `stats.gov.cn` → `stats.gov.cn`（`gov.cn` 属公共后缀，取再上一级）
 * - IP / 单标签 / 空值原样返回（防误伤）
 *
 * 只覆盖常见两级公共后缀，未知后缀退化为「末两级」。
 */
export function registeredDomain(host: string): string {
  const h = host.trim().toLowerCase().replace(/\.$/, "").split(":")[0];
  if (!h) return h;
  if (IPV4_RE.test(h)) return h;
  const parts = h.split(".").filter((p) => p.length > 0);
  if (parts.length <= 2) return parts.join(".");
  const last2 = parts.slice(-2).join(".");
  if (MULTI_LEVEL_SUFFIXES.has(last2)) return parts.slice(-3).join(".");
  return last2;
}

/** URL → 注册域；非标准 URL 时退回粗略取主机。 */
export function registeredDomainOfUrl(url: string): string {
  try {
    return registeredDomain(new URL(url).hostname);
  } catch {
    const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url);
    if (m) return registeredDomain(m[1].split("@").pop() ?? m[1]);
    return registeredDomain(url);
  }
}

/** MMR 候选：score=rel(doc,q)（cosine）；vec 缺失时只看相关性。 */
export interface MmrCandidate {
  score: number;
  vec?: Vector;
}

export interface DiversityOptions {
  /** 0=全多样，1=全相关。 */
  mmrLambda: number;
  /** 同一注册域最多入选项数；<=0 视为不限制。 */
  maxPerDomain: number;
}

function clampLambda(v: number): number {
  if (!Number.isFinite(v)) return 0.7;
  return Math.min(1, Math.max(0, v));
}

function mmrValue(cand: MmrCandidate, selected: MmrCandidate[], lambda: number): number {
  if (lambda >= 1) return cand.score;
  let maxSim = 0;
  if (cand.vec) {
    for (const s of selected) {
      if (!s.vec) continue;
      const sim = dot(cand.vec, s.vec);
      if (sim > maxSim) maxSim = sim;
    }
  }
  return lambda * cand.score - (1 - lambda) * maxSim;
}

/**
 * 贪心 MMR + 同域上限选择，返回按选中顺序排列的候选（最多 limit 条）。
 *
 * - 每步在「同域计数未达上限」的剩余候选里取 MMR 最大者；
 * - MMR = λ·score − (1−λ)·max_{已选} sim(cand, selected)，首选退化为纯 rel；
 * - 同分/同值保持入参顺序（稳定）；
 * - 剩余候选全被同域上限挡住时提前结束（返回可能少于 limit）。
 */
export function mmrSelect<T extends MmrCandidate>(
  candidates: T[],
  limit: number,
  opts: DiversityOptions,
  domainOf: (c: T) => string,
): T[] {
  if (limit <= 0 || candidates.length === 0) return [];
  const lambda = clampLambda(opts.mmrLambda);
  const cap = opts.maxPerDomain > 0 ? opts.maxPerDomain : Number.POSITIVE_INFINITY;

  const remaining = candidates.map((_, i) => i);
  const selected: number[] = [];
  const selectedCands: T[] = [];
  const perDomain = new Map<string, number>();

  while (selected.length < limit && remaining.length > 0) {
    let bestPos = -1;
    let bestVal = 0;
    for (let p = 0; p < remaining.length; p++) {
      const cand = candidates[remaining[p]];
      const d = domainOf(cand);
      if ((perDomain.get(d) ?? 0) >= cap) continue;
      const val = mmrValue(cand, selectedCands, lambda);
      if (bestPos === -1 || val > bestVal) {
        bestVal = val;
        bestPos = p;
      }
    }
    if (bestPos === -1) break; // 剩余候选都被同域上限挡住
    const [chosen] = remaining.splice(bestPos, 1);
    selected.push(chosen);
    selectedCands.push(candidates[chosen]);
    const d = domainOf(candidates[chosen]);
    perDomain.set(d, (perDomain.get(d) ?? 0) + 1);
  }

  return selected.map((i) => candidates[i]);
}
