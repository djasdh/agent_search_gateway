/** 直链下载：白名单 + SSRF + 体积上限 + 并发闸。返回整块 bytes，交给 fetch 落盘。 */

import type { GatewayConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { assertPublicHttpUrl } from "../fetch/ssrf.js";
import { BiliError, type BiliStream } from "./types.js";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

class Gate {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
  }
  release(): void {
    this.active--;
    this.waiters.shift()?.();
  }
}

const gates = new Map<number, Gate>();
const gateFor = (n: number): Gate => {
  const size = Math.max(1, Math.floor(n));
  let gate = gates.get(size);
  if (!gate) gates.set(size, (gate = new Gate(size)));
  return gate;
};

function allowedHost(hostname: string, suffixes: string[]): boolean {
  const host = hostname.toLowerCase();
  return suffixes.some((raw) => {
    const suffix = raw.trim().toLowerCase();
    return suffix !== "" && (host === suffix || host.endsWith(`.${suffix}`));
  });
}

function tooLarge(limit: number, actual: number): BiliError {
  return new BiliError(
    "BILI_DOWNLOAD_FAIL",
    `文件超过上限 ${(limit / 1024 / 1024).toFixed(1)}MB（实际 ${(actual / 1024 / 1024).toFixed(1)}MB）`,
    "调大 bilibili.download.max_bytes 或 fetch.max_download_bytes",
  );
}

export async function downloadStream(
  stream: BiliStream,
  config: GatewayConfig,
  logger?: Logger,
): Promise<{ bytes: Buffer; contentType: string }> {
  const conf = config.bilibili.download;
  const target = new URL(stream.url);
  const check = await assertPublicHttpUrl(stream.url, {
    enabled: !conf.allowPrivateCdn,
    exemptCidrs: config.fetchPrivateIpExemptCidrs,
  });
  if (!check.ok) throw new BiliError("BILI_INVALID_URL", `拒绝下载：${check.reason ?? "URL 非法"}`);
  if (!allowedHost(target.hostname, conf.allowedHosts)) {
    throw new BiliError("BILI_INVALID_URL", `拒绝下载：主机不在白名单（${target.hostname}）`);
  }

  const limit = Math.max(1, Math.min(conf.maxBytes, config.fetchMaxDownloadBytes));
  const gate = gateFor(conf.maxConcurrent);
  await gate.acquire();
  try {
    const res = await fetch(target, {
      headers: { "User-Agent": UA, Referer: "https://www.bilibili.com/" },
      redirect: "follow",
      signal: AbortSignal.timeout(conf.timeoutMs),
    });
    if (res.status === 403 || res.status === 412) {
      await res.body?.cancel().catch(() => {});
      throw new BiliError("BILI_RISK_CONTROL", `CDN 返回 HTTP ${res.status}`, "稍后重试或更换网络出口");
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new BiliError("BILI_DOWNLOAD_FAIL", `CDN 返回 HTTP ${res.status}`);
    }
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limit) throw tooLarge(limit, declared);

    const reader = res.body?.getReader();
    if (!reader) {
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > limit) throw tooLarge(limit, bytes.length);
      return { bytes, contentType: stream.contentType };
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw tooLarge(limit, total);
      }
      chunks.push(Buffer.from(value));
    }
    logger?.debug(`bilibili download: ${target.hostname} ${total} bytes`);
    return { bytes: Buffer.concat(chunks, total), contentType: stream.contentType };
  } catch (err) {
    if (err instanceof BiliError) throw err;
    const text = err instanceof Error ? err.message : String(err);
    throw new BiliError("BILI_DOWNLOAD_FAIL", `下载失败：${text}`);
  } finally {
    gate.release();
  }
}
