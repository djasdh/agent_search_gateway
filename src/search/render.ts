import type { SearxngInfobox, SearxngResponse } from "./searxng.js";
import { isImageResult, type CleanedResult } from "./clean.js";

export interface RenderInput {
  query: string;
  raw: SearxngResponse;
  results: CleanedResult[];
  latencyMs: number;
  skipped?: number; // 被广告过滤丢弃的数量
  /** 请求条数被系统上限截断时的上限值；有值即说明「已达上限」。 */
  cappedAt?: number;
  /** 截断前的候选总数（去重后）；用于说明「还有更多候选」。 */
  availableCount?: number;
}

function engineLabel(engines: string[]): string {
  return engines.length > 0 ? ` · ${engines.join("/")}` : "";
}

function dateLabel(publishedDate?: string): string {
  if (!publishedDate) return "";
  try {
    const d = new Date(publishedDate);
    if (Number.isNaN(d.getTime())) return "";
    return ` · ${d.toISOString().slice(0, 10)}`;
  } catch {
    return "";
  }
}

function scoreLabel(score?: number): string {
  if (score === undefined) return "";
  return ` · score ${score.toFixed(2)}`;
}

function renderMetadata(data: SearxngResponse): string[] {
  const sections: string[] = [];

  const answers = data.answers ?? [];
  if (answers.length > 0) {
    sections.push("## 直接回答");
    for (const a of answers) {
      const text = typeof a === "string" ? a : a.answer ?? "";
      const line = text ? `- ${text}` : "";
      sections.push(line);
      if (typeof a === "object" && a !== null && a.url) {
        sections.push(`  - 来源: ${a.url}`);
      }
    }
  }

  const corrections = data.corrections ?? [];
  if (corrections.length > 0) {
    sections.push("## 拼写纠正");
    sections.push(...corrections.map((c) => `- 你是不是想搜「${c}」?`));
  }

  const suggestions = data.suggestions ?? [];
  if (suggestions.length > 0) {
    sections.push("## 建议");
    sections.push(...suggestions.map((s) => `- ${s}`));
  }

  const infoboxes: SearxngInfobox[] = data.infoboxes ?? [];
  if (infoboxes.length > 0) {
    for (const ib of infoboxes) {
      const lines: string[] = [];
      if (ib.infobox) lines.push(`## ${ib.infobox}`);
      if (ib.content) lines.push(ib.content);
      if (Array.isArray(ib.urls) && ib.urls.length > 0) {
        for (const u of ib.urls) {
          if (u.title && u.url) lines.push(`- [${u.title}](${u.url})`);
        }
      }
      sections.push(lines.join("\n"));
    }
  }

  return sections;
}

function originLabel(r: CleanedResult): string {
  if (r.origin !== "corpus") return "";
  if (!r.fetchedAt) return " · 本地缓存";
  try {
    return ` · 本地缓存 ${new Date(r.fetchedAt).toISOString().slice(0, 10)}`;
  } catch {
    return " · 本地缓存";
  }
}

/** markdown 链接/图片题注里需转义的字符（标题可能自带 `[`/`]`）。 */
function escapeLabel(s: string): string {
  return s.replace(/[[\]]/g, (m) => `\\${m}`);
}

/**
 * 图片结果：以 markdown 图片给出**直链**（agent 可直接展示或交给 fetch 落盘），
 * 来源页/尺寸/格式/引擎另起一行附注。
 */
function renderImageResult(r: CleanedResult, index: number, meta: string): string {
  const src = r.imgSrc ?? r.thumbnailSrc ?? "";
  const label = escapeLabel(r.title || "图片");
  const thumbNote = !r.imgSrc && r.thumbnailSrc ? " · 缩略图" : "";
  const details: string[] = [`[来源页](${r.url})`];
  if (r.resolution) details.push(r.resolution);
  if (r.imgFormat) details.push(r.imgFormat);
  if (r.imgSource) details.push(r.imgSource);
  const body = r.content ? `\n   ${r.content}` : "";
  return `${index + 1}. ![${label}](${src})${thumbNote}\n   ${details.join(" · ")}${meta}${body}`;
}

/** 渲染结果列表为 md（导出以便服务层在错误分支复用）。 */
export function renderResults(results: CleanedResult[]): string {
  if (results.length === 0) {
    return "*没有找到结果。*\n\n可以尝试：\n- 换更短或更宽泛的关键词\n- 去掉时间/语言过滤\n- 检查拼写";
  }
  return results
    .map((r, i) => {
      const meta = `${engineLabel(r.engines)}${dateLabel(r.publishedDate)}${scoreLabel(r.score)}${originLabel(r)}`;
      const src = r.imgSrc ?? r.thumbnailSrc;
      if (src && isImageResult(r)) return renderImageResult(r, i, meta);
      const head = `${i + 1}. [${escapeLabel(r.title)}](${r.url})${meta}`;
      const body = r.content ? `\n   ${r.content}` : "";
      return `${head}${body}`;
    })
    .join("\n\n");
}

/**
 * 渲染为纯 md 文本（无 front matter）。
 * 结构：# 标题 → 元数据置顶 → ## 结果。
 *
 * 注意：不渲染 `unresponsive_engines`。引擎不可用/降级由 service 层的静默重试
 * 兜底，对用户隐藏（否则会暴露降级过程）。
 */
export function renderSearchMarkdown(input: RenderInput): string {
  const { query, raw, results, latencyMs, skipped, cappedAt, availableCount } = input;
  const lines: string[] = [];

  lines.push(`# Search: ${query}`);
  const metaParts = [`${results.length} 个结果`];
  if (skipped && skipped > 0) metaParts.push(`(已过滤 ${skipped} 条)`);
  metaParts.push(`${latencyMs}ms`);
  lines.push(`*${metaParts.join(" · ")}*`);
  lines.push("");

  lines.push(...renderMetadata(raw));
  if (raw.answers?.length || raw.corrections?.length || raw.suggestions?.length || raw.infoboxes?.length) {
    lines.push("");
  }

  lines.push("## 结果");
  lines.push("");
  lines.push(renderResults(results));

  // 截断说明：与 skipped（广告过滤）分开表述。
  // 优先报「已达上限」（请求被 cap 截断）；否则报「还有更多候选」。
  if (cappedAt !== undefined) {
    lines.push("");
    lines.push(`*请求条数已达系统上限 ${cappedAt} 条；如需更精确的结果，可缩小关键词范围。*`);
  } else if (availableCount !== undefined && availableCount > results.length) {
    lines.push("");
    lines.push(`*已显示 ${results.length}/${availableCount} 条，可用更精确的关键词获取其余结果。*`);
  }

  return lines.join("\n");
}
