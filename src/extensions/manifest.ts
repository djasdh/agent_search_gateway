/** 第三方扩展 manifest 的解析。
 *
 * 0.4.0 起只接受 V2：`asg-extension.json` + `api_version: 2`。
 * V1 `asg-plugin.json` 不再解析；调用方遇到旧文件时应提示用户升级插件。
 *
 * 这一层不做严格校验：未知字段忽略，只保留字段类型、必填项和路径安全约束。
 */

import path from "node:path";
import { z } from "zod";
import { validateConfigSchemaDefinition } from "./config.js";

/** 扩展 id：3-64 位小写字母/数字/`. _ -`，首尾必须是字母或数字。 */
export const EXTENSION_ID_RE = /^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/;

/** 扩展版本：语义化版本的主干 + 可选预发布后缀（不接受 build 元数据）。 */
export const EXTENSION_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** 扩展能力：search 表示搜索源，fetch 表示抓取实现。 */
export const EXTENSION_PROVIDES = ["search", "fetch"] as const;

export type ExtensionProvide = (typeof EXTENSION_PROVIDES)[number];

/** V2 manifest 文件名；0.4.0 起是唯一接受的 manifest 文件。 */
export const V2_MANIFEST_FILE = "asg-extension.json";

/** manifest 声明的后端：只描述身份与旧名，不承载代码。 */
const backendSchema = z.object({
  id: z
    .string()
    .regex(
      EXTENSION_ID_RE,
      "backends[].id 必须是 3-64 位小写字母/数字/._-，且首尾为字母或数字",
    ),
  name: z.string().min(1, "backends[].name 不能为空"),
  description: z.string().optional(),
  /** 历史安装名/通道别名；用于兼容旧安装与配置键。 */
  aliases: z.array(z.string()).optional(),
});

export type ExtensionBackend = z.infer<typeof backendSchema>;

/** V2 抓取通道声明。 */
const fetchChannelSchema = z.object({
  id: z.string().min(1, "fetch_channels[].id 不能为空"),
  name: z.string().optional(),
  description: z.string().optional(),
  backends: z.array(z.string()).optional(),
  aliases: z.array(z.string()).optional(),
});

export type ExtensionFetchChannel = z.infer<typeof fetchChannelSchema>;

/** V2 搜索源声明。 */
const searchEngineSchema = z.object({
  id: z.string().min(1, "search_engines[].id 不能为空"),
  name: z.string().optional(),
  description: z.string().optional(),
});

export type ExtensionSearchEngine = z.infer<typeof searchEngineSchema>;

const commonFields = {
  id: z
    .string()
    .regex(EXTENSION_ID_RE, "id 必须是 3-64 位小写字母/数字/._-，且首尾为字母或数字"),
  name: z.string().min(1, "name 不能为空"),
  version: z
    .string()
    .regex(EXTENSION_VERSION_RE, "version 必须是语义化版本，例如 1.2.3 或 1.2.3-beta.1"),
  provides: z.array(z.enum(EXTENSION_PROVIDES, "provides 只能包含 search / fetch")),
  entry: z
    .string()
    .min(1, "entry 不能为空")
    .refine((value) => isValidEntryName(value), "entry 只能是单个 .mjs / .js 文件名"),
  description: z.string().optional(),
  config_schema: z.unknown().optional(),
};

const manifestV2Schema = z.object({
  ...commonFields,
  api_version: z.literal(2, "api_version 必须是 2"),
  backends: z.array(backendSchema).optional(),
  fetch_channels: z.array(fetchChannelSchema).optional(),
  search_engines: z.array(searchEngineSchema).optional(),
});

type ParsedManifestV2 = z.infer<typeof manifestV2Schema>;

export type ExtensionManifestV2 = Omit<ParsedManifestV2, "config_schema"> & {
  config_schema?: Record<string, unknown>;
};
/** 0.4.0 起 manifest 只有 V2 一种形态。 */
export type ExtensionManifest = ExtensionManifestV2;

/** manifest 解析/校验错误：消息已包含中文说明，调用方负责包装成 CLI 错误。 */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

export function isValidExtensionId(value: string): boolean {
  return EXTENSION_ID_RE.test(value);
}

export function isValidExtensionVersion(value: string): boolean {
  return EXTENSION_VERSION_RE.test(value);
}

/** entry 必须是安装目录内的单个文件名，不能带路径、不能是绝对路径。 */
export function isValidEntryName(value: string): boolean {
  if (!value || value === "." || value === "..") return false;
  if (value.startsWith(".")) return false;
  if (value.includes("/") || value.includes("\\") || value.includes("\0")) return false;
  if (value.includes("..")) return false;
  if (value.includes(":")) return false;
  if (path.isAbsolute(value)) return false;
  return value.endsWith(".mjs") || value.endsWith(".js");
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.length > 0 ? issue.path.map(String).join(".") : "(根)";
      return `${at}: ${issue.message}`;
    })
    .join("；");
}

/** 解析 manifest 文本；失败抛 ManifestError（中文说明）。 */
export function parseManifest(text: string, file: string = V2_MANIFEST_FILE): ExtensionManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ManifestError(
      `${file} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const apiVersion = (raw as { api_version?: unknown }).api_version;
    if (apiVersion !== 2) {
      throw new ManifestError(
        `${file} 校验失败：0.4.0 起只接受 asg-extension.json（api_version: 2）；V1 插件请升级到 0.2.x`,
      );
    }
  }

  const result = manifestV2Schema.safeParse(raw);
  if (!result.success) {
    throw new ManifestError(`${file} 校验失败：${formatIssues(result.error)}`);
  }

  if (result.data.config_schema !== undefined) {
    try {
      validateConfigSchemaDefinition(result.data.config_schema);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ManifestError(`${file} 校验失败：${detail}`);
    }
  }

  return result.data as ExtensionManifest;
}
