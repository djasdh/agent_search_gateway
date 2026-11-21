import { describe, expect, it } from "vitest";
import {
  isValidEntryName,
  isValidExtensionId,
  isValidExtensionVersion,
  parseManifest,
} from "../../src/extensions/manifest.js";

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "demo-fetch",
    name: "Demo Fetch",
    version: "1.2.3",
    api_version: 2,
    provides: ["fetch"],
    entry: "index.mjs",
    ...overrides,
  });
}

describe("插件 manifest", () => {
  it("接受最小 manifest 与可选 description", () => {
    const parsed = parseManifest(manifest({ description: "示例插件" }));
    expect(parsed).toEqual({
      id: "demo-fetch",
      name: "Demo Fetch",
      version: "1.2.3",
      api_version: 2,
      provides: ["fetch"],
      entry: "index.mjs",
      description: "示例插件",
    });
  });

  it("接受 search、fetch 或两者，并保留声明顺序", () => {
    expect(parseManifest(manifest({ provides: ["search"] })).provides).toEqual(["search"]);
    expect(parseManifest(manifest({ provides: ["search", "fetch"] })).provides).toEqual([
      "search",
      "fetch",
    ]);
  });

  it("拒绝非法 JSON，并给出中文说明", () => {
    expect(() => parseManifest("{")).toThrow(/不是合法 JSON/);
  });

  it("校验 id 规则", () => {
    for (const id of ["ab", "ABC", "-abc", "abc-", ".abc", "a".repeat(65), "中文"]) {
      expect(() => parseManifest(manifest({ id })), id).toThrow(/id 必须/);
    }
    expect(isValidExtensionId("abc")).toBe(true);
    expect(isValidExtensionId("a.b_c-1")).toBe(true);
  });

  it("校验 name 与 version", () => {
    expect(() => parseManifest(manifest({ name: "" }))).toThrow(/name/);
    expect(() => parseManifest(manifest({ version: "1.2" }))).toThrow(/version/);
    expect(() => parseManifest(manifest({ version: "v1.2.3" }))).toThrow(/version/);
    expect(isValidExtensionVersion("1.2.3-beta.1")).toBe(true);
  });

  it("0.4.0 起只接受 api_version 2", () => {
    expect(parseManifest(manifest()).api_version).toBe(2);
    for (const apiVersion of [1, 3, "2", undefined]) {
      expect(
        () => parseManifest(manifest({ api_version: apiVersion })),
        String(apiVersion),
      ).toThrow(/0\.4\.0 起只接受 asg-extension\.json（api_version: 2）/);
    }
  });

  it("默认按 asg-extension.json 报告 V1 错误", () => {
    expect(() => parseManifest(manifest({ api_version: 1 }))).toThrow(/asg-extension\.json/);
  });

  it("provides 只接受 search/fetch", () => {
    expect(parseManifest(manifest({ provides: [] })).provides).toEqual([]);
    expect(parseManifest(manifest({ provides: ["fetch", "fetch"] })).provides).toEqual([
      "fetch",
      "fetch",
    ]);
    expect(() => parseManifest(manifest({ provides: ["other"] }))).toThrow(/provides/);
  });

  it("entry 只能是单个 .mjs/.js 文件名", () => {
    for (const entry of [
      "dist/index.mjs",
      "../index.mjs",
      "/index.mjs",
      "index.txt",
      "C:\\index.mjs",
      "C:index.js",
      "index..mjs",
      ".mjs",
    ]) {
      expect(() => parseManifest(manifest({ entry })), entry).toThrow(/entry/);
    }
    expect(isValidEntryName("index.js")).toBe(true);
    expect(isValidEntryName("x.y.mjs")).toBe(true);
    expect(isValidEntryName("index_mjs.js")).toBe(true);
  });
});

describe("插件 manifest 的 backends", () => {
  const backend = {
    id: "demo-api",
    name: "Demo API",
    description: "示例后端",
    aliases: ["demo_old", "demo-old"],
  };

  it("合法 backends 通过并原样保留", () => {
    const parsed = parseManifest(manifest({ backends: [backend] }));
    expect(parsed.backends).toEqual([backend]);
  });

  it("没有 backends 时不产生该字段", () => {
    expect(parseManifest(manifest())).not.toHaveProperty("backends");
  });

  it("校验 backend id 规则", () => {
    for (const id of ["ab", "ABC", "-abc", "abc-", ".abc", "a".repeat(65), "中文"]) {
      expect(
        () => parseManifest(manifest({ backends: [{ ...backend, id }] })),
        id,
      ).toThrow(/backends\[\]\.id|重复 id/);
    }
  });

  it("校验 backend name 必填", () => {
    expect(() =>
      parseManifest(manifest({ backends: [{ id: "demo-api", name: "" }] })),
    ).toThrow(/backends\[\]\.name/);
  });

});

