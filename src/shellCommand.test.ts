import { test } from "node:test";
import assert from "node:assert/strict";
import { shellKind, terminalLaunch } from "./shellCommand";

const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const CMD = "C:\\Windows\\System32\\cmd.exe";
const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const KIRO = "C:\\Users\\me\\AppData\\Local\\Kiro-Cli\\kiro-cli.exe";

test("the shell kind comes from the shell's file name, and only on Windows", () => {
  assert.equal(shellKind(PS, "win32"), "powershell");
  assert.equal(shellKind("C:\\Program Files\\PowerShell\\7\\pwsh.exe", "win32"), "powershell");
  assert.equal(shellKind(CMD, "win32"), "cmd");
  assert.equal(shellKind(GIT_BASH, "win32"), "posix");
  assert.equal(shellKind(undefined, "win32"), "powershell");
  assert.equal(shellKind("/bin/zsh", "darwin"), "posix");
  assert.equal(shellKind(CMD, "linux"), "posix");
});

test("WSL, fish and nu on Windows are not guessed at", () => {
  assert.equal(shellKind("C:\\Windows\\System32\\wsl.exe", "win32"), "other");
  // System32\bash.exe is the WSL launcher, not Git Bash.
  assert.equal(shellKind("C:\\Windows\\System32\\bash.exe", "win32"), "other");
  assert.equal(shellKind("C:\\tools\\nu.exe", "win32"), "other");
  assert.equal(shellKind("C:\\msys64\\usr\\bin\\fish.exe", "win32"), "other");
});

test("PowerShell runs a quoted program with &, and doubles a quote inside quotes", () => {
  assert.deepEqual(terminalLaunch(KIRO, ["login"], PS, "win32"), { sendText: `${KIRO} login` });
  assert.deepEqual(terminalLaunch("C:\\Users\\Jane Doe\\kiro-cli.exe", ["login"], PS, "win32"), {
    sendText: "& 'C:\\Users\\Jane Doe\\kiro-cli.exe' login",
  });
  assert.deepEqual(terminalLaunch("kiro-cli", ["agent", "it's"], PS, "win32"), { sendText: "kiro-cli agent 'it''s'" });
});

test("PowerShell: a comma, @ or % is quoted, and typographic quotes are doubled", () => {
  // Unquoted, a comma makes an array and @ starts splatting.
  assert.deepEqual(terminalLaunch("C:\\a,b\\kiro-cli.exe", ["login"], PS, "win32"), { sendText: "& 'C:\\a,b\\kiro-cli.exe' login" });
  assert.deepEqual(terminalLaunch("C:\\@x\\kiro-cli.exe", [], PS, "win32"), { sendText: "& 'C:\\@x\\kiro-cli.exe'" });
  assert.deepEqual(terminalLaunch("C:\\100%\\kiro-cli.exe", [], PS, "win32"), { sendText: "& 'C:\\100%\\kiro-cli.exe'" });
  // PowerShell treats ‘ and ’ as quote marks too; a doubled one is that character.
  assert.deepEqual(terminalLaunch("C:\\Jo\u2019s\\kiro-cli.exe", [], PS, "win32"), { sendText: "& 'C:\\Jo\u2019\u2019s\\kiro-cli.exe'" });
});

test("cmd takes double quotes", () => {
  assert.deepEqual(terminalLaunch("C:\\Users\\Jane Doe\\kiro-cli.exe", ["login"], CMD, "win32"), {
    sendText: '"C:\\Users\\Jane Doe\\kiro-cli.exe" login',
  });
  assert.deepEqual(terminalLaunch("kiro-cli", ["a b"], CMD, "win32"), { sendText: 'kiro-cli "a b"' });
  assert.deepEqual(terminalLaunch("C:\\a,b\\kiro-cli.exe", [], CMD, "win32"), { sendText: '"C:\\a,b\\kiro-cli.exe"' });
});

test("cmd expands %VAR% even inside quotes, so the program is started directly instead", () => {
  assert.deepEqual(terminalLaunch("C:\\100%\\kiro-cli.exe", ["login"], CMD, "win32"), {
    shellPath: "C:\\100%\\kiro-cli.exe",
    shellArgs: ["login"],
  });
  assert.deepEqual(terminalLaunch(KIRO, ["50%"], CMD, "win32"), { shellPath: KIRO, shellArgs: ["50%"] });
});

test("a shell with unknown quoting gets the program started directly", () => {
  for (const sh of ["C:\\Windows\\System32\\wsl.exe", "C:\\Windows\\System32\\bash.exe", "C:\\tools\\nu.exe"]) {
    assert.deepEqual(terminalLaunch(KIRO, ["login"], sh, "win32"), { shellPath: KIRO, shellArgs: ["login"] });
  }
});

test("a POSIX shell takes single quotes, also for a Windows path in Git Bash", () => {
  assert.deepEqual(terminalLaunch("/usr/local/bin/kiro-cli", ["login"], "/bin/zsh", "darwin"), { sendText: "/usr/local/bin/kiro-cli login" });
  assert.deepEqual(terminalLaunch("/Users/Jo Doe/bin/kiro-cli", ["agent", "it's"], "/bin/zsh", "darwin"), {
    sendText: "'/Users/Jo Doe/bin/kiro-cli' agent 'it'\\''s'",
  });
  assert.deepEqual(terminalLaunch("C:\\Users\\me\\kiro-cli.exe", ["login"], GIT_BASH, "win32"), { sendText: "'C:\\Users\\me\\kiro-cli.exe' login" });
});
