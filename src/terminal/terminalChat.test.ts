// End-to-end test of the terminal chat: a fake `vscode` module and a fake
// kiro-cli (whoami + an ACP engine) drive a real TerminalChat through a turn
// with streamed text, a tool call, an approval and the footer.

import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { stripAnsi } from "./ansi";

class Emitter<T> {
  private listeners: Array<(v: T) => void> = [];
  readonly event = (l: (v: T) => void) => {
    this.listeners.push(l);
    return { dispose: () => (this.listeners = this.listeners.filter((x) => x !== l)) };
  };
  fire(v: T): void {
    for (const l of [...this.listeners]) {
      l(v);
    }
  }
  dispose(): void {}
}

const dir = mkdtempSync(join(tmpdir(), "kiro-term-"));
// The program is node, and the fake is the file named by its first argument ("whoami" or
// "acp") in the working folder: no `#!` line, which Windows can't use.
const cli = process.execPath;
const FAKE = `const mode = require("path").basename(process.argv[1]);
if (mode === "whoami") { console.log(JSON.stringify({ email: "test@example.com" })); process.exit(0); }
if (mode !== "acp") process.exit(2);
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const update = (u) => send({ method: "session/update", params: { sessionId: "s1", update: u } });
let waiting;
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.method === undefined) { process.stderr.write("answer " + JSON.stringify(msg.result) + "\\n"); waiting(msg); continue; }
    if (msg.method === "initialize") send({ id: msg.id, result: { protocolVersion: 1 } });
    else if (msg.method === "session/new") send({ id: msg.id, result: { sessionId: "s1" } });
    else if (msg.method === "session/set_config_option") send({ id: msg.id, result: {} });
    else if (msg.method === "session/prompt" && msg.params.prompt[0].text.includes("ask me")) {
      waiting = (m) => {
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "You picked " + JSON.stringify(m.result) } });
        send({ id: msg.id, result: { stopReason: "end_turn" } });
      };
      send({ id: "q-1", method: "_kiro/userInput", params: { sessionId: "s1", toolCallId: "q1", question: "Pick **one**", options: [{ title: "red" }, { title: "blue", recommended: true }] } });
    }
    else if (msg.method === "session/prompt" && msg.params.prompt[0].text.includes("attached_file")) {
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "GOT " + JSON.stringify(msg.params.prompt[0].text) } });
      send({ id: msg.id, result: { stopReason: "end_turn" } });
    }
    else if (msg.method === "session/prompt" && msg.params.prompt[0].text.includes("slow job")) {
      globalThis.pid = msg.id;
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working on it.\\n" } });
    }
    else if (msg.method === "_session/steer") {
      const info = (kind, extra) => update({ sessionUpdate: "session_info_update", _meta: { kiro: { kind, ...extra } } });
      const id = "steer-" + msg.params.messageId;
      send({ id: msg.id, result: { queued: true, messageId: id } });
      info("steering_queued", { messageId: id, content: msg.params.message });
      info("steering_injected", { messageId: id, content: msg.params.message });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "GOT STEER: " + msg.params.message } });
      info("steering_cleared", { messageIds: [id] });
      send({ id: globalThis.pid, result: { stopReason: "end_turn" } });
    }
    else if (msg.method === "session/prompt") {
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello **there**.\\n" } });
      update({ sessionUpdate: "tool_call", toolCallId: "tc1", title: "Run find .", status: "pending" });
      waiting = () => {
        update({ sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "completed" });
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "All done." } });
        send({ id: msg.id, result: { stopReason: "end_turn" } });
      };
      send({ id: "perm-1", method: "session/request_permission", params: {
        sessionId: "s1",
        toolCall: { toolCallId: "tc1", title: "find ." },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
        _meta: { kiro: { consent: { capability: "shell", triggeringResource: "find ." } } },
      } });
    }
  }
});
`;
writeFileSync(join(dir, "acp"), FAKE);
writeFileSync(join(dir, "whoami"), FAKE);
process.chdir(dir); // for the commands that run without a folder of their own (whoami)
const startDir = process.cwd();
test.after(() => {
  process.chdir(startDir); // Windows won't delete the folder a process is in
  rmSync(dir, { recursive: true, force: true });
});

writeFileSync(join(dir, "n.txt"), "remember the milk");

