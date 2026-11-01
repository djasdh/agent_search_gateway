/**
 * Bilibili 评论本地库（node:sqlite）。
 *
 * 评论动作先落库、再按需检索：`comments` 负责增量拉取并 upsert，
 * `comments_search` 只查本地库（不触发网络）。表结构刻意保持扁平，
 * 楼中楼通过 root/parent 还原层级；FTS5 可用时加速检索，不可用时降级 LIKE。
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Logger } from "../logger.js";
import type { BiliComment, BiliCommentStore } from "./types.js";

type Row = Record<string, unknown>;

const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 500;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bili_comment (
  bvid       TEXT    NOT NULL,
  rpid       INTEGER NOT NULL,
  root       INTEGER,
  parent     INTEGER,
  mid        INTEGER NOT NULL DEFAULT 0,
  uname      TEXT    NOT NULL DEFAULT '',
  content    TEXT    NOT NULL DEFAULT '',
  like_count INTEGER NOT NULL DEFAULT 0,
  ctime      INTEGER NOT NULL DEFAULT 0,
  page       INTEGER NOT NULL DEFAULT 1,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (bvid, rpid)
);
CREATE INDEX IF NOT EXISTS idx_bili_comment_bvid_like
  ON bili_comment (bvid, like_count DESC);
CREATE TABLE IF NOT EXISTS bili_comment_sync (
  bvid      TEXT PRIMARY KEY,
  next_page INTEGER NOT NULL DEFAULT 1,
  finished  INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
`;

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS bili_comment_fts USING fts5(content);
CREATE TRIGGER IF NOT EXISTS bili_comment_ai AFTER INSERT ON bili_comment BEGIN
  INSERT INTO bili_comment_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS bili_comment_ad AFTER DELETE ON bili_comment BEGIN
  INSERT INTO bili_comment_fts(bili_comment_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS bili_comment_au AFTER UPDATE ON bili_comment BEGIN
  INSERT INTO bili_comment_fts(bili_comment_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
  INSERT INTO bili_comment_fts(rowid, content) VALUES (new.rowid, new.content);
END;
`;

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

/** 正数才视为有效 ID（B 站接口用 0 表示"无"）。 */
function positiveOr(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function rowToComment(row: Row): BiliComment {
  const root = row.root;
  const parent = row.parent;
  return {
    rpid: toNumber(row.rpid),
    root: root === null || root === undefined ? undefined : toNumber(root),
    parent: parent === null || parent === undefined ? undefined : toNumber(parent),
    mid: toNumber(row.mid),
    uname: toText(row.uname),
    content: toText(row.content),
    like: toNumber(row.like_count),
    ctime: toNumber(row.ctime),
  };
}

/** 转义 LIKE 通配符，避免用户输入 `%` / `_` 变成模糊匹配。 */
function escapeLike(keyword: string): string {
  return keyword.replace(/[\\%_]/g, (m) => `\\${m}`);
}

interface FlatComment {
  rpid: number;
  root: number | null;
  parent: number | null;
  mid: number;
  uname: string;
  content: string;
  like: number;
  ctime: number;
}

/** 递归展开 items 与 replies；顶层 root 缺省时用自身 rpid。 */
function flattenComments(
  items: BiliComment[],
  inheritedRoot: number | undefined,
  inheritedParent: number | undefined,
  out: FlatComment[],
): void {
  for (const item of items) {
    const rpid = toNumber(item.rpid);
    if (rpid <= 0) continue;

    const root = positiveOr(item.root, inheritedRoot ?? rpid);
    const parent = positiveOr(item.parent, inheritedParent ?? 0) || null;

    out.push({
      rpid,
      root,
      parent,
      mid: toNumber(item.mid),
      uname: toText(item.uname),
      content: toText(item.content),
      like: toNumber(item.like),
      ctime: toNumber(item.ctime),
    });

    if (item.replies && item.replies.length > 0) {
      flattenComments(item.replies, root, rpid, out);
    }
  }
}

export function createCommentStore(path: string, logger?: Logger): BiliCommentStore {
  if (path !== ":memory:") {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }

  const db = new DatabaseSync(path);
  let closed = false;

  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec(SCHEMA);

  const upsertComment = db.prepare(`
    INSERT INTO bili_comment
      (bvid, rpid, root, parent, mid, uname, content, like_count, ctime, page, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(bvid, rpid) DO UPDATE SET
      root       = excluded.root,
      parent     = excluded.parent,
      mid        = excluded.mid,
      uname      = excluded.uname,
      content    = excluded.content,
      like_count = excluded.like_count,
      ctime      = excluded.ctime,
      page       = excluded.page,
      fetched_at = excluded.fetched_at
  `);

  const upsertSync = db.prepare(`
    INSERT INTO bili_comment_sync (bvid, next_page, finished, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(bvid) DO UPDATE SET
      next_page  = MAX(bili_comment_sync.next_page, excluded.next_page),
      finished   = excluded.finished,
      updated_at = excluded.updated_at
  `);

  // FTS5 并非所有 SQLite 构建都带；失败时只影响检索性能，不影响落库。
  let ftsEnabled = true;
  try {
    db.exec(FTS_SCHEMA);
    // 老库（先有数据后建 FTS）补一遍索引
    db.exec(`
      INSERT INTO bili_comment_fts(rowid, content)
      SELECT rowid, content FROM bili_comment
      WHERE rowid NOT IN (SELECT rowid FROM bili_comment_fts)
    `);
  } catch (err) {
    ftsEnabled = false;
    logger?.debug(`bilibili: FTS5 不可用，检索降级 LIKE（${err instanceof Error ? err.message : String(err)}）`);
  }

  function upsertPage(input: { bvid: string; page: number; items: BiliComment[]; hasMore: boolean }): void {
    const flat: FlatComment[] = [];
    flattenComments(input.items, undefined, undefined, flat);

    const now = Date.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const c of flat) {
        upsertComment.run(
          input.bvid,
          c.rpid,
          c.root,
          c.parent,
          c.mid,
          c.uname,
          c.content,
          c.like,
          c.ctime,
          input.page,
          now,
        );
      }
      const nextPage = input.hasMore ? input.page + 1 : input.page;
      upsertSync.run(input.bvid, nextPage, input.hasMore ? 0 : 1, now);
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* 事务可能已自动回滚 */
      }
      throw err;
    }
  }

  function syncState(bvid: string): { nextPage: number; finished: boolean } {
    const row = db
      .prepare("SELECT next_page, finished FROM bili_comment_sync WHERE bvid = ?")
      .get(bvid);
    if (!row) return { nextPage: 1, finished: false };
    return { nextPage: toNumber(row.next_page, 1), finished: toNumber(row.finished) === 1 };
  }

  function search(
    bvid: string,
    keyword: string,
    opts: { mid?: number; limit?: number } = {},
  ): BiliComment[] {
    const kw = keyword.trim();
    if (kw === "") return [];

    const limit = Math.min(
      Math.max(opts.limit ?? DEFAULT_SEARCH_LIMIT, 1),
      MAX_SEARCH_LIMIT,
    );
    const mid = opts.mid !== undefined && opts.mid > 0 ? opts.mid : undefined;

    const rows: Row[] = [];

    if (ftsEnabled) {
      try {
        // 短语查询：转义内部双引号，避免用户输入当成 FTS 语法
        const pattern = `"${kw.replace(/"/g, '""')}"`;
        const sql = [
          "SELECT c.* FROM bili_comment_fts",
          "JOIN bili_comment c ON c.rowid = bili_comment_fts.rowid",
          "WHERE bili_comment_fts MATCH ? AND c.bvid = ?",
          mid !== undefined ? "AND c.mid = ?" : "",
          "ORDER BY c.like_count DESC, c.rpid DESC LIMIT ?",
        ]
          .filter(Boolean)
          .join(" ");
        const params: (string | number)[] = [pattern, bvid];
        if (mid !== undefined) params.push(mid);
        params.push(limit);
        rows.push(...(db.prepare(sql).all(...params) as Row[]));
      } catch (err) {
        // 部分 FTS 实现对中文/特殊字符查询会报错；直接降级到 LIKE 并记住
        ftsEnabled = false;
        logger?.debug(`bilibili: FTS 查询失败，降级 LIKE（${err instanceof Error ? err.message : String(err)}）`);
      }
    }

    if (rows.length < limit) {
      const sql = [
        "SELECT * FROM bili_comment",
        "WHERE bvid = ? AND content LIKE ? ESCAPE '\\'",
        mid !== undefined ? "AND mid = ?" : "",
        "ORDER BY like_count DESC, rpid DESC LIMIT ?",
      ]
        .filter(Boolean)
        .join(" ");
      const params: (string | number)[] = [bvid, `%${escapeLike(kw)}%`];
      if (mid !== undefined) params.push(mid);
      params.push(limit);
      rows.push(...(db.prepare(sql).all(...params) as Row[]));
    }

    // FTS 与 LIKE 可能重复命中，按 rpid 去重后统一按点赞数排序
    const seen = new Set<number>();
    const merged: BiliComment[] = [];
    for (const row of rows) {
      const comment = rowToComment(row);
      if (seen.has(comment.rpid)) continue;
      seen.add(comment.rpid);
      merged.push(comment);
    }
    merged.sort((a, b) => b.like - a.like || b.rpid - a.rpid);
    return merged.slice(0, limit);
  }

  function count(bvid: string): number {
    const row = db.prepare("SELECT COUNT(*) AS n FROM bili_comment WHERE bvid = ?").get(bvid);
    return row ? toNumber(row.n) : 0;
  }

  function close(): void {
    if (closed) return;
    closed = true;
    db.close();
  }

  return { upsertPage, syncState, search, count, close };
}
