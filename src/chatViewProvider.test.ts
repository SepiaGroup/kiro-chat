// Tests for the multi-chat manager, using a minimal fake `vscode` module.
// No engine is started: chats only start when their webview sends "ready".

import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

type Listener<T> = (v: T) => void;

class Emitter<T = void> {
  private listeners: Array<Listener<T>> = [];
  readonly event = (l: Listener<T>) => {
    this.listeners.push(l);
    return { dispose: () => (this.listeners = this.listeners.filter((x) => x !== l)) };
  };
  fire(v: T): void {
    for (const l of [...this.listeners]) {
      l(v);
    }
  }
  dispose(): void {
    this.listeners = [];
  }
}

class FakeWebview {
  options: unknown;
  html = "";
  cspSource = "fake";
  sent: Array<{ type?: string; [k: string]: unknown }> = [];
  readonly messages = new Emitter<unknown>();
  readonly onDidReceiveMessage = this.messages.event;
  asWebviewUri(u: unknown): unknown {
    return u;
  }
  postMessage(m: { type?: string }): Promise<boolean> {
    this.sent.push(m);
    return Promise.resolve(true);
  }
}

class TabInputWebview {
  constructor(readonly viewType: string) {}
}
const tabGroups: { all: Array<{ viewColumn: number; tabs: Array<{ label: string; input: unknown }> }> } = { all: [] };

class FakePanel {
  viewColumn = 1;
  readonly webview = new FakeWebview();
  active = true;
  iconPath: unknown;
  revealed = 0;
  readonly viewState = new Emitter<void>();
  readonly disposed = new Emitter<void>();
  readonly onDidChangeViewState = this.viewState.event;
  readonly onDidDispose = this.disposed.event;
  constructor(public title: string) {}
  reveal(): void {
    this.revealed++;
  }
}

