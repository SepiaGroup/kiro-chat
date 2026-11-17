// Splitting typed text into words, for `/` command arguments and for finding
// image paths. 'single' and "double" quotes group words everywhere. A backslash
// escapes the next character (`a\ b`) on macOS and Linux, but on Windows it is
// the path separator, so `C:\Users\me\a.png` must stay as typed (spaces there
// go in quotes). Pure.

/**
 * A fresh global pattern (it keeps state), for `exec` in a loop. Groups: 1
 * single-quoted, 2 double-quoted, 3 bare word. With `oneLine`, a quote must close
 * on its own line and hold something, so an apostrophe in prose can't pair with
 * one lines later.
 */
export function wordPattern(platform: NodeJS.Platform = process.platform, oneLine = false): RegExp {
  const quoted = oneLine ? "[^'\\n]+" : "[^']*";
  const dquoted = oneLine ? '[^"\\n]+' : '[^"]*';
  // On Windows an apostrophe inside a word stays in it (it's.png); one that starts a word opens a quote.
  const bare = platform === "win32" ? "[^\\s'\"][^\\s\"]*" : "(?:\\\\.|[^\\s'\"])+";
  return new RegExp(`'(${quoted})'|"(${dquoted})"|(${bare})`, "g");
}

/** A bare word with its escapes removed. */
export function unescapeWord(word: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? word : word.replace(/\\(.)/g, "$1");
}
