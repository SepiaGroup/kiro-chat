import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { candidateCliPaths, executableProblem, pickFromWhere, resolveCliPath, sanitizedEnv } from "./cli";

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

test("pickFromWhere takes the .exe, not a script, and copes with CRLF", () => {
  assert.equal(pickFromWhere("C:\\bin\\kiro-cli.cmd\r\nC:\\Users\\me\\AppData\\Local\\Kiro-Cli\\kiro-cli.exe\r\n"), "C:\\Users\\me\\AppData\\Local\\Kiro-Cli\\kiro-cli.exe");
  assert.equal(pickFromWhere("C:\\bin\\kiro-cli.cmd\r\n"), "C:\\bin\\kiro-cli.cmd");
  assert.equal(pickFromWhere(""), undefined);
});

test("a .cmd or .bat can't be the kiro-cli path on Windows", () => {
  assert.match(executableProblem("C:\\x\\kiro-cli.cmd", "win32") ?? "", /script/);
  assert.match(executableProblem("C:\\x\\kiro-cli.BAT", "win32") ?? "", /script/);
});

test("sanitizedEnv keeps the PATH variable under its own name and separator", () => {
  // On Windows a copy of process.env has `Path`, not `PATH`: adding a `PATH` next to it would break the child's PATH.
  const win = sanitizedEnv({ Path: "C:\\a;C:\\b", Other: "1" }, ";");
  assert.deepEqual(Object.keys(win).sort(), ["Other", "Path"]);
  assert.equal(win.Path, "C:\\a;C:\\b");
  const mac = sanitizedEnv({ PATH: "/usr/bin:/Applications/Kiro CLI.app/Contents/MacOS:/bin" }, ":");
  assert.equal(mac.PATH, "/usr/bin:/bin");
  assert.equal(sanitizedEnv({}, ":").PATH, "");
});
