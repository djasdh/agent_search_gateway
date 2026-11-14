/**
 * 网关原生引擎注册表：编译期静态注册。
 *
 * 新增引擎 = 新建 `providers/<name>.ts` + 在这里加一行；CLI 与运行期都从这里取。
 */

import type { EngineProvider } from "./provider.js";
import type { EngineGroup } from "./types.js";
import { tracemoeProvider } from "./providers/tracemoe.js";
import { saucenaoProvider } from "./providers/saucenao.js";
import { baiduProvider } from "./providers/baidu.js";
import { weiboProvider } from "./providers/weibo.js";

export const ENGINE_PROVIDERS: readonly EngineProvider[] = [
  tracemoeProvider,
  saucenaoProvider,
  baiduProvider,
  weiboProvider,
];

// 内置 provider 的 id 是编程契约；重复说明注册表写错了，直接 fail fast。
const seen = new Set<string>();
for (const provider of ENGINE_PROVIDERS) {
  if (seen.has(provider.id)) {
    throw new Error(`重复的引擎 provider id：${provider.id}`);
  }
  seen.add(provider.id);
}

export function engineProvider(group: EngineGroup, name: string): EngineProvider | undefined {
  return ENGINE_PROVIDERS.find((provider) => provider.group === group && provider.name === name);
}

export function providersForGroup(group: EngineGroup): readonly EngineProvider[] {
  return ENGINE_PROVIDERS.filter((provider) => provider.group === group);
}
