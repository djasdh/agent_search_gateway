/**
 * 引擎 `requires` 中“密钥类依赖”的判定。
 *
 * - `secrets.a.b`：内置密钥（secrets.yaml）；
 * - `secret:<name>`：扩展密钥（secrets.yaml → extensions.<id>.<name>）；
 * - `searxng.engines.<name>.api_key`：searxng settings.yml 里该引擎的 api_key。
 */

const SEARXNG_SECRET_PREFIX = "searxng.engines.";
const SEARXNG_SECRET_SUFFIX = ".api_key";

/** 构造 searxng 引擎的 api_key 依赖。 */
export function searxngSecretRequirement(engineName: string): string {
  return `${SEARXNG_SECRET_PREFIX}${engineName}${SEARXNG_SECRET_SUFFIX}`;
}

/** 解析 `searxng.engines.<name>.api_key`；不匹配返回 undefined。 */
export function parseSearxngSecretRequirement(requirement: string): string | undefined {
  if (!requirement.startsWith(SEARXNG_SECRET_PREFIX)) return undefined;
  if (!requirement.endsWith(SEARXNG_SECRET_SUFFIX)) return undefined;
  const name = requirement.slice(
    SEARXNG_SECRET_PREFIX.length,
    requirement.length - SEARXNG_SECRET_SUFFIX.length,
  );
  return name.length > 0 ? name : undefined;
}

/** 该 `requires` 条目是否属于“缺密钥”类（决定 MISSING_SECRET / MISSING_DEPENDENCY）。 */
export function isSecretRequirement(requirement: string): boolean {
  return (
    requirement.startsWith("secrets.") ||
    requirement.startsWith("secret:") ||
    parseSearxngSecretRequirement(requirement) !== undefined
  );
}
