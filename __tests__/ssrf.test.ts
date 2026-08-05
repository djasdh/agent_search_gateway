import { describe, expect, it } from "vitest";
import { isPrivateHost, isPrivateIp } from "../src/fetch/ssrf.js";

describe("isPrivateIp", () => {
  const priv = [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.5.5",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.1.1",
    "::1",
    "fc00::1",
    "fe80::1",
  ];
  const pub = [
    "93.184.216.34",
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1", // 172.32 不在 172.16/12 内
    "198.18.0.136",
    "2606:4700::6810:84e5",
  ];

  it("私有 IP 判定为私有", () => {
    for (const ip of priv) expect(isPrivateIp(ip), ip).toBe(true);
  });

  it("公网 IP 判定为非私有", () => {
    for (const ip of pub) expect(isPrivateIp(ip), ip).toBe(false);
  });
});

describe("isPrivateHost", () => {
  it("localhost 视为私有", async () => {
    expect(await isPrivateHost("localhost")).toBe(true);
  });

  it("IP 字面量主机判定", async () => {
    expect(await isPrivateHost("127.0.0.1")).toBe(true);
    expect(await isPrivateHost("8.8.8.8")).toBe(false);
  });
});
