#!/usr/bin/env node
/**
 * agent_search_gateway 自更新 CLI（共享实现）
 *
 * 职责：
 *   1. 查询 GitHub Release，定位当前平台对应的 CI 预构建产物；
 *   2. 下载并校验 SHA256；
 *   3. 解压到 data/releases/<version>-<platform>/；
 *   4. 切换 data/current（符号链接）或 data/current.json；
 *   5. 重启服务并做健康检查，失败自动回滚。
 *
 * 各操作系统的薄包装（linux.sh / macos.sh / windows.ps1）只负责准备 Node.js，
 * 最终都会执行本文件。所有路径均相对仓库根（scripts/self-update/ 的上两级）。
 */

import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const DEFAULT_REPO = 'djasdh/agent_search_gateway';
const GITHUB_API = 'https://api.github.com';
const MIN_NODE_VERSION = '20.18.1';
const RELEASES_KEEP = 3;
const HEALTH_TIMEOUT_MS = 30000;
const HEALTH_INTERVAL_MS = 1000;

// 代理环境变量（curl 会自动读取；这里用于决定下载顺序与错误提示）
const PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
];

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 平台标识映射：process.platform + process.arch -> 发布资产平台后缀
const PLATFORM_MAP = {
  linux: { x64: 'linux-x64', arm64: 'linux-arm64' },
  darwin: { x64: 'darwin-x64', arm64: 'darwin-arm64' },
  win32: { x64: 'win32-x64' },
};

const USAGE = `用法: node scripts/self-update/cli.mjs [选项]

拉取 GitHub Release 中的 CI 预构建产物，并完整更新当前安装。

选项:
  --version <v>       安装指定版本（可省略前缀 v，例如 1.2.3 或 v1.2.3）
  --repo <owner/name> 覆盖默认仓库（默认 ${DEFAULT_REPO}）
  --check             只检查是否有可用更新，不下载、不切换
  --no-restart        更新后不重启服务
  --force             即使版本相同也强制重新安装
  -h, --help          显示本帮助

环境变量:
  GITHUB_TOKEN        GitHub 令牌，用于避免 API 限流
  HTTPS_PROXY         代理地址；设置后优先用系统 curl/wget 下载资产
                      （也支持 https_proxy / HTTP_PROXY / ALL_PROXY 等）

说明:
  - gateway.yaml、secrets.yaml 与 data/ 始终保留在仓库根，不随版本切换；
  - 安装包先校验 SHA256，再解压到 data/releases/<版本>-<平台>/；
  - Linux/macOS 维护 data/current 符号链接（文件系统不支持时退化为
    data/current.json）；Windows 只使用 data/current.json；
  - 更新后自动重启并轮询 /health，失败会自动回滚到上一版本。
`;

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

/** 带退出码的错误（2 = 用法错误，1 = 运行错误） */
export class UpdateError extends Error {
  constructor(message, exitCode = 1, status = null) {
    super(message);
    this.name = 'UpdateError';
    this.exitCode = exitCode;
    this.status = status;
  }
}

function log(message) {
  process.stdout.write(`[self-update] ${message}\n`);
}

function warn(message) {
  process.stderr.write(`[self-update] 警告: ${message}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomSuffix() {
  return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function truncate(text, max) {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function isFile(target) {
  try {
    return (await fsp.stat(target)).isFile();
  } catch {
    return false;
  }
}

/** child 是否位于 parent 目录内（两者都应为绝对路径） */
export function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function assertInside(child, parent, label) {
  if (!isInside(child, parent)) {
    throw new UpdateError(`${label || '目标路径'} 越界：${child} 不在 ${parent} 内`);
  }
}

/** 解析版本号数字段，用于 Node.js 版本比较 */
function versionParts(value) {
  return String(value)
    .replace(/^v/i, '')
    .split('-')[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
}

/** a >= b */
export function versionGte(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < Math.max(left.length, right.length, 3); i += 1) {
    const x = left[i] || 0;
    const y = right[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 参数与版本
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = {
    version: null,
    repo: null,
    check: false,
    noRestart: false,
    force: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    if (arg === '--check') {
      opts.check = true;
      continue;
    }
    if (arg === '--no-restart') {
      opts.noRestart = true;
      continue;
    }
    if (arg === '--force') {
      opts.force = true;
      continue;
    }
    if (arg === '--version' || arg.startsWith('--version=')) {
      const value = arg === '--version' ? argv[++i] : arg.slice('--version='.length);
      if (!value || value.startsWith('-')) {
        throw new UpdateError('--version 需要一个版本号，例如 --version 1.2.3', 2);
      }
      opts.version = value;
      continue;
    }
    if (arg === '--repo' || arg.startsWith('--repo=')) {
      const value = arg === '--repo' ? argv[++i] : arg.slice('--repo='.length);
      if (!value) {
        throw new UpdateError('--repo 需要一个 owner/name 形式的仓库名', 2);
      }
      opts.repo = value;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new UpdateError(`未知参数: ${arg}\n\n${USAGE}`, 2);
    }
    throw new UpdateError(`不支持的位置参数: ${arg}\n\n${USAGE}`, 2);
  }

  if (opts.repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(opts.repo)) {
    throw new UpdateError(`--repo 格式错误: ${opts.repo}（应为 owner/name）`, 2);
  }

  return opts;
}

/** 去掉版本号前缀 v，并拒绝可能造成路径穿越的字符 */
export function normalizeVersion(value) {
  const version = String(value || '')
    .trim()
    .replace(/^v/i, '');
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(version) || version.includes('..')) {
    throw new UpdateError(`版本号不合法: ${value}`);
  }
  return version;
}

export function resolveRepoRoot() {
  return path.resolve(HERE, '..', '..');
}

export function checkNodeRuntime() {
  const current = process.versions.node;
  if (!versionGte(current, MIN_NODE_VERSION)) {
    throw new UpdateError(
      `当前 Node.js 版本 ${current} 过低，至少需要 ${MIN_NODE_VERSION}。` +
        '\n请通过 scripts/self-update/ 下的包装脚本运行，它会自动准备 Node.js。',
    );
  }
}

// ---------------------------------------------------------------------------
// 平台与资产
// ---------------------------------------------------------------------------

export function platformTag(platform = process.platform, arch = process.arch) {
  const tag = PLATFORM_MAP[platform] && PLATFORM_MAP[platform][arch];
  if (!tag) {
    const supported = Object.entries(PLATFORM_MAP)
      .flatMap(([os, arches]) => Object.keys(arches).map((a) => `${os}/${a}`))
      .join('、');
    throw new UpdateError(`不支持的平台: ${platform}/${arch}。当前支持: ${supported}`);
  }
  return tag;
}

export function archiveKind(platform) {
  return platform.startsWith('win32') ? 'zip' : 'tar.gz';
}

export function buildAssetName(version, platform) {
  return `agent-search-gateway-${version}-${platform}.${archiveKind(platform)}`;
}

export function selectAsset(release, name) {
  const asset = (release.assets || []).find((item) => item && item.name === name);
  if (!asset) {
    const names = (release.assets || [])
      .map((item) => item && item.name)
      .filter(Boolean)
      .join(', ');
    throw new UpdateError(
      `Release ${release.version} 中未找到资产 ${name}。\n现有资产: ${names || '(无)'}`,
    );
  }
  return asset;
}

// ---------------------------------------------------------------------------
// HTTP / GitHub API
// ---------------------------------------------------------------------------

function assertHttps(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new UpdateError(`URL 不合法: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new UpdateError(`安全限制：只允许 https 请求，收到 ${url}`);
  }
  return parsed;
}

