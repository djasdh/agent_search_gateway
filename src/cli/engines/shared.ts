/** 引擎存储适配器共用的小工具（从运行期共享层重新导出）。 */

import { asObject, stringArray } from "../../engines/values.js";

export { stringArray, dig, asObject, nonEmptyString, numberOr } from "../../engines/values.js";

/** `search.engines` 的 resident / rotating 引用列表。 */
export function routingFor(configPlain: Record<string, unknown>, name: string): string[] {
  const engines = asObject(asObject(configPlain.search).engines);
  if (stringArray(engines.resident).includes(name)) return ["resident"];
  if (stringArray(engines.rotating).includes(name)) return ["rotating"];
  return [];
}
