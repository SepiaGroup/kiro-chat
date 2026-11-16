import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL_PERMISSIONS, checkRemoteMessage, MAX_REMOTE_PROMPT, parsePermissions, Permission } from "./remotePolicy";

const ALL = [...ALL_PERMISSIONS];
const ok = (raw: unknown, perms: Permission[] = ALL) => {
  const r = checkRemoteMessage(raw, perms);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.ok ? r.msg : { type: "" };
};
const refused = (raw: unknown, status: number, perms: Permission[] = ALL) => {
  const r = checkRemoteMessage(raw, perms);
  assert.equal(r.ok, false, JSON.stringify(raw));
  if (!r.ok) {
    assert.equal(r.status, status, r.reason);
  }
};

test("bad shapes are refused", () => {
  for (const raw of [null, undefined, 5, "x", [], {}, { type: 5 }, { type: "x".repeat(50) }]) {
    refused(raw, 400);
  }
});

test("only the listed message types get through", () => {
  // These act on the Mac's own screen, so no device may send them.
  for (const type of [
    "login",
    "newSession",
    "pickAttachment",
    "attachPaths",
    "debugLog",
    "setAutoApprove",
    "remoteAccess",
    "remoteLink",
    "remoteState",
    "__proto__",
    "constructor",
  ]) {
    refused({ type }, 403);
  }
  // A paired device may restart, open a tab, resume, load a session and answer a command's y/n question.
  assert.deepEqual(ok({ type: "restart" }), { type: "restart" });
  assert.deepEqual(ok({ type: "newTab" }), { type: "newTab" });
  assert.deepEqual(ok({ type: "resumeSession" }), { type: "resumeSession" });
  assert.deepEqual(ok({ type: "loadSession", sessionId: "s1" }), { type: "loadSession", sessionId: "s1" });
  refused({ type: "loadSession" }, 400);
  assert.deepEqual(ok({ type: "confirmAnswer", id: 3, yes: true }), { type: "confirmAnswer", id: 3, yes: true });
  assert.deepEqual(ok({ type: "confirmAnswer", id: 4, yes: "x" }), { type: "confirmAnswer", id: 4, yes: false });
  refused({ type: "confirmAnswer", yes: true }, 400);
  refused({ type: "restart" }, 403, ["view"]);
  refused({ type: "confirmAnswer", id: 1 }, 403, ["view"]);
});

test("view, prompt and approve are separate permissions", () => {
  ok({ type: "ready" }, ["view"]);
  refused({ type: "sendPrompt", text: "hi" }, 403, ["view"]);
  refused({ type: "cancelTurn" }, 403, ["view"]);
  refused({ type: "approve", toolCallId: "t", optionId: "allow_once" }, 403, ["view", "prompt"]);
  refused({ type: "ready" }, 403, ["prompt", "approve"]);
  ok({ type: "approve", toolCallId: "t", optionId: "allow_once" }, ["approve"]);
  refused({ type: "ready" }, 403, []);
});

test("parsePermissions keeps the known ones and defaults to all", () => {
  assert.deepEqual(parsePermissions(undefined), ALL);
  assert.deepEqual(parsePermissions("view"), ALL);
  assert.deepEqual(parsePermissions(["prompt", "view", "root"]), ["view", "prompt"]);
  assert.deepEqual(parsePermissions([]), []);
});

test("an approval keeps the answer, reason, rule and folder", () => {
  const m = ok({
    type: "approve",
    toolCallId: "t1",
    optionId: "reject_once",
    reason: "no thanks",
    rule: "entire-tool",
    folder: "/tmp",
    extra: true,
  });
  assert.deepEqual(m, { type: "approve", toolCallId: "t1", optionId: "reject_once", reason: "no thanks", rule: "entire-tool", folder: "/tmp" });
  refused({ type: "approve", optionId: "allow_once" }, 400);
  refused({ type: "approve", toolCallId: "t", optionId: "" }, 400);
  refused({ type: "approve", toolCallId: "t".repeat(300), optionId: "a" }, 400);
  assert.equal((ok({ type: "approve", toolCallId: "t", optionId: "a", reason: "x".repeat(5000) }).reason as string).length, 2000);
});

test("prompts: text and images, size limited, nothing else passes", () => {
  assert.deepEqual(ok({ type: "sendPrompt", text: "hello", secret: 1 }), { type: "sendPrompt", text: "hello", images: [] });
  refused({ type: "sendPrompt" }, 400);
  refused({ type: "sendPrompt", text: "   " }, 400);
  refused({ type: "sendPrompt", text: "x".repeat(MAX_REMOTE_PROMPT + 1) }, 413);
  const withImage = ok({
    type: "sendPrompt",
    text: "",
    images: [{ mimeType: "image/png", data: "AAAA", name: "a.png" }, { mimeType: "text/html", data: "AAAA" }, "junk"],
  });
  assert.deepEqual(withImage.images, [{ mimeType: "image/png", data: "AAAA", name: "a.png" }]);
});

test("steering, answers, mode and settings", () => {
  assert.deepEqual(ok({ type: "steerPrompt", text: " also this " }), { type: "steerPrompt", text: "also this" });
  refused({ type: "steerPrompt", text: " " }, 400);
  assert.deepEqual(ok({ type: "answerQuestion", toolCallId: "q", answer: " red " }), { type: "answerQuestion", toolCallId: "q", answer: "red" });
  assert.deepEqual(ok({ type: "answerQuestion", toolCallId: "q", answer: "" }), { type: "answerQuestion", toolCallId: "q" });
  refused({ type: "answerQuestion", answer: "x" }, 400);
  assert.deepEqual(ok({ type: "setMode", modeId: "plan" }), { type: "setMode", modeId: "plan" });
  refused({ type: "setMode" }, 400);
  assert.deepEqual(ok({ type: "setConfig", id: "model", value: "auto" }), { type: "setConfig", id: "model", value: "auto" });
  assert.deepEqual(ok({ type: "setConfig", id: "effortLevel", value: "high" }), { type: "setConfig", id: "effortLevel", value: "high" });
  // A device may change the Settings-panel options; autopilot also needs the approve permission.
  for (const id of ["memoryReflection", "contentCollection"]) {
    assert.deepEqual(ok({ type: "setConfig", id, value: "on" }), { type: "setConfig", id, value: "on" });
  }
  assert.deepEqual(ok({ type: "setConfig", id: "autopilot", value: "on" }), { type: "setConfig", id: "autopilot", value: "on" });
  refused({ type: "setConfig", id: "autopilot", value: "on" }, 403, ["view", "prompt"]);
  refused({ type: "setConfig", id: "anything", value: "on" }, 403);
  refused({ type: "setConfig", id: "model" }, 400);
});

test("simple requests carry no fields", () => {
  assert.deepEqual(ok({ type: "cancelTurn", x: 1 }), { type: "cancelTurn" });
  assert.deepEqual(ok({ type: "compact" }), { type: "compact" });
  assert.deepEqual(ok({ type: "getContextBreakdown" }), { type: "getContextBreakdown" });
});
