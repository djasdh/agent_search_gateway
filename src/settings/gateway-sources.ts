/**
 * 网关原生「以图搜图」源：schema 与 `asg engines` 共用的唯一清单。
 *
 * 第一版固定为 tracemoe / saucenao / baidu；新增源必须同时修改本文件、
 * 对应的 provider 实现与 `search.reverse_image` 配置段。
 */

export const GATEWAY_SOURCES = ["tracemoe", "saucenao", "baidu"] as const;

export type GatewaySource = (typeof GATEWAY_SOURCES)[number];

export interface GatewaySourceSpec {
  name: GatewaySource;
  /**
   * 启用该源所需的 secrets.yaml 路径（点号写法，`secrets.` 前缀保持与 CLI 一致）。
   * 缺失时 `asg engines enable` 直接拒绝（MISSING_SECRET）。
   */
  requires: readonly string[];
}

export const GATEWAY_SOURCE_SPECS: readonly GatewaySourceSpec[] = [
  { name: "tracemoe", requires: [] },
  {
    name: "saucenao",
    requires: ["secrets.search.reverse_image.saucenao.api_key"],
  },
  { name: "baidu", requires: [] },
];

/** 按名字取源定义；未知名字返回 undefined。 */
export function gatewaySourceSpec(name: string): GatewaySourceSpec | undefined {
  return GATEWAY_SOURCE_SPECS.find((spec) => spec.name === name);
}

/** 源是否属于网关原生源。 */
export function isGatewaySource(name: string): name is GatewaySource {
  return (GATEWAY_SOURCES as readonly string[]).includes(name);
}
