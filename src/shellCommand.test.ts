import { test } from "node:test";
import assert from "node:assert/strict";
import { shellCommandLine, shellKind } from "./shellCommand";

test("the shell kind comes from the shell's file name, and only on Windows", () => {
  assert.equal(shellKind("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "win32"), "powershell");
  assert.equal(shellKind("C:\\Program Files\\PowerShell\\7\\pwsh.exe", "win32"), "powershell");
  assert.equal(shellKind("C:\\Windows\\System32\\cmd.exe", "win32"), "cmd");
  assert.equal(shellKind("C:\\Program Files\\Git\\bin\\bash.exe", "win32"), "posix");
  assert.equal(shellKind(undefined, "win32"), "powershell");
  assert.equal(shellKind("/bin/zsh", "darwin"), "posix");
  assert.equal(shellKind("C:\\Windows\\System32\\cmd.exe", "linux"), "posix");
});

test("PowerShell runs a quoted program with &, and doubles a quote inside quotes", () => {
  const ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  assert.equal(shellCommandLine("C:\\Users\\me\\AppData\\Local\\Kiro-Cli\\kiro-cli.exe", ["login"], ps, "win32"), "C:\\Users\\me\\AppData\\Local\\Kiro-Cli\\kiro-cli.exe login");
  assert.equal(shellCommandLine("C:\\Users\\Jane Doe\\kiro-cli.exe", ["login"], ps, "win32"), "& 'C:\\Users\\Jane Doe\\kiro-cli.exe' login");
  assert.equal(shellCommandLine("kiro-cli", ["agent", "it's"], ps, "win32"), "kiro-cli agent 'it''s'");
});

test("cmd takes double quotes", () => {
  const cmd = "C:\\Windows\\System32\\cmd.exe";
  assert.equal(shellCommandLine("C:\\Users\\Jane Doe\\kiro-cli.exe", ["login"], cmd, "win32"), '"C:\\Users\\Jane Doe\\kiro-cli.exe" login');
  assert.equal(shellCommandLine("kiro-cli", ["a b"], cmd, "win32"), 'kiro-cli "a b"');
});

test("a POSIX shell takes single quotes, also for a Windows path in Git Bash", () => {
  assert.equal(shellCommandLine("/usr/local/bin/kiro-cli", ["login"], "/bin/zsh", "darwin"), "/usr/local/bin/kiro-cli login");
  assert.equal(shellCommandLine("/Users/Jo Doe/bin/kiro-cli", ["agent", "it's"], "/bin/zsh", "darwin"), "'/Users/Jo Doe/bin/kiro-cli' agent 'it'\\''s'");
  assert.equal(shellCommandLine("C:\\Users\\me\\kiro-cli.exe", ["login"], "C:\\Program Files\\Git\\bin\\bash.exe", "win32"), "'C:\\Users\\me\\kiro-cli.exe' login");
});
