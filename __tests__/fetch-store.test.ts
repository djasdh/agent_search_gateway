import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FetchStore } from "../src/fetch/store.js";

const tmpDirs: string[] = [];

function tmpStore(opts: { ttlMs?: number; maxTotalBytes?: number } = {}): { dir: string; store: FetchStore } {
  const dir = mkdtempSync(join(tmpdir(), "fetch-store-"));
  tmpDirs.push(dir);
  return {
    dir,
    store: new FetchStore(dir, opts.ttlMs ?? 604800000, opts.maxTotalBytes ?? 1 << 30),
  };
}

function countFiles(dir: string): number {
  let n = 0;
  for (const sub of readdirSync(dir)) {
    for (const f of readdirSync(join(dir, sub))) {
      if (!f.endsWith(".json")) n += 1;
    }
  }
  return n;
}

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("FetchStore", () => {
  const meta = { contentType: "image/png", sourceUrl: "https://example.com/a.png" };

  it("put 落盘并可按 id 取回", () => {
    const { store } = tmpStore();
    const buf = Buffer.from("hello-bytes");
    const f = store.put(buf, meta);

    expect(f.id).toMatch(/^[0-9a-f]{64}$/);
    expect(f.size).toBe(buf.length);
    expect(f.deduped).toBe(false);
    expect(f.url).toBe(`/files/${f.id}`);
    expect(existsSync(f.path)).toBe(true);

    const ref = store.get(f.id);
    expect(ref).not.toBeUndefined();
    expect(ref!.contentType).toBe("image/png");
    expect(ref!.size).toBe(buf.length);
    expect(ref!.ext).toBe(".png");
  });

  it("同内容幂等：deduped=true 且不新增文件", () => {
    const { dir, store } = tmpStore();
    const buf = Buffer.from("same-content");
    const a = store.put(buf, meta);
    const b = store.put(buf, meta);
    expect(a.id).toBe(b.id);
    expect(b.deduped).toBe(true);
    expect(countFiles(dir)).toBe(1);
  });

  it("id 非法 / 不存在时 get 返回 undefined", () => {
    const { store } = tmpStore();
    expect(store.get("../../etc/passwd")).toBeUndefined();
    expect(store.get("0".repeat(64))).toBeUndefined();
    expect(store.openReadStream("../x")).toBeUndefined();
  });

  it("TTL 到期被 gc 清走（含侧车）", () => {
    const { dir, store } = tmpStore({ ttlMs: 1000 });
    const f = store.put(Buffer.from("expire-me"), meta);
    // 把 mtime 拨到 2 小时前
    const old = (Date.now() - 7200_000) / 1000;
    utimesSync(f.path, old, old);

    const r = store.gc(Date.now());
    expect(r.removed).toBe(1);
    expect(existsSync(f.path)).toBe(false);
    expect(store.get(f.id)).toBeUndefined();
    expect(countFiles(dir)).toBe(0);
  });

  it("总量超配额时按最旧优先清理", () => {
    const { store } = tmpStore({ maxTotalBytes: 30, ttlMs: 604800000 });
    const older = store.put(Buffer.alloc(20, 1), meta);
    const newer = store.put(Buffer.alloc(20, 2), meta);

    const old = (Date.now() - 3600_000) / 1000;
    utimesSync(older.path, old, old);

    const r = store.gc(Date.now());
    expect(r.removed).toBeGreaterThanOrEqual(1);
    expect(store.get(older.id)).toBeUndefined();
    expect(store.get(newer.id)).not.toBeUndefined();
  });

  it("stats 汇总文件数与字节数", () => {
    const { store } = tmpStore();
    store.put(Buffer.alloc(10), meta);
    store.put(Buffer.alloc(20), meta);
    const s = store.stats();
    expect(s.files).toBe(2);
    expect(s.bytes).toBe(30);
  });
});