/** 返回首个非空的代理环境变量名，没有则返回 null */
export function proxyEnvName() {
  for (const key of PROXY_ENV_KEYS) {
    if (process.env[key] && process.env[key].trim()) return key;
  }
  return null;
}

function authHeaders(url, token, accept) {
  const headers = {
    'User-Agent': 'agent-search-gateway-self-update',
    Accept: accept || 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  // 令牌只发给 api.github.com，避免泄露给其他主机
  if (token && assertHttps(url).hostname === 'api.github.com') {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new UpdateError(`请求超时（${Math.round(timeoutMs / 1000)} 秒）: ${url}`);
    }
    throw new UpdateError(`网络请求失败: ${url}\n${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, token) {
  assertHttps(url);
  const res = await fetchWithTimeout(url, { headers: authHeaders(url, token) });
  const text = await res.text();
  if (!res.ok) {
    throw new UpdateError(
      `GitHub API 请求失败 (${res.status} ${res.statusText || ''}): ${url}\n${truncate(text, 500)}`,
      1,
      res.status,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UpdateError(`GitHub API 返回的内容不是合法 JSON: ${url}`);
  }
}

function toRelease(data) {
  if (!data || typeof data !== 'object') {
    throw new UpdateError('Release 数据格式异常');
  }
  const version = normalizeVersion(data.tag_name || data.name || '');
  return {
    version,
    tagName: data.tag_name || '',
    assets: Array.isArray(data.assets) ? data.assets : [],
    htmlUrl: data.html_url || '',
    publishedAt: data.published_at || '',
  };
}

/** 查询 latest Release，或按 --version 查询指定 tag */
export async function resolveRelease({ repo, version, token }) {
  const base = `${GITHUB_API}/repos/${repo}/releases`;

  if (version) {
    const candidates = [`${base}/tags/v${version}`, `${base}/tags/${version}`];
    let lastError = null;
    for (const url of candidates) {
      try {
        return toRelease(await fetchJson(url, token));
      } catch (error) {
        lastError = error;
        if (error.status !== 404) throw error;
      }
    }
    throw new UpdateError(
      `未找到版本 ${version} 的 Release（仓库 ${repo}）。${lastError ? `\n${lastError.message.split('\n')[0]}` : ''}`,
    );
  }

  try {
    return toRelease(await fetchJson(`${base}/latest`, token));
  } catch (error) {
    if (error.status === 404) {
      throw new UpdateError(`仓库 ${repo} 还没有任何 Release（或无法访问）。`);
    }
    throw error;
  }
}

async function downloadWithFetch(url, tmp, headers) {
  const res = await fetchWithTimeout(
    url,
    { headers, redirect: 'follow' },
    120000,
  );

  if (!res.ok) {
    throw new UpdateError(`下载失败 (${res.status} ${res.statusText || ''}): ${url}`);
  }
  if (!res.body) {
    throw new UpdateError(`下载响应为空: ${url}`);
  }
  // 跟随重定向后仍然要求 https
  assertHttps(res.url || url);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
}

async function downloadWithCurl(url, tmp, headers) {
  // Windows 10+ 自带 curl.exe
  const command = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const args = [
    '--fail',
    '--location',
    '--silent',
    '--show-error',
    '--retry',
    '2',
    '--connect-timeout',
    '20',
    '--max-time',
    '600',
    // 限制初始请求与重定向都只能使用 https
    '--proto',
    '=https',
  ];
  for (const [key, value] of Object.entries(headers)) {
    args.push('-H', `${key}: ${value}`);
  }
  args.push('--output', tmp, url);

  const result = await run(command, args);
  if (result.code !== 0) {
    const detail = truncate(result.stderr, 500);
    throw new UpdateError(`curl 退出码 ${result.code}${detail ? `：${detail}` : ''}`);
  }
}

/** 让只认小写代理变量的 wget 也能复用大写变量 */
function wgetProxyEnv() {
  const env = { ...process.env };
  const aliases = [
    ['HTTPS_PROXY', 'https_proxy'],
    ['HTTP_PROXY', 'http_proxy'],
    ['ALL_PROXY', 'all_proxy'],
    ['NO_PROXY', 'no_proxy'],
  ];
  for (const [upper, lower] of aliases) {
    if (!env[lower] && env[upper]) env[lower] = env[upper];
  }
  return env;
}

async function downloadWithWget(url, tmp, headers) {
  const command = process.platform === 'win32' ? 'wget.exe' : 'wget';
  // --server-response 用于检查每一跳重定向；--https-only 只覆盖递归模式，
  // 因此还需要在下面自行校验 Location 头。
  const args = [
    '-nv',
    '--server-response',
    '--https-only',
    '--max-redirect=5',
    '--timeout=60',
    '--tries=2',
  ];
  for (const [key, value] of Object.entries(headers)) {
    args.push('--header', `${key}: ${value}`);
  }
  args.push('-O', tmp, url);

  const result = await run(command, args, { env: wgetProxyEnv() });
  if (result.code !== 0) {
    const detail = truncate(result.stderr, 500);
    throw new UpdateError(`wget 退出码 ${result.code}${detail ? `：${detail}` : ''}`);
  }

  // 逐跳解析 Location，拒绝任何降级到 http 的重定向
  let current = url;
  for (const match of result.stderr.matchAll(/^\s*Location:\s*(\S+)\s*$/gim)) {
    let next;
    try {
      next = new URL(match[1], current);
    } catch {
      throw new UpdateError(`wget 重定向地址不合法: ${match[1]}`);
    }
    if (next.protocol !== 'https:') {
      throw new UpdateError(`安全限制：wget 尝试重定向到非 https 地址 ${next.href}`);
    }
    current = next.href;
  }
}

/**
 * 下载到与目标同目录的临时文件，成功后原子 rename。
 *
 * 顺序：
 *   - 检测到代理变量：curl -> wget -> Node fetch（curl/wget 会读取代理环境变量）
 *   - 未检测到代理：Node fetch -> curl -> wget
 * 全部失败时删除临时文件，并给出代理设置提示。
 */
export async function downloadFile(url, dest, token) {
  assertHttps(url);
  const isApiHost = assertHttps(url).hostname === 'api.github.com';
  const headers = authHeaders(
    url,
    token,
    isApiHost ? 'application/octet-stream' : '*/*',
  );
  const proxyKey = proxyEnvName();

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part-${randomSuffix()}`;
  const attempts = [];

  const viaFetch = () => downloadWithFetch(url, tmp, headers);
  const viaCurl = () => downloadWithCurl(url, tmp, headers);
  const viaWget = () => downloadWithWget(url, tmp, headers);

  const sequence = proxyKey
    ? [
        ['curl', viaCurl],
        ['wget', viaWget],
        ['Node fetch', viaFetch],
      ]
    : [
        ['Node fetch', viaFetch],
        ['curl', viaCurl],
        ['wget', viaWget],
      ];

  try {
    for (const [label, attempt] of sequence) {
      try {
        await attempt();
        const stat = await fsp.stat(tmp);
        if (!stat.isFile() || stat.size === 0) {
          throw new UpdateError('下载内容为空');
        }
        await fsp.rename(tmp, dest);
        if (label !== 'Node fetch') {
          log(`已通过 ${label} 下载: ${path.basename(dest)}`);
        }
        return label;
      } catch (error) {
        const reason = truncate(
          error && error.message ? error.message : String(error),
          500,
        ).replace(/\s*\n\s*/g, ' ');
        attempts.push(`${label}: ${reason}`);
        await fsp.rm(tmp, { force: true }).catch(() => {});
        if (proxyKey && label === 'curl') {
          warn('curl 下载失败，继续尝试 wget / Node fetch。');
        } else if (!proxyKey && label === 'Node fetch') {
          warn('内置 fetch 下载失败，尝试回退到 curl/wget ...');
        }
      }
    }
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }

  const detail = attempts.map((item, index) => `  ${index + 1}. ${item}`).join('\n');
  const hint = proxyKey
    ? `已检测到代理环境变量 ${proxyKey}；请确认代理可用（例如 HTTPS_PROXY=http://127.0.0.1:7897），并检查 NO_PROXY 设置。`
    : '若在代理环境，请设置 HTTPS_PROXY（或 https_proxy），例如 HTTPS_PROXY=http://127.0.0.1:7897 后重试。';

  throw new UpdateError(`下载失败: ${url}\n${detail}\n${hint}`);
}

// ---------------------------------------------------------------------------
// 校验和
// ---------------------------------------------------------------------------

export function parseChecksums(text) {
  const map = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(trimmed);
    if (!match) continue;
    let name = match[2].trim();
    if (name.startsWith('./')) name = name.slice(2);
    map.set(name, match[1].toLowerCase());
  }
  return map;
}

export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

/**
 * 校验文件 SHA256；不匹配时删除文件并抛错（要求：校验失败不得继续解压）。
 */
export async function verifySha256(file, fileName, sums) {
  const expected = sums.get(fileName);
  if (!expected) {
    await fsp.rm(file, { force: true }).catch(() => {});
    throw new UpdateError(`SHA256SUMS 中没有 ${fileName} 的记录，已删除下载文件。`);
  }
  const actual = await sha256File(file);
  if (actual !== expected) {
    await fsp.rm(file, { force: true }).catch(() => {});
    throw new UpdateError(
      `SHA256 校验失败: ${fileName}\n  期望: ${expected}\n  实际: ${actual}\n已删除下载文件。`,
    );
  }
  return actual;
}

// ---------------------------------------------------------------------------
// 归档解压
// ---------------------------------------------------------------------------

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env || process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function tryRun(command, args, options) {
  try {
    const result = await run(command, args, options);
    return result.code === 0 ? result.stdout : null;
  } catch {
    return null;
  }
}

function splitLines(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function listZipWithPowerShell(file) {
  const script =
    'Add-Type -AssemblyName System.IO.Compression.FileSystem; ' +
    '$zip = [System.IO.Compression.ZipFile]::OpenRead($env:ASG_ARCHIVE); ' +
    'try { $zip.Entries | ForEach-Object { $_.FullName } } finally { $zip.Dispose() }';
  return tryRun('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, ASG_ARCHIVE: file },
  });
}

export async function listArchiveEntries(file, kind) {
  if (kind === 'zip') {
    if (process.platform === 'win32') {
      let output = await tryRun('tar', ['-tf', file]);
      if (output === null) output = await listZipWithPowerShell(file);
      if (output === null) {
        throw new UpdateError('无法读取 zip 内容：系统 tar 与 PowerShell 均不可用。');
      }
      return splitLines(output);
    }
    let output = await tryRun('unzip', ['-Z1', file]);
    if (output === null) output = await tryRun('tar', ['-tf', file]);
    if (output === null) {
      throw new UpdateError('无法读取 zip 内容：请安装 unzip 或使用支持 zip 的 tar。');
    }
    return splitLines(output);
  }

  const output = await tryRun('tar', ['-tzf', file]);
  if (output === null) {
    throw new UpdateError('无法读取 tar.gz 内容：系统 tar 不可用或文件已损坏。');
  }
  return splitLines(output);
}

/** 拒绝绝对路径与 ../，防止解压时路径穿越 */
export function validateArchiveEntries(entries) {
  for (const raw of entries) {
    const name = String(raw).replace(/\\/g, '/');
    if (!name) continue;
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
      throw new UpdateError(`安装包包含绝对路径条目，拒绝解压: ${raw}`);
    }
    if (name.split('/').includes('..')) {
      throw new UpdateError(`安装包包含路径穿越条目，拒绝解压: ${raw}`);
    }
    if (name.includes('\0')) {
      throw new UpdateError('安装包包含非法字符，拒绝解压。');
    }
  }
}

