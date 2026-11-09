import { statSync } from "node:fs";
import { z } from "zod";

/**
 * 密钥 schema（secrets.yaml）。
 *
 * 只放敏感值，结构与 gateway.yaml 的对应路径一致；加载后是**独立对象**，
 * 不合并进 Settings，由根节点只传给真正需要它的组件。
 *
 * 环境变量优先级最高（见 applySecretEnv）。空环境变量视为未设置。
 */

const gatewaySecretsSchema = z
  .object({
    token: z.string().default(""),
  })
  .strict();

const embeddingSecretsSchema = z
  .object({
    api_key: z.string().default(""),
  })
  .strict();

const saucenaoSecretsSchema = z
  .object({
    api_key: z.string().default(""),
  })
  .strict();

const reverseImageSecretsSchema = z
  .object({
    saucenao: saucenaoSecretsSchema.default(() => saucenaoSecretsSchema.parse({})),
  })
  .strict();

const searchSecretsSchema = z
  .object({
    reverse_image: reverseImageSecretsSchema.default(() => reverseImageSecretsSchema.parse({})),
  })
  .strict();

const bilibiliHttpSecretsSchema = z
  .object({
    token: z.string().default(""),
  })
  .strict();

const bilibiliSecretsSchema = z
  .object({
    http: bilibiliHttpSecretsSchema.default(() => bilibiliHttpSecretsSchema.parse({})),
  })
  .strict();

const browserSecretsSchema = z
  .object({
    proxy_password: z.string().default(""),
  })
  .strict();

export const secretsSchema = z
  .object({
    gateway: gatewaySecretsSchema.default(() => gatewaySecretsSchema.parse({})),
    embedding: embeddingSecretsSchema.default(() => embeddingSecretsSchema.parse({})),
    search: searchSecretsSchema.default(() => searchSecretsSchema.parse({})),
    bilibili: bilibiliSecretsSchema.default(() => bilibiliSecretsSchema.parse({})),
    browser: browserSecretsSchema.default(() => browserSecretsSchema.parse({})),
  })
  .strict();

export type Secrets = z.infer<typeof secretsSchema>;

/** 全空密钥：secrets.yaml 缺失时的默认值。 */
export function defaultSecrets(): Secrets {
  return secretsSchema.parse({});
}

/** 环境变量 → 密钥路径映射（顺序即覆盖顺序）。 */
const SECRET_ENV: Array<[string, (s: Secrets, v: string) => void]> = [
  ["GATEWAY_TOKEN", (s, v) => void (s.gateway.token = v)],
  ["EMBEDDING_API_KEY", (s, v) => void (s.embedding.api_key = v)],
  ["SAUCENAO_API_KEY", (s, v) => void (s.search.reverse_image.saucenao.api_key = v)],
  ["BILIBILI_HTTP_TOKEN", (s, v) => void (s.bilibili.http.token = v)],
  ["BROWSER_PROXY_PASSWORD", (s, v) => void (s.browser.proxy_password = v)],
];

/** 用非空环境变量覆盖密钥（空值保持 secrets.yaml / 默认值）。 */
export function applySecretEnv(secrets: Secrets, env: NodeJS.ProcessEnv = process.env): Secrets {
  for (const [name, assign] of SECRET_ENV) {
    const value = env[name];
    if (value !== undefined && value.length > 0) assign(secrets, value);
  }
  return secrets;
}

/** secrets.yaml 权限检查：对 group/other 可读时返回警告文案。 */
export function secretsPermissionWarning(path: string): string | undefined {
  try {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      return `secrets.yaml 权限过宽（${mode.toString(8)}），建议执行 chmod 600 ${path}`;
    }
  } catch {
    /* 文件不存在/不可 stat：由加载流程决定是否报错 */
  }
  return undefined;
}
