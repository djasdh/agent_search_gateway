/**
 * searxng 安装模块（一键安装器依赖）。
 *
 * 模式：
 *   - docker  ：官方镜像 searxng/searxng + docker compose（Linux/macOS 默认，需 Docker）
 *   - native  ：pins.archive 源码 + venv + granian（Windows 默认；无 Docker 时回退）
 *   - external：连接已有 searxng，不安装
 *
 * 目录：<root>/data/deps/searxng/
 *   ├─ settings.yml      生成的配置（含自定义引擎/插件）
 *   ├─ compose.yaml      Docker 模式
 *   ├─ src/              原生源码（pins.searxng.commit）
 *   ├─ venv/             原生 Python 虚拟环境
 *   ├─ ext/              从 searxng-ext 复制出的引擎/插件
 *   ├─ quota/            配额台账目录（挂给容器）
 *   ├─ cache/            下载缓存（源码 ZIP、Windows Python 安装包）
 *   └─ install.json      安装记录（模式/版本/端口）
 *
 * 所有下载交给 ../http.mjs（代理优先、仅 https、临时文件 + rename）。
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { download, sha256File, verifySha256 } from '../http.mjs';
import { patchValkeyDbFile, unpackZip } from './windows-patch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 完整包 / 仓库根（scripts/install/deps 的上三级） */
const PACKAGE_ROOT = path.resolve(HERE, '..', '..', '..');
const DEPS_REL = path.join('data', 'deps', 'searxng');
const DOCKER_IMAGE = 'searxng/searxng:latest';
const DOCKER_PROJECT = 'agent-search-searxng';
const MIN_PYTHON = [3, 11];
const WINDOWS_PYTHON_VERSION = '3.12.10';
const WINDOWS_PYTHON_URL =
  `https://www.python.org/ftp/python/${WINDOWS_PYTHON_VERSION}/` +
  `python-${WINDOWS_PYTHON_VERSION}-amd64.exe`;
const HEALTH_PATH = '/healthz';

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function makeLogger(logger) {
  if (typeof logger === 'function') return logger;
  return (message) => console.log(`[searxng] ${message}`);
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(file, text, mode) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, file);
  if (mode) await fs.chmod(file, mode).catch(() => {});
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeJson(file, data) {
  await writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
}

function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** 依次在 root、root/data/current、完整包根目录查找项目内文件 */
async function resolveProjectPath(root, relative, { required = false, kind = 'file' } = {}) {
  const bases = [
    path.resolve(root),
    path.join(path.resolve(root), 'data', 'current'),
    PACKAGE_ROOT,
  ];
  for (const base of bases) {
    const candidate = path.join(base, relative);
    if (existsSync(candidate)) return candidate;
  }
  if (required) {
    throw new Error(`未找到 ${relative}（已查找: ${bases.join(', ')}）`);
  }
  return null;
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env || process.env,
        stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', error });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-8000);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-8000);
    });

    let timer = null;
    if (options.timeout) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, options.timeout);
    }

    child.once('error', (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout, stderr, error });
    });
    child.once('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function runOrThrow(command, args, options = {}) {
  const result = await run(command, args, options);
  if (result.error) {
    throw new Error(`无法执行 ${command}：${result.error.message}`);
  }
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(
      `命令执行失败（退出码 ${result.code}）：${command} ${args.join(' ')}` +
        (detail ? `\n${detail}` : ''),
    );
  }
  return result;
}

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return override;
  const target = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      target[key] = deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function venvPythonPath(venvDir, platform) {
  return platform === 'win32' || platform.startsWith('win32')
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

// ---------------------------------------------------------------------------
// 项目资产：settings 模板 / searxng-ext
// ---------------------------------------------------------------------------

async function loadTemplate(root) {
  const file = await resolveProjectPath(root, path.join('docker', 'searxng', 'settings.template.yml'), {
    required: true,
  });
  return { file, text: await fs.readFile(file, 'utf8') };
}

async function resolveExtDir(root) {
  const dir = await resolveProjectPath(root, 'searxng-ext', { kind: 'dir' });
  if (!dir) {
    throw new Error('找不到 searxng-ext 目录（无法安装自定义引擎/插件）');
  }
  return dir;
}

/** 用 `${VAR}` 占位符替换环境变量；未知变量置空并记录 */
function substituteEnv(value, missing, keyPath = '') {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => {
      const envValue = process.env[name];
      if (envValue === undefined || envValue === '') {
        missing.add(name);
        return '';
      }
      return envValue;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => substituteEnv(item, missing, `${keyPath}[${index}]`));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = substituteEnv(item, missing, keyPath ? `${keyPath}.${key}` : key);
    }
    return out;
  }
  return value;
}

