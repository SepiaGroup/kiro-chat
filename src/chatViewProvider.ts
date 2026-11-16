// Manages the chat UIs: any number of editor-tab chats plus the bottom-panel
// view, each its own conversation (ChatSession) with its own engine.

import * as vscode from "vscode";
import { ChatSession, ChatSessionHooks, RemoteAccessControl } from "./chatSession";

/** Webview state saved per chat so a reload can reopen its session. */
interface ChatState {
  sessionId?: string;
  /** A name given with /title or Rename Chat, and the name it had before (a reset goes back to it). */
  title?: string;
  defaultTitle?: string;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "kiroCliChat.chatView";
  public static readonly editorViewType = "kiroCliChat.editor";

  private panelChat?: ChatSession;
  private panelView?: vscode.WebviewView;
  private readonly tabs = new Map<vscode.WebviewPanel, ChatSession>();
  private active?: ChatSession;
  private lastTab?: vscode.WebviewPanel;
  private tabCount = 0;
  private readonly changed = new vscode.EventEmitter<void>();
  /** The set of chats, or whether one is busy, changed (remote access lists them). */
  readonly onDidChangeChats = this.changed.event;
  private readonly hooks: ChatSessionHooks = {
    onActive: (chat) => {
      this.active = chat;
    },
    newTab: () => this.newTab(),
    changed: () => this.changed.fire(),
    remoteAccess: () => this.remoteControl,
    renamed: (chat, title) => {
      for (const [panel, c] of this.tabs) {
        if (c === chat) {
          panel.title = title ?? chat.defaultTitle;
        }
      }
      if (chat === this.panelChat && this.panelView) {
        this.panelView.title = title; // undefined: the view's own name
      }
    },
  };
  private remoteControl?: RemoteAccessControl;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {}