async function extractWithPowerShell(file, destDir) {
  const script =
    'Expand-Archive -LiteralPath $env:ASG_ARCHIVE -DestinationPath $env:ASG_DEST -Force';
  const result = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, ASG_ARCHIVE: file, ASG_DEST: destDir },
  });
  if (result.code !== 0) {
    throw new UpdateError(`PowerShell Expand-Archive 解压失败:\n${truncate(result.stderr, 800)}`);
  }
}

export async function extractArchive(file, kind, destDir) {
  // 先列出条目，确认没有绝对路径 / ../ 再解压
  const entries = await listArchiveEntries(file, kind);
  validateArchiveEntries(entries);

  if (kind === 'tar.gz') {
    const result = await run('tar', ['-xzf', file, '-C', destDir]);
    if (result.code !== 0) {
      throw new UpdateError(`tar 解压失败:\n${truncate(result.stderr, 800)}`);
    }
    return;
  }

  // Windows 优先 Expand-Archive：兼容 Compress-Archive 生成的 \ 分隔条目。
  if (process.platform === 'win32') {
    await extractWithPowerShell(file, destDir);
    return;
  }

  // 其它平台优先系统 tar（Windows 10+ 的 bsdtar 也支持 zip），失败再换工具
  let result = await run('tar', ['-xf', file, '-C', destDir]);
  if (result.code === 0) return;

  result = await run('unzip', ['-q', '-o', file, '-d', destDir]);
  if (result.code !== 0) {
    throw new UpdateError(
      `zip 解压失败（tar 与 unzip 均不可用）:\n${truncate(result.stderr, 800)}`,
    );
  }
}

