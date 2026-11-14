/** SauceNAO 引擎 provider：插画 / 同人图出处反查（需要 api_key）。 */

import type { EngineProvider, EngineProviderContext } from "../provider.js";
import { asObject, dig, nonEmptyString, numberOr } from "../values.js";
import { searchSaucenao } from "../../search/saucenao.js";

const REQUIRES = "secrets.search.reverse_image.saucenao.api_key";

function secret(ctx: EngineProviderContext): string {
  const value = dig(ctx.secrets, ["search", "reverse_image", "saucenao", "api_key"]);
  return nonEmptyString(value) ?? "";
}

export const saucenaoProvider: EngineProvider = {
  id: "gateway.reverse_image:saucenao",
  group: "gateway.reverse_image",
  name: "saucenao",
  kind: "gateway",
  displayName: "SauceNAO",
  routing: () => ["source"],
  requires: [REQUIRES],
  available: (ctx) => secret(ctx).length > 0,
  runtime: {
    kind: "reverse_image",
    search(input, ctx) {
      const reverse = asObject(asObject(ctx.config.search).reverse_image);
      const saucenao = asObject(reverse.saucenao);
      return searchSaucenao(
        {
          apiKey: secret(ctx),
          baseUrl: nonEmptyString(saucenao.url),
          timeoutMs: numberOr(saucenao.timeout_ms, 15_000),
          maxResults: numberOr(saucenao.max_results, 8),
          minsim: numberOr(saucenao.minsim, 30),
        },
        input,
      );
    },
  },
};
