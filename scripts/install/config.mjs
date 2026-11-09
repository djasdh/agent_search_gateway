/** 生成/更新 gateway.yaml 与 secrets.yaml。 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';

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

export async function prepareConfig({
  installRoot,
  currentDir,
  port = 3000,
  searxngUrl = 'http://127.0.0.1:8888',
  flaresolverrUrl = 'http://127.0.0.1:8192',
  flaresolverrEnabled = true,
  logger,
}) {
  await copyExample({
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
  configDoc.setIn(['gateway', 'port'], port);
  configDoc.setIn(['searxng', 'url'], searxngUrl);
  configDoc.setIn(['flaresolverr', 'url'], flaresolverrUrl);
  configDoc.setIn(['flaresolverr', 'enabled'], Boolean(flaresolverrEnabled));
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
