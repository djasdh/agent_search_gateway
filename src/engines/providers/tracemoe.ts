/** trace.moe 引擎 provider：动画截图出处反查（免 key）。 */

import type { EngineProvider } from "../provider.js";
import { asObject, nonEmptyString, numberOr } from "../values.js";
import { searchTraceMoe, searchTraceMoeUpload } from "../../search/reverse-image.js";

const DEFAULT_URL = "https://api.trace.moe";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESULTS = 8;

export const tracemoeProvider: EngineProvider = {
  id: "gateway.reverse_image:tracemoe",
  group: "gateway.reverse_image",
  name: "tracemoe",
  kind: "gateway",
  displayName: "trace.moe",
  routing: () => ["source"],
  available: () => true,
  runtime: {
    kind: "reverse_image",
    search(input, ctx) {
      const reverse = asObject(asObject(ctx.config.search).reverse_image);
      const baseUrl = nonEmptyString(reverse.tracemoe_url) ?? DEFAULT_URL;
      const timeoutMs = numberOr(reverse.tracemoe_timeout_ms, DEFAULT_TIMEOUT_MS);
      const maxResults = numberOr(reverse.tracemoe_max_results, DEFAULT_MAX_RESULTS);

      return input.kind === "bytes"
        ? searchTraceMoeUpload(baseUrl, timeoutMs, input.bytes, input.filename, input.mime, maxResults)
        : searchTraceMoe(baseUrl, timeoutMs, input.url, maxResults);
    },
  },
};
