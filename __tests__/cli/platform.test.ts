import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, describe, expect, it } from "vitest";
import type { CommandResult, CommandRunner, PlatformEnv } from "../../src/cli/platform/index.js";
import { detectManager } from "../../src/cli/platform/index.js";
import * as launchd from "../../src/cli/platform/launchd.js";
import * as schtasks from "../../src/cli/platform/schtasks.js";
import * as systemd from "../../src/cli/platform/systemd.js";
import {
  LAUNCHD_LABEL,
  SERVICE_NAME,
  WINDOWS_TASK_NAME,
  launchdPlistPath,
  systemdUnitPath,
} from "../../src/cli/platform/paths.js";

const tempDirs: string[] = [];

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asg-platform-"));
  tempDirs.push(dir);
  return dir;
}

interface Call {
  command: string;
  args: string[];
}

function makeRunner(
  handler: (command: string, args: string[]) => Partial<CommandResult> | void,
): { runner: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: CommandRunner = (command, args) => {
    calls.push({ command, args });
    return {
      ok: true,
      status: 0,
      stdout: "",
      stderr: "",
      ...(handler(command, args) ?? {}),
    };
  };
  return { runner, calls };
}

function envWith(
  runner: CommandRunner,
  home: string,
  platform = "linux",
  uid = "501",
): PlatformEnv {
  return { runner, platform, home, uid };
}

function fail(): Partial<CommandResult> {
  return { ok: false, status: 1, stdout: "", stderr: "command failed" };
}

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("systemd", () => {
  it("is-active=active 时报告已注册且激活", () => {
    const { runner, calls } = makeRunner((_command, args) =>
      args[1] === "is-active" ? { stdout: "active\n" } : undefined,
    );
    const result = systemd.detect(envWith(runner, tempHome()));

    expect(result).toMatchObject({ registered: true, active: true });
    expect(calls[0]).toEqual({
      command: "systemctl",
      args: ["--user", "is-active", SERVICE_NAME],
    });
  });

  it("inactive 但单元文件存在时视为已注册未激活", () => {
    const home = tempHome();
    const unit = systemdUnitPath(home);
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, "[Unit]\n", "utf8");

    const { runner } = makeRunner((_command, args) =>
      args[1] === "is-active" ? { ok: false, status: 3, stdout: "inactive\n" } : fail(),
    );
    const result = systemd.detect(envWith(runner, home));

    expect(result.registered).toBe(true);
    expect(result.active).toBe(false);
  });

  it("命令失败且没有单元文件时视为未注册（不抛异常）", () => {
    const { runner } = makeRunner(() => fail());
    const result = systemd.detect(envWith(runner, tempHome()));
    expect(result).toMatchObject({ registered: false, active: false });
  });

  it("start / stop / restart 使用约定的 systemctl 参数", () => {
    const { runner, calls } = makeRunner(() => undefined);
    const env = envWith(runner, tempHome());

    systemd.start(env);
    systemd.stop(env);
    systemd.restart(env);

    expect(calls).toEqual([
      { command: "systemctl", args: ["--user", "start", SERVICE_NAME] },
      { command: "systemctl", args: ["--user", "stop", SERVICE_NAME] },
      { command: "systemctl", args: ["--user", "restart", SERVICE_NAME] },
    ]);
  });

  it("控制命令失败时抛 START_FAILED", () => {
    const { runner } = makeRunner(() => fail());
    const env = envWith(runner, tempHome());
    expect(() => systemd.start(env)).toThrowError(/启动 systemd 服务失败/);
  });
});

describe("launchd", () => {
  it("print 输出 state = running 时报告激活", () => {
    const { runner, calls } = makeRunner(() => ({
      stdout: "state = running\n\tpid = 321\n",
    }));
    const result = launchd.detect(envWith(runner, tempHome(), "darwin", "501"));

    expect(result).toMatchObject({ registered: true, active: true });
    expect(calls[0]).toEqual({
      command: "launchctl",
      args: ["print", `gui/501/${LAUNCHD_LABEL}`],
    });
  });

  it("plist 存在但未加载时视为已注册未激活", () => {
    const home = tempHome();
    const plist = launchdPlistPath(home);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, "<plist/>", "utf8");

    const { runner } = makeRunner(() => fail());
    const result = launchd.detect(envWith(runner, home, "darwin", "501"));

    expect(result.registered).toBe(true);
    expect(result.active).toBe(false);
  });

  it("start / stop / restart 使用约定的 launchctl 参数", () => {
    const home = tempHome();
    const { runner, calls } = makeRunner(() => undefined);
    const env = envWith(runner, home, "darwin", "501");

    launchd.start(env);
    launchd.stop(env);
    launchd.restart(env);

    expect(calls).toEqual([
      { command: "launchctl", args: ["kickstart", `gui/501/${LAUNCHD_LABEL}`] },
      { command: "launchctl", args: ["bootout", "gui/501", launchdPlistPath(home)] },
      { command: "launchctl", args: ["kickstart", "-k", `gui/501/${LAUNCHD_LABEL}`] },
    ]);
  });
});

