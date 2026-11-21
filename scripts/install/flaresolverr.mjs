/**
 * FlareSolverr 安装：官方 Release 只提供 linux-x64 / win32-x64 二进制。
 * 其它平台（arm64、macOS）没有官方二进制，返回 enabled=false 让网关关闭该能力。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { download, verifySha256 } from './http.mjs';

/** Xvfb 常见安装位置：PATH 之外，系统包、X11、Homebrew 都要考虑。 */
const XVFB_EXTRA_DIRS = ['/usr/bin', '/usr/local/bin', '/opt/X11/bin', '/opt/homebrew/bin'];
/** conda / mamba 发行版默认会把 Xvfb 装在各自 bin 下（用户级，无需 root）。 */
const XVFB_CONDA_DIRS = [
  'miniconda3',
  'anaconda3',
  'miniforge3',
  'mambaforge',
  '.conda',
  '.local/share/mamba',
];

function splitPath(value) {
  return String(value || '')
    .split(path.delimiter)
    .filter(Boolean);
}

/** 查找 Xvfb 的候选目录：PATH 优先，再补常见位置（去重、保持顺序）。 */
export function xvfbCandidateDirs({ env = process.env, home = os.homedir() } = {}) {
  const dirs = [...splitPath(env.PATH), ...XVFB_EXTRA_DIRS];
  for (const name of XVFB_CONDA_DIRS) dirs.push(path.join(home, name, 'bin'));
  return [...new Set(dirs.filter(Boolean))];
}

/**
 * 查找可用的 Xvfb。
 *
 * FlareSolverr 在 Linux 上无 DISPLAY 时会用 Xvfb 跑「有头 Chrome」（不走 --headless，
 * 为反检测），上游二进制不自带，官方 Docker 镜像也是 apt install xvfb。
 * 服务管理器给的 PATH 通常不含 conda / Homebrew 目录，所以这里主动找。
 *
 * @returns {{ binary: string, dir: string } | null}
 */
export function findXvfb(options = {}) {
  const { platform = process.platform, dirs } = options;
  if (platform === 'win32') return null;
  for (const dir of dirs ?? xvfbCandidateDirs(options)) {
    const binary = path.join(dir, 'Xvfb');
    if (existsSync(binary)) return { binary, dir };
  }
  return null;
}

/** 把目录前置到 PATH（用于自检环境与 launch env）。 */
export function prependPath(dir, value = process.env.PATH) {
  const rest = splitPath(value).filter((item) => item !== dir);
  return [dir, ...rest].join(path.delimiter);
}

/** FlareSolverr 缺少 Xvfb 时的可操作提示（按发行版给命令）。 */
export const XVFB_HINT =
  '需要 Xvfb（FlareSolverr 用它跑有头 Chrome）：Debian/Ubuntu `sudo apt install xvfb`；' +
  'Arch `sudo pacman -S xorg-server-xvfb`；Fedora `sudo dnf install xorg-x11-server-Xvfb`。' +
  '未安装时会关闭 FlareSolverr，网关仍可用浏览器渲染兜底。';

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
async function smokeTest(binary, cwd, timeoutMs = 120_000, options = {}) {
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
      ...options.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'error',
    },
    // 独立进程组：FlareSolverr 会再拉起 Xvfb / chrome，清理时要整组杀掉。
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let output = '';
  let exited = false;
  const append = (chunk) => {
    output = (output + chunk.toString('utf8')).slice(-8000);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  child.once('error', (error) => {
    exited = true;
    output = `${output}\n${error.message}`;
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

  // 自检结束就清干净：FlareSolverr + 它拉起的 Xvfb / chrome 都不能留。
  killProcessTree(child);

  if (healthy) {
    return { healthy: true };
  }

  return { healthy: false, detail: summarizeSmokeFailure(output, timeoutMs) };
}

/** 结束自检进程及其子进程（POSIX 用进程组，Windows 退回单进程）。 */
function killProcessTree(child) {
  const signal = (sig) => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      // 进程可能已退出。
    }
  };

  signal('SIGTERM');
  const timer = setTimeout(() => signal('SIGKILL'), 5000);
  if (typeof timer.unref === 'function') timer.unref();
}

