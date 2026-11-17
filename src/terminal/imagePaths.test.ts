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

// The Windows rules, run on any machine through the platform argument.
test("Windows: a typed or dragged C:\\ path keeps its backslashes", () => {
  const text = 'see C:\\Users\\me\\a.png and "C:\\My Pics\\b.JPG" and ~\\c.gif and .\\sub\\d.webp and file:///C:/tmp/e.jpeg';
  assert.deepEqual(findImagePaths(text, "C:\\w", "win32", "C:\\Users\\me"), [
    "C:\\Users\\me\\a.png",
    "C:\\My Pics\\b.JPG",
    "C:\\Users\\me\\c.gif",
    "C:\\w\\sub\\d.webp",
    "C:\\tmp\\e.jpeg",
  ]);
});

test("Windows: an apostrophe inside a file name stays in it", () => {
  assert.deepEqual(findImagePaths("look at C:\\pics\\it's.png now", "C:\\w", "win32", "C:\\Users\\me"), ["C:\\pics\\it's.png"]);
});

test("macOS: ~\\ is not the home folder, ~/ is", () => {
  assert.deepEqual(findImagePaths("~/a.png", "/w", "darwin", "/Users/me"), ["/Users/me/a.png"]);
  // A file literally called ~\c.gif in the working folder.
  assert.deepEqual(findImagePaths("see ~\\\\c.gif", "/w", "darwin", "/Users/me"), ["/w/~\\c.gif"]);
});

test("sniffImageMime checks the file's first bytes", () => {
  assert.equal(sniffImageMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), "image/png");
  assert.equal(sniffImageMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImageMime(Buffer.from("GIF89a")), "image/gif");
  assert.equal(sniffImageMime(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(sniffImageMime(Buffer.from("#!/bin/sh\n")), undefined);
});
