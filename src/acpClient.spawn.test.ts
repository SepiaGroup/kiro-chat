// AcpClient starts a real program with pipes on every platform, Windows too.
// The fake engine is a file called `acp` in the working folder and the program
// is node itself, so it needs no `#!` line (which Windows can't use). It answers
// with CRLF line ends, as a Windows program may, and writes down its process id
// and its arguments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AcpClient } from "./acpClient";

const ENGINE = `
const fs = require("fs");
fs.writeFileSync("pid.txt", String(process.pid));
fs.writeFileSync("args.txt", JSON.stringify(process.argv.slice(2)));
fs.writeFileSync("path.txt", String(process.env.PATH ?? process.env.Path ?? ""));
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\r\\n");
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.method === "initialize") send({ id: msg.id, result: { protocolVersion: 1 } });
    if (msg.method === "session/new") send({ id: msg.id, result: { sessionId: "s1" } });
  }
});
`;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a program is started with the engine's arguments, speaks CRLF lines, and is gone after dispose", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiro-spawn-"));
  writeFileSync(join(dir, "acp"), ENGINE);
  const c = new AcpClient({ cliPath: process.execPath, engine: "v3", cwd: dir });
  let pid = 0;
  try {
    assert.equal(await c.start(), false);
    assert.equal(c.currentSessionId, "s1");
    assert.ok(existsSync(join(dir, "pid.txt")));
    pid = Number(readFileSync(join(dir, "pid.txt"), "utf8"));
    assert.ok(pid > 0 && alive(pid));
    // The first argument is the script node runs ("acp"); the rest is what kiro-cli gets.
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "args.txt"), "utf8")), ["--agent-engine", "v3", "--auth-method", "cli"]);
    // The environment reaches the program with its PATH (named PATH or Path).
    assert.ok(readFileSync(join(dir, "path.txt"), "utf8").length > 0);
  } finally {
    c.dispose();
  }
  const end = Date.now() + 5000;
  while (pid && alive(pid) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(pid > 0 && alive(pid), false, "the engine process was stopped");
  // Windows keeps the folder busy for a moment after its process has gone. Cleaning up is not what is tested.
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});
