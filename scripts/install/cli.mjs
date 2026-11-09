#!/usr/bin/env node
/**
 * 一键安装器编排。
 *
 * 引导脚本（install.sh / install.ps1）负责下载完整包并切换到 data/current，
 * 本脚本负责：生成配置、安装 searxng/flaresolverr/浏览器、注册自启、启动自检。
 *
 * 用法：
 *   node scripts/install/cli.mjs --install-root <dir> [选项]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareConfig } from './config.mjs';
import { installBrowser } from './browser.mjs';
import { installFlareSolverr } from './flaresolverr.mjs';
import { writeLaunchJson } from './launch.mjs';
import { installSearxng } from './deps/searxng.mjs';
import { installService } from './service.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CURRENT_DIR = path.resolve(HERE, '..', '..');

function log(message) {
  console.log(`[install] ${message}`);
}

function warn(message) {
  console.error(`[install] 警告: ${message}`);
}

const USAGE = `用法: node scripts/install/cli.mjs --install-root <目录> [选项]

选项:
  --install-root <dir>     安装根目录（默认当前目录）
  --port <n>              网关端口（默认 3000）
  --searxng-port <n>      searxng 端口（默认 8888）
  --flaresolverr-port <n> FlareSolverr 端口（默认 8192）
  --searxng-mode <mode>   auto | docker | native | external（默认 auto）
  --searxng-url <url>     连接已有 searxng（隐含 external）
  --flaresolverr-url <url> 连接已有 FlareSolverr
  --no-deps               不安装 searxng / FlareSolverr
  --no-browser            不安装 Playwright chromium
  --no-service            不注册自启
  --no-start              安装后不启动
  --no-python-install     Windows 缺少 Python 时不自动安装
  --deps-only             只更新依赖与 launch.json（自更新联动用）
  --launch-only           只刷新 launch.json（自更新切换版本用）
  --force                 重新生成配置
  --check                 只检查，不安装
  -h, --help              显示帮助
`;

export function parseArgs(argv) {
  const opts = {
    installRoot: process.cwd(),
    port: 3000,
    searxngPort: 8888,
    flaresolverrPort: 8192,
    searxngMode: 'auto',
    searxngUrl: '',
    flaresolverrUrl: '',
    noDeps: false,
    noBrowser: false,
    noService: false,
    noStart: false,
    noPythonInstall: false,
    depsOnly: false,
    launchOnly: false,
    force: false,
    check: false,
    help: false,
  };
  const next = (i, name) => {
    const value = argv[i];
    if (!value || value.startsWith('-')) throw new Error(`${name} 需要一个值`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '--install-root':
        opts.installRoot = path.resolve(next(++i, arg));
        break;
      case '--port':
        opts.port = Number.parseInt(next(++i, arg), 10);
        break;
      case '--searxng-port':
        opts.searxngPort = Number.parseInt(next(++i, arg), 10);
        break;
      case '--flaresolverr-port':
        opts.flaresolverrPort = Number.parseInt(next(++i, arg), 10);
        break;
      case '--searxng-mode':
        opts.searxngMode = next(++i, arg);
        break;
      case '--searxng-url':
        opts.searxngUrl = next(++i, arg);
        break;
      case '--flaresolverr-url':
        opts.flaresolverrUrl = next(++i, arg);
        break;
      case '--no-deps':
        opts.noDeps = true;
        break;
      case '--no-browser':
        opts.noBrowser = true;
        break;
      case '--no-service':
        opts.noService = true;
        break;
      case '--no-start':
        opts.noStart = true;
        break;
      case '--no-python-install':
        opts.noPythonInstall = true;
        break;
      case '--deps-only':
        opts.depsOnly = true;
        break;
      case '--launch-only':
        opts.launchOnly = true;
        break;
      case '--force':
        opts.force = true;
        break;
      case '--check':
        opts.check = true;
        break;
      default:
        throw new Error(`未知参数: ${arg}\n\n${USAGE}`);
    }
  }
  for (const [key, value] of [
    ['--port', opts.port],
    ['--searxng-port', opts.searxngPort],
    ['--flaresolverr-port', opts.flaresolverrPort],
  ]) {
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new Error(`${key} 不是合法端口: ${value}`);
    }
  }
  return opts;
}

export function platformTag(platform = process.platform, arch = process.arch) {
  const map = {
    linux: { x64: 'linux-x64', arm64: 'linux-arm64' },
    darwin: { x64: 'darwin-x64', arm64: 'darwin-arm64' },
    win32: { x64: 'win32-x64' },
  };
  const tag = map[platform]?.[arch];
  if (!tag) throw new Error(`不支持的平台: ${platform}/${arch}`);
  return tag;
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function readPins() {
  for (const file of [path.join(CURRENT_DIR, 'runtime', 'pins.json'), path.join(CURRENT_DIR, 'runtime.json')]) {
    if (await exists(file)) return readJson(file);
  }
  throw new Error(`未找到 runtime/pins.json（版本目录: ${CURRENT_DIR}）`);
}

async function readVersion() {
  for (const file of [path.join(CURRENT_DIR, 'version.json'), path.join(CURRENT_DIR, 'package.json')]) {
    if (await exists(file)) {
      const data = await readJson(file);
      return data.version || 'unknown';
    }
  }
  return 'unknown';
}

async function nodePath(installRoot) {
  if (process.platform === 'win32') {
    const local = path.join(installRoot, 'data', 'toolchain', 'node', 'node.exe');
    if (await exists(local)) return local;
  } else {
    const local = path.join(installRoot, 'data', 'toolchain', 'node', 'bin', 'node');
    if (await exists(local)) return local;
  }
  return process.execPath;
}

async function ensureRootScripts({ installRoot, currentDir }) {
  const targetDir = path.join(installRoot, 'scripts');
  await fs.mkdir(targetDir, { recursive: true });
  for (const name of ['start-all.mjs', 'start-all.ps1', 'gateway.sh', 'gateway.ps1']) {
    const source = path.join(currentDir, 'scripts', name);
    if (!(await exists(source))) continue;
    const target = path.join(targetDir, name);
    if (await exists(target)) continue;
    await fs.copyFile(source, target);
    if (name.endsWith('.sh')) await fs.chmod(target, 0o755).catch(() => {});
  }
}

async function writeDepsState({ installRoot, pins }) {
  const file = path.join(installRoot, 'data', 'runtime', 'deps.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    `${JSON.stringify(
      {
        searxng: pins.searxng || null,
        flaresolverr: pins.flaresolverr || null,
        playwright: pins.playwright || null,
        updated_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

async function installDeps({ installRoot, platform, pins, opts, logger }) {
  let searxngResult = {
    mode: 'external',
    url: opts.searxngUrl || `http://127.0.0.1:${opts.searxngPort}`,
    version: 'external',
    launch: null,
  };
  if (!opts.noDeps && !opts.searxngUrl) {
    logger(`安装 searxng（模式: ${opts.searxngMode}）...`);
    searxngResult = await installSearxng({
      root: installRoot,
      platform,
      pins,
      logger,
      options: {
        mode: opts.searxngMode,
        port: opts.searxngPort,
        pythonPath: '',
        noPythonInstall: opts.noPythonInstall,
      },
    });
  }
  const searxngUrl = searxngResult.url || `http://127.0.0.1:${opts.searxngPort}`;

  let flaresolverrResult = { enabled: true, launch: null, version: 'external' };
  let flaresolverrUrl = opts.flaresolverrUrl || `http://127.0.0.1:${opts.flaresolverrPort}`;
  if (!opts.noDeps && !opts.flaresolverrUrl) {
    logger('安装 FlareSolverr ...');
    flaresolverrResult = await installFlareSolverr({
      root: installRoot,
      platform,
      pins,
      logger,
      port: opts.flaresolverrPort,
    });
    flaresolverrUrl = `http://127.0.0.1:${opts.flaresolverrPort}`;
  }
  if (!flaresolverrResult.enabled) {
    warn(flaresolverrResult.reason || 'FlareSolverr 未启用');
  }

  return { searxngResult, searxngUrl, flaresolverrResult, flaresolverrUrl };
}

async function waitHealth(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch {
      /* 继续等 */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const installRoot = path.resolve(opts.installRoot);
  const platform = platformTag();
  const pins = await readPins();
  const version = await readVersion();
  const node = await nodePath(installRoot);

  log(`安装根: ${installRoot}`);
  log(`版本: ${version}（${platform}）`);

  if (opts.check) {
    log(`searxng: ${opts.searxngUrl || `http://127.0.0.1:${opts.searxngPort}`}（${opts.searxngMode}）`);
    log(`flaresolverr: ${opts.flaresolverrUrl || `http://127.0.0.1:${opts.flaresolverrPort}`}`);
    log('检查完成（未做任何修改）');
    return 0;
  }

  await fs.mkdir(path.join(installRoot, 'data'), { recursive: true });
  await ensureRootScripts({ installRoot, currentDir: CURRENT_DIR });

  const gatewayLaunch = {
    name: 'gateway',
    command: [node, path.join(CURRENT_DIR, 'dist', 'index.js')],
    cwd: installRoot,
    env: {
      GATEWAY_CONFIG_FILE: path.join(installRoot, 'gateway.yaml'),
      GATEWAY_SECRETS_FILE: path.join(installRoot, 'secrets.yaml'),
    },
    health: `http://127.0.0.1:${opts.port}/health`,
  };

  if (opts.launchOnly) {
    const launchPath = path.join(installRoot, 'data', 'runtime', 'launch.json');
    let existing = { services: [] };
    try {
      existing = JSON.parse(await fs.readFile(launchPath, 'utf8'));
    } catch {
      existing = { services: [] };
    }
    const services = (existing.services || []).filter((item) => item && item.name !== 'gateway');
    services.push(gatewayLaunch);
    const launchFile = await writeLaunchJson({ installRoot, services });
    log(`已刷新启动清单: ${launchFile}`);
    return 0;
  }

  const deps = await installDeps({ installRoot, platform, pins, opts, logger: log });
  log(`searxng: ${deps.searxngUrl}（${deps.searxngResult.mode}）`);

  if (opts.depsOnly) {
    const launchFile = await writeLaunchJson({
      installRoot,
      services: [
        deps.searxngResult.launch ? { ...deps.searxngResult.launch, name: 'searxng' } : null,
        deps.flaresolverrResult.launch
          ? { ...deps.flaresolverrResult.launch, name: 'flaresolverr' }
          : null,
        gatewayLaunch,
      ],
    });
    await writeDepsState({ installRoot, pins });
    log(`依赖更新完成，启动清单: ${launchFile}`);
    return 0;
  }

  // ---- 配置 ----
  const config = await prepareConfig({
    installRoot,
    currentDir: CURRENT_DIR,
    port: opts.port,
    searxngUrl: deps.searxngUrl,
    flaresolverrUrl: deps.flaresolverrUrl,
    flaresolverrEnabled: Boolean(deps.flaresolverrResult.enabled),
    logger: log,
  });

  // ---- 浏览器 ----
  if (!opts.noBrowser) {
    await installBrowser({ currentDir: CURRENT_DIR, logger: log });
  }

  // ---- launch.json ----
  const launchFile = await writeLaunchJson({
    installRoot,
    services: [
      deps.searxngResult.launch ? { ...deps.searxngResult.launch, name: 'searxng' } : null,
      deps.flaresolverrResult.launch
        ? { ...deps.flaresolverrResult.launch, name: 'flaresolverr' }
        : null,
      gatewayLaunch,
    ],
  });
  await writeDepsState({ installRoot, pins });
  log(`启动清单: ${launchFile}`);

  // ---- 自启 ----
  let service = null;
  if (!opts.noService) {
    log('注册用户级自启 ...');
    try {
      service = await installService({ root: installRoot, platform, nodePath: node, logger: log });
    } catch (error) {
      warn(`注册自启失败（不影响网关本体）: ${error.message}`);
    }
  }

  // Windows 计划任务是 onlogon，需要显式 run 才会立即启动。
  let serviceStarted = Boolean(service && (service.active || service.loaded));
  if (service?.registered && service?.taskName) {
    const result = spawnSync('schtasks', ['/run', '/tn', service.taskName], { encoding: 'utf8' });
    if (result.status === 0) {
      log('登录计划任务已启动');
      serviceStarted = true;
    } else {
      warn(`计划任务启动失败: ${(result.stderr || result.stdout || '').trim()}`);
    }
  }

  // ---- 启动与健康检查 ----
  if (!opts.noStart) {
    if (serviceStarted) {
      log('等待网关健康检查 ...');
      const ok = await waitHealth(`http://127.0.0.1:${opts.port}/health`, 90_000);
      if (!ok) throw new Error('网关启动后健康检查超时');
      log('网关已就绪');
    } else {
      log(`未注册自启或未自动启动；手动启动：node ${path.join(installRoot, 'scripts', 'start-all.mjs')}`);
    }
  }

  log('');
  log('安装完成');
  log(`  网关: http://127.0.0.1:${opts.port}/mcp`);
  log(`  searxng: ${deps.searxngUrl}`);
  log(`  FlareSolverr: ${deps.flaresolverrUrl}${deps.flaresolverrResult.enabled ? '' : '（已关闭）'}`);
  log(`  配置: ${config.configPath}`);
  log(`  密钥: ${config.secretsPath}`);
  if (config.token) log('  gateway.token 已写入 secrets.yaml');
  return 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`[install] 错误: ${error.message}`);
      process.exit(1);
    },
  );
}
