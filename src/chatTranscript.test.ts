import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatTranscript, MAX_TRANSCRIPT } from "./chatTranscript";

const ev = (event: Record<string, unknown>) => ({ type: "event", event });

test("replay: ready first, then messages, then the latest state snapshots", () => {
  const t = new ChatTranscript();
  t.record({ type: "ready", n: 1 });
  t.record(ev({ kind: "configOptions", n: 1 }));
  t.record({ type: "userMessage", text: "hi" });
  t.record(ev({ kind: "assistantChunk", text: "yo" }));
  t.record(ev({ kind: "configOptions", n: 2 }));
  t.record(ev({ kind: "contextUsage", usagePercentage: 3 }));
  t.record({ type: "status", text: "ignored" });
  assert.deepEqual(t.replay(), [
    { type: "ready", n: 1 },
    { type: "userMessage", text: "hi" },
    ev({ kind: "assistantChunk", text: "yo" }),
    ev({ kind: "configOptions", n: 2 }),
    ev({ kind: "contextUsage", usagePercentage: 3 }),
  ]);
  t.record({ type: "cleared" });
  assert.equal(t.replay().length, 3);
});

test("answered approvals don't come back on restore", () => {
  const t = new ChatTranscript();
  t.record(ev({ kind: "approvalRequest", request: { toolCallId: "a" } }));
  t.record(ev({ kind: "approvalRequest", request: { toolCallId: "b" } }));
  t.dropApprovalCard("a");
  t.record(ev({ kind: "approvalResolved", toolCallId: "b", label: "Allowed by rule" }));
  assert.deepEqual(t.replay(), [ev({ kind: "approvalResolved", toolCallId: "b", label: "Allowed by rule" })]);
});

test("keeps at most MAX_TRANSCRIPT messages", () => {
  const t = new ChatTranscript();
  for (let i = 0; i < MAX_TRANSCRIPT + 5; i++) {
    t.record({ type: "notice", i });
  }
  const r = t.replay() as Array<{ i: number }>;
  assert.equal(r.length, MAX_TRANSCRIPT);
  assert.equal(r[0].i, 5);
});

test("answered or cancelled questions don't come back on restore", () => {
  const t = new ChatTranscript();
  t.record(ev({ kind: "question", question: { toolCallId: "a" } }));
  t.record(ev({ kind: "question", question: { toolCallId: "b" } }));
  t.record(ev({ kind: "question", question: { toolCallId: "c" } }));
  t.dropQuestionCard("a");
  t.record(ev({ kind: "questionResolved", toolCallId: "b" }));
  assert.deepEqual(t.replay(), [ev({ kind: "question", question: { toolCallId: "c" } })]);
});

test("over the size budget, images in the oldest messages go first, with a notice", () => {
  const t = new ChatTranscript(3000);
  const img = { mimeType: "image/png", data: "A".repeat(1000) };
  t.record({ type: "userMessage", text: "first", images: [img, img] });
  t.record(ev({ kind: "assistantChunk", text: "one" }));
  t.record({ type: "userMessage", text: "second", images: [img] });
  const out = t.replay() as Array<{ type: string; text?: string; images?: unknown[] }>;
  assert.equal(out[0].text, "first");
  assert.deepEqual(out[0].images, []);
  assert.deepEqual(out[1], { type: "notice", text: "2 images from this message are no longer kept (the chat is long)." });
  assert.equal(out[2].type, "event");
  assert.equal(out[3].images?.length, 1); // the newest keeps its image
});

test("over the size budget without images, the oldest messages are dropped; the newest always stays", () => {
  const t = new ChatTranscript(500);
  for (let i = 0; i < 20; i++) {
    t.record(ev({ kind: "toolUpdate", toolCallId: String(i), status: "done", output: "x".repeat(100) }));
  }
  const kept = t.replay() as Array<{ event: { toolCallId: string } }>;
  assert.ok(kept.length >= 1 && kept.length < 20);
  assert.equal(kept.at(-1)?.event.toolCallId, "19");
  const huge = new ChatTranscript(100);
  huge.record(ev({ kind: "toolUpdate", toolCallId: "big", status: "done", output: "x".repeat(1000) }));
  assert.equal(huge.replay().length, 1);
});

test("the size count follows removals and clears", () => {
  const t = new ChatTranscript(2000);
  t.record(ev({ kind: "approvalRequest", request: { toolCallId: "a" }, pad: "p".repeat(1500) }));
  t.dropApprovalCard("a");
  t.record(ev({ kind: "assistantChunk", text: "y".repeat(1500) })); // fits again once the card is gone
  assert.equal(t.replay().length, 1);
  t.record({ type: "cleared" });
  t.record(ev({ kind: "assistantChunk", text: "z".repeat(1500) }));
  assert.equal(t.replay().length, 1);
});