describe("插件 manifest 的 fetch_channels 与 search_engines", () => {
  it("原样保留通道和搜索源", () => {
    const parsed = parseManifest(
      manifest({
        fetch_channels: [
          {
            id: "example:cli",
            name: "Example CLI",
            description: "示例通道",
            backends: ["demo-api"],
            aliases: ["example"],
          },
        ],
        search_engines: [
          {
            id: "gateway.search:example",
            name: "Example Search",
            description: "示例搜索源",
          },
        ],
      }),
    );
    expect(parsed.fetch_channels).toHaveLength(1);
    expect(parsed.search_engines).toHaveLength(1);
  });
});

describe("插件 manifest 的 config_schema", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["base_url"],
    properties: {
      enabled: { type: "boolean", default: true, description: "总开关" },
      base_url: { type: "string", description: "上游根地址" },
      limit: { type: "integer", default: 10, minimum: 1, maximum: 50 },
      retry: {
        type: "object",
        additionalProperties: false,
        properties: {
          times: { type: "integer", default: 2 },
        },
        default: {},
      },
    },
  };

  it("没有 config_schema 时解析结果不含该字段", () => {
    const parsed = parseManifest(manifest());
    expect(parsed).not.toHaveProperty("config_schema");
    expect(parsed).toEqual({
      id: "demo-fetch",
      name: "Demo Fetch",
      version: "1.2.3",
      api_version: 2,
      provides: ["fetch"],
      entry: "index.mjs",
    });
  });

  it("保留合法的 config_schema", () => {
    const parsed = parseManifest(manifest({ config_schema: schema }));
    expect(parsed.config_schema).toEqual(schema);
  });

  it("拒绝未知关键字（$ref / pattern），并带路径", () => {
    const withRef = {
      type: "object",
      properties: { a: { $ref: "#/definitions/x" } },
    };
    expect(() => parseManifest(manifest({ config_schema: withRef }))).toThrow(
      /config_schema\.properties\.a\.\$ref/,
    );

    const withPattern = {
      type: "object",
      properties: { base_url: { type: "string", pattern: "^https://" } },
    };
    expect(() => parseManifest(manifest({ config_schema: withPattern }))).toThrow(
      /config_schema\.properties\.base_url\.pattern/,
    );
  });

  it("拒绝根节点不是 object", () => {
    expect(() =>
      parseManifest(manifest({ config_schema: { type: "string", properties: {} } })),
    ).toThrow(/根节点 type 必须是 "object"/);
    expect(() => parseManifest(manifest({ config_schema: "nope" }))).toThrow(
      /config_schema.*必须是对象/,
    );
  });

  it("拒绝 required 引用不存在的字段", () => {
    expect(() =>
      parseManifest(
        manifest({
          config_schema: {
            type: "object",
            required: ["missing"],
            properties: { base_url: { type: "string" } },
          },
        }),
      ),
    ).toThrow(/missing.*未在 properties 中声明/);
  });

  it("拒绝 properties 放在非 object、items 放在非 array", () => {
    expect(() =>
      parseManifest(
        manifest({
          config_schema: {
            type: "object",
            properties: { a: { type: "string", properties: {} } },
          },
        }),
      ),
    ).toThrow(/properties.*只有 type 为 object/);

    expect(() =>
      parseManifest(
        manifest({
          config_schema: {
            type: "object",
            properties: { a: { type: "string", items: { type: "string" } } },
          },
        }),
      ),
    ).toThrow(/items.*只有 type 为 array/);
  });

  it("拒绝超过深度与节点上限", () => {
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 8; i += 1) {
      deep = { type: "object", properties: { child: deep } };
    }
    expect(() => parseManifest(manifest({ config_schema: deep }))).toThrow(
      /深度不能超过 8 层/,
    );

    const wide = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 300 }, (_, index) => [`f${index}`, { type: "string" }]),
      ),
    };
    expect(() => parseManifest(manifest({ config_schema: wide }))).toThrow(
      /节点总数不能超过 256/,
    );
  });
});
