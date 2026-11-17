// The webview scripts run in a browser: bundle them as the build does and check
// they don't use Node globals. A shared module that reads `process` at load
// stops the chat page before it starts (it stays on "Starting up").
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { join } from "path";
import { runInNewContext } from "vm";

const root = join(__dirname, "..", "..");

for (const entry of ["src/webview/main.ts", "src/webview/remoteShim.ts"]) {
  test(`${entry} doesn't use Node's process or require`, () => {
    const out = buildSync({
      entryPoints: [join(root, entry)],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      target: "es2022",
      logLevel: "silent",
    }).outputFiles[0].text;
    // A bare `process` throws in the browser; `globalThis.process?.…` is fine.
    const bare = [...out.matchAll(/(?<![.\w$])process\s*[.[]/g)].map((m) => out.slice(m.index - 40, m.index + 30));
    assert.deepEqual(bare, []);
    assert.doesNotMatch(out, /\brequire\(/);
  });
}

test("machine() works without process, from the browser's user agent", () => {
  const out = buildSync({
    entryPoints: [join(root, "src/machine.ts")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    globalName: "m",
    logLevel: "silent",
  }).outputFiles[0].text;
  const run = (ua: string) =>
    runInNewContext(out + ";m.machine()", { navigator: { userAgent: ua } }) as string;
  assert.equal(run("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), "Mac");
  assert.equal(run("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), "computer");
});
