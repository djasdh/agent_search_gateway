import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { getHealth } from "../src/health.js";
import type { HealthSettings } from "../src/health.js";
import { healthDeps, makeSettings } from "./helpers/settings.js";

const MOCK = {
  up: createHttpServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><body>ok</body></html>");
  }),
  down: createHttpServer((_req, res) => {
    res.destroy(); // 模拟不可达
  }),
};

let upPort = 0;
let downPort = 0;

beforeAll(async () => {
  await new Promise<void>((r) => MOCK.up.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => MOCK.down.listen(0, "127.0.0.1", r));
  upPort = (MOCK.up.address() as AddressInfo).port;
  downPort = (MOCK.down.address() as AddressInfo).port;
});

afterAll(async () => {
  MOCK.up.close();
  MOCK.down.close();
});

function makeConfig(searxngPort: number, fsPort: number): HealthSettings {
  return healthDeps(
    makeSettings({
      searxng: { url: `http://127.0.0.1:${searxngPort}` },
      flaresolverr: { url: `http://127.0.0.1:${fsPort}` },
    }),
  );
}

describe("getHealth", () => {
  it("两后端均 up 时报告 up", async () => {
    const h = await getHealth(makeConfig(upPort, upPort), Date.now());
    expect(h.searxng.status).toBe("up");
    expect(h.flaresolverr.status).toBe("up");
    expect(h.gateway.uptimeSec).toBeGreaterThanOrEqual(0);
  });

  it("后端不可达时报告 down 且带错误信息", async () => {
    const h = await getHealth(makeConfig(downPort, downPort), Date.now());
    expect(h.searxng.status).toBe("down");
    expect(h.flaresolverr.status).toBe("down");
    expect(h.searxng.error).toBeTruthy();
  });

  it("混合情况分别报告", async () => {
    const h = await getHealth(makeConfig(upPort, downPort), Date.now());
    expect(h.searxng.status).toBe("up");
    expect(h.flaresolverr.status).toBe("down");
  });
});
