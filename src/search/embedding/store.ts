import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getLoadablePath } from "sqlite-vec";
import type { Logger } from "../../logger.js";
import { distanceToSimilarity, fromVectorBytes, toVectorJson } from "../../utils/vector.js";
import type { CorpusEntry, CorpusHit, Vector } from "./types.js";

/**
 * 本地语料库（磁盘，sqlite-vec）。
 *
 * 实例代表整个库；绑定的「当前命名空间」作为读写默认，库内可并存多个命名空间
 * （模型切换后旧向量保留）。运行时方法同步，不抛异常（put/gc 的事务错误除外）。
 */
export interface CorpusStore {
  /** 当前命名空间：`${provider}:${model}@${dim}`。 */
  readonly namespace: string;

  /** 批量取向量，按 url 建键；仅返回命中的。用于跳过重复嵌入。 */
  get(urls: string[]): Map<string, Vector>;

  /** 写入/更新条目，同 url 覆盖（含向量）。向量维度须与命名空间一致。 */
  put(entries: Array<CorpusEntry & { vec: Vector }>): void;

  /** 相似度召回 top-k，按 similarity 降序。 */
  knn(query: Vector, k: number): CorpusHit[];

  /** TTL 清扫（跨命名空间），返回删除条数。 */
  gc(now: number): number;

  /** 统计：当前命名空间、条数、库内全部命名空间。 */
  stats(): { namespace: string; entries: number; namespaces: string[] };

  /** 释放句柄。 */
  close(): void;
}

export interface CorpusStoreOptions {
  /** sqlite 文件路径（`:memory:` 亦可）。 */
  path: string;
  /** 当前命名空间。 */
  namespace: string;
  /** 向量维度；<=0 表示未知，无法建表。 */
  dim: number;
  /** 条目存活毫秒数。 */
  ttlMs: number;
}

/** 命名空间 → vec0 表名（hash 规避非法字符）。 */
function tableFor(namespace: string): string {
  return "vec_" + createHash("sha1").update(namespace).digest("hex").slice(0, 16);
}

function placeholders(n: number): string {
  return new Array(n).fill("?").join(",");
}

interface MetaRow {
  url: string;
  title: string;
  content: string;
  fetched_at: number;
}

/**
 * 创建语料库；维度未知（dim<=0）时返回 null。
 * 扩展加载或建表失败抛异常，由调用方决定降级。
 */
export function createCorpusStore(opts: CorpusStoreOptions, logger?: Logger): CorpusStore | null {
  if (opts.dim <= 0) {
    logger?.warn("语料库未创建：维度未知 (dim<=0)");
    return null;
  }

  const dir = dirname(opts.path);
  if (dir && dir !== ".") mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(opts.path, { allowExtension: true });
  db.loadExtension(getLoadablePath());

  db.exec("CREATE TABLE IF NOT EXISTS corpus_ns(name TEXT PRIMARY KEY, created_at INTEGER NOT NULL)");
  db.exec(
    `CREATE TABLE IF NOT EXISTS corpus_meta(
       namespace TEXT NOT NULL,
       url TEXT NOT NULL,
       title TEXT NOT NULL,
       content TEXT NOT NULL,
       fetched_at INTEGER NOT NULL,
       expires_at INTEGER NOT NULL,
       PRIMARY KEY(namespace, url)
     )`,
  );
  const vecTable = tableFor(opts.namespace);
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${vecTable} USING vec0(
       url TEXT PRIMARY KEY,
       embedding FLOAT[${opts.dim}] distance_metric=cosine
     )`,
  );
  db.prepare("INSERT OR IGNORE INTO corpus_ns(name, created_at) VALUES(?, ?)").run(opts.namespace, Date.now());

  const metaPut = db.prepare(
    `INSERT INTO corpus_meta(namespace, url, title, content, fetched_at, expires_at)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(namespace, url) DO UPDATE SET
       title=excluded.title, content=excluded.content,
       fetched_at=excluded.fetched_at, expires_at=excluded.expires_at`,
  );
  const vecDel = db.prepare(`DELETE FROM ${vecTable} WHERE url = ?`);
  const vecIns = db.prepare(`INSERT INTO ${vecTable}(url, embedding) VALUES(?, ?)`);
  const knnStmt = db.prepare(`SELECT url, distance FROM ${vecTable} WHERE embedding MATCH ? ORDER BY distance LIMIT ?`);
  const delMeta = db.prepare("DELETE FROM corpus_meta WHERE namespace = ? AND url = ?");

  return {
    namespace: opts.namespace,

    get(urls: string[]): Map<string, Vector> {
      const out = new Map<string, Vector>();
      if (urls.length === 0) return out;
      const rows = db
        .prepare(`SELECT url, embedding FROM ${vecTable} WHERE url IN (${placeholders(urls.length)})`)
        .all(...urls) as Array<{ url: string; embedding: Uint8Array }>;
      for (const r of rows) out.set(r.url, fromVectorBytes(r.embedding));
      return out;
    },

    put(entries: Array<CorpusEntry & { vec: Vector }>): void {
      if (entries.length === 0) return;
      const expires = Date.now() + opts.ttlMs;
      db.exec("BEGIN");
      try {
        for (const e of entries) {
          metaPut.run(opts.namespace, e.url, e.title, e.content, e.fetchedAt, expires);
          vecDel.run(e.url);
          vecIns.run(e.url, toVectorJson(e.vec));
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },

    knn(query: Vector, k: number): CorpusHit[] {
      if (k <= 0) return [];
      const rows = knnStmt.all(toVectorJson(query), k) as Array<{ url: string; distance: number }>;
      if (rows.length === 0) return [];
      const urls = rows.map((r) => r.url);
      const metaRows = db
        .prepare(
          `SELECT url, title, content, fetched_at FROM corpus_meta
           WHERE namespace = ? AND url IN (${placeholders(urls.length)})`,
        )
        .all(opts.namespace, ...urls) as unknown as MetaRow[];
      const meta = new Map(metaRows.map((m) => [m.url, m]));
      const hits: CorpusHit[] = [];
      for (const r of rows) {
        const m = meta.get(r.url);
        if (!m) continue;
        hits.push({
          entry: { url: m.url, title: m.title, content: m.content, fetchedAt: m.fetched_at },
          similarity: distanceToSimilarity(r.distance),
        });
      }
      return hits;
    },

    gc(now: number): number {
      const expired = db
        .prepare("SELECT namespace, url FROM corpus_meta WHERE expires_at <= ?")
        .all(now) as Array<{ namespace: string; url: string }>;
      if (expired.length === 0) return 0;
      db.exec("BEGIN");
      try {
        for (const e of expired) {
          delMeta.run(e.namespace, e.url);
          const table = tableFor(e.namespace);
          try {
            db.prepare(`DELETE FROM ${table} WHERE url = ?`).run(e.url);
          } catch {
            // 命名空间表可能尚未创建，忽略
          }
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return expired.length;
    },

    stats(): { namespace: string; entries: number; namespaces: string[] } {
      const entries = (db.prepare("SELECT count(*) AS c FROM corpus_meta WHERE namespace = ?").get(opts.namespace) as { c: number }).c;
      const namespaces = (db.prepare("SELECT name FROM corpus_ns").all() as Array<{ name: string }>).map((r) => r.name);
      return { namespace: opts.namespace, entries, namespaces };
    },

    close(): void {
      db.close();
    },
  };
}
