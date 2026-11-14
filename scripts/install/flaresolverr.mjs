/**
 * FlareSolverr 安装：官方 Release 只提供 linux-x64 / win32-x64 二进制。
 * 其它平台（arm64、macOS）没有官方二进制，返回 enabled=false 让网关关闭该能力。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
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

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('无法分配空闲端口'))));
    });
  });
}

/**
 * 启动自检：官方二进制自带一套动态库，在部分新发行版上会与系统 /bin/sh 冲突
 * （例如 Arch 的 readline 符号缺失），表现为启动即退出。
 *
 * 自检失败时返回 enabled=false，让安装器关闭该能力而不是让整栈无法启动。
 */
async function smokeTest(binary, cwd, timeoutMs = 30_000) {
  let port;
  try {
    port = await freePort();
  } catch (error) {
    return { healthy: false, detail: error.message };
  }

  const child = spawn(binary, [], {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });

  let stderr = '';
  let exited = false;
  child.stderr?.on('data', (chunk) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-2000);
  });
  child.once('error', (error) => {
    exited = true;
    stderr = `${stderr}\n${error.message}`;
  });
  child.once('exit', () => {
    exited = true;
  });

  let healthy = false;
  const deadline = Date.now() + timeoutMs;
  while (!exited && Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      // 继续等
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  try {
    child.kill('SIGTERM');
  } catch {
    // 进程可能已退出。
  }
  const killTimer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // 忽略
    }
  }, 5000);
  if (typeof killTimer.unref === 'function') killTimer.unref();

  if (healthy) {
    child.unref();
    return { healthy: true };
  }

  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const detail = lines.length > 0 ? lines[lines.length - 1] : `启动后 ${timeoutMs / 1000} 秒内未通过健康检查`;
  return { healthy: false, detail };
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

export async function installFlareSolverr({ root, platform, pins, logger, port = 8192, options = {} }) {
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

  if (options?.smokeTest !== false) {
    logger?.('FlareSolverr 启动自检 ...');
    const smoke = await smokeTest(binary, path.dirname(binary));
    if (!smoke.healthy) {
      logger?.(`FlareSolverr 自检失败，已关闭该能力：${smoke.detail}`);
      return {
        enabled: false,
        version: asset.version,
        binary,
        reason: `FlareSolverr 在当前系统无法启动（${smoke.detail}）；已关闭该能力，安装继续`,
        launch: null,
      };
    }
  }

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