async function readExistingSecret(settingsPath) {
  if (!(await exists(settingsPath))) return null;
  try {
    const doc = parseYaml(await fs.readFile(settingsPath, 'utf8'));
    const secret = doc?.server?.secret_key;
    if (typeof secret === 'string' && secret.trim() && !secret.includes('${')) {
      return secret.trim();
    }
  } catch {
    /* 损坏的旧配置忽略，重新生成 */
  }
  return null;
}

/**
 * 生成 settings.yml：
 *   - 基础项（use_default_settings / server / limiter / formats / valkey）由安装器控制；
 *   - engines / plugins / outgoing / ui 等从项目模板合并，保留自定义引擎与配额插件。
 */
async function buildSettings({ root, templateText, port, bindAddress, secretKey, logger }) {
  let template;
  try {
    template = parseYaml(templateText) || {};
  } catch (error) {
    throw new Error(`settings 模板不是合法 YAML：${error.message}`);
  }
  if (typeof template !== 'object' || Array.isArray(template)) {
    throw new Error('settings 模板内容格式异常');
  }

  const doc = deepMerge(
    {
      use_default_settings: true,
      general: { debug: false, instance_name: 'agent-search-gateway' },
      search: { safe_search: 1, autocomplete: '', default_lang: 'zh-HK' },
      outgoing: { request_timeout: 5.0 },
      ui: { default_theme: 'simple' },
    },
    template,
  );

  doc.use_default_settings = true;
  doc.server = {
    ...(doc.server && typeof doc.server === 'object' ? doc.server : {}),
    port,
    bind_address: bindAddress,
    secret_key: secretKey,
    limiter: false,
    public_instance: false,
    image_proxy: false,
    method: 'POST',
  };
  doc.search = {
    ...(doc.search && typeof doc.search === 'object' ? doc.search : {}),
    formats: ['html', 'json'],
  };
  doc.valkey = { url: false };

  const missing = new Set();
  const substituted = substituteEnv(doc, missing);
  if (missing.size > 0) {
    logger(`未设置的环境变量（已置空）：${[...missing].sort().join(', ')}`);
  }

  return stringifyYaml(substituted, { lineWidth: 0 });
}

async function writeSettings({
  root,
  settingsPath,
  templateText,
  port,
  bindAddress,
  options,
  logger,
  mode = 0o600,
}) {
  const existing = await readExistingSecret(settingsPath);
  const secretKey =
    (options.secretKey && String(options.secretKey).trim()) ||
    existing ||
    randomBytes(32).toString('hex');

  const text = await buildSettings({
    root,
    templateText,
    port,
    bindAddress,
    secretKey,
    logger,
  });
  await writeAtomic(settingsPath, text, mode);
  logger(`已生成配置: ${settingsPath}`);
  return text;
}

async function copyExtFiles({ root, extDir, depsDir, logger }) {
  const enginesSrc = path.join(extDir, 'searx', 'engines');
  const pluginsSrc = path.join(extDir, 'searx', 'plugins');
  const enginesDest = path.join(depsDir, 'ext', 'searx', 'engines');
  const pluginsDest = path.join(depsDir, 'ext', 'searx', 'plugins');
  await fs.mkdir(enginesDest, { recursive: true });
  await fs.mkdir(pluginsDest, { recursive: true });

  const copied = [];
  const engineFiles = (await fs.readdir(enginesSrc)).filter(
    (name) => name.endsWith('.py') && !name.startsWith('__'),
  );
  for (const name of engineFiles) {
    const target = path.join(enginesDest, name);
    await fs.copyFile(path.join(enginesSrc, name), target);
    copied.push({ kind: 'engine', name, path: target });
  }

  const quota = path.join(pluginsSrc, 'quota.py');
  if (!(await exists(quota))) {
    throw new Error(`searxng-ext 缺少配额插件：${quota}`);
  }
  const quotaTarget = path.join(pluginsDest, 'quota.py');
  await fs.copyFile(quota, quotaTarget);
  copied.push({ kind: 'plugin', name: 'quota.py', path: quotaTarget });

  logger(`已准备 ${engineFiles.length} 个自定义引擎 + quota 插件`);
  return copied;
}

