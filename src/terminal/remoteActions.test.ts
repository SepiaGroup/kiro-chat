import { test } from "node:test";
import assert from "node:assert/strict";
import { stripAnsi } from "./ansi";
import { RemoteActions, type RemoteEngine } from "./remoteActions";
import type { RpcId } from "../types";

function rig(over: { canAct?: boolean; engine?: boolean } = {}) {
  const printed: string[] = [];
  const posted: Array<Record<string, unknown>> = [];
  const calls: unknown[][] = [];
  const shown: unknown[][] = [];
  const state = { canAct: over.canAct ?? true, turnRunning: false };
  const engine: RemoteEngine = {
    get turnRunning() {
      return state.turnRunning;
    },
    steer: async (t) => void calls.push(["steer", t]),
    respondToApproval: (id, a, o) => {
      calls.push(["approve", id, a, o]);
      if (a.optionId === "rule") {
        throw new Error("A remote device can only allow or deny once.");
      }
      return a.optionId === "a1" ? "allow_once" : "reject_once";
    },
    answerQuestion: (id, a) => void calls.push(["answer", id, a]),
    setMode: async (m) => void calls.push(["mode", m]),
    setConfigOption: async (id, v) => void calls.push(["config", id, v]),
    extMethod: async <T,>(m: string) => {
      calls.push(["ext", m]);
      return { breakdown: { total: 1 } } as T;
    },
  };
  const actions = new RemoteActions({
    engine: () => (over.engine === false ? undefined : engine),
    canAct: () => state.canAct,
    isClosed: () => false,
    print: (t) => printed.push(stripAnsi(t)),
    post: (m) => posted.push(m as Record<string, unknown>),
    formatUser: (t) => `> ${t}`,
    sendPrompt: async (text, device, images) => void calls.push(["prompt", text, device, images.length]),
    cancelTurn: () => calls.push(["cancel"]),
    compact: async () => ({ ok: true, message: "Conversation compacted." }),
    approvalAnswered: (ev) => shown.push(["approval", ev.label]),
    questionAnswered: (id: RpcId, label) => shown.push(["question", id, label]),
  });
  return { actions, printed, posted, calls, shown, state };
}

const approval = (toolCallId: string, requestId: RpcId) =>
  ({ kind: "approvalRequest", requestId, request: { toolCallId, question: "q", options: [] } }) as never;

test("an idle prompt runs as a turn; a busy terminal says so; a running turn is steered", async () => {
  const r = rig();
  await r.actions.handle({ type: "sendPrompt", text: "/quit", images: [] }, "iPhone");
  assert.deepEqual(r.calls, [["prompt", "/quit", "iPhone", 0]]);
  r.state.canAct = false;
  await r.actions.handle({ type: "sendPrompt", text: "hi", images: [] }, "iPhone");
  assert.equal(r.calls.length, 1);
  assert.match(String(r.posted.at(-1)?.text), /busy/);
  r.state.turnRunning = true;
  await r.actions.handle({ type: "sendPrompt", text: " more ", images: [] }, "iPhone");
  assert.deepEqual(r.calls.at(-1), ["steer", " more "]);
  assert.deepEqual(r.printed.at(-1), "> more  (from iPhone)");
  await r.actions.handle({ type: "sendPrompt", text: "pic", images: [{ mimeType: "image/png", data: "AAAA" }] }, "iPhone");
  assert.match(String(r.posted.at(-1)?.text), /Images can't be added/);
});

test("approvals from a device are once only, labelled, and leave the terminal waiting on a refusal", async () => {
  const r = rig();
  r.actions.track(approval("tc1", 7));
  await r.actions.handle({ type: "approve", toolCallId: "tc1", optionId: "rule" }, "iPhone");
  assert.deepEqual(r.shown, []);
  assert.equal(r.posted.at(-1)?.type, "notice");
  await r.actions.handle({ type: "approve", toolCallId: "tc1", optionId: "a1" }, "iPhone");
  assert.deepEqual(r.calls.at(-1), ["approve", 7, { optionId: "a1" }, { onceOnly: true }]);
  assert.deepEqual(r.shown, [["approval", "Allowed from iPhone"]]);
  await r.actions.handle({ type: "approve", toolCallId: "tc1", optionId: "a1" }, "iPhone");
  assert.equal(r.shown.length, 1, "answered once");
});

test("an approval answered in the terminal reaches the device; the turn's end drops the rest", () => {
  const r = rig();
  r.actions.track(approval("tc1", 1));
  r.actions.track(approval("tc2", 2));
  assert.deepEqual(r.actions.approvalDone(2, false, "in the terminal"), { kind: "approvalResolved", toolCallId: "tc2", requestId: 2, allowed: false, label: "Denied in the terminal" });
  assert.equal(r.actions.approvalDone(2, true, "x"), undefined);
  assert.equal(r.actions.track({ kind: "runFinished" } as never), true);
  assert.equal(r.actions.approvalDone(1, true, "x"), undefined);
});

test("questions: answered or skipped from a device", async () => {
  const r = rig();
  r.actions.track({ kind: "question", requestId: "q-1", question: { toolCallId: "q1" } } as never);
  r.actions.track({ kind: "question", requestId: "q-2", question: { toolCallId: "q2" } } as never);
  await r.actions.handle({ type: "answerQuestion", toolCallId: "q1", answer: "red" }, "iPhone");
  await r.actions.handle({ type: "answerQuestion", toolCallId: "q2" }, "iPhone");
  assert.deepEqual(r.shown, [
    ["question", "q-1", "Answered from iPhone: red"],
    ["question", "q-2", "Skipped from iPhone."],
  ]);
  assert.deepEqual(r.posted.map((m) => (m.event as { label?: string })?.label), ["Answered from iPhone: red", "Skipped from iPhone."]);
});

test("compact uses the terminal's own /compact and is refused while the terminal is busy", async () => {
  const r = rig();
  await r.actions.handle({ type: "compact" }, "iPhone");
  assert.deepEqual(r.posted.at(-1), { type: "compactDone", ok: true, message: "Conversation compacted." });
  assert.equal(r.printed.at(-1), "Compacting, from iPhone.");
  r.state.canAct = false;
  await r.actions.handle({ type: "compact" }, "iPhone");
  assert.equal(r.posted.at(-1)?.ok, false);
});

test("settings and stop say which device changed them", async () => {
  const r = rig();
  await r.actions.handle({ type: "setConfig", id: "effortLevel", value: "high" }, "iPhone");
  await r.actions.handle({ type: "setConfig", id: "other", value: "x" }, "iPhone");
  await r.actions.handle({ type: "setMode", modeId: "plan" }, "iPhone");
  await r.actions.handle({ type: "cancelTurn" }, "iPhone");
  assert.deepEqual(r.printed, ["Effort changed from iPhone.", "other changed from iPhone.", "Mode changed from iPhone."]);
  r.state.turnRunning = true;
  await r.actions.handle({ type: "cancelTurn" }, "iPhone");
  assert.deepEqual(r.calls.at(-1), ["cancel"]);
});

test("without an engine a prompt and the context card say so", async () => {
  const r = rig({ engine: false });
  await r.actions.handle({ type: "sendPrompt", text: "hi", images: [] }, "iPhone");
  await r.actions.handle({ type: "getContextBreakdown" }, "iPhone");
  assert.deepEqual(r.posted.map((m) => m.type), ["error", "contextBreakdown"]);
});
