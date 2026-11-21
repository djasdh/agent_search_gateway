/** 第三方插件安装薄层：解析 GitHub Release、下载校验、原子写入 data/extensions。
 *
 * 这里**不加载任何插件代码**，只维护安装目录。运行时加载留到后续版本。
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import type { Dirent } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
// @ts-expect-error 纯 JS 安装脚本没有类型声明
import { download, fetchJson, sha256File } from "../../scripts/install/http.mjs";
import { CliError, EXIT } from "../cli/errors.js";
import { GATEWAY_VERSION } from "../version.js";
import {
  V2_MANIFEST_FILE,
  isValidEntryName,
  isValidExtensionId,
  isValidExtensionVersion,
  parseManifest,
  type ExtensionBackend,
  type ExtensionFetchChannel,
  type ExtensionManifest,
  type ExtensionProvide,
  type ExtensionSearchEngine,
} from "./manifest.js";

const CHECKSUMS_FILE = "SHA256SUMS";
/** V1 文件名只用于诊断旧安装，不再参与发现或解析。 */
const LEGACY_MANIFEST_FILE = "asg-plugin.json";
const LEGACY_UPGRADE_MESSAGE = `未找到 ${V2_MANIFEST_FILE}；0.4.0 起不再加载 ${LEGACY_MANIFEST_FILE}，请执行 asg extensions install <repo>`;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

export interface RequestOptions {
  token?: string;
  logger?: (message: string) => void;
  headers?: Record<string, string>;
}

export type FetchJson = (url: string, options?: RequestOptions) => Promise<unknown>;
export type Download = (url: string, dest: string, options?: RequestOptions) => Promise<unknown>;
export type Sha256File = (file: string) => Promise<string>;

/** 安装依赖注入点：默认使用 scripts/install/http.mjs 的真实实现，测试可替换。 */
export interface InstallDeps {
  fetchJson: FetchJson;
  download: Download;
  sha256File: Sha256File;
  random?: () => string;
}

export interface InstallExtensionOptions {
  root: string;
  repo: string;
  version?: string;
  logger?: (message: string) => void;
  deps?: Partial<InstallDeps>;
}

export interface InstalledExtensionInfo {
  id: string;
  version: string;
  name: string;
  provides: ExtensionProvide[];
  /** manifest.backends；未声明时为 []。 */
  backends: ExtensionBackend[];
  /** manifest.fetch_channels；未声明时为 []。 */
  fetch_channels: ExtensionFetchChannel[];
  /** manifest.search_engines；未声明时为 []。 */
  search_engines: ExtensionSearchEngine[];
  path: string;
}

export interface InstalledExtension {
  id: string;
  name?: string;
  version?: string;
  provides?: ExtensionProvide[];
  backends?: ExtensionBackend[];
  fetch_channels?: ExtensionFetchChannel[];
  search_engines?: ExtensionSearchEngine[];
  entry?: string;
  path: string;
  /** 单个安装目录损坏时只标记该条，不让整条 list 命令失败。 */
  error?: string;
}

export interface ExtensionSearchItem {
  repo: string;
  description: string;
  url: string;
  stars: number;
  updated_at: string;
}

export interface SearchExtensionsOptions {
  query?: string;
  limit?: number;
  logger?: (message: string) => void;
  /** 测试钩子：覆盖环境变量中的 token。 */
  token?: string;
  /** 测试钩子：覆盖默认的 User-Agent。 */
  userAgent?: string;
  deps?: Partial<InstallDeps>;
}

interface ReleaseInfo {
  tag: string;
  assets: Map<string, string>;
}

const DEFAULT_RANDOM = (): string => randomBytes(6).toString("hex");