/** 解压后检查：所有符号链接都不得指向临时目录之外 */
export async function assertTreeContained(rootDir) {
  const realRoot = await fsp.realpath(rootDir);

  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const stat = await fsp.lstat(full);
      if (stat.isSymbolicLink()) {
        const link = await fsp.readlink(full);
        const resolved = path.resolve(path.dirname(full), link);
        if (!isInside(resolved, realRoot)) {
          throw new UpdateError(
            `安装包包含指向外部的符号链接，拒绝使用: ${path.relative(realRoot, full)} -> ${link}`,
          );
        }
        try {
          const real = await fsp.realpath(full);
          if (!isInside(real, realRoot)) {
            throw new UpdateError(
              `安装包包含指向外部的符号链接，拒绝使用: ${path.relative(realRoot, full)}`,
            );
          }
        } catch (error) {
          if (error instanceof UpdateError) throw error;
          if (error.code !== 'ENOENT') throw error;
        }
      } else if (stat.isDirectory()) {
        await walk(full);
      }
    }
  }

  await walk(realRoot);
}

/** 在解压目录中定位真正的包根（要求包含 dist/index.js） */
export async function findPackageRoot(tmpDir) {
  const realTmp = await fsp.realpath(tmpDir);

  if (await isFile(path.join(realTmp, 'dist', 'index.js'))) {
    return realTmp;
  }

  const candidates = [];
  for (const entry of await fsp.readdir(realTmp, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(realTmp, entry.name);
    if (await isFile(path.join(candidate, 'dist', 'index.js'))) {
      candidates.push(candidate);
    }
  }

  if (candidates.length === 0) {
    throw new UpdateError('安装包内未找到 dist/index.js，资产结构不符合约定。');
  }
  if (candidates.length > 1) {
    throw new UpdateError(
      `安装包结构异常：发现多个包含 dist/index.js 的目录: ${candidates
        .map((item) => path.relative(realTmp, item))
        .join(', ')}`,
    );
  }
  return candidates[0];
}

// ---------------------------------------------------------------------------
// 状态文件
// ---------------------------------------------------------------------------

/** 安装状态读取；返回 installed = null 表示首次安装 */
export async function readInstalled(dataDir) {
  const file = path.join(dataDir, 'installed.json');
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { file, installed: null };
    }
    throw new UpdateError(`读取 ${file} 失败: ${error.message}`);
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new UpdateError(
      `data/installed.json 不是合法 JSON，请先修复或删除该文件（为避免误删版本，本次不继续）。`,
    );
  }

  // 兼容早期可能存在的平铺结构
  const currentSource = raw.current || (raw.version && raw.dir ? raw : null);
  const previousSource = raw.previous || null;

  const normalize = (source) => {
    if (!source || typeof source !== 'object') return null;
    if (typeof source.version !== 'string' || typeof source.dir !== 'string') return null;
    return {
      version: source.version,
      dir: source.dir,
      installedAt: source.installedAt || null,
    };
  };

  return {
    file,
    installed: {
      raw,
      current: normalize(currentSource),
      previous: normalize(previousSource),
    },
  };
}

export function resolveStoredPath(root, stored) {
  if (!stored) return null;
  return path.isAbsolute(stored) ? stored : path.resolve(root, stored);
}

