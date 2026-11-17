import { test } from "node:test";
import assert from "node:assert/strict";
import { shortcutLabel } from "./shortcut";

const kb = [
  { command: "kiroChat.open", key: "ctrl+alt+k", mac: "cmd+alt+k" },
  { key: "shift+enter", command: "workbench.action.terminal.sendSequence" },
];

test("the tooltip shows the shortcut package.json gives for the platform", () => {
  assert.equal(shortcutLabel(kb, "kiroChat.open", "darwin"), "⌘⌥K");
  assert.equal(shortcutLabel(kb, "kiroChat.open", "win32"), "Ctrl+Alt+K");
  assert.equal(shortcutLabel(kb, "kiroChat.open", "linux"), "Ctrl+Alt+K");
});

test("a platform entry wins over key; a command without a shortcut gives nothing", () => {
  assert.equal(shortcutLabel([{ command: "x", key: "ctrl+k", win: "ctrl+shift+k" }], "x", "win32"), "Ctrl+Shift+K");
  assert.equal(shortcutLabel(kb, "kiroChat.nothing", "darwin"), undefined);
  assert.equal(shortcutLabel(undefined, "kiroChat.open", "darwin"), undefined);
  assert.equal(shortcutLabel([{ command: "x" }], "x", "darwin"), undefined);
});
