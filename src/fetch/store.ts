/**
 * fetch 产物存储：把"抓到的非文本文件"落盘，返回本地路径 + `/files/<id>` 链接。
 *
 * - id = 内容 sha256（天然幂等 + 去重；全文 64 位 hex，不可猜）
 * - 布局：`<download_dir>/<前2位>/<sha256><ext>` + 同名 `.json` 侧车（记 contentType/sourceUrl）
 * - 清理：TTL（download_ttl_ms）+ 总量配额（download_max_total_bytes，按 mtime LRU）
 *
 * 必须作为**进程级单例**使用（见 server.ts 的 getFetchStore），不要放进每个 MCP 会话。
 */
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  type ReadStream,
} from "node:fs";
import { join } from "node:path";
import type { Logger } from "../logger.js";
import { extForContentType } from "./convert.js";

export interface StoredFile {
  id: string;
  path: string;
  /** 对外的下载路径（绝对 URL 由 service 层按配置拼接）。 */
  url: string;
  size: number;
  contentType: string;
  sourceUrl: string;
  createdAt: number;
  /** 是否命中了已存在的同内容文件（未重复写盘）。 */
  deduped: boolean;
}

export interface StoredFileRef {
  id: string;
  path: string;
  size: number;
  contentType: string;
  ext: string;
}

interface Sidecar {
  contentType: string;
  sourceUrl: string;
  createdAt: number;
  size: number;
  ext: string;
}

const ID_RE = /^[0-9a-f]{64}$/;
const META_SUFFIX = ".json";
/** 触发总量配额后回收到上限的这一比例，避免每来一个文件就触发一轮删除。 */
const GC_KEEP_RATIO = 0.9;

export class FetchStore {
  constructor(
    private readonly dir: string,
    private readonly ttlMs: number,
    private readonly maxTotalBytes: number,
    private readonly logger?: Logger,
  ) {}

  private sidecarPath(subdir: string, id: string): string {
    return join(subdir, `${id}${META_SUFFIX}`);
  }

  private writeSidecar(path: string, meta: Sidecar): void {
    try {
      writeFileSync(path, JSON.stringify(meta));
    } catch (err) {
      this.logger?.warn(`fetch 产物侧车写入失败: ${path} ${String(err)}`);
    }
  }

  /** 落盘；同 sha256 已存在时只刷新 mtime（推迟 TTL 清理）。 */
  put(bytes: Buffer, meta: { contentType: string; sourceUrl: string }): StoredFile {
    const id = createHash("sha256").update(bytes).digest("hex");
    const ext = extForContentType(meta.contentType);
    const subdir = join(this.dir, id.slice(0, 2));
    mkdirSync(subdir, { recursive: true });

    const path = join(subdir, `${id}${ext}`);
    const now = Date.now();
    const deduped = existsSync(path);
    const sidecar: Sidecar = {
      contentType: meta.contentType,
      sourceUrl: meta.sourceUrl,
      createdAt: now,
      size: bytes.length,
      ext,
    };

    if (deduped) {
      try {
        const t = now / 1000;
        utimesSync(path, t, t);
      } catch {
        /* 刷新 mtime 失败不影响可用性 */
      }
      if (!existsSync(this.sidecarPath(subdir, id))) this.writeSidecar(this.sidecarPath(subdir, id), sidecar);
    } else {
      writeFileSync(path, bytes);
      this.writeSidecar(this.sidecarPath(subdir, id), sidecar);
    }

    return {
      id,
      path,
      url: `/files/${id}`,
      size: bytes.length,
      contentType: meta.contentType,
      sourceUrl: meta.sourceUrl,
      createdAt: now,
      deduped,
    };
  }

