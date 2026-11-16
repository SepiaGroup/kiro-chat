import { test } from "node:test";
import assert from "node:assert/strict";
import type { RemoteMessage } from "../remote/remotePolicy";
import { TerminalChats, TerminalRemote } from "./terminalRemote";

function rig() {
  const handled: Array<[RemoteMessage, string]> = [];
  const state = { title: "Kiro Chat (terminal)", busy: false };
  const remote = new TerminalRemote({
    title: () => state.title,
    busy: () => state.busy,
    handle: async (msg, device) => void handled.push([msg, device]),
  });
  return { remote, handled, state };
}

test("what the terminal posts is kept for a snapshot and streamed to listeners", () => {
  const { remote } = rig();
  const got: unknown[] = [];
  remote.post({ type: "ready", engine: "v3" });
  remote.post({ type: "userMessage", text: "hi", images: [] });
  const stop = remote.subscribe((m) => got.push(m));
  remote.post({ type: "event", event: { kind: "assistantChunk", text: "yo" } });
  stop();
  remote.post({ type: "cleared" });
  assert.equal(got.length, 1);
  assert.deepEqual(remote.snapshot(), [{ type: "ready", engine: "v3" }]);
});

test("a remote message reaches the terminal with the device name; ready does not", async () => {
  const { remote, handled, state } = rig();
  await remote.send({ type: "ready" }, { id: "d", name: "iPhone" });
  await remote.send({ type: "cancelTurn" }, { id: "d", name: "iPhone" });
  assert.deepEqual(handled, [[{ type: "cancelTurn" }, "iPhone"]]);
  state.busy = true;
  state.title = "Build (terminal)";
  assert.equal(remote.busy, true);
  assert.equal(remote.title, "Build (terminal)");
});

test("a listener that throws does not stop the others", () => {
  const { remote } = rig();
  let n = 0;
  remote.subscribe(() => {
    throw new Error("x");
  });
  remote.subscribe(() => n++);
  remote.post({ type: "notice", text: "a" });
  assert.equal(n, 1);
});

test("the terminal list: added, taken off once, and changes announced", () => {
  const chats = new TerminalChats();
  let changes = 0;
  const sub = chats.onDidChangeChats(() => changes++);
  const a = rig().remote;
  const off = chats.add(a);
  assert.deepEqual(chats.chats(), [a]);
  chats.changed();
  off();
  off();
  assert.deepEqual(chats.chats(), []);
  assert.equal(changes, 3);
  sub.dispose();
  chats.changed();
  assert.equal(changes, 3);
});

test("a rename nothing announced is found by checkTitles, once", () => {
  const chats = new TerminalChats();
  let changes = 0;
  chats.onDidChangeChats(() => changes++);
  const r = rig();
  chats.add(r.remote);
  chats.checkTitles();
  assert.equal(changes, 1, "no change, no announcement");
  r.state.title = "Renamed (terminal)";
  chats.checkTitles();
  chats.checkTitles();
  assert.equal(changes, 2);
});
