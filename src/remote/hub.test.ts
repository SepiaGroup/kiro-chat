// Two windows end to end: a member window with chats, a hub window that shows
// them to a paired phone, over real loopback servers.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import { COOKIE_NAME, DeviceStore, PairingCode } from "./remoteAuth";
import { callPeer, MemberConnection } from "./memberLink";
import { Permission, RemoteMessage } from "./remotePolicy";
import { RemoteChat, RemoteServer } from "./remoteServer";

class FakeChat implements RemoteChat {
  busy = false;
  snapshotMsgs: unknown[] = [{ type: "userMessage", text: "earlier" }];
  sent: Array<{ msg: RemoteMessage; device: { id: string; name: string } }> = [];
  listeners = new Set<(msg: unknown) => void>();
  constructor(
    readonly id: string,
    public title: string
  ) {}
  snapshot(): unknown[] {
    return this.snapshotMsgs;
  }
  async send(msg: RemoteMessage, device: { id: string; name: string }): Promise<void> {
    this.sent.push({ msg, device });
  }
  subscribe(listener: (msg: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(msg: unknown): void {
    this.listeners.forEach((l) => l(msg));
  }
}

const TOKEN = "t".repeat(43);

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(port: number, method: string, path: string, opts: { headers?: Record<string, string>; json?: unknown } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${port}`, ...opts.headers };
    let body: string | undefined;
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      headers["Content-Type"] = "application/json";
    }
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

interface Sse {
  status: number;
  events: Array<{ id?: string; event?: string; data: string }>;
  ended: Promise<void>;
  close(): void;
}

function openSse(port: number, path: string, headers: Record<string, string> = {}): Promise<Sse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = "";
      const events: Sse["events"] = [];
      let end!: () => void;
      const ended = new Promise<void>((r) => (end = r));
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        text += chunk;
        let i: number;
        while ((i = text.indexOf("\n\n")) >= 0) {
          const block = text.slice(0, i);
          text = text.slice(i + 2);
          const ev: { id?: string; event?: string; data: string } = { data: "" };
          for (const line of block.split("\n")) {
            if (line.startsWith("id: ")) {
              ev.id = line.slice(4);
            } else if (line.startsWith("event: ")) {
              ev.event = line.slice(7);
            } else if (line.startsWith("data: ")) {
              ev.data += line.slice(6);
            }
          }
          if (ev.data || ev.event) {
            events.push(ev);
          }
        }
      });
      res.on("end", end);
      res.on("close", end);
      resolve({ status: res.statusCode ?? 0, events, ended, close: () => req.destroy() });
    });
    req.on("error", reject);
    req.end();
  });
}

async function until(what: string, cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

const texts = (s: Sse): string[] => s.events.filter((e) => !e.event).map((e) => (JSON.parse(e.data) as { text?: string }).text ?? "?");

async function rig() {
  // A member window: two chats, internal routes only (it is not the hub).
  const memberChats = [new FakeChat("m1", "Build"), new FakeChat("m2", "Tests")];
  const member = new RemoteServer({
    chats: () => memberChats,
    windowName: "OtherRepo",
    internal: { token: TOKEN },
    publicApi: () => false,
    devices: new DeviceStore(),
    pairing: new PairingCode(),
    permissions: () => [],
    assets: () => undefined,
    heartbeatMs: 50,
  });
  const memberPort = await member.start(0);

  // The hub window: one chat of its own, and the member's through a connection.
  const hubChats = [new FakeChat("h1", "Main")];
  const devices = new DeviceStore();
  const pairing = new PairingCode();
  const perms = { current: ["view", "prompt", "approve"] as Permission[] };
  const hubRef: { server?: RemoteServer } = {};
  const conn = new MemberConnection({ id: "aaaaaaaa", name: "OtherRepo", port: memberPort }, TOKEN, () => hubRef.server?.chatsChanged());
  const removed: Array<string[] | "all"> = [];
  const hub = new RemoteServer({
    chats: () => hubChats,
    windowName: "KiroRepo",
    members: () => conn.chats(),
    internal: { token: TOKEN },
    hubApi: {
      pairLink: async (retry) => ({ link: `http://127.0.0.1/#k=${pairing.issue()}`, shared: retry }),
      devices: () => devices.list().map((d) => ({ id: d.id, name: d.name, lastSeen: d.lastSeen })),
      removeDevices: (ids) => removed.push(ids),
    },
    devices,
    pairing,
    permissions: () => perms.current,
    assets: () => undefined,
    heartbeatMs: 50,
  });
  hubRef.server = hub;
  const hubPort = await hub.start(0);
  conn.start();
  await until("the hub to see the member's chats", () => conn.chats().length === 2);
  const secret = pairing.issue();
  const paired = await request(hubPort, "POST", "/api/pair", { json: { secret }, headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1" } });
  const cookie = String(paired.headers["set-cookie"]?.[0] ?? "").split(";")[0];
  assert.ok(cookie.startsWith(`${COOKIE_NAME}=`));
  const stop = async (): Promise<void> => {
    conn.stop();
    await hub.stop();
    await member.stop();
  };
  return { member, memberPort, memberChats, hub, hubPort, hubChats, conn, cookie, perms, removed, devices, pairing, stop };
}

test("the phone sees the hub's chats and the other window's, with window names", async () => {
  const r = await rig();
  try {
    const list = JSON.parse((await request(r.hubPort, "GET", "/api/chats", { headers: { Cookie: r.cookie } })).body) as Array<{ id: string; title: string; window: string }>;
    assert.deepEqual(
      list.map((c) => [c.window, c.title]),
      [["KiroRepo", "Main"], ["OtherRepo", "Build"], ["OtherRepo", "Tests"]]
    );
    assert.equal(list[1].id, "aaaaaaaa.m1");
  } finally {
    await r.stop();
  }
});

test("a chat in the other window streams through the hub: snapshot, live messages, catch-up", async () => {
  const r = await rig();
  try {
    const s = await openSse(r.hubPort, "/api/chats/aaaaaaaa.m1/events", { Cookie: r.cookie });
    assert.equal(s.status, 200);
    await until("the snapshot", () => s.events.some((e) => e.event === "sync"));
    assert.deepEqual(texts(s), ["earlier"]);
    r.memberChats[0].emit({ type: "agentText", text: "one" });
    await until("a live message", () => texts(s).includes("one"));
    const lastId = s.events.filter((e) => e.id).pop()?.id;
    assert.ok(lastId);
    s.close();
    r.memberChats[0].emit({ type: "agentText", text: "two" });
    // Back again with the id: only what was missed, no snapshot.
    const again = await openSse(r.hubPort, "/api/chats/aaaaaaaa.m1/events", { Cookie: r.cookie, "Last-Event-ID": lastId });
    await until("the missed message", () => texts(again).includes("two"));
    assert.deepEqual(texts(again), ["two"]);
    assert.ok(!again.events.some((e) => e.event === "snapshot"));
    again.close();
  } finally {
    await r.stop();
  }
});

test("a message from the phone reaches the chat in the other window, with the device", async () => {
  const r = await rig();
  try {
    const ok = await request(r.hubPort, "POST", "/api/chats/aaaaaaaa.m2/message", { headers: { Cookie: r.cookie }, json: { type: "sendPrompt", text: "hello" } });
    assert.equal(ok.status, 204, ok.body);
    assert.equal(r.memberChats[1].sent.length, 1);
    assert.equal(r.memberChats[1].sent[0].msg.type, "sendPrompt");
    assert.match(r.memberChats[1].sent[0].device.name, /iPhone/);
    // The hub's rules apply first: no prompt permission, nothing reaches the other window.
    r.perms.current = ["view"];
    const denied = await request(r.hubPort, "POST", "/api/chats/aaaaaaaa.m2/message", { headers: { Cookie: r.cookie }, json: { type: "sendPrompt", text: "no" } });
    assert.equal(denied.status, 403);
    assert.equal(r.memberChats[1].sent.length, 1);
    // An approval with a rule and folder now passes through to the other window.
    r.perms.current = ["view", "prompt", "approve"];
    const approve = await request(r.hubPort, "POST", "/api/chats/aaaaaaaa.m2/message", {
      headers: { Cookie: r.cookie },
      json: { type: "approve", toolCallId: "t1", optionId: "allow_once", rule: "tool", folder: "/tmp" },
    });
    assert.equal(approve.status, 204, approve.body);
    assert.deepEqual(r.memberChats[1].sent[1].msg, { type: "approve", toolCallId: "t1", optionId: "allow_once", rule: "tool", folder: "/tmp" });
  } finally {
    await r.stop();
  }
});

test("the other window checks again: it takes nothing the permissions it was told do not allow", async () => {
  const r = await rig();
  try {
    const bad = await request(r.memberPort, "POST", "/internal/chats/m1/message", {
      headers: { Authorization: `Bearer ${TOKEN}` },
      json: { msg: { type: "sendPrompt", text: "x" }, device: { id: "d", name: "n" }, permissions: ["view"] },
    });
    assert.equal(bad.status, 403);
    const good = await request(r.memberPort, "POST", "/internal/chats/m1/message", {
      headers: { Authorization: `Bearer ${TOKEN}` },
      json: { msg: { type: "sendPrompt", text: "x" }, device: { id: "d", name: "n" }, permissions: ["view", "prompt"] },
    });
    assert.equal(good.status, 204);
    assert.equal(r.memberChats[0].sent.length, 1);
  } finally {
    await r.stop();
  }
});

test("the internal routes answer only with the secret and a loopback host", async () => {
  const r = await rig();
  try {
    for (const headers of [{} as Record<string, string>, { Authorization: "Bearer wrong" }, { Authorization: `Bearer ${TOKEN}`, Host: "mac.tail1.ts.net" }, { Authorization: `Basic ${TOKEN}` }]) {
      const res = await request(r.memberPort, "GET", "/internal/chats", { headers });
      assert.equal(res.status, 404, JSON.stringify(headers));
    }
    assert.equal((await request(r.memberPort, "GET", "/internal/chats", { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200);
    // A device's cookie is no key to them either.
    assert.equal((await request(r.hubPort, "GET", "/internal/chats", { headers: { Cookie: r.cookie } })).status, 404);
  } finally {
    await r.stop();
  }
});

test("a window that is not the hub does not serve the page or the device API", async () => {
  const r = await rig();
  try {
    for (const path of ["/", "/static/webview.js", "/api/me", "/api/chats", "/api/pair"]) {
      assert.equal((await request(r.memberPort, "GET", path)).status, 404, path);
    }
    assert.equal((await request(r.memberPort, "POST", "/api/pair", { json: { secret: r.pairing.issue() } })).status, 404);
  } finally {
    await r.stop();
  }
});

test("the other window's streams are not counted as devices", async () => {
  const r = await rig();
  try {
    const s = await openSse(r.hubPort, "/api/chats/aaaaaaaa.m1/events", { Cookie: r.cookie });
    await until("the stream", () => s.events.some((e) => e.event === "sync"));
    assert.equal(r.hub.connectedDevices.length, 1);
    assert.equal(r.hub.streamCount, 1);
    assert.equal(r.member.connectedDevices.length, 0);
    assert.equal(r.member.streamCount, 0);
    s.close();
    await until("the stream to close", () => r.hub.streamCount === 0);
  } finally {
    await r.stop();
  }
});

test("a chat closed in the other window is gone for the phone, and the list follows", async () => {
  const r = await rig();
  try {
    const list = await openSse(r.hubPort, "/api/chats/events", { Cookie: r.cookie });
    const chat = await openSse(r.hubPort, "/api/chats/aaaaaaaa.m2/events", { Cookie: r.cookie });
    await until("both streams", () => chat.events.some((e) => e.event === "sync") && list.events.length > 0);
    r.memberChats.pop();
    r.member.chatsChanged();
    await until("gone", () => chat.events.some((e) => e.event === "gone"));
    await chat.ended;
    await until("the new list", () => {
      const last = list.events.filter((e) => e.event === "chats").pop();
      return !!last && (JSON.parse(last.data) as unknown[]).length === 2;
    });
    assert.equal((await request(r.hubPort, "GET", "/api/chats/aaaaaaaa.m2/events", { headers: { Cookie: r.cookie } })).status, 404);
    list.close();
  } finally {
    await r.stop();
  }
});

test("when the other window goes away its chats leave the list and its streams end", async () => {
  const r = await rig();
  try {
    const chat = await openSse(r.hubPort, "/api/chats/aaaaaaaa.m1/events", { Cookie: r.cookie });
    await until("the stream", () => chat.events.some((e) => e.event === "sync"));
    await r.member.stop();
    await chat.ended;
    await until("the list to lose them", () => r.conn.chats().length === 0);
    const list = JSON.parse((await request(r.hubPort, "GET", "/api/chats", { headers: { Cookie: r.cookie } })).body) as unknown[];
    assert.equal(list.length, 1);
  } finally {
    r.conn.stop();
    await r.hub.stop();
  }
});

test("a window asks the hub for a pairing link and for the devices", async () => {
  const r = await rig();
  try {
    const link = (await callPeer({ port: r.hubPort }, TOKEN, "POST", "/internal/pair-link", { retry: true })) as { link: string; shared: boolean };
    assert.match(link.link, /#k=/);
    assert.equal(link.shared, true);
    const devices = (await callPeer({ port: r.hubPort }, TOKEN, "GET", "/internal/devices")) as Array<{ name: string }>;
    assert.equal(devices.length, 1);
    await callPeer({ port: r.hubPort }, TOKEN, "POST", "/internal/devices/remove", { ids: "all" });
    assert.deepEqual(r.removed, ["all"]);
    // The member has no hub API: it cannot be asked.
    await assert.rejects(callPeer({ port: r.memberPort }, TOKEN, "POST", "/internal/pair-link", { retry: false }), /404/);
  } finally {
    await r.stop();
  }
});