// ---------------------------------------------------------------------------
// Docker 模式
// ---------------------------------------------------------------------------

async function dockerUsable() {
  const info = await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 15000 });
  if (info.code !== 0) return false;
  const compose = await run('docker', ['compose', 'version'], { timeout: 15000 });
  return compose.code === 0;
}

async function dockerCompose(args, cwd, logger, { ignoreError = false } = {}) {
  const result = await run('docker', ['compose', ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300000,
  });
  const detail = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (result.error) {
    if (ignoreError) return result;
    throw new Error(`无法执行 docker compose：${result.error.message}`);
  }
  if (result.code !== 0) {
    if (ignoreError) {
      logger(`docker compose 退出码 ${result.code}${detail ? `：${detail.slice(-500)}` : ''}`);
      return result;
    }
    throw new Error(
      `docker compose 失败（退出码 ${result.code}）：${detail.slice(-1000) || '(无输出)'}`,
    );
  }
  return result;
}

async function buildCompose({ depsDir, settingsPath, port, extFiles, quotaDir, image }) {
  const volumes = [`${settingsPath}:/etc/searxng/settings.yml:ro`];
  for (const item of extFiles) {
    if (item.kind === 'engine') {
      volumes.push(`${item.path}:/usr/local/searxng/searx/engines/${item.name}:ro`);
    } else {
      volumes.push(`${item.path}:/usr/local/searxng/searx/plugins/${item.name}:ro`);
    }
  }
  volumes.push(`${quotaDir}:/quota`);

  const compose = {
    name: DOCKER_PROJECT,
    services: {
      searxng: {
        image,
        container_name: `${DOCKER_PROJECT}-deps`,
        restart: 'unless-stopped',
        ports: [`127.0.0.1:${port}:8080`],
        environment: {
          TZ: process.env.TZ || 'Asia/Shanghai',
          SEARXNG_BASE_URL: `http://127.0.0.1:${port}/`,
          QUOTA_LEDGER_PATH: '/quota/quota.json',
          QUOTA_CONFIG_PATH: '/quota/quota.config.json',
        },
        volumes,
        healthcheck: {
          test: [
            'CMD',
            '/usr/local/searxng/.venv/bin/python',
            '-c',
            "import sys,urllib.request;sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz',timeout=3).status==200 else 1)",
          ],
          interval: '10s',
          timeout: '5s',
          retries: 18,
          start_period: '30s',
        },
      },
    },
  };
  return stringifyYaml(compose, { lineWidth: 0 });
}