export async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${randomSuffix()}`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, file);
}

export async function writeInstalled(dataDir, { repo, platform, current, previous, rollback }) {
  const payload = {
    schemaVersion: 1,
    repo,
    platform,
    current,
    previous: previous || null,
    updatedAt: new Date().toISOString(),
  };
  if (rollback) payload.lastRollback = rollback;
  await writeJsonAtomic(path.join(dataDir, 'installed.json'), payload);
  return payload;
}

/**
 * 写入当前版本：
 *   - 始终写 data/current.json（含 dir / version / previousDir / previousVersion）；
 *   - Linux/macOS 额外尝试原子替换 data/current 符号链接，失败则退化为仅 JSON。
 */
export async function writeCurrentState({
  root,
  dataDir,
  releaseDir,
  version,
  previousDir = null,
  previousVersion = null,
}) {
  // dir 使用绝对路径：gateway.ps1 会直接用 Join-Path $d.dir 定位入口，
  // 不依赖调用时的工作目录；gateway.sh 同样兼容绝对路径。
  const payload = {
    dir: path.resolve(releaseDir),
    version,
    previousDir: previousDir ? path.resolve(previousDir) : null,
    previousVersion: previousVersion || null,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(path.join(dataDir, 'current.json'), payload);

  let mode = 'json';
  if (process.platform !== 'win32') {
    const linkPath = path.join(dataDir, 'current');
    const tmpLink = `${linkPath}.tmp-${randomSuffix()}`;
    try {
      const target = path.relative(dataDir, releaseDir) || '.';
      await fsp.symlink(target, tmpLink, 'dir');
      await fsp.rename(tmpLink, linkPath);
      mode = 'symlink';
    } catch (error) {
      await fsp.rm(tmpLink, { force: true }).catch(() => {});
      // 移除可能残留、指向旧版本的符号链接，让使用方回退到 current.json
      try {
        const stat = await fsp.lstat(linkPath);
        if (stat.isSymbolicLink() || stat.isFile()) {
          await fsp.rm(linkPath, { force: true });
        }
      } catch {
        /* 不存在则忽略 */
      }
      warn(
        `文件系统不支持符号链接或创建失败（${error.code || error.message}），` +
          '已退化为使用 data/current.json。',
      );
    }
  }

  return { mode, payload };
}

/** 清理旧版本目录：保留最近 3 个，当前与 previous 永不删除 */
export async function cleanupReleases({ releasesRoot, protectedDirs = [], keep = RELEASES_KEEP }) {
  let entries;
  try {
    entries = await fsp.readdir(releasesRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { removed: [] };
    throw error;
  }

  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const full = path.join(releasesRoot, entry.name);
    let stat;
    try {
      stat = await fsp.stat(full);
    } catch {
      continue;
    }
    dirs.push({ name: entry.name, dir: full, mtime: stat.mtimeMs });
  }

  const protectedPaths = new Set();
  for (const item of protectedDirs.filter(Boolean)) {
    protectedPaths.add(path.resolve(item));
    try {
      protectedPaths.add(await fsp.realpath(item));
    } catch {
      /* previous 目录可能已被手工删除，忽略 */
    }
  }

  const sorted = dirs.sort((a, b) => b.mtime - a.mtime);
  const kept = new Set();
  for (const item of sorted) {
    if (protectedPaths.has(path.resolve(item.dir))) kept.add(item.dir);
  }

  let slots = Math.max(0, keep - kept.size);
  const removed = [];
  for (const item of sorted) {
    if (kept.has(item.dir)) continue;
    // 崩溃残留的备份目录直接清理（当前/上一版本已被保护）
    if (/\.old-\d+$/.test(item.name)) {
      removed.push(item);
      continue;
    }
    if (slots > 0) {
      slots -= 1;
      kept.add(item.dir);
      continue;
    }
    removed.push(item);
  }

  for (const item of removed) {
    try {
      await fsp.rm(item.dir, { recursive: true, force: true });
      log(`已清理旧版本目录: ${path.basename(item.dir)}`);
    } catch (error) {
      warn(`清理旧版本目录失败 ${path.basename(item.dir)}: ${error.message}`);
    }
  }

  return { removed: removed.map((item) => item.dir) };
}

// ---------------------------------------------------------------------------
// 网关端口 / 重启 / 健康检查
// ---------------------------------------------------------------------------

function parsePortFallback(text) {
  const lines = String(text).split(/\r?\n/);
  let inGateway = false;
  for (const line of lines) {
    if (/^gateway\s*:\s*(#.*)?$/.test(line)) {
      inGateway = true;
      continue;
    }
    if (inGateway && /^\S/.test(line) && !line.startsWith('#')) {
      break; // 已离开 gateway 块
    }
    if (inGateway) {
      const match = /^\s+port\s*:\s*["']?(\d+)["']?/.exec(line);
      if (match) return Number.parseInt(match[1], 10);
    }
  }
  const loose = /^\s+port\s*:\s*["']?(\d+)["']?/m.exec(String(text));
  return loose ? Number.parseInt(loose[1], 10) : null;
}

/** 从仓库根 gateway.yaml 读取 gateway.port，默认 3000 */
export async function readGatewayPort(root) {
  const file = path.join(root, 'gateway.yaml');
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return 3000;
    warn(`读取 gateway.yaml 失败（${error.message}），按默认端口 3000 处理。`);
    return 3000;
  }

  let port = null;
  try {
    // yaml 是项目依赖，按需加载；若缺失则退化为简单文本解析
    const yaml = await import('yaml');
    const doc = yaml.parse(text);
    const value = doc && doc.gateway ? doc.gateway.port : null;
    if (typeof value === 'number' && Number.isInteger(value)) port = value;
    else if (typeof value === 'string' && /^\d+$/.test(value)) port = Number.parseInt(value, 10);
  } catch (error) {
    warn(`解析 gateway.yaml 失败（${error.message}），尝试使用文本解析。`);
  }

  if (port === null) port = parsePortFallback(text);
  if (!port || port < 1 || port > 65535) {
    warn(`gateway.port 无效（${port}），按默认端口 3000 处理。`);
    return 3000;
  }
  return port;
}

function runInherit(command, args, { cwd, timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, stdio: 'inherit' });
    } catch (error) {
      resolve({ code: null, timedOut: false, error });
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      warn(`重启命令超过 ${Math.round(timeoutMs / 1000)} 秒，正在终止。`);
      try {
        child.kill('SIGTERM');
      } catch {
        /* 忽略 */
      }
      settled = true;
      resolve({ code: null, timedOut: true });
    }, timeoutMs);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, timedOut: false, error });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, timedOut: false });
    });
  });
}

export async function restartGateway(root) {
  const isWindows = process.platform === 'win32';

  // 安装器注册的用户级服务优先：start-all 是前台 supervisor，
  // 直接重启服务比杀 gateway 子进程更稳。
  if (!isWindows) {
    try {
      const active = await run(
        'systemctl',
        ['--user', 'is-active', 'agent-search-gateway.service'],
        { cwd: root },
      );
      if (active.code === 0) {
        log('重启 systemd 用户服务: agent-search-gateway.service');
        const result = await runInherit(
          'systemctl',
          ['--user', 'restart', 'agent-search-gateway.service'],
          { cwd: root },
        );
        return {
          ran: true,
          ok: result.code === 0,
          manual: 'systemctl --user restart agent-search-gateway.service',
        };
      }
    } catch {
      /* 没有 systemd 时回退 gateway.sh */
    }

    if (process.platform === 'darwin') {
      const uid = typeof process.getuid === 'function' ? process.getuid() : '';
      const label = 'com.djasdh.agent-search-gateway';
      try {
        const result = await runInherit(
          'launchctl',
          ['kickstart', '-k', `gui/${uid}/${label}`],
          { cwd: root },
        );
        if (result.code === 0) {
          return {
            ran: true,
            ok: true,
            manual: `launchctl kickstart -k gui/${uid}/${label}`,
          };
        }
      } catch {
        /* 回退 gateway.sh */
      }
    }
  } else {
    try {
      const query = await run('schtasks', ['/query', '/tn', 'AgentSearchGateway'], { cwd: root });
      if (query.code === 0) {
        await run('schtasks', ['/end', '/tn', 'AgentSearchGateway'], { cwd: root });
        const result = await runInherit('schtasks', ['/run', '/tn', 'AgentSearchGateway'], {
          cwd: root,
        });
        return { ran: true, ok: result.code === 0, manual: 'schtasks /run /tn AgentSearchGateway' };
      }
    } catch {
      /* 回退 gateway.ps1 */
    }
  }

  const script = path.join(root, 'scripts', isWindows ? 'gateway.ps1' : 'gateway.sh');
  const manual = isWindows
    ? 'powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\gateway.ps1 restart'
    : 'bash scripts/gateway.sh restart gateway';

  if (!(await pathExists(script))) {
    return { ran: false, ok: false, manual };
  }

  log(`重启服务: ${isWindows ? 'scripts/gateway.ps1 restart' : 'scripts/gateway.sh restart gateway'}`);
  const result = isWindows
    ? await runInherit(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'restart'],
        { cwd: root },
      )
    : await runInherit('bash', [script, 'restart', 'gateway'], { cwd: root });

  if (result.error) {
    warn(`重启命令执行失败: ${result.error.message}`);
  }
  return { ran: true, ok: result.code === 0, ...result, manual };
}

function healthTimeoutMs() {
  const raw = process.env.ASG_UPDATE_HEALTH_TIMEOUT_MS;
  if (raw && /^\d+$/.test(raw)) {
    const value = Number.parseInt(raw, 10);
    if (value > 0) return value;
  }
  return HEALTH_TIMEOUT_MS;
}

function healthIntervalMs() {
  const raw = process.env.ASG_UPDATE_HEALTH_INTERVAL_MS;
  if (raw && /^\d+$/.test(raw)) {
    const value = Number.parseInt(raw, 10);
    if (value > 0) return value;
  }
  return HEALTH_INTERVAL_MS;
}

/** 轮询 http://127.0.0.1:<port>/health，最多等待 timeoutMs */
export async function waitForHealth({ port, timeoutMs = HEALTH_TIMEOUT_MS, intervalMs = HEALTH_INTERVAL_MS }) {
  const url = `http://127.0.0.1:${port}/health`;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;
    try {
      const res = await fetchWithTimeout(
        url,
        {},
        Math.min(3000, Math.max(500, deadline - Date.now())),
      );
      if (res.ok) {
        // 尽快释放连接
        try {
          await res.arrayBuffer();
        } catch {
          /* 忽略 */
        }
        return true;
      }
    } catch {
      /* 服务尚未就绪，继续重试 */
    }
    const left = deadline - Date.now();
    if (left <= 0) break;
    if (attempt === 1 || attempt % 5 === 0) {
      log(`等待健康检查 ${url}（第 ${attempt} 次）...`);
    }
    await sleep(Math.min(intervalMs, left));
  }
  return false;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function releaseInfoLine(value) {
  return value || '(未知)';
}

