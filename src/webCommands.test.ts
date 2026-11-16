import { test } from "node:test";
import assert from "node:assert/strict";
import { stripAnsi } from "./terminal/ansi";
import { routeSlash, tabCommandList, tabHelp } from "./webCommands";

const engine = [{ name: "context-gatherer", description: "Gathers context" }];

test("our commands run, with their argument; aliases too", () => {
  assert.deepEqual(routeSlash("/usage", engine), { kind: "run", name: "usage", arg: "", text: "/usage" });
  assert.deepEqual(routeSlash("/Context  show ", engine), { kind: "run", name: "context", arg: "show", text: "/Context  show" });
  assert.equal((routeSlash("/exit", engine) as { kind: string }).kind, "unavailable");
});

test("engine commands, paths and a leading space go to the agent; other words are unknown", () => {
  assert.deepEqual(routeSlash("/context-gatherer find x", engine), { kind: "agent" });
  assert.deepEqual(routeSlash("/Users/me/a.png what is it", engine), { kind: "agent" });
  assert.deepEqual(routeSlash(" /usage", engine), { kind: "agent" });
  assert.deepEqual(routeSlash("hello", engine), { kind: "agent" });
  assert.deepEqual(routeSlash("/nope 1", engine), { kind: "unknown", text: "/nope 1", name: "nope" });
});

test("terminal-only commands say what to do instead", () => {
  const r = routeSlash("/paste", engine);
  assert.equal(r.kind, "unavailable");
  assert.match((r as { reason: string }).reason, /Cmd\+V/);
  assert.match((routeSlash("/voice", engine) as { reason: string }).reason, /terminal app/);
});

test("the picker lists only what runs here; help lists the agent's commands too", () => {
  const names = tabCommandList().map((c) => c.name);
  for (const n of ["usage", "context", "tools", "model", "compact", "help", "title"]) {
    assert.ok(names.includes(n), n);
  }
  for (const n of ["paste", "quit", "cls", "voice", "rewind"]) {
    assert.ok(!names.includes(n), n);
  }
  assert.equal(tabCommandList().find((c) => c.name === "tools")?.inputHint, "trust-all | reset");
  const help = stripAnsi(tabHelp(engine));
  assert.match(help, /\/usage/);
  assert.match(help, /\/context-gatherer +Gathers context/);
  assert.doesNotMatch(help, /^ +\/paste/m);
});