const created: FakePanel[] = [];
let inputBoxAnswer: string | undefined;
const fakeVscode = {
  EventEmitter: Emitter,
  Uri: {
    joinPath: (...parts: unknown[]) => ({ fsPath: parts.slice(1).join("/") }),
    file: (p: string) => ({ fsPath: p }),
  },
  ViewColumn: { Active: -1, Beside: -2 },
  TabInputWebview,
  window: {
    createWebviewPanel: (_type: string, title: string) => {
      const p = new FakePanel(title);
      created.push(p);
      return p;
    },
    showWarningMessage: () => Promise.resolve(undefined),
    showInformationMessage: () => Promise.resolve(undefined),
    showInputBox: () => Promise.resolve(inputBoxAnswer),
    tabGroups,
  },
  workspace: { workspaceFolders: undefined, getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
};

// Route `require("vscode")` to the fake.
const mod = Module as unknown as { _load: (req: string, ...rest: unknown[]) => unknown };
const origLoad = mod._load;
mod._load = function (req: string, ...rest: unknown[]) {
  return req === "vscode" ? fakeVscode : origLoad.call(this, req, ...rest);
};

// Loaded after the fake is installed, so it can't be a hoisted `import`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ChatViewProvider } = require("./chatViewProvider") as typeof import("./chatViewProvider");

const output = { appendLine: () => undefined };
const context = { extensionUri: { fsPath: "/ext" } };

function makeProvider() {
  created.length = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ChatViewProvider(context as any, output as any);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("each new tab is its own chat, numbered", () => {
  const p = makeProvider();
  p.newTab();
  p.newTab();
  assert.deepEqual(created.map((c) => c.title), ["Kiro Chat", "Kiro Chat 2"]);
  assert.ok(created.every((c) => c.webview.html.includes('id="btn-new-tab"')));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tabs = (p as any).tabs as Map<FakePanel, unknown>;
  assert.equal(tabs.size, 2);
  assert.notEqual(tabs.get(created[0]), tabs.get(created[1]));
});

test("replies go only to the tab that asked", async () => {
  const p = makeProvider();
  p.newTab();
  p.newTab();
  const [t1, t2] = created;
  t1.webview.messages.fire({ type: "resumeSession" });
  await tick();
  assert.ok(t1.webview.sent.some((m) => m.type === "sessionList"));
  assert.equal(t2.webview.sent.length, 0);
});

test("the ＋ button opens another tab", async () => {
  const p = makeProvider();
  p.newTab();
  created[0].webview.messages.fire({ type: "newTab" });
  await tick();
  assert.deepEqual(created.map((c) => c.title), ["Kiro Chat", "Kiro Chat 2"]);
});

test("open reveals the existing tab instead of making a new one", () => {
  const p = makeProvider();
  p.openInEditor();
  p.openInEditor();
  assert.equal(created.length, 1);
  assert.equal(created[0].revealed, 1);
});

test("restored tabs keep their session and the numbering continues", () => {
  const p = makeProvider();
  const restored = new FakePanel("Kiro Chat 5");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  p.adoptEditorPanel(restored as any, { sessionId: "sess_abc" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chat = (p as any).tabs.get(restored);
  assert.equal(chat.resumeSessionId, "sess_abc");
  p.newTab();
  assert.equal(created[0].title, "Kiro Chat 6");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((p as any).tabs.get(created[0]).resumeSessionId, undefined);
});

test("closing a tab disposes its chat", () => {
  const p = makeProvider();
  p.newTab();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chat = (p as any).tabs.get(created[0]);
  created[0].disposed.fire();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((p as any).tabs.size, 0);
  assert.equal(chat.disposed, true);
});

test("the bottom-panel view is a separate chat that survives a rebuild", async () => {
  const p = makeProvider();
  p.newTab();
  const view1 = { webview: new FakeWebview(), visible: true, onDidDispose: new Emitter<void>(), onDidChangeVisibility: new Emitter<void>().event };
  const asView = (v: typeof view1) => ({ ...v, onDidDispose: v.onDidDispose.event });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  p.resolveWebviewView(asView(view1) as any, { state: { sessionId: "sess_panel" } } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const panelChat = (p as any).panelChat;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.notEqual(panelChat, (p as any).tabs.get(created[0]));
  assert.equal(panelChat.resumeSessionId, "sess_panel");

  view1.webview.messages.fire({ type: "resumeSession" });
  await tick();
  assert.ok(view1.webview.sent.some((m) => m.type === "sessionList"));
  assert.equal(created[0].webview.sent.length, 0);

  // Moving the view rebuilds it: same chat, new webview.
  view1.onDidDispose.fire();
  const view2 = { ...view1, webview: new FakeWebview(), onDidDispose: new Emitter<void>() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  p.resolveWebviewView(asView(view2) as any, { state: undefined } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((p as any).panelChat, panelChat);
  assert.equal(panelChat.disposed, false);
});

test("Resume command opens the panel once the new tab's webview is ready", async () => {
  const p = makeProvider();
  p.newTab();
  p.openResumePanel();
  const w = created[0].webview;
  assert.equal(w.sent.some((m) => m.type === "openResume"), false);
  // "ready" would also start the engine; stub that out for this test.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).tabs.get(created[0]).ensureStarted = () => Promise.resolve();
  w.messages.fire({ type: "ready" });
  await tick();
  assert.ok(w.sent.some((m) => m.type === "openResume"));
});

test("the list of chats follows the tabs, and listeners hear about changes", () => {
  const p = makeProvider();
  let changes = 0;
  p.onDidChangeChats(() => changes++);
  assert.deepEqual(p.chats(), []);
  p.newTab();
  p.newTab();
  assert.equal(p.chats().length, 2);
  assert.notEqual(p.chats()[0].id, p.chats()[1].id);
  assert.deepEqual(p.chats().map((c) => c.title), ["Kiro Chat", "Kiro Chat 2"]);
  assert.equal(changes, 2);
  created[0].disposed.fire();
  assert.equal(p.chats().length, 1);
  assert.equal(changes, 3);
});

test("/title renames the tab, its saved state and the remote list; clear gives its name back", async () => {
  const p = makeProvider();
  let changes = 0;
  p.onDidChangeChats(() => changes++);
  p.newTab();
  p.newTab();
  const tab = created[1];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chat = (p as any).tabs.get(tab);
  chat.ensureStarted = () => Promise.resolve();
  tab.webview.messages.fire({ type: "ready" });
  await tick();
  changes = 0;
  tab.webview.messages.fire({ type: "sendPrompt", text: "/title  Build\tfix ", images: [] });
  await tick();
  assert.equal(tab.title, "Build fix");
  assert.equal(chat.title, "Build fix");
  assert.equal(changes, 1);
  assert.deepEqual(tab.webview.sent.filter((m) => m.type === "titleState").at(-1), { type: "titleState", title: "Build fix", defaultTitle: "Kiro Chat 2" });
  assert.ok(tab.webview.sent.some((m) => m.type === "notice" && m.text === "Title set to Build fix."));
  assert.ok(!tab.webview.sent.some((m) => m.type === "userMessage"), "not sent to the agent");
  tab.webview.messages.fire({ type: "sendPrompt", text: "/title", images: [] });
  await tick();
  assert.ok(tab.webview.sent.some((m) => m.type === "notice" && String(m.text).startsWith("Title: Build fix")));
  tab.webview.messages.fire({ type: "sendPrompt", text: "/title clear", images: [] });
  await tick();
  assert.equal(tab.title, "Kiro Chat 2");
  assert.equal(chat.title, "Kiro Chat 2");
  assert.equal(created[0].title, "Kiro Chat", "the other tab is untouched");
});

test("a renamed tab comes back renamed after a reload, and a reset still knows its own name", async () => {
  const p = makeProvider();
  const restored = new FakePanel("Build");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  p.adoptEditorPanel(restored as any, { sessionId: "s", title: "Build", defaultTitle: "Kiro Chat 3" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chat = (p as any).tabs.get(restored);
  assert.equal(chat.title, "Build");
  p.newTab();
  assert.equal(created[0].title, "Kiro Chat 4");
  chat.rename(undefined);
  assert.equal(restored.title, "Kiro Chat 3");
});

test("Rename Chat renames the current chat; an empty name resets it, Esc keeps it", async () => {
  const p = makeProvider();
  p.newTab();
  inputBoxAnswer = "Docs";
  await p.renameChat();
  assert.equal(created[0].title, "Docs");
  inputBoxAnswer = undefined;
  await p.renameChat();
  assert.equal(created[0].title, "Docs");
  inputBoxAnswer = "";
  await p.renameChat();
  assert.equal(created[0].title, "Kiro Chat");
});

test("the panel view's name follows a rename", async () => {
  const p = makeProvider();
  const view = { webview: new FakeWebview(), visible: true, title: undefined as string | undefined, onDidDispose: new Emitter<void>().event, onDidChangeVisibility: new Emitter<void>().event };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  p.resolveWebviewView(view as any, { state: { title: "Notes" } } as any);
  assert.equal(view.title, "Notes");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (p as any).panelChat.rename(undefined);
  assert.equal(view.title, undefined);
});

test("a chat name is one short line", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { cleanTitle } = require("./chatSession") as typeof import("./chatSession");
  assert.equal(cleanTitle("  a\n\u0007b  "), "a b");
  assert.equal(cleanTitle("   "), undefined);
  assert.equal(cleanTitle(3), undefined);
  assert.equal(cleanTitle("x".repeat(100))?.length, 80);
});

test("Rename Chat from a tab's context menu renames the tab clicked, not the current one", async () => {
  const p = makeProvider();
  p.newTab();
  p.newTab();
  const [t1, t2] = created;
  t2.viewColumn = 2;
  const chatTab = (label: string) => ({ label, input: new TabInputWebview("mainThreadWebview-kiroCliChat.editor") });
  tabGroups.all = [
    { viewColumn: 1, tabs: [{ label: "notes.md", input: {} }, chatTab("Kiro Chat")] },
    { viewColumn: 2, tabs: [chatTab("Kiro Chat 2")] },
  ];
  inputBoxAnswer = "First";
  await p.renameChat(1); // the current chat is tab 2; the click was on tab 1
  assert.equal(t1.title, "First");
  assert.equal(t2.title, "Kiro Chat 2");
  inputBoxAnswer = "Second";
  await p.renameChat(0); // index 0: a file in group 1, the chat in group 2
  assert.equal(t2.title, "Second");
  tabGroups.all = [{ viewColumn: 1, tabs: [{ label: "Preview", input: new TabInputWebview("markdown.preview") }] }];
  await p.renameChat(0);
  assert.equal(t1.title, "First", "another extension's webview is left alone");
  tabGroups.all = [];
});

test("a restored name without its saved own name doesn't become the name a reset goes back to", () => {
  const p = makeProvider();
  const restored = new FakePanel("Build");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  p.adoptEditorPanel(restored as any, { sessionId: "s", title: "Build" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chat = (p as any).tabs.get(restored);
  assert.equal(chat.title, "Build");
  chat.rename(undefined);
  assert.equal(restored.title, "Kiro Chat");
});

test("the session gets the name once the engine runs, a failure says so, and a slow engine doesn't hold up the notice", async () => {
  const p = makeProvider();
  p.newTab();
  const tab = created[0];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chat = (p as any).tabs.get(tab);
  chat.ensureStarted = () => Promise.resolve();
  tab.webview.messages.fire({ type: "ready" });
  await tick();
  chat.rename("Early"); // no engine yet: nothing to send
  const sent: unknown[] = [];
  let fail = false;
  const client = {
    extMethod: (m: string, params: unknown) => {
      sent.push([m, params]);
      return fail ? Promise.reject(new Error("boom")) : new Promise(() => undefined); // never answers
    },
  };
  chat.transport = { mode: "persistent", client };
  chat.engineTitle = undefined;
  chat.sendTitle(); // what start does once the engine is up
  assert.deepEqual(sent, [["_kiro/session/rename", { title: "Early" }]]);
  chat.sendTitle();
  assert.equal(sent.length, 1, "sent once");
  tab.webview.messages.fire({ type: "sendPrompt", text: "/title Later", images: [] });
  await tick();
  assert.ok(tab.webview.sent.some((m) => m.type === "notice" && m.text === "Title set to Later."), "not held up by the engine");
  fail = true;
  chat.rename("Broken");
  await tick();
  assert.ok(tab.webview.sent.some((m) => m.type === "notice" && m.isError && String(m.text).includes("could not be changed: boom")));
  chat.transport = undefined;
});

/** A chat tab with a fake persistent engine, ready for commands. */
async function commandTab() {
  const p = makeProvider();
  p.newTab();
  const tab = created[0];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chat = (p as any).tabs.get(tab);
  chat.ensureStarted = () => Promise.resolve();
  const calls: unknown[][] = [];
  const prompts: string[] = [];
  chat.transport = {
    mode: "persistent",
    client: {
      turnRunning: false,
      extMethod: async (m: string, params: unknown) => {
        calls.push([m, params]);
        return m === "_kiro/account/getUsage" ? { success: true, data: { planName: "Pro", usageBreakdowns: [] } } : { success: true, message: "Cleared." };
      },
      prompt: async (text: string) => void prompts.push(text),
      setAutoApprove: () => undefined,
      setConfigOption: async () => undefined,
    },
  };
  tab.webview.messages.fire({ type: "ready" });
  await tick();
  const say = async (text: string) => {
    tab.webview.messages.fire({ type: "sendPrompt", text, images: [] });
    await tick();
    await tick();
  };
  const output = () =>
    tab.webview.sent
      .filter((m) => m.type === "commandOutput")
      .map((m) => (m.segments as Array<{ text: string }>).map((s) => s.text).join(""))
      .join("\n");
  return { p, tab, chat, calls, prompts, say, output };
}

test("slash commands in a tab run the terminal chat's code, not a prompt", async () => {
  const t = await commandTab();
  await t.say("/usage");
  assert.deepEqual(t.calls.map((c) => c[0]), ["_kiro/account/getUsage"]);
  assert.deepEqual(t.tab.webview.sent.find((m) => m.type === "commandStart"), { type: "commandStart", run: 1, text: "/usage" });
  assert.match(t.output(), /Pro/);
  await t.say("/tools");
  assert.match(t.output(), /Tools.*Supervised/);
  await t.say("/nope");
  assert.match(t.output(), /Unknown command \/nope/);
  await t.say("/paste");
  assert.match(t.output(), /Cmd\+V/);
  await t.say("/help");
  assert.match(t.output(), /\/context/);
  assert.deepEqual(t.prompts, []);
  assert.ok(!t.tab.webview.sent.some((m) => m.type === "userMessage"), "nothing went to the agent");
  await t.say(" /usage as text");
  assert.deepEqual(t.prompts, [" /usage as text"]);
  t.chat.transport = undefined;
});

test("the agent's own commands go to the agent; a remote device runs commands too, except the ones for the Mac", async () => {
  const t = await commandTab();
  t.chat.conv.engineCommands = [{ name: "context-gatherer" }];
  await t.say("/context-gatherer look");
  assert.deepEqual(t.prompts, ["/context-gatherer look"]);
  // A remote device's command runs, and its output reaches every screen, naming the device.
  const seen: Array<Record<string, unknown>> = [];
  const stop = t.chat.subscribe((m: Record<string, unknown>) => seen.push(m));
  await t.chat.send({ type: "sendPrompt", text: "/usage", images: [] }, { id: "d", name: "iPhone" });
  assert.deepEqual(t.calls.map((c) => c[0]), ["_kiro/account/getUsage"]);
  assert.deepEqual(t.prompts, ["/context-gatherer look"]);
  assert.equal(seen.find((m) => m.type === "commandStart")?.text, "/usage  (from iPhone)");
  assert.ok(seen.some((m) => m.type === "commandOutput"));
  assert.ok(t.tab.webview.sent.some((m) => m.type === "commandOutput"), "the Mac's tab shows it too");
  // The Mac's own screen: /copy and /remote say why not.
  await t.chat.send({ type: "sendPrompt", text: "/copy", images: [] }, { id: "d", name: "iPhone" });
  await t.chat.send({ type: "sendPrompt", text: "/remote stop", images: [] }, { id: "d", name: "iPhone" });
  const text = seen.filter((m) => m.type === "commandOutput").map((m) => (m.segments as Array<{ text: string }>).map((s) => s.text).join("")).join("\n");
  assert.match(text, /clipboard/);
  assert.match(text, /cut this device off/);
  stop();
  t.chat.transport = undefined;
});

test("a command's Yes/No question waits for the tab's answer", async () => {
  const t = await commandTab();
  t.tab.webview.messages.fire({ type: "sendPrompt", text: "/knowledge clear", images: [] });
  await tick();
  const ask = t.tab.webview.sent.find((m) => m.type === "confirm");
  assert.equal(ask?.question, "Remove every entry from the knowledge base?");
  t.tab.webview.messages.fire({ type: "confirmAnswer", id: ask?.id, yes: true });
  await tick();
  await tick();
  assert.deepEqual(t.calls.map((c) => c[0]), ["_kiro/knowledge"]);
  t.chat.transport = undefined;
});

test("a remote device's restart is asked on its page, not in a dialog on the Mac; its approval may carry a rule", async () => {
  const t = await commandTab();
  const seen: Array<Record<string, unknown>> = [];
  t.chat.subscribe((m: Record<string, unknown>) => seen.push(m));
  let restarted = 0;
  t.chat.restart = async () => void restarted++;
  const done = t.chat.send({ type: "restart" }, { id: "d", name: "iPhone" });
  await tick();
  const ask = seen.find((m) => m.type === "confirm");
  assert.match(String(ask?.question), /Restart the Kiro engine/);
  assert.equal(restarted, 0, "waits for the answer");
  await t.chat.send({ type: "confirmAnswer", id: ask?.id, yes: true }, { id: "d", name: "iPhone" });
  await done;
  assert.equal(restarted, 1);
  assert.ok(seen.some((m) => m.type === "confirmDone" && m.id === ask?.id), "the other screens drop the question");
  assert.ok(seen.some((m) => m.type === "restarting"));

  // An approval with a rule is passed to the engine as it is, from a remote device too.
  const answers: unknown[][] = [];
  t.chat.transport = { mode: "persistent", client: { respondToApproval: (...a: unknown[]) => (answers.push(a), "allow_always") } };
  t.chat.pendingApprovals.set("tc1", "req1");
  await t.chat.send({ type: "approve", toolCallId: "tc1", optionId: "allow_always", rule: "tool" }, { id: "d", name: "iPhone" });
  assert.deepEqual(answers, [["req1", { optionId: "allow_always", rule: "tool" }]]);
  assert.ok(seen.some((m) => (m.event as { label?: string } | undefined)?.label === "Allowed from iPhone"));
  t.chat.transport = undefined;
});
