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

class FakePanel {
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
  window: {
    createWebviewPanel: (_type: string, title: string) => {
      const p = new FakePanel(title);
      created.push(p);
      return p;
    },
    showWarningMessage: () => Promise.resolve(undefined),
    showInformationMessage: () => Promise.resolve(undefined),
    showInputBox: () => Promise.resolve(inputBoxAnswer),
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
  assert.ok(tab.webview.sent.some((m) => m.type === "notice" && m.text === "Title set to Build fix (tab and session)."));
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
  await chat.rename(undefined);
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
  await (p as any).panelChat.rename(undefined);
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