  /** 按 id 取产物元信息；id 非法、侧车缺失或文件已被清走时返回 undefined。 */
  get(id: string): StoredFileRef | undefined {
    if (!ID_RE.test(id)) return undefined;
    const subdir = join(this.dir, id.slice(0, 2));
    const metaPath = this.sidecarPath(subdir, id);
    if (!existsSync(metaPath)) return undefined;

    let meta: Sidecar;
    try {
      meta = JSON.parse(readFileSync(metaPath, "utf-8")) as Sidecar;
    } catch {
      return undefined;
    }

    const ext = typeof meta.ext === "string" && meta.ext.length > 0 ? meta.ext : ".bin";
    const path = join(subdir, `${id}${ext}`);
    if (!existsSync(path)) return undefined;

    let size = typeof meta.size === "number" ? meta.size : 0;
    try {
      size = statSync(path).size;
    } catch {
      return undefined;
    }

    return {
      id,
      path,
      size,
      contentType: typeof meta.contentType === "string" && meta.contentType.length > 0
        ? meta.contentType
        : "application/octet-stream",
      ext,
    };
  }

  /** 打开只读流（`GET /files/<id>` 用，避免把整个文件读进内存）。 */
  openReadStream(id: string): ReadStream | undefined {
    const ref = this.get(id);
    if (!ref) return undefined;
    return createReadStream(ref.path);
  }

  private removeFile(path: string, metaPath: string): number {
    let size = 0;
    try {
      size = statSync(path).size;
      rmSync(path, { force: true });
    } catch {
      /* 已被清走 */
    }
    try {
      rmSync(metaPath, { force: true });
    } catch {
      /* ignore */
    }
    return size;
  }

  /** TTL + 总量配额清理；返回删除数量与释放字节数。 */
  gc(now: number = Date.now()): { removed: number; freedBytes: number } {
    let subdirs: string[];
    try {
      subdirs = readdirSync(this.dir);
    } catch {
      return { removed: 0, freedBytes: 0 };
    }

    const alive: Array<{ path: string; metaPath: string; size: number; mtimeMs: number }> = [];
    let removed = 0;
    let freedBytes = 0;

    for (const sub of subdirs) {
      const subdir = join(this.dir, sub);
      let files: string[];
      try {
        files = readdirSync(subdir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (f.endsWith(META_SUFFIX)) continue;
        const dot = f.lastIndexOf(".");
        if (dot <= 0) continue;
        const path = join(subdir, f);
        let stat;
        try {
          stat = statSync(path);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;
        const metaPath = this.sidecarPath(subdir, f.slice(0, dot));

        if (now - stat.mtimeMs > this.ttlMs) {
          freedBytes += this.removeFile(path, metaPath);
          removed += 1;
          continue;
        }
        alive.push({ path, metaPath, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }

    let total = alive.reduce((acc, e) => acc + e.size, 0);
    if (total > this.maxTotalBytes) {
      const target = Math.floor(this.maxTotalBytes * GC_KEEP_RATIO);
      // 最旧的先删（LRU）
      alive.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const e of alive) {
        if (total <= target) break;
        const freed = this.removeFile(e.path, e.metaPath);
        total -= freed;
        freedBytes += freed;
        removed += 1;
      }
    }

    if (removed > 0) {
      this.logger?.info(`fetch 产物清理: 删除 ${removed} 个文件，释放 ${(freedBytes / 1024 / 1024).toFixed(1)}MB`);
    }
    return { removed, freedBytes };
  }

  stats(): { files: number; bytes: number } {
    let files = 0;
    let bytes = 0;
    let subdirs: string[];
    try {
      subdirs = readdirSync(this.dir);
    } catch {
      return { files: 0, bytes: 0 };
    }
    for (const sub of subdirs) {
      const subdir = join(this.dir, sub);
      let names: string[];
      try {
        names = readdirSync(subdir);
      } catch {
        continue;
      }
      for (const f of names) {
        if (f.endsWith(META_SUFFIX)) continue;
        try {
          const st = statSync(join(subdir, f));
          if (st.isFile()) {
            files += 1;
            bytes += st.size;
          }
        } catch {
          /* ignore */
        }
      }
    }
    return { files, bytes };
  }
}
