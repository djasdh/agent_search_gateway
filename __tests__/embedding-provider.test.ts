import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmbeddingProvider, type EmbeddingProviderOptions } from "../src/search/embedding/provider.js";
import { profileFor, resolvePrefixes } from "../src/search/embedding/profiles.js";

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const openaiOpts: EmbeddingProviderOptions = {
  provider: "openai",
  baseUrl: "http://embed.local/v1/",
  apiKey: "k",
  model: "text-embedding-3-small",
  dim: 0,
  timeoutMs: 1000,
  batchSize: 2,
  maxInputChars: 1000,
};

interface Captured {
  url: string;
  body: { model?: string; input?: string[] };
}

/** 记录请求并回显：每条输入按其长度生成向量，index 与输入序号一致。 */
function stubEchoFetch(): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body });
      const inputs: string[] = body.input;
      return jsonResponse({ data: inputs.map((t, i) => ({ index: i, embedding: [t.length + 1, 0] })) });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("EmbeddingProvider (openai)", () => {
  it("解析 data，按 index 排序，归一化，并打对端点", async () => {
    const calls: Captured[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body: string }) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return jsonResponse({
          data: [
            { index: 1, embedding: [0, 2] },
            { index: 0, embedding: [3, 0] },
          ],
        });
      }),
    );
    const p = createEmbeddingProvider(openaiOpts);
    const r = await p.embed(["a", "b"], "passage");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dim).toBe(2);
    expect(Array.from(r.vectors[0])).toEqual([1, 0]);
    expect(Array.from(r.vectors[1])).toEqual([0, 1]);
    expect(calls[0].url).toBe("http://embed.local/v1/embeddings");
    expect(calls[0].body.model).toBe("text-embedding-3-small");
  });

  it("批次拆分后顺序保持", async () => {
    const calls = stubEchoFetch();
    const p = createEmbeddingProvider({ ...openaiOpts, batchSize: 2 });
    const r = await p.embed(["a", "bb", "ccc"], "passage");
    expect(calls).toHaveLength(2);
    expect(calls[0].body.input).toEqual(["a", "bb"]);
    expect(calls[1].body.input).toEqual(["ccc"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.vectors.map((v) => v.length)).toEqual([2, 2, 2]);
  });

  it("空输入不发请求", async () => {
    const calls = stubEchoFetch();
    const p = createEmbeddingProvider(openaiOpts);
    const r = await p.embed([], "query");
    expect(r).toEqual({ ok: true, vectors: [], dim: 0 });
    expect(calls).toHaveLength(0);
  });

  it("dim=0 时由首次调用解析维度", async () => {
    stubEchoFetch();
    const p = createEmbeddingProvider(openaiOpts);
    expect(await p.dim()).toBe(2);
  });

  it("维度不一致返回 dim_mismatch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: [{ embedding: [1, 0] }] })));
    const p = createEmbeddingProvider({ ...openaiOpts, dim: 4 });
    const r = await p.embed(["a"], "passage");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("dim_mismatch");
  });

  it("maxInputChars 截断", async () => {
    const calls = stubEchoFetch();
    const p = createEmbeddingProvider({ ...openaiOpts, maxInputChars: 3 });
    await p.embed(["abcdef"], "passage");
    expect(calls[0].body.input).toEqual(["abc"]);
  });
});

