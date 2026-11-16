// What a webview chat has shown, kept so a re-created webview can be restored
// (VS Code rebuilds the webview when the panel view is moved, and a tab's
// webview after a reload). Pure (no vscode import).

/** Most messages kept; older ones are dropped. */
export const MAX_TRANSCRIPT = 20000;
/**
 * Most text kept per chat, in characters (about bytes; pasted images are base64).
 * Over it, images in the oldest messages go first, then the oldest messages.
 */
export const MAX_TRANSCRIPT_CHARS = 32 * 1024 * 1024;

/** Rough size of a message: what it takes to post it. */
function sizeOf(msg: unknown): number {
  try {
    return JSON.stringify(msg)?.length ?? 0;
  } catch {
    return 0;
  }
}

interface Entry {
  msg: unknown;
  size: number;
}

type Msg = {
  type?: string;
  images?: unknown[];
  event?: { kind?: string; toolCallId?: string; request?: { toolCallId?: string }; question?: { toolCallId?: string } };
};

export class ChatTranscript {
  private messages: Entry[] = [];
  private chars = 0;
  // Latest state snapshots: only the newest one matters.
  private lastReady?: unknown;
  private lastConfig?: unknown;
  private lastCommands?: unknown;
  private lastContext?: unknown;

  constructor(private readonly maxChars = MAX_TRANSCRIPT_CHARS) {}

  private push(msg: unknown): void {
    const size = sizeOf(msg);
    this.messages.push({ msg, size });
    this.chars += size;
  }

  private keep(test: (m: Msg) => boolean): void {
    this.messages = this.messages.filter((e) => test(e.msg as Msg));
    this.chars = this.messages.reduce((n, e) => n + e.size, 0);
  }

  /** Over the size budget: drop image data from the oldest messages, then the oldest messages. */
  private trim(): void {
    if (this.messages.length > MAX_TRANSCRIPT) {
      this.messages.splice(0, this.messages.length - MAX_TRANSCRIPT);
      this.chars = this.messages.reduce((n, e) => n + e.size, 0);
    }
    for (let i = 0; i < this.messages.length - 1 && this.chars > this.maxChars; i++) {
      const m = this.messages[i].msg as Msg;
      const n = m.type === "userMessage" && Array.isArray(m.images) ? m.images.length : 0;
      if (n === 0) {
        continue;
      }
      const lighter = { ...m, images: [] };
      const note = { type: "notice", text: `${n === 1 ? "An image" : `${n} images`} from this message ${n === 1 ? "is" : "are"} no longer kept (the chat is long).` };
      const entries = [lighter, note].map((msg) => ({ msg, size: sizeOf(msg) }));
      this.chars += entries[0].size + entries[1].size - this.messages[i].size;
      this.messages.splice(i, 1, ...entries);
      i++; // past the notice
    }
    let drop = 0;
    while (drop < this.messages.length - 1 && this.chars > this.maxChars) {
      this.chars -= this.messages[drop].size;
      drop++;
    }
    if (drop > 0) {
      this.messages.splice(0, drop);
    }
  }

  /** Record a message posted to the webview. */
  record(msg: unknown): void {
    const m = msg as Msg;
    switch (m?.type) {
      case "ready":
        this.lastReady = msg;
        break;
      case "cleared":
        this.messages = [];
        this.chars = 0;
        break;
      case "userMessage":
      case "error":
      case "notice":
        this.push(msg);
        break;
      case "event": {
        const kind = m.event?.kind;
        if (kind === "configOptions") {
          this.lastConfig = msg;
        } else if (kind === "availableCommands") {
          this.lastCommands = msg;
        } else if (kind === "contextUsage") {
          this.lastContext = msg;
        } else {
          if (kind === "approvalResolved") {
            // Answered by a rule: no card to restore.
            this.dropApprovalCard(m.event?.toolCallId ?? "");
          }
          if (kind === "questionResolved") {
            this.dropQuestionCard(m.event?.toolCallId ?? "");
            break; // nothing to show for it on restore
          }
          this.push(msg);
        }
        break;
      }
      default:
        break;
    }
    this.trim();
  }

  /** Once answered, don't bring an approval card back on restore. */
  dropApprovalCard(toolCallId: string): void {
    this.keep((m) => !(m.type === "event" && m.event?.kind === "approvalRequest" && (m.event.request?.toolCallId ?? "") === toolCallId));
  }

  /** Same for the agent's questions. */
  dropQuestionCard(toolCallId: string): void {
    this.keep((m) => !(m.type === "event" && m.event?.kind === "question" && (m.event.question?.toolCallId ?? "") === toolCallId));
  }

  /** Messages to post to a new webview, in order. */
  replay(): unknown[] {
    const out: unknown[] = [];
    if (this.lastReady) {
      out.push(this.lastReady);
    }
    out.push(...this.messages.map((e) => e.msg));
    for (const msg of [this.lastConfig, this.lastCommands, this.lastContext]) {
      if (msg) {
        out.push(msg);
      }
    }
    return out;
  }
}
