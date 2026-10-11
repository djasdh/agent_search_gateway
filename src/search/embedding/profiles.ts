/**
 * 模型 profile：已知 embedding 模型的输入约定（query/passage 前缀）。
 *
 * 前缀配错不会报错，只会静默变差，因此对常见模型内置默认值；
 * 配置里的非空前缀可覆盖。
 */

export interface ModelProfile {
  queryPrefix: string;
  passagePrefix: string;
}

const EMPTY: ModelProfile = { queryPrefix: "", passagePrefix: "" };

/** 按模型名匹配内置 profile；顺序即优先级。 */
const PROFILES: Array<{ match: RegExp; profile: ModelProfile }> = [
  // multilingual-e5 系列要求 query/passage 前缀
  { match: /multilingual-e5|(^|[^a-z])e5([^a-z]|$)/i, profile: { queryPrefix: "query: ", passagePrefix: "passage: " } },
  // bge-m3 无需前缀
  { match: /bge[-_]m3/i, profile: EMPTY },
  // OpenAI 文本嵌入无需前缀
  { match: /text-embedding-3|text-embedding-ada/i, profile: EMPTY },
];

/** 取模型内置 profile；未知模型返回空前缀。 */
export function profileFor(model: string): ModelProfile {
  for (const { match, profile } of PROFILES) {
    if (match.test(model)) return profile;
  }
  return EMPTY;
}

/**
 * 合并内置 profile 与配置覆盖。
 * 约定：仅当覆盖值为非 undefined 才生效；空串视为「用内置」。
 */
export function resolvePrefixes(
  model: string,
  override?: { queryPrefix?: string; passagePrefix?: string },
): ModelProfile {
  const base = profileFor(model);
  return {
    queryPrefix: override?.queryPrefix || base.queryPrefix,
    passagePrefix: override?.passagePrefix || base.passagePrefix,
  };
}
