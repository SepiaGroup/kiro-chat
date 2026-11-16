// What a terminal chat does with a message from a remote device, and which
// approvals and questions are waiting for an answer from one. Pure: the
// terminal is behind `RemoteActionsHost`.

import { errorMessage } from "../format";
import type { RemoteMessage } from "../remote/remotePolicy";
import type { ApprovalAnswer, ChatEvent, PromptImage, RpcId } from "../types";
import { sanitizeImages } from "../webviewInput";
import { sanitize, style } from "./ansi";

/** What the actions need from the engine (an `AcpClient`). */
export interface RemoteEngine {
  readonly turnRunning: boolean;
  steer(text: string): Promise<unknown>;
  respondToApproval(requestId: RpcId, answer: ApprovalAnswer, opts: { onceOnly: true }): string;
  answerQuestion(requestId: RpcId, answer?: string): void;
  setMode(modeId: string): Promise<void>;
  setConfigOption(id: string, value: string): Promise<unknown>;
  extMethod<T>(method: string, params?: Record<string, unknown>): Promise<T>;
}

export interface RemoteActionsHost {
  engine(): RemoteEngine | undefined;
  /** Idle, with no approval, question or y/n confirm on the screen. */
  canAct(): boolean;
  isClosed(): boolean;
  print(text: string): void;
  /** To the remote screens (a webview message). */
  post(msg: unknown): void;
  /** The user's line as the terminal shows it ("> text"). */
  formatUser(text: string): string;
  /** Run a prompt as a turn, like one typed in the terminal (the host keeps the typed line). */
  sendPrompt(text: string, device: string, images: PromptImage[]): Promise<void>;
  cancelTurn(): void;
  /** The terminal's /compact, with the typed line kept. */
  compact(): Promise<{ ok: boolean; message: string }>;
  /** Take an approval answered elsewhere off the terminal's screen. */
  approvalAnswered(event: Extract<ChatEvent, { kind: "approvalResolved" }>): void;
  questionAnswered(requestId: RpcId, label: string): void;
}

/** " (from iPhone)", after a line the device sent. */
export function fromLabel(device: string): string {
  return style.gray(`  (from ${sanitize(device)})`);
}

/** The note under a prompt with images from a device. */
export function remoteImagesNote(count: number): string[] {
  return count ? [style.gray(`  📎 ${count === 1 ? "an image" : `${count} images`}`)] : [];
}

const CONFIG_NAMES: Record<string, string> = { model: "Model", effortLevel: "Effort" };

/** Requests waiting for an answer, by tool call (what a device names) and by request id (what the prompts know). */
class Pending {
  private readonly byTool = new Map<string, RpcId>();
  private readonly byRequest = new Map<RpcId, string>();

  set(toolCallId: string, requestId: RpcId): void {
    this.delete(toolCallId);
    this.byTool.set(toolCallId, requestId);
    this.byRequest.set(requestId, toolCallId);
  }

  request(toolCallId: string): RpcId | undefined {
    return this.byTool.get(toolCallId);
  }

  /** Remove the one with this request id; its tool call id, if it was waiting. */
  takeRequest(requestId: RpcId): string | undefined {
    const toolCallId = this.byRequest.get(requestId);
    if (toolCallId !== undefined) {
      this.delete(toolCallId);
    }
    return toolCallId;
  }

  delete(toolCallId: string): void {
    const id = this.byTool.get(toolCallId);
    if (id !== undefined) {
      this.byRequest.delete(id);
    }
    this.byTool.delete(toolCallId);
  }

  clear(): void {
    this.byTool.clear();
    this.byRequest.clear();
  }
}

export class RemoteActions {
  private readonly approvals = new Pending();
  private readonly questions = new Pending();

  constructor(private readonly host: RemoteActionsHost) {}

  /** Follow the engine's events. True for runStarted and runFinished (the chat list shows busy). */
  track(ev: ChatEvent): boolean {
    switch (ev.kind) {
      case "approvalRequest":
        if (ev.requestId !== undefined) {
          this.approvals.set(ev.request.toolCallId, ev.requestId);
        }
        return false;
      case "approvalResolved":
        this.approvals.delete(ev.toolCallId);
        return false;
      case "question":
        this.questions.set(ev.question.toolCallId, ev.requestId);
        return false;
      case "questionResolved":
        this.questions.delete(ev.toolCallId);
        return false;
      case "runStarted":
        return true;
      case "runFinished":
        // Approvals end with the turn and nothing says so. Questions need no
        // clearing: the client resolves them at the turn's end with a
        // questionResolved event, which removes them above.
        this.approvals.clear();
        return true;
      default:
        return false;
    }
  }

  /** The engine is gone or replaced: nothing is waiting any more. */
  clear(): void {
    this.approvals.clear();
    this.questions.clear();
  }

  /** An approval was answered in the terminal or from a device: other screens drop the card and say who. */
  approvalDone(requestId: RpcId, allowed: boolean, where: string): Extract<ChatEvent, { kind: "approvalResolved" }> | undefined {
    const toolCallId = this.approvals.takeRequest(requestId);
    if (toolCallId === undefined) {
      return undefined;
    }
    const event = { kind: "approvalResolved" as const, toolCallId, requestId, allowed, label: `${allowed ? "Allowed" : "Denied"} ${where}` };
    this.host.post({ type: "event", event });
    return event;
  }

