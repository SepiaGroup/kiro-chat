// Remote access inside VS Code: starts and stops the local server, shows the
// pairing link, lists and removes paired devices, and keeps the status bar
// item. The server and its rules are in the pure modules next to this file.
//
// Several VS Code windows can have remote access on at once. Each runs its own
// loopback server and lists itself in a shared folder (windowRegistry.ts). One
// of them, the hub, owns the tailnet address, the pairing and the devices, and
// shows every window's chats to the phone; the others answer the hub's calls.
// If the hub window closes, another one takes over within a few seconds.

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { TerminalChats } from "../terminal/terminalRemote";
import { ChatViewProvider } from "../chatViewProvider";
import { assetType } from "./assets";
import { DeviceRecord, DeviceStore, PairingCode } from "./remoteAuth";
import { callPeer, MemberConnection } from "./memberLink";
import { WindowRegistry } from "./windowRegistry";
import { parsePermissions } from "./remotePolicy";
import { HubApi, RemoteAsset, RemoteServer } from "./remoteServer";
import { cardAction, pairingCardHtml } from "./pairingCard";
import { encodeQr, qrSvg } from "./qr";
import { DEFAULT_HTTPS_PORT, HTTPS_PORTS, nodeRun, TailscaleServe } from "./tailscale";
import * as net from "net";
import { errorMessage } from "../format";

const DEVICES_KEY = "kiroCliChat.remoteDevices";
const PORT_KEY = "kiroCliChat.remotePort";
/** How long a pairing link works (see PairingCode). */
const PAIRING_MINUTES = 10;
/** How often a window looks for the hub and for other windows. */
const TICK_MS = 2500;

/** This window's part: the hub owns the tailnet address, the others pass their chats to it. */
type Role = "off" | "hub" | "member";

/** A pairing link as the card shows it. */
interface LinkInfo {
  link: string;
  /** The link works from the tailnet (so a QR code makes sense). */
  shared: boolean;
  problem?: { advice: string; enableUrl?: string };
}

