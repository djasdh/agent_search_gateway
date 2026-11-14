/**
 * 密钥引用解析（secrets.yaml 里的 `env:NAME` 写法）。
 *
 * 只支持 `env:NAME`：
 * - `env:` 前后允许空白；
 * - 环境变量缺失时解析为空串（与"未配置密钥"一致，不报错）；
 * - 其它值（含明文）原样返回，作为兼容保留，文档不推荐长期使用。
 */

/** 解析单个字符串值；`env:NAME` 读取环境变量，其余原样返回。 */
export function resolveSecretValue(raw: string, env: NodeJS.ProcessEnv = process.env): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("env:")) return raw;
  const name = trimmed.slice("env:".length).trim();
  if (!name) return "";
  return env[name] ?? "";
}

/** 递归解析对象/数组中的字符串值（保持结构不变）。 */
export function resolveSecretTree<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof value === "string") return resolveSecretValue(value, env) as T;
  if (Array.isArray(value)) {
    return value.map((item) => resolveSecretTree(item, env)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = resolveSecretTree(item, env);
    }
    return out as T;
  }
  return value;
}
