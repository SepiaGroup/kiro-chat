// The remote-access side of a terminal chat. The terminal records what it
// shows as the webview chat's messages (engine events, prompts), so a phone
// sees a terminal chat the way it sees a chat tab, and hands the phone's
// messages back to the terminal. Pure (no vscode import).

import { randomUUID } from "crypto";
import { ChatTranscript } from "../chatTranscript";
import type { RemoteMessage } from "../remote/remotePolicy";
import type { RemoteChat } from "../remote/remoteServer";

export interface TerminalRemoteHost {
  title(): string;
  busy(): boolean;
  /** A message from a remote device. The server's policy has checked it already. */
  handle(msg: RemoteMessage, device: string): Promise<void>;
}

export class TerminalRemote implements RemoteChat {
  readonly id = randomUUID();
  private readonly transcript = new ChatTranscript();
  private readonly listeners = new Set<(msg: unknown) => void>();

  constructor(private readonly host: TerminalRemoteHost) {}

  get title(): string {
    return this.host.title();
  }

  get busy(): boolean {
    return this.host.busy();
  }

  snapshot(): unknown[] {
    return this.transcript.replay();
  }

  subscribe(listener: (msg: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async send(msg: RemoteMessage, device: { id: string; name: string }): Promise<void> {
    if (msg.type === "ready") {
      return; // the page has its snapshot; the terminal starts its own engine
    }
    await this.host.handle(msg, device.name);
  }

  /** Something the terminal showed, as a webview message. */
  post(msg: unknown): void {
    this.transcript.record(msg);
    for (const l of [...this.listeners]) {
      try {
        l(msg);
      } catch {
        // A remote page's stream failing is the server's business.
      }
    }
  }
}

/** The open terminal chats, for remote access's chat list. */
export class TerminalChats {
  private readonly list = new Set<TerminalRemote>();
  private readonly listeners = new Set<() => void>();
  /** The titles last listed, to notice a rename nothing announces. */
  private titles = "";

  /** List a chat; returns the way to take it off. */
  add(chat: TerminalRemote): () => void {
    this.list.add(chat);
    this.changed();
    return () => {
      if (this.list.delete(chat)) {
        this.changed();
      }
    };
  }

  chats(): TerminalRemote[] {
    return [...this.list];
  }

  /**
   * Announce the list again if a title changed. VS Code renames a terminal
   * (its tab's Rename) without an event, so remote access calls this on its tick.
   */
  checkTitles(): void {
    if (this.currentTitles() !== this.titles) {
      this.changed();
    }
  }

  private currentTitles(): string {
    return JSON.stringify(this.chats().map((c) => c.title));
  }

  /** The list, a title or a busy state changed. */
  changed(): void {
    this.titles = this.currentTitles();
    for (const l of [...this.listeners]) {
      l();
    }
  }

  onDidChangeChats(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
}