const settings: Record<string, unknown> = { kiroCliPath: cli, defaultEngine: "v3", autopilot: false };
const fakeVscode = {
  EventEmitter: Emitter,
  workspace: {
    workspaceFolders: [{ uri: { fsPath: dir } }],
    getConfiguration: () => ({ get: (k: string, d: unknown) => (k in settings ? settings[k] : d) }),
  },
  window: { createTerminal: () => ({ show() {}, sendText() {} }) },
};
const mod = Module as unknown as { _load: (req: string, ...rest: unknown[]) => unknown };
const origLoad = mod._load;
mod._load = function (req: string, ...rest: unknown[]) {
  return req === "vscode" ? fakeVscode : origLoad.call(this, req, ...rest);
};
// Loaded after the fake is installed, so it can't be a hoisted `import`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TerminalChat } = require("./terminalChat") as typeof import("./terminalChat");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TerminalChats } = require("./terminalRemote") as typeof import("./terminalRemote");

async function until(what: string, cond: () => boolean, ms = 10000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) {
      throw new Error("timed out waiting for " + what);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("a turn: streamed reply, tool card, approval answered with y, footer", async () => {
  const logs: string[] = [];
  const chat = new TerminalChat({ appendLine: (l: string) => logs.push(l) } as never, "Kiro Chat");
  let screen = "";
  chat.onDidWrite((s) => (screen += s));
  const text = () => stripAnsi(screen).replace(/\r\n/g, "\n");
  chat.open({ columns: 100, rows: 30 });
  try {
    await until("ready", () => text().includes("Ready · engine v3"));
    assert.match(text(), /Supervised/);
    for (const ch of "list files") {
      chat.handleInput(ch);
    }
    chat.handleInput("\r");
    await until("approval", () => text().includes("[y] Allow"));
    assert.match(text(), /Hello there\./);
    assert.match(text(), /● Run find \./);
    assert.match(text(), /\? find \.\n {2}\[y\] Allow {2}\[n\] Deny {2}\[Tab\] Deny with reason/);
    chat.handleInput("y");
    await until("footer", () => text().includes("Time:"));
    assert.match(text(), /→ Allow/);
    assert.match(text(), /– Completed in \d/);
    assert.match(text(), /All done\./);
    assert.match(text(), /▸ Time: \d+s/);
    assert.ok(logs.some((l) => l.includes('answer {"outcome":{"outcome":"selected","optionId":"allow"}')), logs.join("\n"));
    // The "/" menu and a local command.
    screen = "";
    chat.handleInput("/");
    chat.handleInput("h");
    chat.handleInput("e");
    await until("menu", () => text().includes("/help"));
    chat.handleInput("\r");
    await until("help", () => text().includes("Commands"));
  } finally {
    chat.close();
  }
});

test("a question from the agent is answered with the keyboard; @file: is attached", async () => {
  const chat = new TerminalChat({ appendLine: () => undefined } as never, "Kiro Chat");
  let screen = "";
  chat.onDidWrite((s) => (screen += s));
  const text = () => stripAnsi(screen).replace(/\r\n/g, "\n");
  const send = (line: string) => {
    for (const ch of line) {
      chat.handleInput(ch);
    }
    chat.handleInput("\r");
  };
  chat.open({ columns: 100, rows: 30 });
  try {
    await until("ready", () => text().includes("Ready · engine v3"));
    send("please ask me something");
    await until("question", () => text().includes("[2] blue (recommended)"));
    assert.match(text(), /\? Pick one\n {2}\[1\] red/);
    chat.handleInput("\r"); // empty answer = the recommended choice
    await until("answer", () => text().includes("Time:"));
    assert.match(text(), /→ You answered: blue/);
    assert.match(text(), /You picked \{"action":"answered","answer":"blue"\}/);

    screen = "";
    send("what is in @file:n.txt?");
    await until("echo", () => text().includes("GOT"));
    assert.match(text(), /GOT .*attached_file.*remember the milk/);
  } finally {
    chat.close();
  }
});

test("a line typed while the agent works is sent to it as a steering message", async () => {
  const chat = new TerminalChat({ appendLine: () => undefined } as never, "Kiro Chat");
  let screen = "";
  chat.onDidWrite((s) => (screen += s));
  const text = () => stripAnsi(screen).replace(/\r\n/g, "\n");
  const type = (s: string) => {
    for (const ch of s) {
      chat.handleInput(ch);
    }
  };
  chat.open({ columns: 100, rows: 30 });
  try {
    await until("ready", () => text().includes("Ready · engine v3"));
    type("do a slow job\r");
    await until("working", () => text().includes("Working on it."));
    // What is typed shows on the status line.
    type("dra");
    await until("draft", () => text().includes("Enter sends: dra"));
    type("\x7f\x7f\x7f");
    // Commands don't run mid-reply.
    type("/help\r");
    await until("refusal", () => text().includes("Commands can't run while the agent works."));
    type("\x7f\x7f\x7f\x7f\x7f");
    type("also x\r");
    await until("steered", () => text().includes("GOT STEER: also x"));
    assert.match(text(), /↳ queued: the agent reads it at its next step/);
    assert.match(text(), /↳ the agent has read your message/);
    await until("end", () => text().includes("Time:"));
  } finally {
    chat.close();
  }
});

test("remote access: a phone sees the terminal chat, prompts it, and answers approvals and questions", async () => {
  const chats = new TerminalChats();
  let listChanges = 0;
  chats.onDidChangeChats(() => listChanges++);
  const chat = new TerminalChat({ appendLine: () => undefined } as never, "Kiro Chat", { remote: chats });
  let screen = "";
  chat.onDidWrite((s) => (screen += s));
  const text = () => stripAnsi(screen).replace(/\r\n/g, "\n");
  const phone = { id: "d1", name: "iPhone" };
  chat.open({ columns: 100, rows: 30 });
  try {
    assert.equal(chats.chats().length, 1);
    const remote = chats.chats()[0];
    assert.equal(remote.title, "Kiro Chat (terminal)");
    await until("ready", () => text().includes("Ready · engine v3"));
    const seen: Array<{ type: string; text?: string; event?: { kind: string; label?: string } }> = [];
    remote.subscribe((m) => seen.push(m as (typeof seen)[number]));
    assert.ok(remote.snapshot().some((m) => (m as { type: string }).type === "ready"));

    // A prompt from the phone, and the approval answered there.
    const turn = remote.send({ type: "sendPrompt", text: "list files", images: [] }, phone);
    await until("approval", () => text().includes("[y] Allow"));
    assert.equal(remote.busy, true);
    assert.match(text(), /> list files {2}\(from iPhone\)/);
    await remote.send({ type: "approve", toolCallId: "tc1", optionId: "allow" }, phone);
    await turn;
    assert.match(text(), /✓ Allowed from iPhone: find \./);
    assert.match(text(), /All done\./);
    assert.ok(seen.some((m) => m.type === "userMessage" && m.text === "list files"));
    assert.ok(seen.some((m) => m.event?.kind === "approvalResolved" && m.event.label === "Allowed from iPhone"));
    assert.ok(seen.some((m) => m.event?.kind === "assistantChunk"));
    assert.ok(!remote.snapshot().some((m) => (m as { event?: { kind: string } }).event?.kind === "approvalRequest"), "no card comes back");
    assert.ok(listChanges >= 2, "busy and idle reach the chat list");

    // A "/" line from the phone goes to the agent: it never runs a terminal command.
    const asked = remote.send({ type: "sendPrompt", text: "/quit ask me", images: [] }, phone);
    await until("question", () => text().includes("[2] blue (recommended)"));
    await remote.send({ type: "answerQuestion", toolCallId: "q1", answer: "red" }, phone);
    await asked;
    assert.match(text(), /Answered from iPhone: red/);
    assert.match(text(), /You picked \{"action":"answered","answer":"red"\}/);
    assert.ok(seen.some((m) => m.event?.kind === "questionResolved" && m.event.label === "Answered from iPhone: red"));

    // Answered at the keyboard: the phone is told, and by whom.
    for (const ch of "list files") {
      chat.handleInput(ch);
    }
    chat.handleInput("\r");
    await until("second approval", () => text().split("[y] Allow").length > 2);
    chat.handleInput("y");
    await until("second footer", () => seen.some((m) => m.event?.kind === "approvalResolved" && m.event.label === "Allowed in the terminal"));
  } finally {
    chat.close();
  }
  assert.equal(chats.chats().length, 0, "a closed terminal leaves the list");
});
