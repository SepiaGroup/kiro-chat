import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import type { AddressInfo } from "net";
import { callPeer, SseReader } from "./memberLink";

function read(chunks: string[], max?: number): { events: Array<[string, string]>; ok: boolean[] } {
  const events: Array<[string, string]> = [];
  const r = new SseReader((e, d) => events.push([e, d]));
  return { events, ok: chunks.map((c) => r.push(c, max)) };
}

test("SseReader: events, multi-line data, comments, and one space after the colon", () => {
  const { events } = read(["retry: 2000\n\n: ping\n\nevent: chats\ndata: {\"a\":\ndata:  1}\n\ndata: x\n\n"]);
  assert.deepEqual(events, [["chats", "{\"a\":\n 1}"], ["message", "x"]]);
});

test("SseReader: \\r\\n and \\r line ends, also split across chunks", () => {
  const { events } = read(["event: chats\r\ndata: one\r", "\n\r", "\ndata: two\r\r"]);
  assert.deepEqual(events, [["chats", "one"], ["message", "two"]]);
});

test("SseReader: an event that never ends past the cap is refused", () => {
  const { ok } = read(["data: " + "x".repeat(50), "y".repeat(50)], 80);
  assert.deepEqual(ok, [true, false]);
});

test("callPeer: a peer that sends headers and then stalls is cut off at the deadline, and the socket closed", async () => {
  let closed = false;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write("{");
    req.socket.on("close", () => (closed = true));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const started = Date.now();
    await assert.rejects(callPeer({ port }, "t", "GET", "/internal/devices", undefined, 200));
    assert.ok(Date.now() - started < 2000);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(closed, true);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
