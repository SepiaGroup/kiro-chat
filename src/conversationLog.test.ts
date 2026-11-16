import { test } from "node:test";
import assert from "node:assert/strict";
import { ConversationLog } from "./conversationLog";

test("a turn: transcript, user turn id, stats with credits and the engine's timing", () => {
  const log = new ConversationLog();
  log.promptStarted("hi", 1000);
  log.track({ kind: "userMessageId", messageId: "m1" } as never);
  log.track({ kind: "assistantChunk", text: "Hel" } as never);
  log.track({ kind: "assistantChunk", text: "lo" } as never);
  log.track({ kind: "toolCall", title: "Reading a.ts" } as never);
  log.track({ kind: "assistantChunk", text: "Done" } as never);
  log.track({ kind: "metering", credits: 0.5 } as never);
  log.track({ kind: "metering", credits: 0.25 } as never);
  log.track({ kind: "turnCompletion", elapsedMs: 900, requestIds: ["r1"], status: "success" } as never);
  log.promptFinished(false, 3000);
  assert.deepEqual(log.transcript, [
    { role: "user", text: "hi" },
    { role: "assistant", text: "Hello" },
    { role: "tool", text: "Reading a.ts" },
    { role: "assistant", text: "Done" },
  ]);
  assert.deepEqual(log.userTurns, [{ messageId: "m1", text: "hi" }]);
  assert.deepEqual(log.turnStats.map((s) => [s.prompt, s.elapsedMs, s.credits, s.requestIds, s.status]), [["hi", 900, 0.75, ["r1"], "success"]]);
  log.promptStarted("again", 4000);
  log.promptFinished(true, 4500);
  assert.equal(log.turnStats[1].status, "cancelled");
  assert.equal(log.turnStats[1].elapsedMs, 500);
});

test("settings, commands, tool groups and MCP servers; reset keeps settings", () => {
  const log = new ConversationLog();
  log.track({ kind: "configOptions", options: [{ id: "autopilot", name: "Autopilot", currentValue: "off" }] } as never);
  log.track({ kind: "availableCommands", commands: [{ name: "find-skills" }] } as never);
  log.track({ kind: "contextUsage", usagePercentage: 12 } as never);
  log.notification("_kiro/tools/didChange", { tags: [{ tag: "shell", description: "Run" }, { bad: 1 }] });
  log.notification("_kiro/mcp/status", { servers: [{ name: "x" }] });
  log.track({ kind: "userMessage", text: "old" } as never);
  assert.equal(log.config.option("autopilot")?.currentValue, "off");
  assert.deepEqual(log.toolGroups, [{ tag: "shell", description: "Run" }]);
  assert.equal(log.mcpServers.length, 1);
  assert.equal(log.contextPercent, 12);
  log.reset();
  assert.deepEqual(log.transcript, []);
  assert.equal(log.contextPercent, undefined);
  assert.equal(log.config.all.length, 1);
  assert.equal(log.engineCommands.length, 1);
});
