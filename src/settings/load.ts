import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import YAML from "yaml";
import { settingsSchema } from "./schema.js";
import { applySecretEnv, defaultSecrets, secretsPermissionWarning, secretsSchema, type Secrets } from "./secrets.js";
import type { Settings } from "./types.js";

/** 展开路径开头的 `~` 为当前用户 home（配置文件里的可读写法）。 */
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/** 旧版把密钥写在 gateway.yaml 的字段路径；出现即提示迁移。 */
const LEGACY_SECRET_PATHS: Array<{ path: string[]; hint: string }> = [
  { path: ["gateway", "token"], hint: "secrets.yaml 的 gateway.token" },
  { path: ["embedding", "api_key"], hint: "secrets.yaml 的 embedding.api_key" },
  {
    path: ["search", "reverse_image", "saucenao", "api_key"],
    hint: "secrets.yaml 的 search.reverse_image.saucenao.api_key",
  },
  { path: ["bilibili", "http", "token"], hint: "secrets.yaml 的 bilibili.http.token" },
  { path: ["browser", "proxy_password"], hint: "secrets.yaml 的 browser.proxy_password" },
];

type JsonObject = Record<string, unknown>;

function dig(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as JsonObject)[key];
  }
  return cur;
}

function removePath(obj: unknown, path: string[]): void {
  if (!obj || typeof obj !== "object") return;
  const parent = dig(obj, path.slice(0, -1));
  if (!parent || typeof parent !== "object") return;
  delete (parent as JsonObject)[path[path.length - 1]!];
}

/**
 * 迁移期保护：
 * - 旧密钥字段仍非空 → 直接报错（绝不能静默忽略，否则网关可能变成未鉴权）；
 * - 旧密钥字段为空 → 忽略并给 warning（照抄旧示例的配置不会因此启动失败）；
 * - 旧 `search.engines` 平铺数组 → 明确提示新写法。
 */
function migrateLegacyFormat(raw: JsonObject, warnings: string[]): void {
  for (const { path, hint } of LEGACY_SECRET_PATHS) {
    const value = dig(raw, path);
    if (value === undefined) continue;
    if (typeof value === "string" && value.length === 0) {
      removePath(raw, path);
      warnings.push(`gateway.yaml 中的旧字段 ${path.join(".")} 已为空，已忽略；密钥请迁移到 ${hint}。`);
      continue;
    }
    throw new Error(
      `检测到旧版密钥字段 ${path.join(".")}：请将其迁移到 ${hint}，gateway.yaml 不再接受密钥。`,
    );
  }

  const engines = dig(raw, ["search", "engines"]);
  if (Array.isArray(engines)) {
    throw new Error(
      "search.engines 不再支持平铺数组：请改为 `engines: { resident: [...], rotating: [...] }`。",
    );
  }
}

function formatIssues(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`).join("; ");
}

function readYaml(path: string, required: boolean): unknown {
  if (!existsSync(path)) {
    if (!required) return undefined;
    throw new Error(`配置文件不存在: ${path}。请复制 gateway.yaml.example 为 gateway.yaml 后修改。`);
  }
  let raw: unknown;
  try {
    raw = YAML.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`${path} 解析失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  return raw;
}

/** 归一化：URL 去尾斜杠、路径展开 `~`（与旧版行为保持一致）。 */
function normalizeSettings(settings: Settings): Settings {
  settings.searxng.url = stripTrailingSlashes(settings.searxng.url);
  settings.flaresolverr.url = stripTrailingSlashes(settings.flaresolverr.url);
  settings.search.reverse_image.tracemoe_url = stripTrailingSlashes(
    settings.search.reverse_image.tracemoe_url,
  );
  settings.search.reverse_image.saucenao.url = stripTrailingSlashes(
    settings.search.reverse_image.saucenao.url,
  );
  settings.search.reverse_image.baidu.url = stripTrailingSlashes(
    settings.search.reverse_image.baidu.url,
  );
  settings.search.quota_ledger_path = expandHome(settings.search.quota_ledger_path);
  settings.bilibili.http.base_url = stripTrailingSlashes(settings.bilibili.http.base_url);
  settings.bilibili.comment_db = expandHome(settings.bilibili.comment_db);
  settings.embedding.base_url = stripTrailingSlashes(settings.embedding.base_url);
  return settings;
}

export function defaultConfigPath(): string {
  return process.env.GATEWAY_CONFIG_FILE || resolve(process.cwd(), "gateway.yaml");
}

export function defaultSecretsPath(configPath: string = defaultConfigPath()): string {
  return process.env.GATEWAY_SECRETS_FILE || resolve(dirname(configPath), "secrets.yaml");
}

export interface LoadSettingsOptions {
  configPath?: string;
  secretsPath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface LoadedSettings {
  settings: Settings;
  secrets: Secrets;
  /** 不影响启动、但值得在日志里提示的问题（旧字段、文件权限等）。 */
  warnings: string[];
  configPath: string;
  secretsPath: string;
}

/**
 * 唯一设置入口：读取 gateway.yaml + secrets.yaml，校验后返回 { settings, secrets }。
 *
 * - gateway.yaml 必填；secrets.yaml 缺失时全部密钥为空（不报错）。
 * - 环境变量对密钥的覆盖优先级最高（见 applySecretEnv）。
 * - 只加载一次；进程级单例的初始化参数在启动时确定，不支持热更新。
 */
export function loadSettings(options: LoadSettingsOptions = {}): LoadedSettings {
  const configPath = options.configPath ?? defaultConfigPath();
  const secretsPath = options.secretsPath ?? defaultSecretsPath(configPath);
  return loadSettingsFrom(configPath, secretsPath, options.env ?? process.env);
}

/**
 * 按显式路径加载（CLI 校验临时文件用）。
 *
 * 与 loadSettings 行为完全一致，只是路径由调用方给定：CLI 写入前的校验必须能
 * 指定临时 gateway.yaml/secrets.yaml，而不是进程 cwd 下的文件。
 * `env` 仅供 loadSettings 透传，CLI 校验时传空对象以隔离外部密钥环境。
 */
export function loadSettingsFrom(
  configPath: string,
  secretsPath: string,
  env: NodeJS.ProcessEnv = process.env,
): LoadedSettings {
  const warnings: string[] = [];

  const raw = readYaml(configPath, true);
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${configPath} 内容为空或格式非法`);
  }
  migrateLegacyFormat(raw as JsonObject, warnings);

  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${configPath} 校验失败: ${formatIssues(parsed.error.issues)}`);
  }
  const settings = normalizeSettings(parsed.data);

  const rawSecrets = readYaml(secretsPath, false);
  let secrets: Secrets;
  if (rawSecrets === undefined || rawSecrets === null) {
    secrets = defaultSecrets();
  } else {
    if (typeof rawSecrets !== "object" || Array.isArray(rawSecrets)) {
      throw new Error(`${secretsPath} 内容格式非法`);
    }
    const parsedSecrets = secretsSchema.safeParse(rawSecrets);
    if (!parsedSecrets.success) {
      throw new Error(`${secretsPath} 校验失败: ${formatIssues(parsedSecrets.error.issues)}`);
    }
    secrets = parsedSecrets.data;
  }

  applySecretEnv(secrets, env);

  if (existsSync(secretsPath)) {
    const warning = secretsPermissionWarning(secretsPath);
    if (warning) warnings.push(warning);
  }

  return { settings, secrets, warnings, configPath, secretsPath };
}