async function waitHealth(url, timeoutMs, logger) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}${HEALTH_PATH}`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return { ok: true, status: res.status };
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  logger(`健康检查超时（最后一次错误：${lastError || '未知'}）`);
  return { ok: false, error: lastError };
}

async function installDocker({ root, platform, pins, options, depsDir, logger }) {
  if (!(await dockerUsable())) {
    throw new Error(
      '未检测到可用的 Docker（或 docker compose 插件）。请安装 Docker Desktop / Docker Engine，' +
        '或使用 --searxng-mode native 改用源码方式。',
    );
  }

  const port = options.port || 8888;
  const image =
    (pins.searxng.dockerImage && String(pins.searxng.dockerImage).trim()) || DOCKER_IMAGE;
  const template = await loadTemplate(root);
  const extDir = await resolveExtDir(root);
  const settingsPath = path.join(depsDir, 'settings.yml');
  const quotaDir = path.join(depsDir, 'quota');
  await fs.mkdir(quotaDir, { recursive: true });

  // 配额种子配置（不要覆盖已有台账）
  const quotaSeed = await resolveProjectPath(root, path.join('docker', 'searxng', 'quota.config.json'));
  const quotaConfig = path.join(quotaDir, 'quota.config.json');
  if (quotaSeed && !(await exists(quotaConfig))) {
    await fs.copyFile(quotaSeed, quotaConfig);
  }

  await writeSettings({
    root,
    settingsPath,
    templateText: template.text,
    port: 8080,
    bindAddress: '0.0.0.0',
    options,
    logger,
    mode: 0o644,
  });

  const extFiles = await copyExtFiles({ root, extDir, depsDir, logger });
  const composePath = path.join(depsDir, 'compose.yaml');
  const composeText = await buildCompose({
    depsDir,
    settingsPath,
    port,
    extFiles,
    quotaDir,
    image,
  });
  await writeAtomic(composePath, composeText);

  logger(`启动 Docker 容器（127.0.0.1:${port} -> 8080）...`);
  await dockerCompose(
    ['-p', DOCKER_PROJECT, '-f', composePath, 'up', '-d', '--remove-orphans'],
    depsDir,
    logger,
  );

  const url = `http://127.0.0.1:${port}`;
  logger('等待 searxng 健康检查 ...');
  const health = await waitHealth(url, 180000, logger);
  if (!health.ok) {
    throw new Error(
      `searxng 容器已启动但健康检查失败（${url}${HEALTH_PATH}）。` +
        `请查看日志：docker compose -f ${composePath} logs`,
    );
  }

  const version = pins.searxng.commit;
  await writeJson(path.join(depsDir, 'install.json'), {
    mode: 'docker',
    version,
    commit: version,
    image,
    port,
    url,
    installed_at: new Date().toISOString(),
    platform,
  });

  logger(`searxng（Docker）已就绪: ${url}`);
  return { mode: 'docker', url, version, launch: null };
}

// ---------------------------------------------------------------------------
// Python 检测 / Windows 安装
// ---------------------------------------------------------------------------

function pythonVersionOk(version) {
  const [major, minor] = String(version)
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  return major > MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor >= MIN_PYTHON[1]);
}

function windowsPythonCandidates() {
  const candidates = [];
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  for (const version of ['313', '312', '311']) {
    candidates.push(
      path.join(localAppData, 'Programs', 'Python', `Python${version}`, 'python.exe'),
      path.join(programFiles, `Python${version}`, 'python.exe'),
    );
  }
  return candidates;
}

async function probePython(command, args, version) {
  const versionArgs = ['-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])'];
  const result = await run(command, [...args, ...versionArgs], { timeout: 20000 });
  if (result.error || result.code !== 0) return null;
  const detected = (result.stdout || '').trim().split(/\s+/).pop() || '';
  const parsed = detected.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!parsed) return null;
  const normalized = `${parsed[1]}.${parsed[2]}.${parsed[3]}`;
  if (!pythonVersionOk(normalized)) {
    return { command, args, version: normalized, ok: false };
  }
  void version;
  return { command, args, version: normalized, ok: true };
}