  /** The bottom-panel chat: its own conversation, kept alive if the view is rebuilt. */
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    resolveContext: vscode.WebviewViewResolveContext<ChatState>
  ): void {
    if (!this.panelChat) {
      this.panelChat = new ChatSession(
        this.context,
        this.output,
        "panel",
        this.hooks,
        sessionIdOf(resolveContext.state),
        titleOf(resolveContext.state)
      );
    }
    const chat = this.panelChat;
    this.panelView = webviewView;
    if (chat.title !== chat.defaultTitle) {
      webviewView.title = chat.title;
    }
    chat.attach(webviewView.webview);
    this.changed.fire();
    webviewView.onDidDispose(() => {
      chat.detach(webviewView.webview);
      if (this.panelView === webviewView) {
        this.panelView = undefined;
      }
    });
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.active = chat;
      }
    });
    // Startup is triggered by the webview's "ready" message, once its message
    // listener is attached (avoids dropping early status events).
  }

  /** Reveal the most recent chat tab, or open one if there are none. */
  openInEditor(): void {
    const tab = this.lastTab ?? [...this.tabs.keys()].pop();
    if (tab) {
      tab.reveal(undefined, false);
      return;
    }
    this.newTab();
  }

  /** Open another chat tab with a new conversation. */
  newTab(): void {
    const n = ++this.tabCount;
    const panel = vscode.window.createWebviewPanel(
      ChatViewProvider.editorViewType,
      n === 1 ? "Kiro Chat" : `Kiro Chat ${n}`,
      { viewColumn: this.tabs.size > 0 ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
      }
    );
    this.adoptEditorPanel(panel);
  }

  /** Wire up a chat tab (new, or restored by VS Code after a reload). */
  adoptEditorPanel(panel: vscode.WebviewPanel, state?: ChatState): void {
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "media", "icon.svg");
    // A renamed tab comes back with its new name; its own name is in the
    // state. Without it (a damaged state) the tab's title is the custom name,
    // which must not become the name a reset goes back to.
    const custom = titleOf(state);
    const saved = typeof state?.defaultTitle === "string" ? state.defaultTitle.trim() : "";
    const own = !custom ? panel.title : saved || "Kiro Chat";
    // Keep numbering going after restored tabs ("Kiro Chat 3" -> next is 4).
    const num = /^Kiro Chat(?: (\d+))?$/.exec(own);
    if (num) {
      this.tabCount = Math.max(this.tabCount, Number(num[1] ?? 1));
    }
    const chat = new ChatSession(
      this.context,
      this.output,
      own,
      this.hooks,
      sessionIdOf(state),
      custom
    );
    this.tabs.set(panel, chat);
    this.changed.fire();
    this.active = chat;
    this.lastTab = panel;
    chat.attach(panel.webview);
    panel.onDidChangeViewState(() => {
      if (panel.active) {
        this.active = chat;
        this.lastTab = panel;
      }
    });
    panel.onDidDispose(() => {
      chat.dispose();
      this.tabs.delete(panel);
      this.changed.fire();
      if (this.active === chat) {
        this.active = undefined;
      }
      if (this.lastTab === panel) {
        this.lastTab = undefined;
      }
    });
  }

  /** The chat that commands (Restart, Attach, …) act on. */
  private target(): ChatSession | undefined {
    return this.active ?? (this.lastTab && this.tabs.get(this.lastTab)) ?? this.panelChat;
  }

  async confirmRestart(): Promise<void> {
    await this.target()?.confirmRestart();
  }

  async restart(): Promise<void> {
    await this.target()?.restart();
  }

  async pickAttachment(): Promise<void> {
    await this.target()?.pickAttachment();
  }

  async confirmNewSession(): Promise<void> {
    await this.target()?.confirmNewSession();
  }

  openResumePanel(): void {
    this.target()?.openResumePanel();
  }

  async login(): Promise<void> {
    await this.target()?.login();
  }

  /**
   * Rename a chat (Rename Chat command). An empty name gives it its own name
   * back. `editorIndex`: it came from a tab's context menu, so rename that tab.
   */
  async renameChat(editorIndex?: number): Promise<void> {
    let chat: ChatSession | undefined;
    if (editorIndex === undefined) {
      chat = this.target();
    } else {
      const clicked = this.clickedChat(editorIndex);
      if (clicked === null) {
        void vscode.window.showInformationMessage("Rename Chat renames Kiro chat tabs. Use it on a Kiro Chat tab.");
        return;
      }
      chat = clicked ?? this.target();
    }
    if (!chat) {
      void vscode.window.showInformationMessage("Open a chat first.");
      return;
    }
    const name = await vscode.window.showInputBox({
      title: "Rename Chat",
      prompt: `New name for "${chat.title}". Leave it empty for "${chat.defaultTitle}".`,
      value: chat.title,
      valueSelection: [0, chat.title.length],
    });
    if (name !== undefined) {
      chat.rename(name);
    }
  }

  /** Remote access, for the Settings panel's switch. `changes` fires when it starts or stops. */
  setRemoteAccess(control: RemoteAccessControl, changes: vscode.Event<void>): vscode.Disposable {
    this.remoteControl = control;
    return changes(() => this.chats().forEach((c) => c.pushRemoteState()));
  }

  /**
   * The chat of the tab right-clicked: VS Code gives its index in its group
   * but not the group in a form the API has, so look at that index in every
   * group. null: no Kiro chat there; undefined: can't tell (several match).
   */
  private clickedChat(editorIndex: number): ChatSession | null | undefined {
    const hits: Array<{ tab: vscode.Tab; column: vscode.ViewColumn }> = [];
    for (const group of vscode.window.tabGroups.all) {
      const tab = group.tabs[editorIndex];
      if (tab?.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(ChatViewProvider.editorViewType)) {
        hits.push({ tab, column: group.viewColumn });
      }
    }
    if (hits.length === 0) {
      return null;
    }
    if (hits.length > 1) {
      return undefined;
    }
    const { tab, column } = hits[0];
    const panels = [...this.tabs.keys()].filter((p) => p.title === tab.label && p.viewColumn === column);
    return panels.length === 1 ? this.tabs.get(panels[0]) : undefined;
  }

  /** Every open chat: the panel view's and each tab's. */
  chats(): ChatSession[] {
    return [...(this.panelChat ? [this.panelChat] : []), ...this.tabs.values()];
  }

  dispose(): void {
    this.changed.dispose();
    this.panelChat?.dispose();
    for (const chat of this.tabs.values()) {
      chat.dispose();
    }
    this.tabs.clear();
  }
}

function titleOf(state: unknown): string | undefined {
  const t = (state as ChatState | undefined)?.title;
  return typeof t === "string" && t ? t : undefined;
}

function sessionIdOf(state: unknown): string | undefined {
  const id = (state as ChatState | undefined)?.sessionId;
  return typeof id === "string" && id ? id : undefined;
}