const DEFAULT_DEPS: InstallDeps = {
  fetchJson: fetchJson as FetchJson,
  download: download as Download,
  sha256File: sha256File as Sha256File,
  random: DEFAULT_RANDOM,
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertHttps(url: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError("DOWNLOAD_FAILED", EXIT.FAIL, `${label} 的下载地址无效：${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new CliError(
      "DOWNLOAD_FAILED",
      EXIT.FAIL,
      `${label} 只允许 https 下载地址，收到：${url}`,
    );
  }
}

function isNotFound(error: unknown): boolean {
  const message = messageOf(error);
  return /(^|\D)404(\D|$)/.test(message) || /not found/i.test(message) || /未找到/.test(message);
}

function toDownloadError(error: unknown, action: string): CliError {
  if (error instanceof CliError) return error;
  const message = messageOf(error);
  if (/\b(403|429)\b/.test(message) || /rate limit/i.test(message)) {
    return new CliError(
      "DOWNLOAD_FAILED",
      EXIT.FAIL,
      `${action}失败：GitHub API 拒绝请求（可能触发限流）。\n处理：设置 GITHUB_TOKEN（或 GH_TOKEN）后重试。\n原始信息：${message}`,
    );
  }
  return new CliError("DOWNLOAD_FAILED", EXIT.FAIL, `${action}失败：${message}`);
}

function githubToken(): string {
  return (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
}

function githubHeaders(token: string, userAgent?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": userAgent ?? `asg/${GATEWAY_VERSION}`,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** GitHub 仓库名：owner/name，只允许 GitHub 实际接受的字符。 */
export function isValidRepo(value: string): boolean {
  if (!REPO_RE.test(value)) return false;
  return value.split("/").every((part) => part !== "." && part !== "..");
}

function normalizeVersionInput(value: string): string {
  const version = value.trim().replace(/^[vV]/, "");
  if (!isValidExtensionVersion(version)) {
    throw new CliError(
      "PLUGIN_FAILED",
      EXIT.INVALID,
      `版本号不合法：${value}（示例：1.2.3）`,
    );
  }
  return version;
}

function assertInstallableId(id: string): void {
  if (!isValidExtensionId(id)) {
    throw new CliError("PLUGIN_FAILED", EXIT.INVALID, `插件 id 不合法：${id}`);
  }
}

function readRelease(data: unknown): ReleaseInfo {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new CliError("PLUGIN_FAILED", EXIT.INVALID, "GitHub Release 返回格式不是对象");
  }
  const record = data as Record<string, unknown>;
  if (typeof record.tag_name !== "string" || !record.tag_name.trim()) {
    throw new CliError("PLUGIN_FAILED", EXIT.INVALID, "GitHub Release 缺少 tag_name");
  }
  if (!Array.isArray(record.assets)) {
    throw new CliError("PLUGIN_FAILED", EXIT.INVALID, "GitHub Release 缺少 assets");
  }

  const assets = new Map<string, string>();
  for (const item of record.assets) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const asset = item as Record<string, unknown>;
    if (typeof asset.name !== "string") continue;
    const url =
      typeof asset.browser_download_url === "string"
        ? asset.browser_download_url
        : typeof asset.url === "string"
          ? asset.url
          : "";
    if (!url) continue;
    if (!assets.has(asset.name)) assets.set(asset.name, url);
  }
  return { tag: record.tag_name.trim(), assets };
}

async function fetchRelease(
  url: string,
  deps: InstallDeps,
  request: RequestOptions,
): Promise<ReleaseInfo> {
  let data: unknown;
  try {
    data = await deps.fetchJson(url, request);
  } catch (error) {
    throw toDownloadError(error, "读取 GitHub Release");
  }
  return readRelease(data);
}

/** 指定版本时先查 v<version>，再回退到不带 v 的 tag；不指定则用 latest。 */
async function resolveRelease(
  repo: string,
  version: string | undefined,
  deps: InstallDeps,
  request: RequestOptions,
): Promise<ReleaseInfo> {
  const base = `https://api.github.com/repos/${repo}/releases`;
  if (!version) {
    try {
      return await fetchRelease(`${base}/latest`, deps, request);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      // 底层下载层会把 404 也提示成“检查代理”，这里换成明确的“没有 Release”。
      throw new CliError(
        "PLUGIN_FAILED",
        EXIT.FAIL,
        `仓库 ${repo} 没有可用的 Release。\n处理：确认 owner/repo 正确，且该仓库已发布 Release。`,
      );
    }
  }

  const withV = `${base}/tags/v${version}`;
  const withoutV = `${base}/tags/${version}`;
  try {
    return await fetchRelease(withV, deps, request);
  } catch (first) {
    // 只有 404 才回退到不带 v 的 tag；其它网络/限流错误直接上报。
    if (!isNotFound(first)) throw first;
  }

  try {
    return await fetchRelease(withoutV, deps, request);
  } catch (second) {
    if (!isNotFound(second)) throw second;
    throw new CliError(
      "PLUGIN_FAILED",
      EXIT.FAIL,
      `未找到 ${repo} 的 Release ${version}（已尝试 tag v${version} 与 ${version}）。\n处理：确认版本号；或省略版本号安装最新版本：asg extensions install ${repo}`,
    );
  }
}

async function downloadAsset(
  url: string,
  dest: string,
  label: string,
  deps: InstallDeps,
  request: RequestOptions,
): Promise<void> {
  assertHttps(url, label);
  try {
    await deps.download(url, dest, request);
  } catch (error) {
    throw toDownloadError(error, `下载 ${label}`);
  }
}

export function parseChecksums(text: string): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
    if (!match) continue;
    const name = match[2]!.trim().replace(/^\.\//, "");
    if (name) checksums.set(name, match[1]!.toLowerCase());
  }
  return checksums;
}

async function verifyChecksum(
  dir: string,
  file: string,
  checksums: Map<string, string>,
  deps: InstallDeps,
): Promise<void> {
  const expected = checksums.get(file);
  if (!expected) {
    throw new CliError("PLUGIN_FAILED", EXIT.FAIL, `SHA256SUMS 缺少 ${file} 的校验值`);
  }
  const actual = (await deps.sha256File(path.join(dir, file))).toLowerCase();
  if (actual !== expected) {
    throw new CliError(
      "PLUGIN_FAILED",
      EXIT.FAIL,
      `SHA256 校验失败：${file}\n  期望: ${expected}\n  实际: ${actual}`,
    );
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/** 旧目录先移到 .trash-*，再把 staging 换到正式目录；换入失败时回滚旧目录。 */
async function swapIntoPlace(
  target: string,
  staging: string,
  extensionsDir: string,
  id: string,
  rand: string,
): Promise<string | null> {
  let trash: string | null = null;
  if (await exists(target)) {
    trash = path.join(extensionsDir, `.trash-${id}-${rand}`);
    await fsp.rename(target, trash);
  }

  try {
    await fsp.rename(staging, target);
  } catch (error) {
    if (trash) {
      await fsp.rename(trash, target).catch(() => {});
    }
    throw new CliError(
      "PLUGIN_FAILED",
      EXIT.FAIL,
      `安装 ${id} 失败：无法替换目标目录（${messageOf(error)}）`,
    );
  }

  return trash;
}

function declaredBackends(manifest: ExtensionManifest): ExtensionBackend[] {
  return manifest.backends ?? [];
}

function declaredFetchChannels(manifest: ExtensionManifest): ExtensionFetchChannel[] {
  return manifest.fetch_channels ?? [];
}

function declaredSearchEngines(manifest: ExtensionManifest): ExtensionSearchEngine[] {
  return manifest.search_engines ?? [];
}

export function extensionsDir(root: string): string {
  return path.join(root, "data", "extensions");
}

/**
 * 安装单个插件。
 *
 * 目录布局：`<root>/data/extensions/<id>/`，目录存在即视为已安装。
 * 下载、校验全部在 `.staging-*` 中完成，成功后原子替换正式目录。
 */
export async function installExtension(
  options: InstallExtensionOptions,
): Promise<InstalledExtensionInfo> {
  const { root, repo, logger = () => {} } = options;
  if (!isValidRepo(repo)) {
    throw new CliError(
      "PLUGIN_FAILED",
      EXIT.INVALID,
      `仓库格式应为 owner/name：${repo}`,
    );
  }

  const version = options.version === undefined ? undefined : normalizeVersionInput(options.version);
  const deps: InstallDeps = { ...DEFAULT_DEPS, ...options.deps };
  const random = deps.random ?? DEFAULT_RANDOM;
  const token = githubToken();
  const request: RequestOptions = {
    token,
    logger,
    headers: githubHeaders(token),
  };

  const release = await resolveRelease(repo, version, deps, request);
  logger(`已找到 release ${release.tag}`);

  const manifestUrl = release.assets.get(V2_MANIFEST_FILE);
  if (!manifestUrl) {
    throw new CliError(
      "PLUGIN_FAILED",
      EXIT.INVALID,
      `release ${release.tag} 缺少资产 ${V2_MANIFEST_FILE}（0.4.0 起不再接受 ${LEGACY_MANIFEST_FILE}）`,
    );
  }
  const checksumsUrl = release.assets.get(CHECKSUMS_FILE);
  if (!checksumsUrl) {
    throw new CliError(
      "PLUGIN_FAILED",
      EXIT.INVALID,
      `release ${release.tag} 缺少资产 ${CHECKSUMS_FILE}`,
    );
  }

  const baseDir = extensionsDir(root);
  await fsp.mkdir(baseDir, { recursive: true });

  const rand = (random() || "0").replace(/[^A-Za-z0-9]/g, "") || "0";
  const pending = path.join(baseDir, `.staging-pending-${rand}`);
  let staging: string | null = null;
  let success = false;

  try {
    await fsp.mkdir(pending, { recursive: false });
    logger(`下载 ${V2_MANIFEST_FILE}`);
    await downloadAsset(
      manifestUrl,
      path.join(pending, V2_MANIFEST_FILE),
      V2_MANIFEST_FILE,
      deps,
      request,
    );

    let manifest: ExtensionManifest;
    try {
      manifest = parseManifest(
        await fsp.readFile(path.join(pending, V2_MANIFEST_FILE), "utf8"),
        V2_MANIFEST_FILE,
      );
    } catch (error) {
      throw new CliError(
        "PLUGIN_FAILED",
        EXIT.INVALID,
        `插件 manifest 校验失败：${messageOf(error)}`,
      );
    }

    assertInstallableId(manifest.id);
    if (version && manifest.version !== version) {
      throw new CliError(
        "PLUGIN_FAILED",
        EXIT.INVALID,
        `请求版本 ${version} 与 manifest.version ${manifest.version} 不一致`,
      );
    }
    const tagVersion = release.tag.replace(/^[vV]/, "");
    if (tagVersion !== manifest.version) {
      throw new CliError(
        "PLUGIN_FAILED",
        EXIT.INVALID,
        `Release tag ${release.tag} 与 manifest.version ${manifest.version} 不一致`,
      );
    }

    if (!isValidEntryName(manifest.entry)) {
      throw new CliError(
        "PLUGIN_FAILED",
        EXIT.INVALID,
        `manifest.entry 不合法：${manifest.entry}`,
      );
    }
    const entryUrl = release.assets.get(manifest.entry);
    if (!entryUrl) {
      throw new CliError(
        "PLUGIN_FAILED",
        EXIT.INVALID,
        `release ${release.tag} 缺少 manifest.entry 指向的资产 ${manifest.entry}`,
      );
    }

    staging = path.join(baseDir, `.staging-${manifest.id}-${rand}`);
    await fsp.rename(pending, staging);

    logger(`下载 ${manifest.entry} 与 ${CHECKSUMS_FILE}`);
    await downloadAsset(
      entryUrl,
      path.join(staging, manifest.entry),
      manifest.entry,
      deps,
      request,
    );
    await downloadAsset(
      checksumsUrl,
      path.join(staging, CHECKSUMS_FILE),
      CHECKSUMS_FILE,
      deps,
      request,
    );

    const checksums = parseChecksums(
      await fsp.readFile(path.join(staging, CHECKSUMS_FILE), "utf8"),
    );
    await verifyChecksum(staging, V2_MANIFEST_FILE, checksums, deps);
    await verifyChecksum(staging, manifest.entry, checksums, deps);

    const target = path.join(baseDir, manifest.id);
    const trash = await swapIntoPlace(target, staging, baseDir, manifest.id, rand);
    success = true;
    if (trash) {
      await fsp.rm(trash, { recursive: true, force: true }).catch((error: unknown) => {
        logger(`警告：旧目录未能删除（${trash}）：${messageOf(error)}`);
      });
    }

    logger(`已安装 ${manifest.id} ${manifest.version}`);
    return {
      id: manifest.id,
      version: manifest.version,
      name: manifest.name,
      provides: manifest.provides,
      backends: declaredBackends(manifest),
      fetch_channels: declaredFetchChannels(manifest),
      search_engines: declaredSearchEngines(manifest),
      path: target,
    };
  } finally {
    if (!success) {
      await fsp.rm(pending, { recursive: true, force: true }).catch(() => {});
      if (staging) {
        await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}

/** 读取本地安装目录；单个坏包返回带 error 的条目，不中断整条命令。 */
export function listExtensions(root: string): InstalledExtension[] {
  const baseDir = extensionsDir(root);
  let entries: Dirent[];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new CliError("PLUGIN_FAILED", EXIT.FAIL, `无法读取扩展目录：${messageOf(error)}`);
  }

  const items: InstalledExtension[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = path.join(baseDir, entry.name);
    const manifestPath = path.join(dir, V2_MANIFEST_FILE);

    if (!fs.existsSync(manifestPath)) {
      const onlyLegacy = fs.existsSync(path.join(dir, LEGACY_MANIFEST_FILE));
      items.push({
        id: entry.name,
        path: dir,
        error: onlyLegacy ? LEGACY_UPGRADE_MESSAGE : `未找到 ${V2_MANIFEST_FILE}`,
      });
      continue;
    }

    let text: string;
    try {
      text = fs.readFileSync(manifestPath, "utf8");
    } catch (error) {
      items.push({
        id: entry.name,
        path: dir,
        error: `无法读取 ${V2_MANIFEST_FILE}：${messageOf(error)}`,
      });
      continue;
    }

    let manifest: ExtensionManifest;
    try {
      manifest = parseManifest(text, V2_MANIFEST_FILE);
    } catch (error) {
      items.push({ id: entry.name, path: dir, error: messageOf(error) });
      continue;
    }

    const item: InstalledExtension = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      provides: manifest.provides,
      backends: declaredBackends(manifest),
      fetch_channels: declaredFetchChannels(manifest),
      search_engines: declaredSearchEngines(manifest),
      entry: manifest.entry,
      path: dir,
    };
    if (manifest.id !== entry.name) {
      item.error = `目录名 ${entry.name} 与 manifest.id ${manifest.id} 不一致`;
    }
    items.push(item);
  }

  return items.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 读取单个已安装插件的 manifest。
 *
 * 与 `listExtensions` 的区别是「单个目标」：未安装 / manifest 损坏 / 目录名不一致
 * 都直接抛 CliError，供 `asg extensions config` 之类需要插件声明的命令使用。
 */
export function loadInstalledManifest(root: string, id: string): ExtensionManifest {
  if (!isValidExtensionId(id)) {
    throw new CliError("PLUGIN_FAILED", EXIT.INVALID, `插件 id 不合法：${id}`);
  }

  const dir = path.join(extensionsDir(root), id);
  const manifestPath = path.join(dir, V2_MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    if (fs.existsSync(path.join(dir, LEGACY_MANIFEST_FILE))) {
      throw new CliError("PLUGIN_FAILED", EXIT.INVALID, LEGACY_UPGRADE_MESSAGE);
    }
    throw new CliError("PLUGIN_UNKNOWN", EXIT.MISSING, `未安装插件：${id}`);
  }

  let text: string;
  try {
    text = fs.readFileSync(manifestPath, "utf8");
  } catch (error) {
    throw new CliError(
      "PLUGIN_FAILED",
      EXIT.INVALID,
      `无法读取插件 manifest：${messageOf(error)}`,
    );
  }

  let manifest: ExtensionManifest;
  try {
    manifest = parseManifest(text, V2_MANIFEST_FILE);
  } catch (error) {
    throw new CliError(
      "PLUGIN_FAILED",
      EXIT.INVALID,
      `插件 manifest 校验失败：${messageOf(error)}`,
    );
  }

  if (manifest.id !== id) {
    throw new CliError(
      "PLUGIN_FAILED",
      EXIT.INVALID,
      `目录名 ${id} 与 manifest.id ${manifest.id} 不一致`,
    );
  }

  return manifest;
}

/** 卸载第三方插件：只删 data/extensions/<id>，不触碰网关配置。 */
export async function removeExtension(
  root: string,
  id: string,
): Promise<{ id: string; removed: true }> {
  if (!isValidExtensionId(id)) {
    throw new CliError("PLUGIN_UNKNOWN", EXIT.INVALID, `插件 id 不合法：${id}`);
  }

  const target = path.join(extensionsDir(root), id);
  if (!(await exists(target))) {
    throw new CliError("PLUGIN_UNKNOWN", EXIT.INVALID, `未安装第三方扩展：${id}`);
  }

  try {
    await fsp.rm(target, { recursive: true, force: true });
  } catch (error) {
    throw new CliError("PLUGIN_FAILED", EXIT.FAIL, `删除扩展 ${id} 失败：${messageOf(error)}`);
  }
  return { id, removed: true };
}

/** 搜索 GitHub 上带 asg-plugin topic 的仓库。 */
export async function searchExtensions(
  options: SearchExtensionsOptions = {},
): Promise<ExtensionSearchItem[]> {
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new CliError("PLUGIN_FAILED", EXIT.INVALID, "limit 必须是 1..100 的整数");
  }

  const query = options.query?.trim();
  const terms = ["topic:asg-plugin", "fork:false", "archived:false"];
  if (query) {
    const encoded = encodeURIComponent(query).replace(/%20/g, "+");
    terms.push(`${encoded} in:name,description`);
  }
  const url =
    "https://api.github.com/search/repositories" +
    `?q=${terms.join("+")}&sort=updated&order=desc&per_page=${limit}`;
  const token = (options.token ?? githubToken()).trim();
  const deps: InstallDeps = { ...DEFAULT_DEPS, ...options.deps };
  const request: RequestOptions = {
    token,
    logger: options.logger,
    headers: githubHeaders(token, options.userAgent),
  };

  let data: unknown;
  try {
    data = await deps.fetchJson(url, request);
  } catch (error) {
    throw toDownloadError(error, "搜索扩展");
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const record = data as Record<string, unknown>;
  if (!Array.isArray(record.items)) return [];

  const items: ExtensionSearchItem[] = [];
  for (const raw of record.items) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.full_name !== "string") continue;
    items.push({
      repo: item.full_name,
      description: typeof item.description === "string" ? item.description : "",
      url:
        typeof item.html_url === "string"
          ? item.html_url
          : `https://github.com/${item.full_name}`,
      stars: typeof item.stargazers_count === "number" ? item.stargazers_count : 0,
      updated_at: typeof item.updated_at === "string" ? item.updated_at : "",
    });
  }
  return items;
}
