import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "os";
import * as path from "path";
import { findImagePaths, sniffImageMime } from "./imagePaths";

const WIN = process.platform === "win32";
const n = (p: string): string => path.normalize(p);

test("finds quoted, escaped, home, relative and file:// image paths", () => {
  // A backslash escapes a space on macOS and Linux; on Windows it is the separator, so the space is quoted there.
  const spaced = WIN ? '"/tmp/a b.JPG"' : "/tmp/a\\ b.JPG";
  const url = WIN ? "file:///C:/tmp/e.jpeg" : "file:///tmp/e.jpeg";
  const text =
    `what is in '/Users/me/Desktop/Screenshot 1.png' and ${spaced} ` +
    `and ~/pics/c.webp, ./d.gif plus ${url}?`;
  assert.deepEqual(findImagePaths(text, "/work"), [
    n("/Users/me/Desktop/Screenshot 1.png"),
    n("/tmp/a b.JPG"),
    path.join(os.homedir(), "pics/c.webp"),
    path.resolve("/work", "d.gif"),
    n(WIN ? "C:/tmp/e.jpeg" : "/tmp/e.jpeg"),
  ]);
});

test("ignores non-image paths, plain words and duplicates", () => {
  assert.deepEqual(findImagePaths("edit /src/a.ts and say png", "/w"), []);
  assert.deepEqual(findImagePaths("/x/y.png /x/y.png", "/w"), [n("/x/y.png")]);
});

test("bare file name in the working folder counts", () => {
  assert.deepEqual(findImagePaths("look at logo.png please", "/w"), [path.resolve("/w", "logo.png")]);
});

// Needs Windows' own path rules, so it runs only there (CI has a Windows job).
test("on Windows a typed or dragged C:\\ path keeps its backslashes", { skip: !WIN }, () => {
  assert.deepEqual(findImagePaths('see C:\\Users\\me\\a.png and "C:\\My Pics\\b.JPG" and ~\\c.gif', "C:\\w"), [
    "C:\\Users\\me\\a.png",
    "C:\\My Pics\\b.JPG",
    path.join(os.homedir(), "c.gif"),
  ]);
});

test("sniffImageMime checks the file's first bytes", () => {
  assert.equal(sniffImageMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), "image/png");
  assert.equal(sniffImageMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImageMime(Buffer.from("GIF89a")), "image/gif");
  assert.equal(sniffImageMime(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(sniffImageMime(Buffer.from("#!/bin/sh\n")), undefined);
});
