import { test } from "node:test";
import assert from "node:assert/strict";
import { machine } from "./machine";

test("Mac on macOS, computer elsewhere", () => {
  assert.equal(machine("darwin"), "Mac");
  assert.equal(machine("win32"), "computer");
  assert.equal(machine("linux"), "computer");
  assert.equal(machine(), process.platform === "darwin" ? "Mac" : "computer");
});
