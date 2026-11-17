import { test } from "node:test";
import assert from "node:assert/strict";
import { unescapeWord, wordPattern } from "./words";
import { tokenize } from "./slashCommands";

test("a backslash escapes the next character on macOS and Linux", () => {
  assert.deepEqual(tokenize("add ~/a\\ b.md 'x y' \"z w\"", "darwin"), ["add", "~/a b.md", "x y", "z w"]);
  assert.equal(unescapeWord("a\\ b", "darwin"), "a b");
});

test("on Windows a backslash is a path separator and stays", () => {
  assert.deepEqual(tokenize("add C:\\Users\\me\\a.md \"C:\\My Docs\\b.md\" 'D:\\x y'", "win32"), [
    "add",
    "C:\\Users\\me\\a.md",
    "C:\\My Docs\\b.md",
    "D:\\x y",
  ]);
  // A path that ends in a backslash does not swallow the space after it.
  assert.deepEqual(tokenize("C:\\dir\\ C:\\other", "win32"), ["C:\\dir\\", "C:\\other"]);
  assert.equal(unescapeWord("C:\\a\\b", "win32"), "C:\\a\\b");
});

test("on Windows an apostrophe inside a word stays, and one that starts a word opens a quote", () => {
  assert.deepEqual(tokenize("add C:\\pics\\it's.png 'a b.png' don't", "win32"), ["add", "C:\\pics\\it's.png", "a b.png", "don't"]);
});

test("with oneLine a quote closes on its own line, so an apostrophe in prose does not pair up", () => {
  const text = "it's here\nand isn't there\n'a b.png'";
  const quoted = (re: RegExp): string[] => {
    const out: string[] = [];
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m[1] !== undefined) {
        out.push(m[1]);
      }
    }
    return out;
  };
  assert.deepEqual(quoted(wordPattern("darwin", false)), ["s here\nand isn", "a b.png"]);
  assert.deepEqual(quoted(wordPattern("darwin", true)), ["a b.png"]);
});
