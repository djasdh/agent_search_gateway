/** 百度识图引擎 provider：中文 / 国内图反查（抓网页，无官方 API）。 */

import type { EngineProvider } from "../provider.js";
import { asObject, nonEmptyString, numberOr } from "../values.js";
import { searchBaiduReverse } from "../../search/baidu-reverse.js";

const DEFAULT_MAX_BYTES = 5_242_880;

export const baiduProvider: EngineProvider = {
  id: "gateway.reverse_image:baidu",
  group: "gateway.reverse_image",
  name: "baidu",
  kind: "gateway",
  displayName: "百度识图",
  routing: () => ["source"],
  available: (ctx) => {
    const reverse = asObject(asObject(ctx.config.search).reverse_image);
    return asObject(reverse.baidu).enabled !== false;
  },
  runtime: {
    kind: "reverse_image",
    search(input, ctx) {
      const reverse = asObject(asObject(ctx.config.search).reverse_image);
      const baidu = asObject(reverse.baidu);
      return searchBaiduReverse(
        {
          baseUrl: nonEmptyString(baidu.url),
          timeoutMs: numberOr(baidu.timeout_ms, 15_000),
          maxResults: numberOr(baidu.max_results, 8),
          maxBytes: numberOr(reverse.local_max_bytes, DEFAULT_MAX_BYTES),
        },
        input,
      );
    },
  },
};
