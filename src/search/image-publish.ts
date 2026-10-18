import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

/**
 * 本地图片的**公网发布**（ADR-0011）。
 *
 * 用途只有一个：searxng 的 tineye 引擎是 `online_url_search` —— 图片由 **TinEye 侧**
 * 拉取，所以本地文件必须先变成**公网可达的图片 URL** 才能让 tineye 参与。
 * trace.moe 不需要这一步（它接受 multipart 直传）。
 *
 * 协议：**uguu/pomf 系**的上传接口（实测契约）
 *
 *     POST {endpoint}                    # 默认 https://uguu.se/upload?output=json
 *     multipart 字段: files[]
 *     → {"success":true,"files":[{"hash":"…","filename":"…","url":"…","size":…,"dupe":false}]}
 *
 * 因此 `endpoint` 可以指向自建 / 同类的 pomf·uguu 实例而无需改代码。
 * 发布出去的图**公网可见**、由对方按自己的 TTL 删除（uguu 为 3 小时），
 * 对方可能保留上传 IP / 文件名 / 哈希的短时日志 —— 故该能力默认行为由配置决定，
 * 且只在显式提供 `image_path` 时才会用到。
 */

/** magic bytes → MIME（只认图片，避免把任意本地文件发到公网）。 */
const IMAGE_SIGNATURES: Array<{ mime: string; test: (b: Uint8Array) => boolean }> = [
  { mime: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: "image/png",
    test: (b) =>
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  { mime: "image/gif", test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  {
    mime: "image/webp",
    test: (b) =>
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
  { mime: "image/bmp", test: (b) => b[0] === 0x42 && b[1] === 0x4d },
  {
    mime: "image/tiff",
    test: (b) => (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00),
  },
];

/** 按 magic bytes 判定图片类型；非图片返回 undefined。 */
export function detectImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length < 12) return undefined;
  return IMAGE_SIGNATURES.find((s) => s.test(bytes))?.mime;
}

export interface LocalImage {
  path: string;
  /** multipart 里用的文件名（只取 basename）。 */
  filename: string;
  mime: string;
  size: number;
  bytes: Uint8Array;
}

export interface PublishError {
  kind: "not_found" | "not_file" | "too_large" | "not_image" | "timeout" | "http" | "network" | "invalid_json" | "api";
  status?: number;
  message: string;
}

export type LoadImageResult = { ok: true; image: LocalImage } | { ok: false; error: PublishError };

/**
 * 读取并校验一张本地图片：必须是**常规文件**、大小在上限内、**magic bytes 是图片**。
 * 三重校验合起来保证不可能把任意本地文件（配置、密钥…）发到公网。
 */
export async function loadLocalImage(path: string, maxBytes: number): Promise<LoadImageResult> {
  let st;
  try {
    st = await stat(path);
  } catch (err) {
    return { ok: false, error: { kind: "not_found", message: `无法读取 ${path}：${err instanceof Error ? err.message : String(err)}` } };
  }
  if (!st.isFile()) {
    return { ok: false, error: { kind: "not_file", message: `${path} 不是常规文件` } };
  }
  if (maxBytes > 0 && st.size > maxBytes) {
    return {
      ok: false,
      error: { kind: "too_large", message: `图片 ${st.size} 字节，超过上限 ${maxBytes} 字节` },
    };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (err) {
    return { ok: false, error: { kind: "not_found", message: `读取失败：${err instanceof Error ? err.message : String(err)}` } };
  }
  const mime = detectImageMime(bytes);
  if (!mime) {
    return { ok: false, error: { kind: "not_image", message: `${path} 不是受支持的图片（jpeg/png/gif/webp/bmp/tiff）` } };
  }
  return { ok: true, image: { path, filename: basename(path) || "image", mime, size: bytes.byteLength, bytes } };
}

export type PublishResult = { ok: true; url: string; latencyMs: number } | { ok: false; error: PublishError };

/** 从 uguu/pomf 的上传响应里取第一个文件 URL（形如 `files[0].url`）。 */
export function extractPublishedUrl(raw: unknown): { url?: string; error?: string } {
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;
  if (typeof o.error === "string" && o.error.length > 0) return { error: o.error };
  if (o.success === false) {
    return { error: typeof o.error === "string" ? o.error : "上传被拒（success=false）" };
  }
  const files = o.files;
  if (!Array.isArray(files)) return {};
  for (const f of files) {
    if (!f || typeof f !== "object") continue;
    const url = (f as Record<string, unknown>).url;
    if (typeof url === "string" && /^https?:\/\//i.test(url)) return { url };
  }
  return {};
}

/**
 * 发布到公网图床（uguu/pomf 协议）。失败不抛裸异常，返回结构化错误。
 * 注意：**成功即代表这张图已公网可见**，调用方要据此给用户提示。
 */
export async function publishImage(
  endpoint: string,
  timeoutMs: number,
  image: LocalImage,
): Promise<PublishResult> {
  const start = Date.now();
  const form = new FormData();
  form.append("files[]", new Blob([image.bytes as BlobPart], { type: image.mime }), image.filename);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      return { ok: false, error: { kind: "http", status: res.status, message: `图床 HTTP ${res.status}` } };
    }
    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      return { ok: false, error: { kind: "invalid_json", message: "图床返回非 JSON" } };
    }
    const { url, error } = extractPublishedUrl(raw);
    if (!url) {
      return { ok: false, error: { kind: "api", message: error ?? "图床响应里没有可用 URL" } };
    }
    return { ok: true, url, latencyMs };
  } catch (err) {
    const aborted = (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";
    return {
      ok: false,
      error: aborted
        ? { kind: "timeout", message: `图床请求超时 (>${timeoutMs}ms)` }
        : { kind: "network", message: err instanceof Error ? err.message : String(err) },
    };
  }
}