describe("EmbeddingProvider 批次并发", () => {
  it("并发受限（maxInFlight≤concurrency）且结果与串行逐元素一致（顺序保持）", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const inputs: string[] = JSON.parse(init.body).input;
        await new Promise((r) => setTimeout(r, 15));
        inFlight--;
        return jsonResponse({ data: inputs.map((t, i) => ({ index: i, embedding: [t.charCodeAt(0), 1] })) });
      }),
    );
    const texts = ["a", "b", "c", "d", "e"];
    const serial = await createEmbeddingProvider({ ...openaiOpts, batchSize: 1, concurrency: 1 }).embed(
      texts,
      "passage",
    );
    const parallel = await createEmbeddingProvider({ ...openaiOpts, batchSize: 1, concurrency: 2 }).embed(
      texts,
      "passage",
    );
    expect(serial.ok && parallel.ok).toBe(true);
    if (!serial.ok || !parallel.ok) return;
    expect(parallel.batches).toBe(5);
    // 并发回填后顺序与串行完全一致
    expect(parallel.vectors.map((v) => Array.from(v))).toEqual(serial.vectors.map((v) => Array.from(v)));
    // 串行阶段峰值 1，并发阶段（上限 2）达到 2
    expect(maxInFlight).toBe(2);
  });

  it("默认并发下批次结果顺序仍与入参一致", async () => {
    const calls = stubEchoFetch();
    const p = createEmbeddingProvider({ ...openaiOpts, batchSize: 2 });
    const r = await p.embed(["a", "bb", "ccc"], "passage");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.batches).toBe(2);
    expect(calls[0].body.input).toEqual(["a", "bb"]);
    expect(calls[1].body.input).toEqual(["ccc"]);
  });

  it("任一批失败 → 整体失败（不返回半成品）", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        calls++;
        if (calls === 2) return jsonResponse({}, 500);
        const inputs: string[] = JSON.parse(init.body).input;
        return jsonResponse({ data: inputs.map((t, i) => ({ index: i, embedding: [1, 0] })) });
      }),
    );
    const p = createEmbeddingProvider({ ...openaiOpts, batchSize: 1, concurrency: 3 });
    const r = await p.embed(["a", "b", "c"], "passage");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("http");
  });
});

describe("EmbeddingProvider (ollama)", () => {
  it("解析 embeddings，走 /api/embed", async () => {
    const calls: Captured[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body: string }) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return jsonResponse({ embeddings: [[1, 0], [0, 1]] });
      }),
    );
    const p = createEmbeddingProvider({ ...openaiOpts, provider: "ollama", baseUrl: "http://embed.local" });
    const r = await p.embed(["a", "b"], "passage");
    expect(r.ok).toBe(true);
    expect(calls[0].url).toBe("http://embed.local/api/embed");
  });
});

describe("EmbeddingProvider 错误处理", () => {
  it("超时返回 timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        const e = new Error("aborted");
        e.name = "AbortError";
        return Promise.reject(e);
      }),
    );
    const p = createEmbeddingProvider(openaiOpts);
    const r = await p.embed(["a"], "passage");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("timeout");
  });

  it("HTTP 错误返回 http + status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 500)));
    const p = createEmbeddingProvider(openaiOpts);
    const r = await p.embed(["a"], "passage");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("http");
      expect(r.error.status).toBe(500);
    }
  });

  it("probe 失败不抛异常", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 503)));
    const p = createEmbeddingProvider(openaiOpts);
    const pr = await p.probe();
    expect(pr.ok).toBe(false);
    expect(pr.detail).toContain("http");
  });

  it("配置 dim 时 probe 会校验端点维度一致性", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: [{ embedding: [1, 0] }] })));
    const mismatch = await createEmbeddingProvider({ ...openaiOpts, dim: 4 }).probe();
    expect(mismatch.ok).toBe(false);
    expect(mismatch.detail).toContain("dim_mismatch");

    const ok = await createEmbeddingProvider({ ...openaiOpts, dim: 2 }).probe();
    expect(ok.ok).toBe(true);
    expect(ok.dim).toBe(2);
  });
});

describe("profiles", () => {
  it("e5 内置 query/passage 前缀，bge-m3 无前缀", () => {
    expect(profileFor("multilingual-e5-small").queryPrefix).toBe("query: ");
    expect(profileFor("BAAI/bge-m3")).toEqual({ queryPrefix: "", passagePrefix: "" });
  });

  it("配置非空前缀可覆盖内置", () => {
    const p = resolvePrefixes("multilingual-e5-small", { queryPrefix: "Q: " });
    expect(p.queryPrefix).toBe("Q: ");
    expect(p.passagePrefix).toBe("passage: ");
  });

  it("e5 前缀实际拼进请求", async () => {
    const calls = stubEchoFetch();
    const p = createEmbeddingProvider({ ...openaiOpts, model: "multilingual-e5-small" });
    await p.embed(["hello"], "query");
    expect(calls[0].body.input).toEqual(["query: hello"]);
  });
});
