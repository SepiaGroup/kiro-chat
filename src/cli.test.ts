import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import type { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { candidateCliPaths, executableProblem, findOnPath, pickFromWhere, resolveCliPath, sanitizedEnv } from "./cli";

// Windows has no execute bit: a file there is "executable" if its name says so.
test("a configured kiro-cli path must be an executable file", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "kiro-cli-"));
  try {
    const exe = join(dir, "kiro-cli");
    writeFileSync(exe, "#!/bin/sh\n");
    chmodSync(exe, 0o644);
    assert.equal(executableProblem(exe), "isn't executable");
    chmodSync(exe, 0o755);
    assert.equal(executableProblem(exe), undefined);
    assert.equal(resolveCliPath(` ${exe} `), exe);
    assert.equal(executableProblem(dir), "isn't a file");
    assert.throws(() => resolveCliPath(join(dir, "nope")), /kiroCliPath is set to ".*nope", which doesn't exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("on Windows kiro-cli is looked for where its installer puts it", () => {
  assert.deepEqual(candidateCliPaths("win32", { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, "C:\\Users\\me"), [
    "C:\\Users\\me\\AppData\\Local\\Kiro-Cli\\kiro-cli.exe",
    "C:\\Users\\me\\.local\\bin\\kiro-cli.exe",
  ]);
  // Without LOCALAPPDATA it is still under the home folder.
  assert.equal(candidateCliPaths("win32", {}, "C:\\Users\\me")[0], "C:\\Users\\me\\AppData\\Local\\Kiro-Cli\\kiro-cli.exe");
  assert.ok(candidateCliPaths("darwin", {}, "/Users/me").includes("/opt/homebrew/bin/kiro-cli"));
});

test("pickFromWhere takes only an .exe, and copes with CRLF", () => {
  assert.equal(pickFromWhere("C:\\bin\\kiro-cli.cmd\r\nC:\\Users\\me\\AppData\\Local\\Kiro-Cli\\kiro-cli.exe\r\n"), "C:\\Users\\me\\AppData\\Local\\Kiro-Cli\\kiro-cli.exe");
  // A script or a file with no extension can't be started; the search goes on with the install folders.
  assert.equal(pickFromWhere("C:\\bin\\kiro-cli.cmd\r\n"), undefined);
  assert.equal(pickFromWhere("C:\\bin\\kiro-cli\r\nC:\\bin\\kiro-cli.bat\r\n"), undefined);
  assert.equal(pickFromWhere(""), undefined);
});

test("a .cmd or .bat can't be the kiro-cli path on Windows", () => {
  assert.match(executableProblem("C:\\x\\kiro-cli.cmd", "win32") ?? "", /script/);
  assert.match(executableProblem("C:\\x\\kiro-cli.BAT", "win32") ?? "", /script/);
});

test("sanitizedEnv keeps the PATH variable under its own name and separator", () => {
  // On Windows a copy of process.env has `Path`, not `PATH`: adding a `PATH` next to it would break the child's PATH.
  const win = sanitizedEnv({ Path: "C:\\a;C:\\b", Other: "1" }, "win32");
  assert.deepEqual(Object.keys(win).sort(), ["Other", "Path"]);
  assert.equal(win.Path, "C:\\a;C:\\b");
  const mac = sanitizedEnv({ PATH: "/usr/bin:/Applications/Kiro CLI.app/Contents/MacOS:/bin" }, "darwin");
  assert.equal(mac.PATH, "/usr/bin:/bin");
  assert.equal(sanitizedEnv({}, "darwin").PATH, "");
});

test("on Windows kiro-cli is looked up with the system's where.exe, with a time limit", () => {
  const calls: { cmd: string; args: readonly string[]; timeout?: number }[] = [];
  const fake = ((cmd: string, args: readonly string[], opts: { timeout?: number }) => {
    calls.push({ cmd, args, timeout: opts.timeout });
    return { status: 0, stdout: "C:\\x\\kiro-cli.cmd\r\nC:\\Users\\me\\AppData\\Local\\Kiro-Cli\\kiro-cli.exe\r\n" };
  }) as unknown as typeof spawnSync;
  assert.equal(findOnPath("win32", { SystemRoot: "D:\\WIN" }, fake), "C:\\Users\\me\\AppData\\Local\\Kiro-Cli\\kiro-cli.exe");
  assert.equal(calls[0].cmd, "D:\\WIN\\System32\\where.exe");
  assert.deepEqual(calls[0].args, ["kiro-cli"]);
  assert.ok(calls[0].timeout && calls[0].timeout > 0, "where.exe must not be able to hang");
});

test("where.exe finding nothing, failing or timing out means not found", () => {
  const exit = (status: number | null, stdout = "") => (() => ({ status, stdout })) as unknown as typeof spawnSync;
  assert.equal(findOnPath("win32", {}, exit(1)), undefined);
  assert.equal(findOnPath("win32", {}, exit(null)), undefined); // killed by the time limit
  assert.equal(findOnPath("win32", {}, exit(0, "C:\\bin\\kiro-cli.cmd\r\n")), undefined);
});

test("on macOS and Linux the login shell is asked, with a time limit", () => {
  let seen: { cmd: string; args: readonly string[]; timeout?: number } | undefined;
  const fake = ((cmd: string, args: readonly string[], opts: { timeout?: number }) => {
    seen = { cmd, args, timeout: opts.timeout };
    return { status: 0, stdout: "/Users/me/.local/bin/kiro-cli\n" };
  }) as unknown as typeof spawnSync;
  assert.equal(findOnPath("darwin", {}, fake), "/Users/me/.local/bin/kiro-cli");
  assert.equal(seen?.cmd, "bash");
  assert.deepEqual(seen?.args, ["-lc", "command -v kiro-cli"]);
  assert.ok(seen?.timeout && seen.timeout > 0);
});
