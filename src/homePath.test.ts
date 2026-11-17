import { test } from "node:test";
import assert from "node:assert/strict";
import { homeRest } from "./homePath";

test("~/ is the home folder everywhere", () => {
  assert.equal(homeRest("~/a/b.txt", "darwin"), "a/b.txt");
  assert.equal(homeRest("~/a/b.txt", "win32"), "a/b.txt");
  assert.equal(homeRest("~/", "linux"), "");
});

test("~\\ is the home folder on Windows only", () => {
  assert.equal(homeRest("~\\a\\b.txt", "win32"), "a\\b.txt");
  assert.equal(homeRest("~\\a.txt", "darwin"), undefined); // a file named ~\a.txt
});

test("other paths are not in the home folder", () => {
  for (const p of ["~", "~user/x", "/a/~/b", "a/b", ""]) {
    assert.equal(homeRest(p, "darwin"), undefined, p);
    assert.equal(homeRest(p, "win32"), undefined, p);
  }
});
