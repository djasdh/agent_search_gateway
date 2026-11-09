#!/usr/bin/env node
/**
 * agent_search_gateway 前台 supervisor
 *
 * 按 <root>/data/runtime/launch.json 的顺序启动 searxng / flaresolverr / gateway，
 * 每个服务启动后轮询健康检查；全部就绪后持续前台运行，并把子进程输出加上
 * [name] 前缀。任一子进程退出时停止其余进程并非 0 退出，交给 systemd /
 * launchd / 计划任务重启。
 *
 * 用法：
 *   node scripts/start-all.mjs           启动并监督
 *   node scripts/start-all.mjs --check   只校验 launch.json 与健康状态
 *   node scripts/start-all.mjs --help    显示帮助
 *
 * 环境变量：
 *   START_ALL_HEALTH_TIMEOUT        每个服务的健康等待秒数（默认 120）
 *   START_ALL_HEALTH_INTERVAL_MS    健康轮询间隔毫秒（默认 1000）
 *   START_ALL_STOP_GRACE_MS         优雅停止等待毫秒（默认 10000）
 *   START_ALL_MONITOR_INTERVAL_MS   外部已运行服务的复查间隔毫秒（默认 30000）
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCH_FILE = path.join(ROOT, 'data', 'runtime', 'launch.json');

const DEFAULT_HEALTH_TIMEOUT_SECONDS = 120;
const DEFAULT_HEALTH_INTERVAL_MS = 1000;
const DEFAULT_STOP_GRACE_MS = 10_000;
const DEFAULT_MONITOR_INTERVAL_MS = 30_000;

const USAGE = `用法: node scripts/start-all.mjs [--check] [--help]

前台启动并监督 launch.json 中声明的服务。

配置文件:
  <项目根>/data/runtime/launch.json
  services 可以为空数组，也可以只包含部分组件。

选项:
  --check    只校验 launch.json 与服务健康状态，不启动任何进程；
             配置无效或有服务未就绪时以 1 退出
  -h, --help 显示本帮助

环境变量:
  START_ALL_HEALTH_TIMEOUT        每个服务的健康等待秒数（默认 120）
  START_ALL_HEALTH_INTERVAL_MS    健康轮询间隔毫秒（默认 1000）
  START_ALL_STOP_GRACE_MS         优雅停止等待毫秒（默认 10000）
  START_ALL_MONITOR_INTERVAL_MS   外部已运行服务的复查间隔毫秒（默认 30000）

退出行为:
  - 任一本进程管理的子进程退出：停止其余服务，以非 0 退出；
  - 收到 SIGINT / SIGTERM / SIGHUP：把信号转发给所有子进程，等待退出后退出。
`;

const state = {
  shuttingDown: false,
  exitCode: 0,
  signalCount: 0,
  resolveShutdown: null,
};

const records = [];
let monitorTimer = null;
let keepAliveTimer = null;

const shutdownDone = new Promise((resolve) => {
  state.resolveShutdown = resolve;
});

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function log(name, message) {
  process.stdout.write(`[${name}] ${message}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readEnvNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    log('start-all', `环境变量 ${name}=${raw} 无效，使用默认值 ${fallback}`);
    return fallback;
  }
  return value;
}

function formatCommand(command) {
  return command
    .map((part) => (/[\s"]/.test(part) ? JSON.stringify(part) : part))
    .join(' ');
}

function describeExit(code, signal) {
  if (signal) return `信号 ${signal}`;
  if (typeof code === 'number') return `退出码 ${code}`;
  return '未知状态';
}

function parseArgs(argv) {
  const options = { check: false, help: false };
  for (const arg of argv) {
    if (arg === '--check') {
      options.check = true;
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else {
      throw new Error(`未知参数：${arg}\n\n${USAGE}`);
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// 配置加载与校验
// ---------------------------------------------------------------------------

function loadLaunchConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`无法读取启动配置 ${file}：${error.message}`);
  }

  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`启动配置不是合法 JSON（${file}）：${error.message}`);
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`启动配置必须是 JSON 对象：${file}`);
  }

  if (data.services === undefined) {
    return { services: [], warnings: ['launch.json 未包含 services，按空列表处理'] };
  }
  if (!Array.isArray(data.services)) {
    throw new Error('launch.json 的 services 必须是数组');
  }

  const names = new Set();
  const services = data.services.map((item, index) => {
    const service = validateService(item, index);
    if (names.has(service.name)) {
      throw new Error(`launch.json 中存在重复的服务名：${service.name}`);
    }
    names.add(service.name);
    return service;
  });

  return { services, warnings: [] };
}

function validateService(item, index) {
  const label = `services[${index}]`;
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`${label} 必须是对象`);
  }

  const name = typeof item.name === 'string' ? item.name.trim() : '';
  if (!name) {
    throw new Error(`${label}.name 必须是非空字符串`);
  }

  if (!Array.isArray(item.command) || item.command.length === 0) {
    throw new Error(`${name}.command 必须是非空字符串数组`);
  }
  const command = item.command.map((part, partIndex) => {
    if (typeof part !== 'string' || part === '') {
      throw new Error(`${name}.command[${partIndex}] 必须是非空字符串`);
    }
    return part;
  });

  let cwd = ROOT;
  if (item.cwd !== undefined && item.cwd !== null) {
    if (typeof item.cwd !== 'string' || item.cwd.trim() === '') {
      throw new Error(`${name}.cwd 必须是非空字符串`);
    }
    cwd = path.resolve(ROOT, item.cwd);
  }
  let stat;
  try {
    stat = fs.statSync(cwd);
  } catch {
    throw new Error(`${name}.cwd 不存在：${cwd}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${name}.cwd 不是目录：${cwd}`);
  }

  const env = {};
  if (item.env !== undefined && item.env !== null) {
    if (typeof item.env !== 'object' || Array.isArray(item.env)) {
      throw new Error(`${name}.env 必须是对象`);
    }
    for (const [key, value] of Object.entries(item.env)) {
      if (value === null || typeof value === 'object') {
        throw new Error(`${name}.env.${key} 必须是字符串、数字或布尔值`);
      }
      env[key] = String(value);
    }
  }

  let health = null;
  if (item.health !== undefined && item.health !== null && item.health !== '') {
    if (typeof item.health !== 'string') {
      throw new Error(`${name}.health 必须是 http(s) URL 字符串`);
    }
    let url;
    try {
      url = new URL(item.health);
    } catch {
      throw new Error(`${name}.health 不是合法 URL：${item.health}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`${name}.health 只支持 http/https：${item.health}`);
    }
    health = item.health;
  }

  return { name, command, cwd, env, health };
}

// ---------------------------------------------------------------------------
// 健康检查
// ---------------------------------------------------------------------------

async function probeHealth(url, timeoutMs = 2000) {
  if (!url) return true;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))),
      redirect: 'manual',
    });
    // 读掉响应体，避免连接悬挂。
    try {
      await response.arrayBuffer();
    } catch {
      // 忽略响应体读取失败，状态码仍可作为判断依据。
    }
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(record, timeoutMs, intervalMs) {
  const { svc } = record;
  const startedAt = Date.now();
  let nextNotice = 5000;
  let attempts = 0;

  while (Date.now() - startedAt < timeoutMs) {
    if (state.shuttingDown || record.exited) return false;
    attempts += 1;
    const remaining = timeoutMs - (Date.now() - startedAt);
    const probeTimeout = Math.max(200, Math.min(2000, remaining));
    if (await probeHealth(svc.health, probeTimeout)) return true;
    if (state.shuttingDown || record.exited) return false;

    const elapsed = Date.now() - startedAt;
    if (elapsed >= nextNotice) {
      log(
        svc.name,
        `仍在等待健康检查（已 ${Math.round(elapsed / 1000)} 秒，第 ${attempts} 次）：${svc.health}`,
      );
      nextNotice += 5000;
    }

    const wait = Math.min(intervalMs, Math.max(0, timeoutMs - (Date.now() - startedAt)));
    if (wait > 0) await sleep(wait);
  }

  return false;
}

async function runCheck(services) {
  log('check', `配置文件：${LAUNCH_FILE}`);
  if (services.length === 0) {
    log('check', 'services 为空，无需启动任何服务');
    return 0;
  }

  let unhealthy = 0;
  for (const svc of services) {
    if (!svc.health) {
      log(svc.name, '未配置健康检查（启动时直接运行）');
      continue;
    }
    const healthy = await probeHealth(svc.health, 3000);
    log(svc.name, healthy ? `健康：${svc.health}` : `未就绪：${svc.health}`);
    if (!healthy) unhealthy += 1;
  }

  if (unhealthy === 0) {
    log('check', `全部 ${services.length} 个服务检查通过`);
    return 0;
  }
  log('check', `${unhealthy} 个服务未就绪`);
  return 1;
}

// ---------------------------------------------------------------------------
// 子进程管理
// ---------------------------------------------------------------------------

function prefixStream(stream, name, target) {
  if (!stream) return;
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  reader.on('line', (line) => {
    target.write(`[${name}] ${line}\n`);
  });
}

function startService(svc) {
  const child = spawn(svc.command[0], svc.command.slice(1), {
    cwd: svc.cwd,
    env: { ...process.env, ...svc.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });

  const record = {
    svc,
    child,
    external: false,
    exited: false,
    exitCode: null,
    exitSignal: null,
    error: null,
    healthy: true,
    exitPromise: null,
    resolveExit: null,
  };
  record.exitPromise = new Promise((resolve) => {
    record.resolveExit = resolve;
  });

  prefixStream(child.stdout, svc.name, process.stdout);
  prefixStream(child.stderr, svc.name, process.stderr);

  child.on('error', (error) => {
    if (record.exited) return;
    record.exited = true;
    record.error = error;
    record.resolveExit();
    log(svc.name, `启动失败：${error.message}`);
    if (!state.shuttingDown) {
      void initiateShutdown({ code: 1, reason: `启动失败：${svc.name}` });
    }
  });

  child.on('exit', (code, signal) => {
    if (record.exited) return;
    record.exited = true;
    record.exitCode = code;
    record.exitSignal = signal;
    record.resolveExit();
    const detail = describeExit(code, signal);

    if (state.shuttingDown) {
      log(svc.name, `已退出（${detail}）`);
      return;
    }

    log(svc.name, `意外退出（${detail}），正在停止其余服务`);
    const exitCode = typeof code === 'number' && code !== 0 ? code : 1;
    void initiateShutdown({ code: exitCode, reason: `子进程退出：${svc.name}` });
  });

  return record;
}

function sendSignal(record, signal, force = false) {
  const { child } = record;
  if (!child || record.exited) return;
  const pid = child.pid;

  if (process.platform === 'win32') {
    if (force && pid) {
      try {
        spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
          windowsHide: true,
          stdio: 'ignore',
        })
          .on('error', () => {})
          .unref();
      } catch {
        // 下面的 child.kill 作为兜底。
      }
    }
    try {
      child.kill(force ? 'SIGKILL' : undefined);
    } catch {
      // 进程可能已经退出。
    }
    return;
  }

  if (!pid) {
    try {
      child.kill(signal);
    } catch {
      // 忽略已退出进程。
    }
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error && error.code !== 'ESRCH') {
      try {
        child.kill(signal);
      } catch {
        // 忽略已退出进程。
      }
    }
  }
}

async function stopAll(signal) {
  const live = records.filter((record) => !record.external && record.child && !record.exited);
  if (live.length === 0) return;

  for (const record of live) {
    sendSignal(record, signal);
  }

  const graceMs = readEnvNumber('START_ALL_STOP_GRACE_MS', DEFAULT_STOP_GRACE_MS);
  await Promise.race([
    Promise.all(live.map((record) => record.exitPromise)),
    sleep(graceMs),
  ]);

  const remaining = live.filter((record) => !record.exited);
  if (remaining.length === 0) return;

  log('start-all', `${remaining.length} 个进程未在 ${graceMs}ms 内退出，强制结束`);
  for (const record of remaining) {
    sendSignal(record, 'SIGKILL', true);
  }
  await Promise.race([
    Promise.all(remaining.map((record) => record.exitPromise)),
    sleep(3000),
  ]);
}

async function initiateShutdown({ code, reason, signal }) {
  if (state.shuttingDown) return shutdownDone;

  state.shuttingDown = true;
  state.exitCode = Number.isInteger(code) ? code : 1;
  log('start-all', `开始停止所有服务${reason ? `（${reason}）` : ''}`);

  try {
    await stopAll(signal || 'SIGTERM');
  } catch (error) {
    log('start-all', `停止服务时出错：${error.message}`);
  } finally {
    if (monitorTimer) {
      clearInterval(monitorTimer);
      monitorTimer = null;
    }
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    log('start-all', `全部服务已停止，退出码 ${state.exitCode}`);
    if (state.resolveShutdown) state.resolveShutdown();
  }

  return shutdownDone;
}

function installSignalHandlers() {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    try {
      process.on(signal, () => {
        if (state.shuttingDown) {
          state.signalCount += 1;
          if (state.signalCount >= 2) {
            log('start-all', `再次收到 ${signal}，强制结束剩余进程`);
            for (const record of records) {
              sendSignal(record, 'SIGKILL', true);
            }
          }
          return;
        }
        state.signalCount = 1;
        log('start-all', `收到 ${signal}，开始优雅停止`);
        void initiateShutdown({ code: 0, reason: `信号 ${signal}`, signal });
      });
    } catch {
      // 某些平台不支持个别信号，忽略即可。
    }
  }
}

function startMonitor(intervalMs) {
  const externals = records.filter((record) => record.external && record.svc.health);
  if (externals.length === 0) return;

  let running = false;
  monitorTimer = setInterval(async () => {
    if (running || state.shuttingDown) return;
    running = true;
    try {
      for (const record of externals) {
        if (state.shuttingDown) return;
        const healthy = await probeHealth(record.svc.health, 2000);
        if (record.healthy === healthy) continue;
        record.healthy = healthy;
        if (healthy) {
          log(record.svc.name, `外部服务恢复健康：${record.svc.health}`);
        } else {
          log(
            record.svc.name,
            `外部服务健康检查失败：${record.svc.health}（该进程不在本 supervisor 管理范围内）`,
          );
        }
      }
    } finally {
      running = false;
    }
  }, intervalMs);
  // 监督模式由 keepAliveTimer 维持，监控定时器本身不需要阻止退出。
  if (typeof monitorTimer.unref === 'function') monitorTimer.unref();
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  const { services, warnings } = loadLaunchConfig(LAUNCH_FILE);
  for (const warning of warnings) log('start-all', warning);

  if (options.check) {
    process.exitCode = await runCheck(services);
    return;
  }

  installSignalHandlers();

  const healthTimeoutSeconds = readEnvNumber(
    'START_ALL_HEALTH_TIMEOUT',
    DEFAULT_HEALTH_TIMEOUT_SECONDS,
  );
  const healthIntervalMs = readEnvNumber(
    'START_ALL_HEALTH_INTERVAL_MS',
    DEFAULT_HEALTH_INTERVAL_MS,
  );
  const monitorIntervalMs = readEnvNumber(
    'START_ALL_MONITOR_INTERVAL_MS',
    DEFAULT_MONITOR_INTERVAL_MS,
  );
  const healthTimeoutMs = healthTimeoutSeconds * 1000;

  log('start-all', `项目根目录：${ROOT}`);
  log('start-all', `配置文件：${LAUNCH_FILE}`);
  log('start-all', `共 ${services.length} 个服务`);

  for (const svc of services) {
    if (state.shuttingDown) break;

    if (svc.health) {
      const alreadyHealthy = await probeHealth(svc.health, 2000);
      if (state.shuttingDown) break;
      if (alreadyHealthy) {
        records.push({
          svc,
          child: null,
          external: true,
          exited: false,
          healthy: true,
        });
        log(svc.name, `已在运行（${svc.health}），跳过启动并纳入监督`);
        continue;
      }
    }

    log(svc.name, `启动：${formatCommand(svc.command)}`);
    const record = startService(svc);
    records.push(record);
    if (state.shuttingDown) break;

    if (!svc.health) {
      log(svc.name, '未配置健康检查，视为已就绪');
      continue;
    }

    log(svc.name, `等待健康检查：${svc.health}（最多 ${healthTimeoutSeconds} 秒）`);
    const healthy = await waitForHealth(record, healthTimeoutMs, healthIntervalMs);
    if (!healthy) {
      if (state.shuttingDown) break;
      log(svc.name, `健康检查超时（${healthTimeoutSeconds} 秒）：${svc.health}`);
      await initiateShutdown({ code: 1, reason: `健康检查超时：${svc.name}` });
      break;
    }
    log(svc.name, `健康检查通过：${svc.health}`);
  }

  if (state.shuttingDown) {
    await shutdownDone;
    process.exitCode = state.exitCode;
    return;
  }

  startMonitor(monitorIntervalMs);
  keepAliveTimer = setInterval(() => {}, 3_600_000);

  if (services.length === 0) {
    log('start-all', '没有需要启动的服务，仅保持前台监督；按 Ctrl+C 退出');
  } else {
    log('start-all', `全部 ${services.length} 个服务已就绪，进入监督模式`);
  }

  await shutdownDone;
  process.exitCode = state.exitCode;
}

try {
  await main();
} catch (error) {
  log('start-all', `错误：${error.message}`);
  if (!state.shuttingDown && records.length > 0) {
    await initiateShutdown({ code: 1, reason: '未预期错误' });
  }
  process.exitCode = 1;
}
