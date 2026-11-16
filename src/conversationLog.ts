// What a chat tab keeps about its conversation for the slash commands it
// shares with the terminal chat (/copy, /transcript, /stats, /config, /tools,
// /mcp, /prompts): the engine's settings, commands and tool groups, the
// transcript and recent turns. Pure.

import { SessionConfig } from "./terminal/sessionConfig";
import type { TranscriptEntry, TurnStat, UserTurn } from "./terminal/terminalCommands";
import type { AvailableCommand, ChatEvent } from "./types";

const MAX_STATS = 50;

export class ConversationLog {
  readonly config = new SessionConfig();
  engineCommands: AvailableCommand[] = [];
  contextPercent?: number;
  toolGroups: Array<{ tag: string; description: string }> = [];
  mcpServers: unknown[] = [];
  transcript: TranscriptEntry[] = [];
  userTurns: UserTurn[] = [];
  readonly turnStats: TurnStat[] = [];
  private turn?: { prompt: string; since: number; credits?: number; elapsedMs?: number; requestIds: string[]; status?: string };

  track(ev: ChatEvent): void {
    switch (ev.kind) {
      case "assistantChunk": {
        const last = this.transcript[this.transcript.length - 1];
        if (last?.role === "assistant") {
          last.text += ev.text;
        } else {
          this.transcript.push({ role: "assistant", text: ev.text });
        }
        break;
      }
      case "userMessage": // replayed history (Resume)
        this.transcript.push({ role: "user", text: ev.text });
        break;
      case "userMessageId":
        if (this.turn) {
          this.userTurns.push({ messageId: ev.messageId, text: this.turn.prompt });
        }
        break;
      case "toolCall":
        this.transcript.push({ role: "tool", text: ev.title });
        break;
      case "turnCompletion":
        if (this.turn) {
          Object.assign(this.turn, { elapsedMs: ev.elapsedMs, requestIds: ev.requestIds, status: ev.status });
        }
        break;
      case "metering":
        if (this.turn) {
          this.turn.credits = (this.turn.credits ?? 0) + ev.credits;
        }
        break;
      case "contextUsage":
        this.contextPercent = ev.usagePercentage;
        break;
      case "configOptions":
        this.config.merge(ev.options);
        break;
      case "availableCommands":
        this.engineCommands = ev.commands;
        break;
      default:
        break;
    }
  }

  /** Engine notifications that aren't chat events: MCP servers and tool groups. */
  notification(method: string, params: unknown): void {
    const p = (params ?? {}) as { servers?: unknown; tags?: unknown };
    if (method === "_kiro/mcp/status") {
      this.mcpServers = Array.isArray(p.servers) ? p.servers : [];
    } else if (method === "_kiro/tools/didChange" && Array.isArray(p.tags)) {
      this.toolGroups = p.tags
        .map((t) => t as { tag?: unknown; description?: unknown })
        .filter((t) => typeof t.tag === "string")
        .map((t) => ({ tag: String(t.tag), description: String(t.description ?? "") }));
    }
  }

  promptStarted(text: string, now = Date.now()): void {
    this.transcript.push({ role: "user", text });
    this.turn = { prompt: text, since: now, requestIds: [] };
  }

  promptFinished(cancelled: boolean, now = Date.now()): void {
    const t = this.turn;
    this.turn = undefined;
    if (!t) {
      return;
    }
    this.turnStats.push({
      at: new Date(now),
      prompt: t.prompt,
      elapsedMs: t.elapsedMs ?? now - t.since,
      credits: t.credits,
      requestIds: t.requestIds,
      status: cancelled ? "cancelled" : t.status ?? "success",
    });
    if (this.turnStats.length > MAX_STATS) {
      this.turnStats.shift();
    }
  }

  /** A new or resumed conversation: its history starts over (settings stay). */
  reset(): void {
    this.transcript = [];
    this.userTurns = [];
    this.contextPercent = undefined;
  }
}
