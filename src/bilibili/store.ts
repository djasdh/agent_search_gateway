/** 评论本地库（node:sqlite）：落库、楼中楼展开、断点、FTS/LIKE 检索。 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Logger } from "../logger.js";
import type { BiliComment, BiliCommentStore } from "./types.js";

interface Row {
  rpid: number;
  root: number | null;
  parent: number | null;
  mid: number;
  uname: string;
  content: string;
  like_count: number;
  ctime: number;
}

interface Flat extends Row {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bili_comment (
  bvid TEXT NOT NULL, rpid INTEGER NOT NULL, root INTEGER, parent INTEGER,
  mid INTEGER NOT NULL DEFAULT 0, uname TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '', like_count INTEGER NOT NULL DEFAULT 0,
  ctime INTEGER NOT NULL DEFAULT 0, page INTEGER NOT NULL DEFAULT 0,
  fetched_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (bvid, rpid)
);
CREATE INDEX IF NOT EXISTS idx_bili_comment_like ON bili_comment(bvid, like_count DESC);
CREATE TABLE IF NOT EXISTS bili_comment_sync (
  bvid TEXT PRIMARY KEY, next_page INTEGER NOT NULL DEFAULT 1,
  finished INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
);`;

const n = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const s = (v: unknown): string => (typeof v === "string" ? v : "");

function fromRow(row: Row): BiliComment {
  return {
    rpid: n(row.rpid),
    root: row.root ?? undefined,
    parent: row.parent ?? undefined,
    mid: n(row.mid),
    uname: s(row.uname),
    content: s(row.content),
    like: n(row.like_count),
    ctime: n(row.ctime),
  };
}

function flatten(items: BiliComment[], root: number | undefined, parent: number | undefined, out: Flat[]): void {
  for (const item of items) {
    const rpid = n(item.rpid);
    if (rpid <= 0) continue;
    const ownRoot = (item.root as number | null | undefined) || root || rpid;
    const ownParent = (item.parent as number | null | undefined) || parent || null;
    out.push({
      rpid,
      root: ownRoot,
      parent: ownParent,
      mid: n(item.mid),
      uname: s(item.uname),
      content: s(item.content),
      like_count: n(item.like),
      ctime: n(item.ctime),
    });
    if (item.replies?.length) flatten(item.replies, ownRoot, rpid, out);
  }
}

const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);

export function createCommentStore(path: string, logger?: Logger): BiliCommentStore {
  if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(SCHEMA);

  const upsert = db.prepare(`
    INSERT INTO bili_comment
      (bvid,rpid,root,parent,mid,uname,content,like_count,ctime,page,fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(bvid,rpid) DO UPDATE SET
      root=excluded.root, parent=excluded.parent, mid=excluded.mid, uname=excluded.uname,
      content=excluded.content, like_count=excluded.like_count, ctime=excluded.ctime,
      page=excluded.page, fetched_at=excluded.fetched_at`);
  const upsertSync = db.prepare(`
    INSERT INTO bili_comment_sync (bvid,next_page,finished,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(bvid) DO UPDATE SET
      next_page=MAX(bili_comment_sync.next_page,excluded.next_page),
      finished=excluded.finished, updated_at=excluded.updated_at`);

  logger?.debug("bilibili: 评论库使用 LIKE 检索（中文无需分词）");

  return {
    upsertPage({ bvid, page, items, hasMore }) {
      const rows: Flat[] = [];
      flatten(items, undefined, undefined, rows);
      const now = Date.now();
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const c of rows) {
          upsert.run(bvid, c.rpid, c.root, c.parent, c.mid, c.uname, c.content, c.like_count, c.ctime, page, now);
        }
        upsertSync.run(bvid, hasMore ? page + 1 : page, hasMore ? 0 : 1, now);
        db.exec("COMMIT");
      } catch (err) {
        try { db.exec("ROLLBACK"); } catch { /* 已自动回滚 */ }
        throw err;
      }
    },

    syncState(bvid) {
      const row = db.prepare("SELECT next_page, finished FROM bili_comment_sync WHERE bvid=?").get(bvid);
      return row ? { nextPage: n(row.next_page, 1), finished: n(row.finished) === 1 } : { nextPage: 1, finished: false };
    },

    search(bvid, keyword, opts = {}) {
      const kw = keyword.trim();
      if (!kw) return [];
      const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
      const mid = opts.mid && opts.mid > 0 ? opts.mid : undefined;
      const sql = `SELECT * FROM bili_comment WHERE bvid=? AND content LIKE ? ESCAPE '\\'${mid ? " AND mid=?" : ""}
        ORDER BY like_count DESC, rpid DESC LIMIT ?`;
      const rows = db.prepare(sql).all(bvid, `%${escapeLike(kw)}%`, ...(mid ? [mid] : []), limit) as unknown as Row[];
      return rows.map(fromRow);
    },

    count(bvid) {
      return n(db.prepare("SELECT COUNT(*) AS n FROM bili_comment WHERE bvid=?").get(bvid)?.n);
    },

    close() {
      db.close();
    },
  };
}
