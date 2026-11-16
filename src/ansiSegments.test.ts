import { test } from "node:test";
import assert from "node:assert/strict";
import { ansiSegments } from "./ansiSegments";
import { style } from "./terminal/ansi";

test("colors and bold become style names; plain text has none", () => {
  assert.deepEqual(ansiSegments(style.bold("Tools") + style.gray("  (Supervised)") + "\n  read"), [
    { text: "Tools", styles: ["bold"] },
    { text: "  (Supervised)", styles: ["gray"] },
    { text: "\n  read" },
  ]);
});

test("nested styles, resets, and other escapes dropped", () => {
  assert.deepEqual(ansiSegments(style.bold(style.cyan("a") + "b") + "\x1b[2K\x1b]0;title\x07c\x1b[0m"), [
    { text: "a", styles: ["bold", "cyan"] },
    { text: "b", styles: ["bold"] },
    { text: "c" },
  ]);
  assert.deepEqual(ansiSegments(""), []);
});