/** Whether something listens on a local port. */
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export class RemoteController implements vscode.Disposable {
  private server?: RemoteServer;
  private port = 0;
  private pairing = new PairingCode();
  private devices = new DeviceStore();
  private readonly status: vscode.StatusBarItem;
  private chatSub?: vscode.Disposable;
  private starting?: Promise<void>;
  private readonly tailscale: TailscaleServe;
  private role: Role = "off";
  private registry?: WindowRegistry;
  private token = "";
  private windowId = "";
  private timer?: NodeJS.Timeout;
  private ticking = false;
  /** On the hub: the other windows. */
  private readonly members = new Map<string, MemberConnection>();
  /** The tailnet address devices open, once Tailscale shares the port. */
  private publicUrl?: string;
  /** Why Tailscale could not share it (shown with the link), and where to fix that. */
  private problem?: { advice: string; enableUrl?: string };
  /** The pairing card (one at a time) and the link it shows. */
  private card?: vscode.WebviewPanel;
  private cardLink = "";
  private cardProblem?: { advice: string; enableUrl?: string };
  private readonly stateChanged = new vscode.EventEmitter<void>();
  /** Fires when remote access starts or stops. */
  readonly onDidChange = this.stateChanged.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly provider: ChatViewProvider,
    /** The terminal chats, listed after the chat tabs. */
    private readonly terminals: TerminalChats
  ) {
    this.tailscale = new TailscaleServe(nodeRun, (line) => this.log(line), listening);
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.status.command = "kiroCliChat.remoteMenu";
  }

  get running(): boolean {
    return this.server !== undefined;
  }

  private log(line: string): void {
    this.output.appendLine(`[remote] ${line}`);
  }

  private settings(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("kiroCliChat.remote");
  }

  /** The address devices open: the tailnet name when Tailscale shares the port, else this Mac only. */
  private baseUrl(): string {
    return this.publicUrl ?? `http://127.0.0.1:${this.port}`;
  }

  /** Put the local port on the tailnet. Sets `publicUrl`, or `problem` with what to do. */
  private async shareOnTailnet(): Promise<void> {
    const wanted = this.settings().get<number>("httpsPort", DEFAULT_HTTPS_PORT);
    const httpsPort = HTTPS_PORTS.includes(wanted) ? wanted : DEFAULT_HTTPS_PORT;
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Kiro CLI Chat: sharing remote access on your tailnet…" },
      () => this.tailscale.expose(this.port, httpsPort)
    );
    if (result.ok) {
      this.publicUrl = result.url;
      this.problem = undefined;
      this.log(`shared on the tailnet as ${new URL(result.url).host}`);
    } else {
      this.publicUrl = undefined;
      this.problem = { advice: result.advice, enableUrl: result.enableUrl };
      this.log(`tailscale: ${result.advice}`);
    }
    this.updateStatus();
  }

  /** Start unless it already runs. `showLink` also offers the pairing link. */
  /** True when remote access is on afterwards (and, with `showLink`, the card is open). */
  async start(showLink = true): Promise<boolean> {
    if (this.server) {
      if (this.role === "hub" && !this.publicUrl) {
        await this.shareOnTailnet(); // the user may have fixed what was wrong
      }
      return showLink ? this.showLink() : true;
    }
    this.starting ??= this.startServer().finally(() => {
      this.starting = undefined;
    });
    await this.starting;
    if (!this.server) {
      return false; // it said why
    }
    return showLink ? this.showLink() : true;
  }

  private async startServer(): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(
        "Remote access is off in an untrusted workspace. Trust the workspace first, then run \"Kiro CLI Chat: Start Remote Access\"."
      );
      return;
    }
    const registry = new WindowRegistry(path.join(this.context.globalStorageUri.fsPath, "remote"));
    try {
      this.token = registry.token();
    } catch (err) {
      this.log(`could not start: ${errorMessage(err)}`);
      void vscode.window.showErrorMessage(`Could not start remote access: ${errorMessage(err)}`);
      return;
    }
    this.devices = new DeviceStore(await this.loadDevices());
    this.devices.onChange = () => void this.saveDevices();
    this.pairing = new PairingCode();
    const server = new RemoteServer({
      chats: () => [...this.provider.chats(), ...this.terminals.chats()],
      windowName: this.windowName(),
      members: () => [...this.members.values()].flatMap((m) => m.chats()),
      internal: { token: this.token },
      publicApi: () => this.role === "hub",
      hubApi: this.hubApi(),
      devices: this.devices,
      pairing: this.pairing,
      permissions: () => parsePermissions(this.settings().get("permissions")),
      assets: (name) => this.readAsset(name),
      onPaired: (d) => {
        this.card?.dispose(); // its one-use link is used up
        void vscode.window.showInformationMessage(`Remote access: ${d.name} is paired.`);
      },
      onClients: () => this.updateStatus(),
      // Only this Mac and the tailnet name may be the Host: no other name reaches the page.
      allowedHosts: () => (this.publicUrl ? [new URL(this.publicUrl).hostname] : []),
      log: (line) => this.log(line),
    });
    try {
      // The same port as last time when it is free, so a bookmark or an open page
      // still finds the server after a restart.
      const wanted = this.settings().get<number>("port", 0) || this.context.globalState.get<number>(PORT_KEY, 0);
      try {
        this.port = await server.start(wanted);
      } catch (err) {
        if (!wanted || (err as NodeJS.ErrnoException).code !== "EADDRINUSE") {
          throw err;
        }
        this.log(`port ${wanted} is busy; picking another`);
        this.port = await server.start(0);
      }
    } catch (err) {
      this.log(`could not start: ${errorMessage(err)}`);
      void vscode.window.showErrorMessage(`Could not start remote access: ${errorMessage(err)}`);
      return;
    }
    this.server = server;
    this.registry = registry;
    this.windowId = WindowRegistry.newId();
    const tabs = this.provider.onDidChangeChats(() => server.chatsChanged());
    const terms = this.terminals.onDidChangeChats(() => server.chatsChanged());
    this.chatSub = vscode.Disposable.from(tabs, terms);
    this.log(`window ${this.windowId} (${this.windowName()}) listening on 127.0.0.1:${this.port}`);
    this.publishSelf();
    this.role = "member"; // until it holds the hub lock
    await this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    this.updateStatus();
    this.stateChanged.fire();
  }

  private windowName(): string {
    return (vscode.workspace.name ?? "VS Code").slice(0, 80);
  }

  private publishSelf(): void {
    try {
      this.registry?.publish({ id: this.windowId, name: this.windowName(), port: this.port, pid: process.pid });
    } catch (err) {
      this.log(`could not list this window: ${errorMessage(err)}`);
    }
  }

  /** Look for the hub (and take over if there is none), and keep the other windows connected. */
  private async tick(): Promise<void> {
    const registry = this.registry;
    if (!this.server || !registry || this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      this.terminals.checkTitles(); // a terminal renamed from its tab: no event says so
      this.publishSelf(); // also puts the file back if it was removed
      const hub = registry.hub();
      if (this.role === "hub" && hub?.id !== this.windowId && !registry.claimHub(this.windowId)) {
        await this.stepDown();
      } else if (this.role !== "hub" && !hub && registry.claimHub(this.windowId)) {
        await this.becomeHub();
      }
      if (this.role === "hub") {
        this.syncMembers(registry.windows());
      }
    } catch (err) {
      this.log(`window check failed: ${errorMessage(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  private async becomeHub(): Promise<void> {
    this.role = "hub";
    this.devices.reset(await this.loadDevices()); // another window may have been the hub meanwhile
    this.pairing.revoke();
    void this.context.globalState.update(PORT_KEY, this.port);
    this.log("this window now shares remote access");
    await this.shareOnTailnet();
    this.stateChanged.fire();
  }

  /** This window no longer holds the hub lock: give the address up. */
  private async stepDown(): Promise<void> {
    this.role = "member";
    this.syncMembers([]);
    this.card?.dispose();
    await this.tailscale.remove();
    this.publicUrl = undefined;
    this.problem = undefined;
    this.log("another window shares remote access now");
    this.updateStatus();
    this.stateChanged.fire();
  }

  /** On the hub: follow every other window that is listed, and let go of the ones that left. */
  private syncMembers(windows: ReadonlyArray<{ id: string; name: string; port: number }>): void {
    const keep = new Set<string>();
    for (const w of windows) {
      if (w.id === this.windowId) {
        continue;
      }
      keep.add(w.id);
      const have = this.members.get(w.id);
      if (have && have.peer.port === w.port) {
        continue;
      }
      have?.stop();
      const conn = new MemberConnection(w, this.token, () => this.server?.chatsChanged(), (line) => this.log(line));
      this.members.set(w.id, conn);
      conn.start();
      this.log(`following window ${w.name} (${w.id})`);
    }
    for (const [id, conn] of [...this.members]) {
      if (!keep.has(id)) {
        conn.stop();
        this.members.delete(id);
        this.log(`window ${id} left`);
      }
    }
  }

  /** What the hub offers the other windows. */
  private hubApi(): HubApi {
    return {
      pairLink: async (retry) => {
        if (retry) {
          await this.shareOnTailnet();
        }
        const link = `${this.baseUrl()}/#k=${this.pairing.issue()}`;
        return { link, shared: this.publicUrl !== undefined, problem: this.publicUrl ? undefined : this.problem };
      },
      devices: () => this.devices.list().map((d) => ({ id: d.id, name: d.name, lastSeen: d.lastSeen })),
      removeDevices: (ids) => {
        const all = this.devices.list();
        for (const d of ids === "all" ? all : all.filter((x) => ids.includes(x.id))) {
          this.devices.remove(d.id);
          this.server?.disconnectDevice(d.id);
        }
      },
    };
  }

  /** Ask the hub window for something, waiting a moment for an election in progress. */
  private async askHub<T>(method: string, path: string, json?: unknown): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const hub = this.registry?.hub();
      const port = hub ? this.registry?.windows().find((w) => w.id === hub.id)?.port : undefined;
      if (port) {
        return (await callPeer({ port }, this.token, method, path, json)) as T;
      }
      await this.tick(); // there may be no hub right now: this window may have to become it
      if (this.role === "hub") {
        break;
      }
    }
    throw new Error("No window is sharing remote access right now. Try again in a few seconds.");
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    const wasHub = this.role === "hub";
    this.server = undefined;
    this.role = "off";
    clearInterval(this.timer);
    this.timer = undefined;
    this.chatSub?.dispose();
    this.chatSub = undefined;
    this.syncMembers([]);
    this.registry?.withdraw(this.windowId); // another window takes the address over
    this.registry = undefined;
    this.pairing.revoke();
    this.card?.dispose();
    await this.tailscale.remove();
    this.publicUrl = undefined;
    this.problem = undefined;
    await server.stop();
    this.status.hide();
    this.stateChanged.fire();
    this.log("stopped");
    void vscode.window.showInformationMessage(
      wasHub ? "Remote access is off in this window. Paired devices stay paired for next time." : "This window's chats are no longer shown on remote devices."
    );
  }

  /** A new one-use pairing link, from this window (the hub) or from the hub window. */
  private async linkInfo(retry: boolean): Promise<LinkInfo> {
    if (this.role === "hub") {
      return this.hubApi().pairLink(retry);
    }
    return this.askHub<LinkInfo>("POST", "/internal/pair-link", { retry });
  }

  /** The pairing card: a new one-use link as a QR code and text, with buttons. */
  /** True when the card is open afterwards. */
  async showLink(retry = false): Promise<boolean> {
    if (!this.server) {
      return this.start(true);
    }
    let info: LinkInfo;
    try {
      info = await this.linkInfo(retry);
    } catch (err) {
      this.log(`no pairing link: ${errorMessage(err)}`);
      void vscode.window.showWarningMessage(`Could not get a pairing link: ${errorMessage(err)}`);
      return false;
    }
    this.cardLink = info.link;
    this.cardProblem = info.problem;
    const expires = new Date(Date.now() + PAIRING_MINUTES * 60_000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    let svg: string | undefined;
    if (info.shared) {
      try {
        svg = qrSvg(encodeQr(this.cardLink));
      } catch (err) {
        this.log(`no QR code: ${errorMessage(err)}`); // the link text is still there
      }
    }
    const html = pairingCardHtml({
      link: this.cardLink,
      qrSvg: svg,
      problem: info.shared ? undefined : { advice: info.problem?.advice ?? "", canOpenSetup: Boolean(info.problem?.enableUrl) },
      expiresAt: expires,
    });
    if (this.card) {
      this.card.webview.html = html;
      this.card.reveal();
      return true;
    }
    const panel = vscode.window.createWebviewPanel("kiroCliChat.remoteCard", "Kiro Remote Access", vscode.ViewColumn.Active, { enableScripts: true });
    this.card = panel;
    panel.webview.html = html;
    panel.webview.onDidReceiveMessage((msg) => void this.onCardAction(cardAction(msg)));
    panel.onDidDispose(() => {
      this.card = undefined;
      this.cardLink = ""; // the link is not kept once the card is closed
      this.cardProblem = undefined;
    });
    return true;
  }

  private async onCardAction(action: ReturnType<typeof cardAction>): Promise<void> {
    switch (action) {
      case "copy":
        await vscode.env.clipboard.writeText(this.cardLink);
        void vscode.window.showInformationMessage("Pairing link copied.");
        break;
      case "open":
        await vscode.env.openExternal(vscode.Uri.parse(this.cardLink));
        break;
      case "newLink":
        await this.showLink();
        break;
      case "setup":
        if (this.cardProblem?.enableUrl) {
          await vscode.env.openExternal(vscode.Uri.parse(this.cardProblem.enableUrl));
        }
        break;
      case "retry":
        await this.showLink(true);
        break;
      default:
        break;
    }
  }

  /** Pick a paired device to remove (or all of them). */
  async removeDevice(): Promise<void> {
    let list: Array<{ id: string; name: string; lastSeen: number }>;
    try {
      if (this.role === "hub") {
        list = this.devices.list();
      } else if (this.role === "member") {
        list = await this.askHub("GET", "/internal/devices");
      } else {
        list = new DeviceStore(await this.loadDevices()).list();
      }
    } catch (err) {
      void vscode.window.showWarningMessage(`Could not list the devices: ${errorMessage(err)}`);
      return;
    }
    if (list.length === 0) {
      void vscode.window.showInformationMessage("No remote devices are paired.");
      return;
    }
    const items: Array<vscode.QuickPickItem & { id?: string }> = list.map((d) => ({
      label: d.name,
      description: `last used ${new Date(d.lastSeen).toLocaleString()}`,
      id: d.id,
    }));
    items.push({ label: "Remove all devices", description: `${list.length} paired` });
    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Remove which device?" });
    if (!picked) {
      return;
    }
    const ids = picked.id ? [picked.id] : "all";
    try {
      if (this.role === "hub") {
        this.hubApi().removeDevices(ids);
      } else if (this.role === "member") {
        await this.askHub("POST", "/internal/devices/remove", { ids });
      } else {
        const store = new DeviceStore(await this.loadDevices());
        store.onChange = () => void this.saveDevices(store);
        for (const d of store.list()) {
          if (ids === "all" || ids.includes(d.id)) {
            store.remove(d.id);
          }
        }
      }
    } catch (err) {
      void vscode.window.showWarningMessage(`Could not remove: ${errorMessage(err)}`);
      return;
    }
    const n = ids === "all" ? list.length : 1;
    this.log(`removed ${n} device(s)`);
    void vscode.window.showInformationMessage(n === 1 ? `Removed ${picked.label}.` : `Removed ${n} devices.`);
  }

  /** The status bar item's menu. */
  async menu(): Promise<void> {
    if (!this.server) {
      await this.start(true);
      return;
    }
    const picked = await vscode.window.showQuickPick(
      ["Show pairing link", "Remove a device…", "Stop remote access"].map((label) => ({ label })),
      { placeHolder: "Remote access" }
    );
    if (picked?.label === "Show pairing link") {
      await this.showLink();
    } else if (picked?.label === "Remove a device…") {
      await this.removeDevice();
    } else if (picked?.label === "Stop remote access") {
      await this.stop();
    }
  }

  /** At start-up, when the user asked for remote access to start by itself. */
  async startIfWanted(): Promise<void> {
    if (this.settings().get<boolean>("autoStart", false)) {
      await this.start(false);
    }
  }

  dispose(): void {
    clearInterval(this.timer);
    this.chatSub?.dispose();
    this.syncMembers([]);
    this.registry?.withdraw(this.windowId); // so another window can take over at once
    void this.tailscale.remove();
    void this.server?.stop();
    this.server = undefined;
    this.status.dispose();
    this.stateChanged.dispose();
  }

  // --- helpers ---

  private updateStatus(): void {
    const n = this.server?.connectedDevices.length ?? 0;
    const member = this.role === "member";
    this.status.text = member ? "$(broadcast) Remote (shared)" : n > 0 ? `$(broadcast) Remote: ${n} connected` : "$(broadcast) Remote";
    this.status.tooltip = member
      ? "Kiro CLI Chat remote access is on. This window's chats are shown by the window that shares the address. Click for the pairing link, devices and Stop."
      : this.publicUrl
        ? `Kiro CLI Chat remote access is on at ${this.publicUrl}. Click for the pairing link, devices and Stop.`
        : "Kiro CLI Chat remote access is on for this Mac only (Tailscale is not set up). Click for details, devices and Stop.";
    this.status.show();
  }

  private readAsset(name: string): RemoteAsset | undefined {
    const type = assetType(name);
    if (!type) {
      return undefined;
    }
    try {
      const file = path.join(this.context.extensionUri.fsPath, "media", name);
      return { body: fs.readFileSync(file), type };
    } catch {
      return undefined;
    }
  }

  private async loadDevices(): Promise<DeviceRecord[]> {
    try {
      const raw = await this.context.secrets.get(DEVICES_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? (parsed as DeviceRecord[]) : [];
    } catch {
      return [];
    }
  }

  private async saveDevices(store: DeviceStore = this.devices): Promise<void> {
    try {
      await this.context.secrets.store(DEVICES_KEY, JSON.stringify(store.list()));
    } catch (err) {
      this.log(`could not save devices: ${errorMessage(err)}`);
    }
  }
}