describe("schtasks", () => {
  it("计划任务存在且 Status=Running 时报告激活", () => {
    const { runner, calls } = makeRunner((command, args) =>
      args.includes("/fo")
        ? { stdout: "TaskName: \\AgentSearchGateway\r\nStatus: Running\r\n" }
        : undefined,
    );
    const result = schtasks.detect(envWith(runner, tempHome(), "win32"));

    expect(result.registered).toBe(true);
    expect(result.active).toBe(true);
    expect(calls[0]).toEqual({
      command: "schtasks",
      args: ["/query", "/tn", WINDOWS_TASK_NAME],
    });
  });

  it("查询失败视为未注册", () => {
    const { runner } = makeRunner(() => fail());
    const result = schtasks.detect(envWith(runner, tempHome(), "win32"));
    expect(result).toMatchObject({ registered: false, active: false });
  });

  it("restart 先 /end 再 /run，/end 失败不阻断", () => {
    const { runner, calls } = makeRunner((_command, args) =>
      args[0] === "/end" ? fail() : undefined,
    );
    const env = envWith(runner, tempHome(), "win32");

    expect(() => schtasks.restart(env)).not.toThrow();
    expect(calls.map((call) => call.args[0])).toEqual(["/end", "/run"]);
  });

  it("start / stop 使用 /run 与 /end", () => {
    const { runner, calls } = makeRunner(() => undefined);
    const env = envWith(runner, tempHome(), "win32");

    schtasks.start(env);
    schtasks.stop(env);

    expect(calls).toEqual([
      { command: "schtasks", args: ["/run", "/tn", WINDOWS_TASK_NAME] },
      { command: "schtasks", args: ["/end", "/tn", WINDOWS_TASK_NAME] },
    ]);
  });
});

describe("detectManager", () => {
  function pidRoot(): string {
    const dir = tempHome();
    fs.mkdirSync(path.join(dir, "data", "runtime"), { recursive: true });
    return dir;
  }

  it("未注册平台服务时回退 pid 模式，并从 pid 文件判断 active", () => {
    const root = pidRoot();
    const home = tempHome();
    const { runner } = makeRunner(() => fail());
    const env = envWith(runner, home, "linux");

    expect(detectManager(root, env)).toMatchObject({ mode: "pid", active: false });

    fs.writeFileSync(
      path.join(root, "data", "runtime", "supervisor.pid"),
      `${process.pid}\n`,
      "utf8",
    );
    expect(detectManager(root, env)).toMatchObject({ mode: "pid", active: true });

    fs.rmSync(path.join(root, "data", "runtime", "supervisor.pid"));
    expect(detectManager(root, env)).toMatchObject({ mode: "pid", active: false });
  });

  it("已注册 systemd 时报告 systemd 模式（检测不缓存）", () => {
    const root = pidRoot();
    const home = tempHome();
    let active = true;
    const { runner } = makeRunner((_command, args) =>
      args[1] === "is-active"
        ? { ok: active, status: active ? 0 : 3, stdout: active ? "active\n" : "inactive\n" }
        : undefined,
    );
    const env = envWith(runner, home, "linux");

    expect(detectManager(root, env)).toMatchObject({ mode: "systemd", active: true });
    active = false;
    expect(detectManager(root, env)).toMatchObject({ mode: "systemd", active: false });
  });

  it("不支持平台也回退 pid 模式", () => {
    const root = pidRoot();
    const home = tempHome();
    const { runner } = makeRunner(() => fail());
    expect(detectManager(root, envWith(runner, home, "freebsd"))).toMatchObject({
      mode: "pid",
      active: false,
    });
  });
});