async function printCheck({ release, repo, platform, assetName, currentVersion, currentDir }) {
  const asset = (release.assets || []).find((item) => item && item.name === assetName);
  const sums = (release.assets || []).find((item) => item && item.name === 'SHA256SUMS');
  const same =
    currentVersion === release.version &&
    currentDir &&
    path.basename(currentDir) === `${release.version}-${platform}`;

  const lines = [
    `仓库:       ${repo}`,
    `平台:       ${platform}`,
    `当前版本:   ${currentVersion || '未安装'}`,
    `目标版本:   ${release.version}`,
    `安装包:     ${assetName}`,
    `发布页:     ${releaseInfoLine(release.htmlUrl)}`,
    `发布时间:   ${releaseInfoLine(release.publishedAt)}`,
    `资产状态:   ${asset ? '已找到' : '缺失（CI 可能尚未完成构建）'}`,
    `校验文件:   ${sums ? '已找到' : '缺失'}`,
  ];

  if (!asset || !sums) {
    process.stdout.write(`${lines.join('\n')}\n`);
    throw new UpdateError(`Release ${release.version} 资产不完整，暂不能更新。`);
  }

  lines.push(`更新状态:   ${same ? '已是最新版本' : '有可用更新'}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

async function ensureDataDirs(dataDir) {
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(path.join(dataDir, 'download-cache'), { recursive: true });
  await fsp.mkdir(path.join(dataDir, 'releases'), { recursive: true });
  await fsp.mkdir(path.join(dataDir, 'update-tmp'), { recursive: true });
}

/** 切换版本后，如果 runtime/pins.json 里的依赖版本变化，调用新包的安装器更新依赖。 */
async function updateDepsIfNeeded({ root, targetDir }) {
  const pinsFile = path.join(targetDir, 'runtime', 'pins.json');
  const cli = path.join(targetDir, 'scripts', 'install', 'cli.mjs');
  if (!(await pathExists(pinsFile)) || !(await pathExists(cli))) {
    log('安装包不含 runtime/pins.json 或安装器，跳过依赖联动。');
    return { skipped: true };
  }

  let pins;
  try {
    pins = JSON.parse(await fsp.readFile(pinsFile, 'utf8'));
  } catch (error) {
    warn(`读取 runtime/pins.json 失败，跳过依赖联动: ${error.message}`);
    return { skipped: true };
  }

  const stateFile = path.join(root, 'data', 'runtime', 'deps.json');
  let state = null;
  try {
    state = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
  } catch {
    state = null;
  }
  const same =
    state &&
    JSON.stringify(state.searxng) === JSON.stringify(pins.searxng) &&
    JSON.stringify(state.flaresolverr) === JSON.stringify(pins.flaresolverr) &&
    state.playwright === pins.playwright;
  if (same) {
    log('依赖版本未变化，仅刷新 launch.json。');
    const result = await runInherit(
      process.execPath,
      [cli, '--install-root', root, '--launch-only'],
      { cwd: root },
    );
    if (result.code !== 0) warn('刷新 launch.json 失败；请检查日志。');
    return { skipped: true };
  }

  log('依赖版本变化，更新 searxng / FlareSolverr / Playwright ...');
  const result = await runInherit(process.execPath, [cli, '--install-root', root, '--deps-only'], {
    cwd: root,
  });
  if (result.code !== 0) {
    warn('依赖更新失败；网关仍会用现有依赖启动，请检查日志。');
    return { ok: false };
  }
  return { ok: true };
}

/**
 * 主入口：返回进程退出码。
 * 注意：只有在本机全部校验、解压完成后才会切换 current；
 * 任何失败都会保留（或恢复）上一可运行版本。
 */
export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  checkNodeRuntime();

  const root = resolveRepoRoot();
  const dataDir = path.join(root, 'data');
  const repo = opts.repo || DEFAULT_REPO;
  const token = (process.env.GITHUB_TOKEN || '').trim();
  const platform = platformTag();
  const requestedVersion = opts.version ? normalizeVersion(opts.version) : null;

  const { installed } = await readInstalled(dataDir);
  const current = installed ? installed.current : null;
  const currentDir = current ? resolveStoredPath(root, current.dir) : null;

  const release = await resolveRelease({ repo, version: requestedVersion, token });
  const version = release.version;
  const assetName = buildAssetName(version, platform);
  const kind = archiveKind(platform);

  if (opts.check) {
    return printCheck({
      release,
      repo,
      platform,
      assetName,
      currentVersion: current ? current.version : null,
      currentDir,
    });
  }

  const targetDirName = `${version}-${platform}`;
  const alreadyCurrent =
    current &&
    current.version === version &&
    currentDir &&
    path.basename(currentDir) === targetDirName;

  if (alreadyCurrent && !opts.force) {
    log(`当前已是最新版本 ${version}（平台 ${platform}），无需更新。`);
    return 0;
  }

  log(`准备更新: ${current ? current.version : '首次安装'} -> ${version}（平台 ${platform}）`);

  const releasesRoot = path.join(dataDir, 'releases');
  const cacheDir = path.join(dataDir, 'download-cache');
  const tmpBase = path.join(dataDir, 'update-tmp');
  const archivePath = path.join(cacheDir, assetName);
  const sumsPath = path.join(cacheDir, 'SHA256SUMS');
  const targetDir = path.join(releasesRoot, targetDirName);

  assertInside(targetDir, releasesRoot, '版本安装目录');
  await ensureDataDirs(dataDir);

  // ---- 1. 下载并校验 SHA256 ----
  const sumsAsset = selectAsset(release, 'SHA256SUMS');
  const archiveAsset = selectAsset(release, assetName);

  log('下载 SHA256SUMS ...');
  await downloadFile(sumsAsset.browser_download_url || sumsAsset.url, sumsPath, token);
  const sums = parseChecksums(await fsp.readFile(sumsPath, 'utf8'));
  if (sums.size === 0) {
    throw new UpdateError('SHA256SUMS 内容为空或格式无法识别。');
  }

  let verified = false;
  if (await pathExists(archivePath)) {
    try {
      await verifySha256(archivePath, assetName, sums);
      verified = true;
      log('复用已缓存的安装包（SHA256 校验通过）。');
    } catch (error) {
      warn(`缓存安装包不可用，将重新下载：${truncate(error.message, 300)}`);
    }
  }
  if (!verified) {
    log(`下载安装包 ${assetName} ...`);
    await downloadFile(archiveAsset.browser_download_url || archiveAsset.url, archivePath, token);
    await verifySha256(archivePath, assetName, sums);
  }
  log('SHA256 校验通过。');

  // ---- 2. 解压并校验结构 ----
  const tempDir = await fsp.mkdtemp(path.join(tmpBase, 'update-'));
  let stagedRoot = null;
  let moved = false;
  let backupDir = null;

  try {
    log('解压安装包 ...');
    await extractArchive(archivePath, kind, tempDir);
    await assertTreeContained(tempDir);
    stagedRoot = await findPackageRoot(tempDir);
    if (!isInside(stagedRoot, await fsp.realpath(tempDir))) {
      throw new UpdateError('解压结果越出临时目录，已中止。');
    }

    // ---- 3. 放入 data/releases/<version>-<platform> ----
    if (await pathExists(targetDir)) {
      backupDir = `${targetDir}.old-${Date.now()}`;
      await fsp.rename(targetDir, backupDir);
      log(`同名版本目录已存在，暂存为 ${path.basename(backupDir)}`);
    }

    try {
      await fsp.rename(stagedRoot, targetDir);
      moved = true;
      stagedRoot = null;
      if (!(await isFile(path.join(targetDir, 'dist', 'index.js')))) {
        throw new UpdateError('安装后校验失败：目标目录缺少 dist/index.js。');
      }
    } catch (error) {
      if (moved) {
        await fsp.rm(targetDir, { recursive: true, force: true }).catch(() => {});
        moved = false;
      }
      if (backupDir && (await pathExists(backupDir))) {
        await fsp.rename(backupDir, targetDir).catch(() => {});
        backupDir = null;
      }
      throw error;
    }

    // ---- 4. 计算 previous（配置文件/数据不动，只切换版本目录） ----
    const previousRaw = (() => {
      if (current && currentDir && path.resolve(currentDir) !== path.resolve(targetDir)) {
        return current;
      }
      return installed ? installed.previous : null;
    })();

    let previous = null;
    if (previousRaw) {
      const previousDir = resolveStoredPath(root, previousRaw.dir);
      if (previousDir && (await pathExists(path.join(previousDir, 'dist', 'index.js')))) {
        previous = {
          version: previousRaw.version,
          dir: previousDir,
          installedAt: previousRaw.installedAt || null,
        };
      } else {
        warn(`上一版本目录不存在，无法用于回滚: ${previousRaw.dir}`);
      }
    }

    const now = new Date().toISOString();
    const currentEntry = {
      version,
      dir: toPosix(path.relative(root, targetDir)),
      installedAt: now,
    };

    // ---- 5. 切换 current ----
    const switched = await writeCurrentState({
      root,
      dataDir,
      releaseDir: targetDir,
      version,
      previousDir: previous ? previous.dir : null,
      previousVersion: previous ? previous.version : null,
    });

    try {
      await writeInstalled(dataDir, {
        repo,
        platform,
        current: currentEntry,
        previous: previous
          ? {
              version: previous.version,
              dir: toPosix(path.relative(root, previous.dir)),
              installedAt: previous.installedAt,
            }
          : null,
      });
    } catch (error) {
      // 状态写入失败：恢复上一版本，保证当前可运行版本不被破坏
      if (previous) {
        await writeCurrentState({
          root,
          dataDir,
          releaseDir: previous.dir,
          version: previous.version,
          previousDir: null,
          previousVersion: null,
        }).catch(() => {});
        await writeInstalled(dataDir, {
          repo,
          platform,
          current: {
            version: previous.version,
            dir: toPosix(path.relative(root, previous.dir)),
            installedAt: previous.installedAt || now,
          },
          previous: null,
          rollback: { version, reason: '写入 installed.json 失败' },
        }).catch(() => {});
      }
      throw error;
    }

    log(
      `已切换版本: ${version}（${
        switched.mode === 'symlink' ? 'data/current 符号链接 + data/current.json' : 'data/current.json'
      }）`,
    );

    // ---- 5.5 依赖联动 ----
    await updateDepsIfNeeded({ root, targetDir }).catch((error) => {
      warn(`依赖联动异常: ${error.message}`);
    });

    // ---- 6. 重启与健康检查 ----
    if (opts.noRestart) {
      log('已指定 --no-restart，跳过重启与健康检查。');

      if (backupDir) {
        await fsp.rm(backupDir, { recursive: true, force: true }).catch(() => {});
        backupDir = null;
      }
      await cleanupReleases({
        releasesRoot,
        protectedDirs: [targetDir, previous ? previous.dir : null],
      }).catch((error) => warn(`清理旧版本失败: ${error.message}`));

      log(`更新完成: ${current ? current.version : '首次安装'} -> ${version}`);
      log(`版本目录: ${toPosix(path.relative(root, targetDir))}`);
      return 0;
    }

    const restart = await restartGateway(root);
    if (!restart.ran) {
      log('未找到自动重启脚本（scripts/gateway.sh 或 scripts/gateway.ps1）。');
      log(`请手动重启服务: ${restart.manual}`);
      if (backupDir) {
        await fsp.rm(backupDir, { recursive: true, force: true }).catch(() => {});
        backupDir = null;
      }
      await cleanupReleases({
        releasesRoot,
        protectedDirs: [targetDir, previous ? previous.dir : null],
      }).catch((error) => warn(`清理旧版本失败: ${error.message}`));
      log(`更新完成: ${current ? current.version : '首次安装'} -> ${version}`);
      return 0;
    }

    if (!restart.ok) {
      warn(`重启命令返回非 0（${restart.timedOut ? '超时' : restart.code}），继续做健康检查。`);
    }

    const port = await readGatewayPort(root);
    const healthy = await waitForHealth({
      port,
      timeoutMs: healthTimeoutMs(),
      intervalMs: healthIntervalMs(),
    });

    if (healthy) {
      log(`健康检查通过（端口 ${port}）。`);
      if (backupDir) {
        await fsp.rm(backupDir, { recursive: true, force: true }).catch(() => {});
        backupDir = null;
      }
      await cleanupReleases({
        releasesRoot,
        protectedDirs: [targetDir, previous ? previous.dir : null],
      }).catch((error) => warn(`清理旧版本失败: ${error.message}`));
      log(`更新完成: ${current ? current.version : '首次安装'} -> ${version}`);
      log(`版本目录: ${toPosix(path.relative(root, targetDir))}`);
      return 0;
    }

    // ---- 7. 健康检查失败：自动回滚 ----
    warn(`健康检查失败：版本 ${version} 未能正常提供服务。`);

    if (!previous) {
      warn('没有可回滚的上一版本，已保留新版本目录，请手动检查服务状态。');
      return 1;
    }
    if (!(await pathExists(previous.dir))) {
      warn(`上一版本目录已不存在（${previous.dir}），无法自动回滚，请手动处理。`);
      return 1;
    }

    log(`正在回滚到 ${previous.version} ...`);
    await writeCurrentState({
      root,
      dataDir,
      releaseDir: previous.dir,
      version: previous.version,
      previousDir: null,
      previousVersion: null,
    });
    await writeInstalled(dataDir, {
      repo,
      platform,
      current: {
        version: previous.version,
        dir: toPosix(path.relative(root, previous.dir)),
        installedAt: previous.installedAt || now,
      },
      previous: null,
      rollback: { version, reason: '健康检查失败' },
    });

    const rollbackRestart = await restartGateway(root);
    if (rollbackRestart.ran) {
      const rollbackHealthy = await waitForHealth({
        port,
        timeoutMs: healthTimeoutMs(),
        intervalMs: healthIntervalMs(),
      });
      if (rollbackHealthy) {
        log(`回滚后健康检查通过（版本 ${previous.version}）。`);
      } else {
        warn('回滚后健康检查仍未通过，请手动排查服务。');
      }
    } else {
      warn(`请手动重启服务: ${rollbackRestart.manual}`);
    }

    warn(`更新失败，已回滚到 ${previous.version}。`);
    return 1;
  } finally {
    // 清理本次临时解压目录（无论成功失败）
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 直接执行
// ---------------------------------------------------------------------------

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isDirectRun = invokedPath === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main()
    .then((code) => {
      process.exit(typeof code === 'number' ? code : 0);
    })
    .catch((error) => {
      if (error instanceof UpdateError) {
        process.stderr.write(`[self-update] 错误: ${error.message}\n`);
        process.exit(error.exitCode || 1);
      }
      process.stderr.write(`[self-update] 未预期的错误: ${error && error.stack ? error.stack : error}\n`);
      process.exit(1);
    });
}