async function detectPython({ platform, options, logger, allowWindowsInstall }) {
  const isWin = platform.startsWith('win32');
  const explicit = options.pythonPath && String(options.pythonPath).trim();
  const candidates = [];

  if (explicit) {
    candidates.push({ command: explicit, args: [] });
  } else {
    if (process.env.PYTHON) candidates.push({ command: process.env.PYTHON, args: [] });
    if (isWin) {
      for (const version of ['3.12', '3.11', '3']) {
        candidates.push({ command: 'py', args: [`-${version}`] });
      }
      candidates.push({ command: 'python', args: [] });
      candidates.push({ command: 'python3', args: [] });
      for (const candidate of windowsPythonCandidates()) {
        if (existsSync(candidate)) candidates.push({ command: candidate, args: [] });
      }
    } else {
      for (const name of ['python3.13', 'python3.12', 'python3.11', 'python3', 'python']) {
        candidates.push({ command: name, args: [] });
      }
    }
  }

  let tooOld = null;
  for (const candidate of candidates) {
    const probed = await probePython(candidate.command, candidate.args, null);
    if (!probed) continue;
    if (probed.ok) {
      logger(`使用 Python ${probed.version}（${probed.command}${probed.args.length ? ` ${probed.args.join(' ')}` : ''}）`);
      return probed;
    }
    tooOld = tooOld || probed;
  }

  if (explicit) {
    throw new Error(
      `指定的 Python 不可用或版本过低：${explicit}（需要 Python ${MIN_PYTHON.join('.')}+）`,
    );
  }

  if (isWin && allowWindowsInstall) {
    await installWindowsPython({ root: options.root, logger });
    const probed = await detectPython({
      platform,
      options: { ...options, pythonPath: '' },
      logger,
      allowWindowsInstall: false,
    });
    return probed;
  }

  const link = 'https://www.python.org/downloads/';
  if (isWin) {
    throw new Error(
      `未找到 Python ${MIN_PYTHON.join('.')}+。请安装 Python ${WINDOWS_PYTHON_VERSION}（勾选 "Add python.exe to PATH"）：${link}\n` +
        '或在安装器中允许自动安装（去掉 --no-python-install）。',
    );
  }
  throw new Error(
    `未找到 Python ${MIN_PYTHON.join('.')}+${tooOld ? `（检测到 ${tooOld.version}）` : ''}。` +
      `请先安装 Python ${MIN_PYTHON.join('.')}+：${link}`,
  );
}

async function installWindowsPython({ root, logger }) {
  const url = process.env.SEARXNG_PYTHON_INSTALLER_URL || WINDOWS_PYTHON_URL;
  if (!url.startsWith('https://')) {
    throw new Error(`Python 安装包地址必须是 https：${url}`);
  }
  const depsDir = path.join(root, DEPS_REL);
  const cacheDir = path.join(depsDir, 'cache');
  const installer = path.join(cacheDir, path.basename(new URL(url).pathname));

  if (!(await exists(installer))) {
    logger(`未找到 Python，正在下载官方安装包：${url}`);
    await download(url, installer, { logger });
  }

  logger(`正在静默安装 Python ${WINDOWS_PYTHON_VERSION}（当前用户）...`);
  const args = [
    '/quiet',
    'InstallAllUsers=0',
    'PrependPath=1',
    'Include_pip=1',
    'Include_test=0',
    'Include_launcher=1',
    'InstallLauncherAllUsers=0',
  ];
  const result = await run(installer, args, { stdio: 'inherit', timeout: 900000 });
  if (result.error || result.code !== 0) {
    throw new Error(
      `Python 自动安装失败（退出码 ${result.code ?? '未知'}）。请手动安装 Python ${WINDOWS_PYTHON_VERSION}：` +
        'https://www.python.org/downloads/windows/',
    );
  }
  logger('Python 安装完成，重新检测 ...');
}

// ---------------------------------------------------------------------------
// native 模式
// ---------------------------------------------------------------------------

async function ensureArchive({ root, pins, depsDir, logger }) {
  const { archive, sha256, commit } = pins.searxng;
  if (!archive || !sha256 || !commit) {
    throw new Error('runtime/pins.json 缺少 searxng.archive / sha256 / commit');
  }
  const cacheDir = path.join(depsDir, 'cache');
  await fs.mkdir(cacheDir, { recursive: true });
  const fileName = path.basename(new URL(archive).pathname) || `searxng-${commit}.zip`;
  const archivePath = path.join(cacheDir, fileName);

  if (await exists(archivePath)) {
    const cached = await sha256File(archivePath);
    if (cached.toLowerCase() === String(sha256).toLowerCase()) {
      logger(`使用已缓存的 searxng 源码包（${fileName}）`);
      return archivePath;
    }
    logger('缓存源码包校验失败，重新下载 ...');
    await fs.rm(archivePath, { force: true });
  }

  logger(`下载 searxng ${String(commit).slice(0, 12)} 源码 ...`);
  await download(archive, archivePath, { logger });
  await verifySha256(archivePath, sha256, fileName);
  return archivePath;
}

