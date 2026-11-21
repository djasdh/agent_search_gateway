/** 生成/更新 gateway.yaml 与 secrets.yaml。 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';

/**
 * 0.4.0 删除的旧平台配置段（gateway.yaml 顶层 + secrets.yaml 顶层）。
 * 清单里的 target 只用于错误提示。
 */
const LEGACY_PLATFORM_SECTIONS = [
  { file: 'gateway.yaml', path: ['bilibili'], target: 'extensions.bilibili.config' },
  { file: 'gateway.yaml', path: ['weibo'], target: 'extensions.weibo.config' },
  { file: 'gateway.yaml', path: ['search', 'weibo'], target: 'extensions.weibo.config.search' },
  { file: 'secrets.yaml', path: ['bilibili'], target: 'extensions.bilibili' },
];

function hasPathOwn(value, path) {
  let current = value;
  for (const key of path) {
    if (
      !current ||
      typeof current !== 'object' ||
      !Object.prototype.hasOwnProperty.call(current, key)
    ) {
      return false;
    }
    current = current[key];
  }
  return true;
}

async function readYamlIfPresent(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  if (!text.trim()) return undefined;

  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new Error(`${file} 解析失败，无法检查旧版平台配置：${doc.errors[0].message}`);
  }
  return doc.toJS() ?? undefined;
}

/**
 * 安装切换前的守卫：旧版 gateway.yaml / secrets.yaml 在 0.4.0 直接启动会 Zod 报错，
 * 因此安装器在重写配置/切换 current 前先 fail fast，并给出 0.3.11 迁移命令。
 *
 * 文件不存在或为空时直接通过；YAML 无法解析时抛出明确错误（不静默放过旧段）。
 */
export async function assertNoLegacyPlatformConfig(installRoot) {
  const hits = [];
  for (const { file, path: segments, target } of LEGACY_PLATFORM_SECTIONS) {
    const value = await readYamlIfPresent(path.join(installRoot, file));
    if (value !== undefined && hasPathOwn(value, segments)) {
      hits.push(`${file} 的 ${segments.join('.')}（应迁到 ${target}）`);
    }
  }
  if (hits.length === 0) return;

  throw new Error(
    `检测到旧版平台配置段：${hits.join('；')}。` +
      '迁移脚本只存在于 0.3.11：请先用 0.3.11 运行 node scripts/migrations/0.3.x.mjs --phase config；0.4.1 不再接受这些顶层段。',
  );
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function copyExample({ installRoot, currentDir, source, target, logger }) {
  const destination = path.join(installRoot, target);
  if (await exists(destination)) return false;
  const sourcePath = path.join(currentDir, source);
  await fs.copyFile(sourcePath, destination);
  logger?.(`已创建 ${target}`);
  return true;
}

async function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, file);
}

export function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

/** 读取 gateway.yaml 的 gateway.port；文件缺失、键缺失或值非法时回退 fallbackPort。 */
export async function readGatewayPort(installRoot, fallbackPort = 3000) {
  const configPath = path.join(installRoot, 'gateway.yaml');
  let value;
  try {
    const doc = parseDocument(await fs.readFile(configPath, 'utf8'));
    value = doc.getIn(['gateway', 'port']);
  } catch {
    return fallbackPort;
  }

  const port =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number.parseInt(value.trim(), 10)
        : Number.NaN;
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallbackPort;
}

export async function prepareConfig({
  installRoot,
  currentDir,
  port = 3000,
  searxngUrl = 'http://127.0.0.1:8888',
  flaresolverrUrl = 'http://127.0.0.1:8192',
  flaresolverrEnabled = true,
  logger,
}) {
  const configCreated = await copyExample({
    installRoot,
    currentDir,
    source: 'gateway.yaml.example',
    target: 'gateway.yaml',
    logger,
  });
  await copyExample({
    installRoot,
    currentDir,
    source: 'secrets.yaml.example',
    target: 'secrets.yaml',
    logger,
  });

  const configPath = path.join(installRoot, 'gateway.yaml');
  const secretsPath = path.join(installRoot, 'secrets.yaml');

  const configDoc = parseDocument(await fs.readFile(configPath, 'utf8'));
  // 首次从 example 复制时写入 CLI 默认值；升级/重装只补缺失键，保留用户已有配置。
  const defaults = [
    [['gateway', 'port'], port],
    [['searxng', 'url'], searxngUrl],
    [['flaresolverr', 'url'], flaresolverrUrl],
    [['flaresolverr', 'enabled'], Boolean(flaresolverrEnabled)],
  ];
  for (const [keyPath, value] of defaults) {
    if (configCreated || configDoc.getIn(keyPath) === undefined) {
      configDoc.setIn(keyPath, value);
    }
  }
  await writeAtomic(configPath, String(configDoc));

  const secretsDoc = parseDocument(await fs.readFile(secretsPath, 'utf8'));
  const currentToken = secretsDoc.getIn(['gateway', 'token']);
  const token =
    typeof currentToken === 'string' && currentToken.trim() ? currentToken.trim() : generateToken();
  secretsDoc.setIn(['gateway', 'token'], token);
  await writeAtomic(secretsPath, String(secretsDoc));
  await fs.chmod(secretsPath, 0o600).catch(() => {});

  return { configPath, secretsPath, token };
}

export { exists };
