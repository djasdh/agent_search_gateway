/**
 * FlareSolverr 安装：官方 Release 只提供 linux-x64 / win32-x64 二进制。
 * 其它平台（arm64、macOS）没有官方二进制，返回 enabled=false 让网关关闭该能力。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { download, verifySha256 } from './http.mjs';

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2000);
    });
    child.once('error', (error) => resolve({ code: null, stderr: error.message }));
    child.once('close', (code) => resolve({ code, stderr }));
  });
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function findBinary(dir, name) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) {
      const found = await findBinary(full, name);
      if (found) return found;
    }
  }
  return null;
}

async function extractArchive(archive, platform, destDir) {
  await fs.mkdir(destDir, { recursive: true });
  if (archive.endsWith('.zip')) {
    const result = await run('tar', ['-xf', archive, '-C', destDir]);
    if (result.code !== 0) {
      throw new Error(`解压 zip 失败: ${result.stderr}`);
    }
    return;
  }
  const result = await run('tar', ['-xzf', archive, '-C', destDir]);
  if (result.code !== 0) {
    throw new Error(`解压 tar.gz 失败: ${result.stderr}`);
  }
}

export function flaresolverrAsset(pins, platform) {
  const asset = pins?.flaresolverr?.assets?.[platform];
  if (!asset) return null;
  return {
    url: asset,
    version: pins.flaresolverr.version || 'unknown',
    sha256: pins?.flaresolverr?.sha256?.[platform] || '',
  };
}

export async function installFlareSolverr({ root, platform, pins, logger, port = 8192 }) {
  const asset = flaresolverrAsset(pins, platform);
  if (!asset) {
    return {
      enabled: false,
      reason: `FlareSolverr 没有 ${platform} 官方二进制（仅 linux-x64 / win32-x64）；已关闭该能力`,
      launch: null,
    };
  }
  if (!asset.url.startsWith('https://')) {
    throw new Error(`FlareSolverr 资产地址必须是 https: ${asset.url}`);
  }

  const depsDir = path.join(root, 'data', 'deps', 'flaresolverr');
  const destDir = path.join(depsDir, platform);
  await fs.mkdir(depsDir, { recursive: true });

  const binaryName = platform.startsWith('win32') ? 'flaresolverr.exe' : 'flaresolverr';
  let binary = await findBinary(destDir, binaryName).catch(() => null);
  if (!binary) {
    const archiveName = path.basename(new URL(asset.url).pathname);
    const archive = path.join(depsDir, archiveName);
    logger?.(`下载 FlareSolverr ${asset.version} (${platform}) ...`);
    await download(asset.url, archive, { logger });
    await verifySha256(archive, asset.sha256, archiveName);
    await extractArchive(archive, platform, destDir);
    await fs.rm(archive, { force: true });
    binary = await findBinary(destDir, binaryName);
    if (!binary) throw new Error(`FlareSolverr 解压后未找到 ${binaryName}`);
    if (!platform.startsWith('win32')) await fs.chmod(binary, 0o755);
  }

  await fs.writeFile(
    path.join(depsDir, 'version.json'),
    `${JSON.stringify({ version: asset.version, platform, binary, installed_at: new Date().toISOString() }, null, 2)}\n`,
  );

  return {
    enabled: true,
    version: asset.version,
    binary,
    launch: {
      command: [binary],
      cwd: path.dirname(binary),
      env: {
        PORT: String(port),
        HOST: '127.0.0.1',
        LOG_LEVEL: 'info',
      },
      health: `http://127.0.0.1:${port}/`,
    },
  };
}

export async function uninstallFlareSolverr({ root }) {
  await fs.rm(path.join(root, 'data', 'deps', 'flaresolverr'), { recursive: true, force: true });
}

export async function flaresolverrStatus({ root, platform, pins }) {
  const dir = path.join(root, 'data', 'deps', 'flaresolverr', platform);
  const binaryName = platform.startsWith('win32') ? 'flaresolverr.exe' : 'flaresolverr';
  const installed = await exists(path.join(dir, binaryName));
  return {
    platform,
    supported: Boolean(flaresolverrAsset(pins, platform)),
    installed,
    dir,
  };
}

export { exists };
