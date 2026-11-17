// Extension entry point.

import * as vscode from "vscode";
import { ChatViewProvider } from "./chatViewProvider";
import { trackActiveEditor } from "./config";
import { RemoteController } from "./remote/remoteController";
import { TerminalChat } from "./terminal/terminalChat";
import { TerminalChats } from "./terminal/terminalRemote";

export function activate(context: vscode.ExtensionContext): void {
  // `log: true` also persists the channel to the extension's log folder, which
  // makes field diagnostics (e.g. drag-and-drop) readable after the fact.
  const output = vscode.window.createOutputChannel("Kiro Chat", { log: true });
  context.subscriptions.push(output);
  trackActiveEditor(context);

  const provider = new ChatViewProvider(context, output);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );
  context.subscriptions.push({ dispose: () => provider.dispose() });

  // Bring an open chat editor tab back after a window reload.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(ChatViewProvider.editorViewType, {
      deserializeWebviewPanel: async (panel: vscode.WebviewPanel, state: unknown) => {
        provider.adoptEditorPanel(panel, state as { sessionId?: string } | undefined);
      },
    })
  );

  const terminals = registerTerminalChat(context, output);

  const remote = new RemoteController(context, output, provider, terminals);
  context.subscriptions.push(
    remote,
    provider.setRemoteAccess(remote, remote.onDidChange),
    vscode.commands.registerCommand("kiroChat.startRemoteAccess", () => remote.start(true)),
    vscode.commands.registerCommand("kiroChat.stopRemoteAccess", () => remote.stop()),
    vscode.commands.registerCommand("kiroChat.showRemoteLink", () => remote.showLink()),
    vscode.commands.registerCommand("kiroChat.removeRemoteDevice", () => remote.removeDevice()),
    vscode.commands.registerCommand("kiroChat.remoteMenu", () => remote.menu())
  );
  void remote.startIfWanted();

  const openInPanel = async () => {
    await vscode.commands.executeCommand("kiroChat.chatView.focus");
  };
  // Open wherever the user prefers (kiroChat.openIn).
  const reveal = async () => {
    const where = vscode.workspace.getConfiguration("kiroChat").get<string>("openIn", "editor");
    if (where === "panel") {
      await openInPanel();
    } else {
      provider.openInEditor();
    }
  };

  // Always-visible entry point (the view itself can live in the panel or a
  // side bar, and may be closed, so this guarantees a way to reopen it).
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.text = "$(comment-discussion) Kiro Chat";
  statusItem.tooltip = `Open Kiro Chat (${process.platform === "darwin" ? "⌘⌥K" : "Ctrl+Alt+K"})`;
  statusItem.command = "kiroChat.open";
  statusItem.show();
  context.subscriptions.push(statusItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("kiroChat.open", reveal),
    vscode.commands.registerCommand("kiroChat.openInEditor", () => provider.openInEditor()),
    vscode.commands.registerCommand("kiroChat.newChatTab", () => provider.newTab()),
    vscode.commands.registerCommand("kiroChat.openInPanel", openInPanel),
    vscode.commands.registerCommand("kiroChat.newSession", async () => {
      await reveal();
      await provider.confirmNewSession();
    }),
    vscode.commands.registerCommand("kiroChat.resumeSession", async () => {
      await reveal();
      provider.openResumePanel();
    }),
    vscode.commands.registerCommand("kiroChat.restart", async () => {
      await provider.confirmRestart();
    }),
    // From a tab's context menu VS Code passes the tab's place: (resource, { groupId, editorIndex }).
    vscode.commands.registerCommand("kiroChat.renameChat", (_resource?: unknown, tab?: { editorIndex?: unknown }) =>
      provider.renameChat(typeof tab?.editorIndex === "number" ? tab.editorIndex : undefined)
    ),
    vscode.commands.registerCommand("kiroChat.login", async () => {
      await reveal();
      await provider.login();
    }),
    vscode.commands.registerCommand("kiroChat.attach", async () => {
      await reveal();
      await provider.pickAttachment();
    })
  );
}

export function deactivate(): void {
  // Subscriptions dispose automatically.
}

/**
 * Text-mode chats in the Terminal panel: a "Kiro Chat" terminal profile (shows
 * in the terminal "+" dropdown) and a command. Each terminal is independent.
 */
function registerTerminalChat(context: vscode.ExtensionContext, output: vscode.OutputChannel): TerminalChats {
  const terminals = new TerminalChats();
  let count = 0;
  const makeOptions = (initialPrompt?: string): vscode.ExtensionTerminalOptions => {
    count++;
    const name = count === 1 ? "Kiro Chat" : `Kiro Chat ${count}`;
    return {
      name,
      pty: new TerminalChat(output, name, { initialPrompt, spawn: openChat, remote: terminals }),
      iconPath: new vscode.ThemeIcon("comment-discussion"),
    };
  };
  // A new chat terminal in the panel (optionally starting with a task, for /spawn).
  function openChat(initialPrompt?: string): void {
    const terminal = vscode.window.createTerminal({
      ...makeOptions(initialPrompt),
      location: vscode.TerminalLocation.Panel,
    });
    terminal.show();
  }

  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider("kiroChat.terminal", {
      provideTerminalProfile: () => new vscode.TerminalProfile(makeOptions()),
    }),
    vscode.commands.registerCommand("kiroChat.newTerminalChat", () => openChat())
  );

  // Context key so Shift+Enter (→ newline) only applies to our terminals.
  const isChat = (t: vscode.Terminal | undefined): boolean =>
    !!t && (t.creationOptions as vscode.ExtensionTerminalOptions).pty instanceof TerminalChat;
  const update = (t: vscode.Terminal | undefined): void => {
    void vscode.commands.executeCommand("setContext", "kiroChat.terminalChatFocused", isChat(t));
  };
  update(vscode.window.activeTerminal);
  context.subscriptions.push(vscode.window.onDidChangeActiveTerminal(update));
  return terminals;
}
