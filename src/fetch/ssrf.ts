import { lookup } from "node:dns/promises";

const PRIVATE_CIDRS = [
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "0.0.0.0/8",
  "100.64.0.0/10",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
];

function ipToBigInt(ip: string): bigint | null {
  // 支持 IPv4 和 IPv6
  if (ip.includes(".") && !ip.includes(":")) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return null;
    return (
      (BigInt(parts[0]) << 24n) |
      (BigInt(parts[1]) << 16n) |
      (BigInt(parts[2]) << 8n) |
      BigInt(parts[3])
    );
  }
  if (ip.includes(":")) {
    const addr = ip.replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
    const groups = addr.split("::");
    const left = groups[0] ? groups[0].split(":") : [];
    const right = groups.length > 1 && groups[1] ? groups[1].split(":") : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    const full = [...left, ...Array(missing).fill("0"), ...right];
    if (full.length !== 8) return null;
    let n = 0n;
    for (const g of full) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      n = (n << 16n) | BigInt(parseInt(g, 16));
    }
    return n;
  }
  return null;
}

function ipInCidr(ip: string, cidr: string): boolean {
  const [net, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  if (Number.isNaN(bits) || bits < 0 || bits > 128) return false;
  const addr = ipToBigInt(ip);
  const netAddr = ipToBigInt(net);
  if (addr === null || netAddr === null) return false;

  const isV4 = net.includes(".");
  const maxBits = isV4 ? 32 : 128;
  if (bits > maxBits) return false;

  const mask =
    bits === 0
      ? 0n
      : (BigInt("0xffffffffffffffffffffffffffffffff") << BigInt(maxBits - bits)) &
        BigInt(isV4 ? "0xffffffff" : "0xffffffffffffffffffffffffffffffff");
  return (addr & mask) === (netAddr & mask);
}

function isPrivateIp(ip: string): boolean {
  const normalized = ip.replace(/^\[|\]$/g, "").split("%")[0];
  if (normalized === "::1") return true;
  return PRIVATE_CIDRS.some((cidr) => ipInCidr(normalized, cidr));
}

/** 解析 hostname 的所有 A/AAAA 记录，任一为私网 IP 即视为私有（SSRF 防护）。 */
export async function isPrivateHost(hostname: string): Promise<boolean> {
  if (hostname === "localhost") return true;
  try {
    const records = await lookup(hostname, { all: true });
    return records.some((r) => isPrivateIp(r.address));
  } catch {
    // 解析失败：保守起见视为不可解析（由调用方决定）
    return false;
  }
}

export { isPrivateIp };
