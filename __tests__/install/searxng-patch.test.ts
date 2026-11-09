// @ts-expect-error 纯 JS 安装脚本没有类型声明
import { patchValkeyDb, unpackZipSkippingInvalid } from "../../scripts/install/deps/windows-patch.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
const hasZip = spawnSync("zip", ["-v"], { stdio: "ignore" }).status === 0;

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "windows-patch-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SAMPLE = `import pwd

def log():
    _pw = pwd.getpwuid(os.getuid())
    logger.exception("[%s (%s)] can't connect valkey DB ...", _pw.pw_name, _pw.pw_uid)
`;

describe("searxng Windows pwd 补丁", () => {
  it("把 import pwd 改成可选导入，并加 Windows 分支", () => {
    const out = patchValkeyDb(SAMPLE);
    expect(out).toContain("try:");
    expect(out).toContain("pwd = None");
    expect(out).toContain("if pwd is not None");
    expect(out).toContain("USERNAME");
    expect(out).not.toMatch(/^import pwd$/m);
  });

  it("幂等", () => {
    const once = patchValkeyDb(SAMPLE);
    expect(patchValkeyDb(once)).toBe(once);
  });

  it("结构不符时报错", () => {
    expect(() => patchValkeyDb("print('no pwd here')\n")).toThrow(/结构不符合预期/);
  });
});

describe("Windows ZIP 解压", () => {
  it.skipIf(!hasZip)("跳过含冒号等非法文件名", async () => {
    const d = tmp();
    writeFileSync(join(d, "a.txt"), "a");
    writeFileSync(join(d, "b:c.txt"), "b");
    const zipped = spawnSync("zip", ["-q", join(d, "t.zip"), "a.txt", "b:c.txt"], { cwd: d });
    expect(zipped.status).toBe(0);

    const out = join(d, "out");
    await unpackZipSkippingInvalid(join(d, "t.zip"), out);
    expect(existsSync(join(out, "a.txt"))).toBe(true);
    expect(existsSync(join(out, "b:c.txt"))).toBe(false);
  });
});
