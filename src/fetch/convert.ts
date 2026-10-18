/**
 * Content-Type → 处理类别 + 文本类轻转换。
 *
 * fetch 从"仅 HTML"扩展为按类型分派：
 *   html   → html2md（既有路径）
 *   text   → 轻转换（JSON 美化 / CSV 转表格 / XML 包代码块 / 其余直出）
 *   pdf    → 抽正文（见 pdf.ts）
 *   binary → 落盘 + /files/<id>（见 store.ts）
 */

export type PayloadKind = "html" | "text" | "pdf" | "binary";

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);

const TEXT_APPLICATION_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/x-ndjson",
  "application/javascript",
  "application/ecmascript",
]);

/** 去掉 `; charset=…` 等参数并小写；缺失时返回空串。 */
export function baseContentType(ct: string | undefined): string {
  return (ct ?? "").split(";")[0]!.trim().toLowerCase();
}

/** 按 Content-Type 判定处理类别。无法识别者一律按二进制落盘处理。 */
export function classifyContentType(ct: string | undefined): PayloadKind {
  const base = baseContentType(ct);
  if (HTML_TYPES.has(base)) return "html";
  if (base === "application/pdf") return "pdf";
  if (base.startsWith("text/")) return "text";
  if (TEXT_APPLICATION_TYPES.has(base)) return "text";
  // RFC 6839 结构化语法后缀：application/foo+json、image/svg+xml 之类
  if (base.endsWith("+json") || base.endsWith("+xml")) return "text";
  return "binary";
}

/** 落盘文件扩展名（按 Content-Type 推断；未知回退 .bin）。 */
const EXT_BY_TYPE: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/json": ".json",
  "application/xml": ".xml",
  "application/zip": ".zip",
  "application/gzip": ".gz",
  "application/x-tar": ".tar",
  "application/octet-stream": ".bin",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/epub+zip": ".epub",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
  "image/tiff": ".tiff",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/ogg": ".ogg",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "text/html": ".html",
};

export function extForContentType(ct: string | undefined): string {
  return EXT_BY_TYPE[baseContentType(ct)] ?? ".bin";
}

/** 人类可读的字节数（KB/MB/GB，一位小数）；用于错误文案与日志。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} 字节`;
  if (bytes < 1024) return `${bytes} 字节`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)}${units[i]}`;
}

export interface RenderedText {
  text: string;
  truncated: boolean;
}

/** markdown 表格最多渲染的行/列，防止超宽表把上下文撑爆。 */
const MAX_TABLE_ROWS = 200;
const MAX_TABLE_COLS = 20;

function clip(s: string, max: number): RenderedText {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: `${s.slice(0, max)}\n\n…(内容已截断)`, truncated: true };
}

/** 简单分隔符解析：支持双引号包裹、`""` 转义；不做 RFC 4180 的换行内引号支持。 */
function parseDelimited(body: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function delimitedToMarkdown(body: string, delim: string): RenderedText {
  const rows = parseDelimited(body, delim).filter((r) => r.length > 0 && r.some((c) => c.trim() !== ""));
  if (rows.length === 0) return { text: body.trim(), truncated: false };

  const clippedCols = rows.some((r) => r.length > MAX_TABLE_COLS);
  const clippedRows = rows.length > MAX_TABLE_ROWS;
  const use = clippedRows ? rows.slice(0, MAX_TABLE_ROWS) : rows;

  const header = use[0]!.slice(0, MAX_TABLE_COLS);
  const body_ = use.slice(1).map((r) => r.slice(0, MAX_TABLE_COLS));
  const width = Math.max(header.length, ...body_.map((r) => r.length));

  const pad = (r: string[]): string[] => {
    const out = [...r];
    while (out.length < width) out.push("");
    return out.map(escapeCell);
  };

  const lines: string[] = [];
  lines.push(`| ${pad(header).join(" | ")} |`);
  lines.push(`| ${Array.from({ length: width }, () => "---").join(" | ")} |`);
  for (const r of body_) lines.push(`| ${pad(r).join(" | ")} |`);
  if (clippedRows) lines.push("", `> 表已截断：仅显示前 ${MAX_TABLE_ROWS} 行。`);
  if (clippedCols) lines.push("", `> 表已截断：仅显示前 ${MAX_TABLE_COLS} 列。`);
  return { text: lines.join("\n"), truncated: clippedRows || clippedCols };
}

function renderDelimited(body: string, delim: string, maxOutputChars: number): RenderedText {
  const table = delimitedToMarkdown(body, delim);
  const clipped = clip(table.text, maxOutputChars);
  return { text: clipped.text, truncated: clipped.truncated || table.truncated };
}

function fenced(label: string, body: string): string {
  // 内容里若已出现三反引号，用四反引号包裹
  const fence = body.includes("```") ? "````" : "```";
  return `${fence}${label}\n${body}\n${fence}`;
}

function prettyJson(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body.trim();
  }
}


/**
 * 把已解码的文本类响应渲染成 markdown 文本。
 * `base` 为 baseContentType() 的结果；截断到 maxOutputChars。
 */
export function renderTextBody(base: string, body: string, maxOutputChars: number): RenderedText {
  if (base === "application/json" || base.endsWith("+json")) {
    return clip(fenced("json", prettyJson(body)), maxOutputChars);
  }
  if (base === "text/csv") {
    return renderDelimited(body, ",", maxOutputChars);
  }
  if (base === "text/tab-separated-values") {
    return renderDelimited(body, "\t", maxOutputChars);
  }
  if (base === "application/xml" || base.endsWith("+xml")) {
    return clip(fenced("xml", body.trim()), maxOutputChars);
  }
  return clip(body, maxOutputChars);
}