async function ensureSource({ root, platform, pins, depsDir, archivePath, logger }) {
  const srcDir = path.join(depsDir, 'src');
  const markerFile = path.join(depsDir, 'source.json');
  const commit = pins.searxng.commit;

  if (await exists(markerFile)) {
    try {
      const marker = await readJson(markerFile);
      if (marker.commit === commit && (await exists(path.join(srcDir, 'searx', 'webapp.py')))) {
        logger(`searxng 源码已是 pinned 版本（${String(commit).slice(0, 12)}），跳过解压`);
        return srcDir;
      }
    } catch {
      /* 继续重新解压 */
    }
  }

  logger('解压 searxng 源码 ...');
  const tempDir = path.join(depsDir, `src.tmp-${process.pid}-${Date.now()}`);
  await fs.rm(tempDir, { recursive: true, force: true });
  try {
    const result = await unpackZip(archivePath, tempDir, {
      stripComponents: 1,
      skipInvalid: platform.startsWith('win32'),
      logger,
    });
    if (!(await exists(path.join(tempDir, 'searx', 'webapp.py')))) {
      throw new Error('解压后未找到 searx/webapp.py，源码包结构异常');
    }
    await fs.rm(srcDir, { recursive: true, force: true });
    await fs.rename(tempDir, srcDir);
    await writeJson(markerFile, {
      commit,
      sha256: pins.searxng.sha256,
      extracted_at: new Date().toISOString(),
      extracted: result.extracted,
      skipped: result.skipped.length,
    });
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`解压 searxng 源码失败：${error.message}`);
  }
  return srcDir;
}

async function ensureVenv({ platform, python, venvDir, logger }) {
  const venvPython = venvPythonPath(venvDir, platform);
  if (await exists(venvPython)) {
    const probe = await run(venvPython, ['-c', 'import sys; print(sys.version)'], { timeout: 20000 });
    if (probe.code === 0) return venvPython;
    logger('现有 venv 不可用，重新创建 ...');
  }

  await fs.rm(venvDir, { recursive: true, force: true });
  logger(`创建 Python 虚拟环境：${venvDir}`);
  const result = await run(python.command, [...python.args, '-m', 'venv', venvDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300000,
  });
  const detail = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (result.error || result.code !== 0) {
    throw new Error(
      `创建 venv 失败（Python ${python.version}）：${detail || result.error?.message || `退出码 ${result.code}`}\n` +
        'Linux 请安装 python3-venv（Debian/Ubuntu: sudo apt install python3-venv）。',
    );
  }
  if (!(await exists(venvPython))) {
    throw new Error(`venv 创建后未找到 ${venvPython}`);
  }
  return venvPython;
}

async function ensureRequirements({ venvPython, srcDir, venvDir, commit, logger }) {
  const requirements = path.join(srcDir, 'requirements.txt');
  const serverRequirements = path.join(srcDir, 'requirements-server.txt');
  for (const file of [requirements, serverRequirements]) {
    if (!(await exists(file))) {
      throw new Error(`searxng 源码缺少依赖清单：${file}`);
    }
  }

  const stamp =
    sha256Text(
      [
        commit,
        await sha256File(requirements),
        await sha256File(serverRequirements),
      ].join('\n'),
    ) + '\n';
  const stampFile = path.join(venvDir, '.searxng-requirements');
  if ((await exists(stampFile)) && (await fs.readFile(stampFile, 'utf8')) === stamp) {
    logger('Python 依赖已安装（与 pinned 版本一致），跳过 pip install');
    return;
  }

  logger('安装 Python 依赖（首次约需数分钟）...');
  const result = await run(
    venvPython,
    [
      '-m',
      'pip',
      'install',
      '--disable-pip-version-check',
      '-r',
      requirements,
      '-r',
      serverRequirements,
    ],
    { cwd: srcDir, stdio: 'inherit', timeout: 1800000 },
  );
  if (result.error || result.code !== 0) {
    throw new Error(
      `Python 依赖安装失败（退出码 ${result.code ?? '未知'}）。\n` +
        '若在代理环境，请设置 HTTPS_PROXY；也可设置 PIP_INDEX_URL 使用国内镜像后重试。',
    );
  }
  await writeAtomic(stampFile, stamp);
}