  questionDone(requestId: RpcId, label: string): void {
    const toolCallId = this.questions.takeRequest(requestId);
    if (toolCallId !== undefined) {
      this.host.post({ type: "event", event: { kind: "questionResolved", toolCallId, requestId, label } });
    }
  }

  /**
   * A message from a device (checked by the server's policy). Prompts go to
   * the agent as typed: they never run the terminal's / commands, and paths in
   * them are not read as images.
   */
  async handle(msg: RemoteMessage, device: string): Promise<void> {
    const host = this.host;
    if (host.isClosed()) {
      return;
    }
    const engine = host.engine();
    const fail = (err: unknown): void => host.post({ type: "error", message: errorMessage(err) });
    switch (msg.type) {
      case "sendPrompt":
      case "steerPrompt":
        await this.prompt(msg, device, engine);
        return;
      case "cancelTurn":
        if (engine?.turnRunning) {
          host.print(style.gray(`Stopped from ${sanitize(device)}.`));
          host.cancelTurn();
        }
        return;
      case "approve": {
        const requestId = this.approvals.request(String(msg.toolCallId ?? ""));
        if (!engine || requestId === undefined) {
          return;
        }
        const answer: ApprovalAnswer = { optionId: String(msg.optionId ?? ""), ...(typeof msg.reason === "string" ? { reason: msg.reason } : {}) };
        let kind: string;
        try {
          kind = engine.respondToApproval(requestId, answer, { onceOnly: true });
        } catch (err) {
          host.post({ type: "notice", text: errorMessage(err) }); // still waiting
          return;
        }
        const event = this.approvalDone(requestId, kind.startsWith("allow"), `from ${device}`);
        if (event) {
          host.approvalAnswered(event);
        }
        return;
      }
      case "answerQuestion": {
        const requestId = this.questions.request(String(msg.toolCallId ?? ""));
        if (!engine || requestId === undefined) {
          return;
        }
        const answer = typeof msg.answer === "string" ? msg.answer : undefined;
        engine.answerQuestion(requestId, answer);
        const label = answer ? `Answered from ${device}: ${answer}` : `Skipped from ${device}.`;
        this.questionDone(requestId, label);
        host.questionAnswered(requestId, label);
        return;
      }
      case "setMode":
        if (engine) {
          await engine.setMode(String(msg.modeId ?? "")).then(() => host.print(style.gray(`Mode changed from ${sanitize(device)}.`)), fail);
        }
        return;
      case "setConfig":
        if (engine) {
          const id = String(msg.id ?? "");
          await engine
            .setConfigOption(id, String(msg.value ?? ""))
            .then(() => host.print(style.gray(`${CONFIG_NAMES[id] ?? sanitize(id)} changed from ${sanitize(device)}.`)), fail);
        }
        return;
      case "getContextBreakdown":
        if (!engine) {
          host.post({ type: "contextBreakdown", error: "The engine isn't running." });
          return;
        }
        try {
          const res = await engine.extMethod<{ breakdown?: unknown }>("_kiro/session/context", { subcommand: "show" });
          host.post({ type: "contextBreakdown", breakdown: res.breakdown ?? {} });
        } catch (err) {
          host.post({ type: "contextBreakdown", error: errorMessage(err) });
        }
        return;
      case "compact": {
        if (!engine || !host.canAct()) {
          host.post({ type: "compactDone", ok: false, message: "The terminal chat is busy. Try again when it is done." });
          return;
        }
        host.print(style.gray(`Compacting, from ${sanitize(device)}.`));
        try {
          host.post({ type: "compactDone", ...(await host.compact()) });
        } catch (err) {
          host.post({ type: "compactDone", ok: false, message: errorMessage(err) });
        }
        return;
      }
      default:
        return;
    }
  }

  private async prompt(msg: RemoteMessage, device: string, engine: RemoteEngine | undefined): Promise<void> {
    const host = this.host;
    const text = typeof msg.text === "string" ? msg.text : "";
    const images = msg.type === "sendPrompt" ? sanitizeImages(msg.images) : [];
    if (!engine) {
      host.post({ type: "error", message: "The engine isn't running. Type /restart in the terminal." });
      return;
    }
    if (engine.turnRunning) {
      if (!text.trim()) {
        return;
      }
      if (images.length > 0) {
        host.post({ type: "notice", text: "Images can't be added while the agent works. Send them after the reply.", isError: true });
        return;
      }
      host.print(host.formatUser(text.trim()) + fromLabel(device));
      host.post({ type: "userMessage", text, images: [] });
      engine.steer(text).catch((err: unknown) => {
        host.post({ type: "error", message: errorMessage(err) });
        if (!host.isClosed()) {
          host.print(style.red(errorMessage(err)));
        }
      });
      return;
    }
    if (!host.canAct()) {
      host.post({ type: "notice", text: "The terminal chat is busy (a command is running there). Try again in a moment.", isError: true });
      return;
    }
    if (!text.trim() && images.length === 0) {
      return;
    }
    await host.sendPrompt(text, device, images);
  }
}
