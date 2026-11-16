import { test } from "node:test";
import assert from "node:assert/strict";
import { stripAnsi } from "./terminal/ansi";
import { COMMANDS } from "./terminal/slashCommands";
import { remoteCheck, routeSlash, TAB_UNAVAILABLE, tabCommandList, tabHelp } from "./webCommands";

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

test("remote: only an allow-list runs; what acts on the Mac is refused with a reason", () => {
  const refused = (line: string): string => {
    const r = routeSlash(line, engine, true);
    assert.equal(r.kind, "unavailable", line);
    assert.equal(routeSlash(line, engine, false).kind === "unavailable", ["/paste", "/editor", "/reply", "/spawn"].includes(line), line + " on the Mac's own tab");
    return (r as { reason: string }).reason;
  };
  for (const line of [
    "/copy", "/login", "/remote stop", "/settings", "/theme", "/transcript", "/transcript show", "/transcript save /tmp/x",
    "/chat save /tmp/x", "/context add ~/.ssh", "/knowledge add k /etc", "/knowledge update /etc", "/agent create x", "/agent edit x",
  ]) {
    refused(line);
  }
  assert.match(refused("/set nope 1"), /can change these settings/);
  for (const line of [
    "/usage", "/context", "/context show", "/context remove a", "/context clear", "/knowledge clear", "/knowledge cancel", "/chat new", "/chat load",
    "/agent list", "/agent coder", "/model auto", "/set model auto", "/set effortLevel high", "/compact", "/clear", "/restart", "/config", "/tools",
    "/autopilot", "/code status", "/title x",
  ]) {
    const r = routeSlash(line, engine, true);
    assert.equal(r.kind, "run", line);
    assert.equal((r as { needsApprove?: boolean }).needsApprove, undefined, line);
  }
  // Whatever takes approvals away needs the approve permission, however it is typed.
  for (const line of ["/autopilot on", "/autopilot off", "/tools trust-all", "/tools reset", "/set autopilot on"]) {
    const r = routeSlash(line, engine, true);
    assert.equal(r.kind, "run", line);
    assert.equal((r as { needsApprove?: boolean }).needsApprove, true, line);
  }
  // At the Mac's own tab nothing is gated.
  assert.equal((routeSlash("/autopilot on", engine, false) as { needsApprove?: boolean }).needsApprove, undefined);
  const names = tabCommandList(true).map((c) => c.name);
  for (const n of ["copy", "login", "remote", "settings", "theme", "transcript", "spawn"]) {
    assert.ok(!names.includes(n), n);
  }
  for (const n of ["usage", "context", "tools", "model", "compact", "autopilot", "set"]) {
    assert.ok(names.includes(n), n);
  }
  assert.doesNotMatch(stripAnsi(tabHelp(engine, true)), /^ +\/(copy|transcript|settings)/m);
});

test("every command is decided: allowed from a remote device, or listed as refused", () => {
  // A new command is refused for a remote device until it is added to the allow-list, so this lists what is refused today.
  const refusedNames = COMMANDS.filter((c) => !c.unavailable && !TAB_UNAVAILABLE[c.name] && remoteCheck(c.name, "").ok === false).map((c) => c.name).sort();
  assert.deepEqual(refusedNames, ["copy", "login", "remote", "settings", "theme", "transcript"]);
});