async function installNative({ root, platform, pins, options, depsDir, logger }) {
  const port = options.port || 8888;
  const srcDir = path.join(depsDir, 'src');
  const venvDir = path.join(depsDir, 'venv');
  const settingsPath = path.join(depsDir, 'settings.yml');

  const python = await detectPython({
    platform,
    options: { ...options, root },
    logger,
    allowWindowsInstall: platform.startsWith('win32') && !options.noPythonInstall,
  });

  const template = await loadTemplate(root);
  const extDir = await resolveExtDir(root);
  const archivePath = await ensureArchive({ root, pins, depsDir, logger });
  const sourceDir = await ensureSource({ root, platform, pins, depsDir, archivePath, logger });

  // 自定义引擎 / 插件
  const engineDest = path.join(sourceDir, 'searx', 'engines');
  const pluginDest = path.join(sourceDir, 'searx', 'plugins');
  const enginesSrc = path.join(extDir, 'searx', 'engines');
  for (const name of await fs.readdir(enginesSrc)) {
    if (!name.endsWith('.py') || name.startsWith('__')) continue;
    await fs.copyFile(path.join(enginesSrc, name), path.join(engineDest, name));
  }
  await fs.copyFile(path.join(extDir, 'searx', 'plugins', 'quota.py'), path.join(pluginDest, 'quota.py'));
  logger('已复制自定义引擎与 quota 插件');

  // Windows：pwd 补丁
  if (platform.startsWith('win32')) {
    await patchValkeyDbFile(path.join(sourceDir, 'searx', 'valkeydb.py'), logger);
  }

  // 配置
  await writeSettings({
    root,
    settingsPath,
    templateText: template.text,
    port,
    bindAddress: '127.0.0.1',
    options,
    logger,
  });

  // venv + 依赖
  const venvPython = await ensureVenv({ platform, python, venvDir, logger });
  await ensureRequirements({
    venvPython,
    srcDir: sourceDir,
    venvDir,
    commit: pins.searxng.commit,
    logger,
  });

  const url = `http://127.0.0.1:${port}`;
  const launch = {
    command: [venvPython, '-m', 'granian', 'searx.webapp:app'],
    cwd: sourceDir,
    env: {
      GRANIAN_INTERFACE: 'wsgi',
      GRANIAN_HOST: '127.0.0.1',
      GRANIAN_PORT: String(port),
      GRANIAN_WEBSOCKETS: 'false',
      GRANIAN_PROCESS_NAME: 'searxng',
      GRANIAN_BLOCKING_THREADS: '4',
      SEARXNG_SETTINGS_PATH: settingsPath,
      PYTHONUNBUFFERED: '1',
    },
    health: `${url}${HEALTH_PATH}`,
  };

  const version = pins.searxng.commit;
  await writeJson(path.join(depsDir, 'install.json'), {
    mode: 'native',
    version,
    commit: version,
    port,
    url,
    python: python.version,
    python_command: python.command,
    installed_at: new Date().toISOString(),
    platform,
  });

  logger(`searxng（原生）已安装: ${url}（版本 ${String(version).slice(0, 12)}）`);
  return { mode: 'native', url, version, launch };
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/**
 * 安装 searxng。
 *
 * @param {{ root: string, platform: string, pins: object, options?: object, logger?: Function }} params
 * @returns {Promise<{ mode: 'docker'|'native'|'external', url: string, version: string, launch: object|null }>}
 */
export async function installSearxng({ root, platform, pins, options = {}, logger } = {}) {
  const log = makeLogger(logger);
  if (!root) throw new Error('installSearxng 缺少 root 参数');
  if (!platform) throw new Error('installSearxng 缺少 platform 参数');
  if (!pins?.searxng?.commit || !pins?.searxng?.archive || !pins?.searxng?.sha256) {
    throw new Error('runtime/pins.json 缺少 searxng.commit / archive / sha256');
  }

  const mode = options.mode || 'auto';
  const port = Number(options.port || 8888);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`searxng 端口不合法：${options.port}`);
  }
  const depsDir = path.join(root, DEPS_REL);

  if (mode === 'external') {
    if (!options.url || !String(options.url).trim()) {
      throw new Error('external 模式需要提供 searxng URL（options.url）');
    }
    const url = String(options.url).trim().replace(/\/+$/, '');
    log(`使用已有 searxng: ${url}`);
    return { mode: 'external', url, version: 'external', launch: null };
  }
  if (!['auto', 'docker', 'native'].includes(mode)) {
    throw new Error(`未知的 searxng 安装模式：${mode}（可选 auto | docker | native | external）`);
  }

  await fs.mkdir(depsDir, { recursive: true });

  let resolved = mode;
  if (mode === 'auto') {
    resolved = platform.startsWith('win32') ? 'native' : (await dockerUsable()) ? 'docker' : 'native';
    log(`auto 模式选择：${resolved}`);
  }
  if (mode === 'docker' && platform.startsWith('win32')) {
    log('Windows 默认使用原生模式，忽略 docker 模式请求');
    resolved = 'native';
  }

  if (resolved === 'docker') {
    try {
      return await installDocker({ root, platform, pins, options, depsDir, logger: log });
    } catch (error) {
      if (mode !== 'auto') throw error;
      log(`Docker 启动失败，回退原生模式：${error.message}`);
      return installNative({ root, platform, pins, options, depsDir, logger: log });
    }
  }
  return installNative({ root, platform, pins, options, depsDir, logger: log });
}