/**
 * 自检失败原因摘要。
 *
 * PyInstaller 的 stderr 最后一行永远是 `[PYI-…] Failed to execute script`，
 * 真正的异常（如 `FileNotFoundError: Could not find Xvfb`）在它上面几行。
 * 这里优先挑出异常行，并附带对应平台的处理提示。
 */
export function summarizeSmokeFailure(stderr, timeoutMs = 120_000) {
  const lines = String(stderr || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return `启动后 ${Math.round(timeoutMs / 1000)} 秒内未通过健康检查`;
  }

  const reverse = [...lines].reverse();
  const pick = (re) => reverse.find((line) => re.test(line));
  const key =
    pick(/FileNotFoundError|No such file or directory/i) ??
    pick(/Exception:|Error:/) ??
    pick(/ERROR/);

  const detail = (key ?? lines[lines.length - 1]).slice(0, 500);
  if (/Xvfb/i.test(String(stderr))) return `${detail}；${XVFB_HINT}`;
  if (/readline/i.test(String(stderr))) {
    return `${detail}；FlareSolverr 自带的 libreadline 与系统 /bin/sh 冲突，可尝试移除包内 libreadline。`;
  }
  return detail;
}

/** PyInstaller 自带的 libreadline 会通过 LD_LIBRARY_PATH 影响子进程 /bin/sh。 */
export function isReadlineConflict(detail) {
  return /rl_trim_arg_from_keyseq|symbol lookup error:.*readline|readline.*symbol lookup error/i.test(
    String(detail || ''),
  );
}

/**
 * 禁用 PyInstaller 包内自带的 libreadline。
 *
 * FlareSolverr 启动时会把 `_internal` 放进 LD_LIBRARY_PATH；它再 spawn
 * `/bin/sh` 时，Arch 的 bash 会加载这个自带 libreadline，而该库缺少
 * `rl_trim_arg_from_keyseq`，于是报 symbol lookup error。
 * 服务端模式不需要 readline；移除后 /bin/sh 会使用系统库。
 */
export async function disableBundledReadline(binaryDir) {
  const internal = path.join(binaryDir, '_internal');
  let entries;
  try {
    entries = await fs.readdir(internal);
  } catch {
    return [];
  }

  const renamed = [];
  for (const name of entries) {
    if (!/^libreadline\.so(?:\.\d+(?:\.\d+)*)?$/.test(name)) continue;
    const from = path.join(internal, name);
    const to = `${from}.disabled`;
    if (await exists(to)) continue;
    await fs.rename(from, to);
    renamed.push(to);
  }
  return renamed;
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

  // FlareSolverr 的浏览器依赖 Xvfb；先找好并注入 PATH，自检与运行时都用同一份。
  const xvfb = platform.startsWith('win32') ? null : findXvfb();
  const pathEnv =
    !platform.startsWith('win32') && xvfb ? { PATH: prependPath(xvfb.dir, process.env.PATH) } : {};
  if (xvfb) {
    logger?.(`已找到 Xvfb: ${xvfb.binary}`);
  } else if (!platform.startsWith('win32')) {
    logger?.(`未找到 Xvfb。${XVFB_HINT}`);
  }

  if (options?.smokeTest !== false) {
    logger?.('FlareSolverr 启动自检 ...');
    let smoke = await smokeTest(binary, path.dirname(binary), 60_000, { env: pathEnv });
    if (!smoke.healthy && isReadlineConflict(smoke.detail)) {
      const moved = await disableBundledReadline(path.dirname(binary));
      if (moved.length > 0) {
        logger?.(
          `检测到内置 libreadline 与系统 /bin/sh 冲突，已禁用：${moved
            .map((file) => path.basename(file))
            .join(', ')}`,
        );
        // 首次启动 undetected_chromedriver 可能还要下载/初始化，给第二次自检更长时间。
        smoke = await smokeTest(binary, path.dirname(binary), 180_000, { env: pathEnv });
      }
    }
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
        // systemd/launchd 的默认 PATH 很短；把 Xvfb 所在目录带进运行时环境。
        ...pathEnv,
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
