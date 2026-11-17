import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { WindowRegistry } from "./windowRegistry";

function rig(alive: (pid: number) => boolean = () => true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kreg-"));
  const registry = new WindowRegistry(dir, alive);
  return { dir, registry, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const win = (id: string, pid = 1, port = 5000) => ({ id, name: `w-${id}`, port, pid });

// File modes are POSIX; on Windows the file is private through its folder's ACL (user profile).
test("the token is made once and is the same for every window", { skip: process.platform === "win32" }, () => {
  const r = rig();
  try {
    const a = r.registry.token();
    assert.ok(a.length >= 32);
    assert.equal(new WindowRegistry(r.dir).token(), a);
    assert.equal(fs.statSync(path.join(r.dir, "link-token")).mode & 0o077, 0, "readable by this user only");
  } finally {
    r.done();
  }
});

test("windows publish, show up and withdraw", () => {
  const r = rig();
  try {
    r.registry.publish(win("aaaaaaaa", 11, 5001));
    r.registry.publish(win("bbbbbbbb", 12, 5002));
    assert.deepEqual(r.registry.windows().map((w) => w.id).sort(), ["aaaaaaaa", "bbbbbbbb"]);
    r.registry.publish({ ...win("aaaaaaaa", 11, 5009) }); // replaces
    assert.equal(r.registry.windows().find((w) => w.id === "aaaaaaaa")?.port, 5009);
    r.registry.withdraw("aaaaaaaa");
    assert.deepEqual(r.registry.windows().map((w) => w.id), ["bbbbbbbb"]);
  } finally {
    r.done();
  }
});

test("a window whose process is gone is dropped, and so are damaged or misnamed files", () => {
  const dead = new Set<number>();
  const r = rig((pid) => !dead.has(pid));
  try {
    r.registry.publish(win("aaaaaaaa", 11));
    r.registry.publish(win("bbbbbbbb", 12));
    fs.writeFileSync(path.join(r.dir, "windows", "cccccccc.json"), "{not json");
    fs.writeFileSync(path.join(r.dir, "windows", "dddddddd.json"), JSON.stringify(win("eeeeeeee"))); // id does not match its name
    fs.writeFileSync(path.join(r.dir, "windows", "notes.txt"), "x");
    dead.add(12);
    assert.deepEqual(r.registry.windows().map((w) => w.id), ["aaaaaaaa"]);
    assert.ok(!fs.existsSync(path.join(r.dir, "windows", "bbbbbbbb.json")));
    assert.ok(fs.existsSync(path.join(r.dir, "windows", "notes.txt")), "other files are left alone");
  } finally {
    r.done();
  }
});

test("only one window becomes the hub", () => {
  const r = rig();
  try {
    r.registry.publish(win("aaaaaaaa", 11));
    r.registry.publish(win("bbbbbbbb", 12));
    assert.equal(r.registry.claimHub("aaaaaaaa", 11), true);
    assert.equal(r.registry.claimHub("bbbbbbbb", 12), false);
    assert.equal(r.registry.claimHub("aaaaaaaa", 11), true, "asking again is fine");
    assert.deepEqual(r.registry.hub(), { id: "aaaaaaaa", pid: 11 });
  } finally {
    r.done();
  }
});

test("when the hub window leaves or dies, another can take over", () => {
  const dead = new Set<number>();
  const r = rig((pid) => !dead.has(pid));
  try {
    r.registry.publish(win("aaaaaaaa", 11));
    r.registry.publish(win("bbbbbbbb", 12));
    r.registry.claimHub("aaaaaaaa", 11);

    r.registry.withdraw("aaaaaaaa"); // leaves cleanly
    assert.equal(r.registry.hub(), undefined);
    assert.equal(r.registry.claimHub("bbbbbbbb", 12), true);

    r.registry.publish(win("cccccccc", 13));
    dead.add(12); // b crashes without cleaning up: its lock and file stay behind
    assert.equal(r.registry.hub(), undefined);
    assert.equal(r.registry.claimHub("cccccccc", 13), true);
    assert.equal(r.registry.hub()?.id, "cccccccc");
  } finally {
    r.done();
  }
});

test("a lock whose window file is gone does not hold the hub", () => {
  const r = rig();
  try {
    r.registry.publish(win("aaaaaaaa", 11));
    r.registry.claimHub("aaaaaaaa", 11);
    fs.unlinkSync(path.join(r.dir, "windows", "aaaaaaaa.json"));
    assert.equal(r.registry.hub(), undefined);
    r.registry.publish(win("bbbbbbbb", 12));
    assert.equal(r.registry.claimHub("bbbbbbbb", 12), true);
  } finally {
    r.done();
  }
});

test("release only gives up a lock this window holds", () => {
  const r = rig();
  try {
    r.registry.publish(win("aaaaaaaa", 11));
    r.registry.claimHub("aaaaaaaa", 11);
    r.registry.release("bbbbbbbb");
    assert.equal(r.registry.hub()?.id, "aaaaaaaa");
    r.registry.release("aaaaaaaa");
    assert.equal(r.registry.hub(), undefined);
  } finally {
    r.done();
  }
});

test("files from before this Mac restarted are stale, even when the pid is in use again", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kreg-"));
  try {
    const before = new WindowRegistry(dir, () => true, 1_000_000);
    before.publish(win("aaaaaaaa", 11));
    assert.equal(before.claimHub("aaaaaaaa", 11), true);
    const after = new WindowRegistry(dir, () => true, 1_000_000 + 3600); // an hour later, a new boot
    assert.deepEqual(after.windows(), []);
    assert.equal(after.hub(), undefined);
    after.publish(win("bbbbbbbb", 12));
    assert.equal(after.claimHub("bbbbbbbb", 12), true, "the stale lock is replaced");
    assert.deepEqual(after.hub(), { id: "bbbbbbbb", pid: 12 });
    const sameBoot = new WindowRegistry(dir, () => true, 1_000_000 + 3600 + 30); // clock moved a little
    assert.deepEqual(sameBoot.hub(), { id: "bbbbbbbb", pid: 12 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("temp files left by a window that died while writing are removed once old", () => {
  const r = rig();
  try {
    r.registry.publish(win("aaaaaaaa", 11));
    const old = path.join(r.dir, "windows", "aaaaaaaa.json.4242.0badc0de.tmp");
    const fresh = path.join(r.dir, "hub.lock.4242.0badc0df.tmp");
    fs.writeFileSync(old, "{");
    fs.writeFileSync(fresh, "{");
    const past = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(old, past, past);
    assert.deepEqual(r.registry.windows().map((w) => w.id), ["aaaaaaaa"]);
    assert.ok(!fs.existsSync(old));
    assert.ok(fs.existsSync(fresh), "one being written now is left alone");
    assert.deepEqual(fs.readdirSync(path.join(r.dir, "windows")), ["aaaaaaaa.json"], "publish leaves no temp file");
  } finally {
    r.done();
  }
});

test("a damaged (empty) lock is replaced, and the token file is complete when it appears", () => {
  const r = rig();
  try {
    r.registry.publish(win("aaaaaaaa", 11));
    fs.mkdirSync(r.dir, { recursive: true });
    fs.writeFileSync(path.join(r.dir, "hub.lock"), "");
    assert.equal(r.registry.claimHub("aaaaaaaa", 11), true);
    assert.equal(r.registry.token().length >= 32, true);
    assert.deepEqual(fs.readdirSync(r.dir).filter((n) => n.endsWith(".tmp") || n.endsWith(".stale")), []);
  } finally {
    r.done();
  }
});
