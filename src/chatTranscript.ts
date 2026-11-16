// What a webview chat has shown, kept so a re-created webview can be restored
// (VS Code rebuilds the webview when the panel view is moved, and a tab's
// webview after a reload). Pure (no vscode import).

/** Most messages kept; older ones are dropped. */
export const MAX_TRANSCRIPT = 20000;
/**
 * Most kept per chat, counted in JSON characters (UTF-16 units). V8 keeps
 * one-byte text (base64 images, most code and English) at a byte per
 * character and other text at two, so this is 32 to 64 MB of memory. The
 * remote stream and a snapshot point at the same objects; they add no copy.
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
  /** No message before this index still holds images (so trimming does not look there again). */
  private imagesFrom = 0;
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
    this.messages = this.messages.filter((e) => {
      const kept = test(e.msg as Msg);
      if (!kept) {
        this.chars -= e.size;
      }
      return kept;
    });
    this.imagesFrom = 0; // indexes moved; the next trim looks again once
  }

  /** Drop the oldest `n` messages. */
  private dropOldest(n: number): void {
    for (let i = 0; i < n; i++) {
      this.chars -= this.messages[i].size;
    }
    this.messages.splice(0, n);
    this.imagesFrom = Math.max(0, this.imagesFrom - n);
  }

  /** Over the size budget: drop image data from the oldest messages, then the oldest messages. */
  private trim(): void {
    if (this.messages.length > MAX_TRANSCRIPT) {
      this.dropOldest(this.messages.length - MAX_TRANSCRIPT);
    }
    if (this.chars <= this.maxChars) {
      return;
    }
    let i = this.imagesFrom;
    for (; i < this.messages.length - 1 && this.chars > this.maxChars; i++) {
      const m = this.messages[i].msg as Msg;
      const n = m.type === "userMessage" && Array.isArray(m.images) ? m.images.length : 0;
      if (n === 0) {
        continue;
      }
      const lighter = { ...m, images: [] };
      const note = { type: "notice", text: `${n === 1 ? "An image" : `${n} images`} from this message ${n === 1 ? "is" : "are"} no longer kept, to save memory.` };
      const entries = [lighter, note].map((msg) => ({ msg, size: sizeOf(msg) }));
      this.chars += entries[0].size + entries[1].size - this.messages[i].size;
      this.messages.splice(i, 1, ...entries);
      i++; // past the notice
    }
    this.imagesFrom = i;
    let drop = 0;
    let chars = this.chars;
    while (drop < this.messages.length - 1 && chars > this.maxChars) {
      chars -= this.messages[drop].size;
      drop++;
    }
    if (drop > 0) {
      this.dropOldest(drop);
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
        this.imagesFrom = 0;
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