/** 卸载：停止 compose 容器（若存在）并删除 data/deps/searxng。 */
export async function uninstallSearxng({ root, platform, options = {}, logger } = {}) {
  const log = makeLogger(logger);
  if (!root) throw new Error('uninstallSearxng 缺少 root 参数');
  const depsDir = path.join(root, DEPS_REL);
  const composePath = path.join(depsDir, 'compose.yaml');

  if (await exists(composePath)) {
    log('停止 searxng 容器 ...');
    await dockerCompose(
      ['-p', DOCKER_PROJECT, '-f', composePath, 'down', '--remove-orphans', '-v'],
      depsDir,
      log,
      { ignoreError: true },
    );
  }

  if (await exists(depsDir)) {
    await fs.rm(depsDir, { recursive: true, force: true });
    log(`已删除 ${depsDir}`);
  } else {
    log(`未安装（${depsDir} 不存在）`);
  }
  void platform;
  void options;
  return { removed: true };
}

/**
 * 查询安装状态：模式、版本、URL 与 /healthz 健康状态。
 */
export async function searxngStatus({ root, platform, pins, logger } = {}) {
  const log = makeLogger(logger);
  const depsDir = path.join(root, DEPS_REL);
  const markerFile = path.join(depsDir, 'install.json');
  const version = pins?.searxng?.commit || null;

  if (!(await exists(markerFile))) {
    return {
      installed: false,
      mode: null,
      version: null,
      url: null,
      healthy: false,
      health: { ok: false, error: '未安装' },
      dir: depsDir,
    };
  }

  let marker;
  try {
    marker = await readJson(markerFile);
  } catch (error) {
    throw new Error(`安装记录损坏（${markerFile}）：${error.message}`);
  }

  const url = marker.url || (marker.port ? `http://127.0.0.1:${marker.port}` : null);
  let health = { ok: false, error: '缺少 URL' };
  if (url) {
    try {
      const res = await fetch(`${url}${HEALTH_PATH}`, { signal: AbortSignal.timeout(3000) });
      health = res.ok
        ? { ok: true, status: res.status }
        : { ok: false, status: res.status, error: `HTTP ${res.status}` };
    } catch (error) {
      health = { ok: false, error: error?.message || String(error) };
    }
  }
  if (!health.ok) {
    log(`searxng 健康检查失败：${health.error || `HTTP ${health.status}`}`);
  }

  return {
    installed: true,
    mode: marker.mode || null,
    version: marker.version || version,
    url,
    port: marker.port || null,
    healthy: Boolean(health.ok),
    health,
    dir: depsDir,
    platform: marker.platform || platform || null,
    python: marker.python || null,
    installed_at: marker.installed_at || null,
  };
}

export { patchValkeyDb } from './windows-patch.mjs';
