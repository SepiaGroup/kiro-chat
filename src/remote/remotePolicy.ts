// What a remote device may ask a chat to do, and in what shape. An allow-list:
// anything not listed is refused, and only the listed fields get through.
// A paired device is trusted as the owner (it can be unpaired, or removed from
// the tailnet, when it is lost): it gets every approval choice including
// rules, Autopilot and the other settings, Restart, Resume, a new tab and the
// "/" commands (they arrive as prompts). Only what acts on the Mac's own
// screen is left out: logging in, the remote access switch, anything that
// opens a file or a dialog in VS Code.
// Pure (no vscode import).

import { MAX_ANSWER, MAX_IMAGES, MAX_STEER, cleanAnswer, cleanSteer, sanitizeImages } from "../webviewInput";

export type Permission = "view" | "prompt" | "approve";
export const ALL_PERMISSIONS: readonly Permission[] = ["view", "prompt", "approve"];

export type RemoteMessage = { type: string; [k: string]: unknown };

export type PolicyResult =
  | { ok: true; msg: RemoteMessage }
  | { ok: false; status: 400 | 403 | 413; reason: string };

/** Longest prompt accepted from a remote device. */
export const MAX_REMOTE_PROMPT = 200_000;
/** Settings a remote device may change (the ones in the Settings panel). */
export const REMOTE_CONFIG_IDS: readonly string[] = ["model", "effortLevel", "autopilot", "memoryReflection", "contentCollection"];
/** Of those, the ones that take away or change approvals: they need the approve permission. */
const APPROVAL_CONFIG_IDS: readonly string[] = ["autopilot"];

const MAX_ID = 200;
const MAX_FOLDER = 4096;

/** The permissions in a setting value: unknown entries dropped, all of them when it is not a list. */
export function parsePermissions(raw: unknown): Permission[] {
  if (!Array.isArray(raw)) {
    return [...ALL_PERMISSIONS];
  }
  return ALL_PERMISSIONS.filter((p) => raw.includes(p));
}

function str(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;
}

export function checkRemoteMessage(raw: unknown, granted: readonly Permission[]): PolicyResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, status: 400, reason: "not a message" };
  }
  const m = raw as Record<string, unknown>;
  const type = m.type;
  if (typeof type !== "string" || type.length > 40) {
    return { ok: false, status: 400, reason: "no message type" };
  }
  const need = (p: Permission): PolicyResult | undefined =>
    granted.includes(p) ? undefined : { ok: false, status: 403, reason: `this device may not ${verb(p)}` };
  const bad = (reason: string): PolicyResult => ({ ok: false, status: 400, reason });
  const pass = (msg: RemoteMessage): PolicyResult => ({ ok: true, msg });

  switch (type) {
    case "ready":
    case "getContextBreakdown":
      return need("view") ?? pass({ type });

    case "cancelTurn":
    case "compact":
      return need("prompt") ?? pass({ type });

    case "sendPrompt": {
      const denied = need("prompt");
      if (denied) {
        return denied;
      }
      if (typeof m.text !== "string") {
        return bad("no text");
      }
      if (m.text.length > MAX_REMOTE_PROMPT) {
        return { ok: false, status: 413, reason: "message too long" };
      }
      const images = sanitizeImages(m.images).slice(0, MAX_IMAGES);
      if (!m.text.trim() && images.length === 0) {
        return bad("empty message");
      }
      return pass({ type, text: m.text, images });
    }

    case "steerPrompt": {
      const denied = need("prompt");
      if (denied) {
        return denied;
      }
      const text = cleanSteer(m.text);
      return text ? pass({ type, text: text.slice(0, MAX_STEER) }) : bad("empty message");
    }

    case "answerQuestion": {
      const denied = need("prompt");
      if (denied) {
        return denied;
      }
      const toolCallId = str(m.toolCallId, MAX_ID);
      if (!toolCallId) {
        return bad("no question id");
      }
      const answer = cleanAnswer(m.answer);
      return pass({ type, toolCallId, ...(answer ? { answer: answer.slice(0, MAX_ANSWER) } : {}) });
    }

    case "setMode": {
      const denied = need("prompt");
      if (denied) {
        return denied;
      }
      const modeId = str(m.modeId, 100);
      return modeId ? pass({ type, modeId }) : bad("no mode");
    }

    case "setConfig": {
      const denied = need("prompt");
      if (denied) {
        return denied;
      }
      const id = str(m.id, 100);
      const value = str(m.value, 100);
      if (!id || !value) {
        return bad("no setting");
      }
      if (!REMOTE_CONFIG_IDS.includes(id)) {
        return { ok: false, status: 403, reason: `this device may not change ${id}` };
      }
      if (APPROVAL_CONFIG_IDS.includes(id)) {
        const noApprove = need("approve");
        if (noApprove) {
          return noApprove;
        }
      }
      return pass({ type, id, value });
    }

    case "restart":
    case "newTab":
    case "resumeSession":
      return need("prompt") ?? pass({ type });

    case "loadSession": {
      const denied = need("prompt");
      if (denied) {
        return denied;
      }
      const sessionId = str(m.sessionId, MAX_ID);
      return sessionId ? pass({ type, sessionId }) : bad("no session");
    }

    case "confirmAnswer": {
      const denied = need("prompt");
      if (denied) {
        return denied;
      }
      return typeof m.id === "number" && Number.isSafeInteger(m.id) ? pass({ type, id: m.id, yes: m.yes === true }) : bad("no question id");
    }

    case "approve": {
      const denied = need("approve");
      if (denied) {
        return denied;
      }
      const toolCallId = str(m.toolCallId, MAX_ID);
      const optionId = str(m.optionId, 100);
      if (!toolCallId || !optionId) {
        return bad("no approval id");
      }
      // Rules are allowed; the chat checks the rule kind and the folder, as for the desktop page.
      const reason = typeof m.reason === "string" ? m.reason.slice(0, 2000) : undefined;
      const rule = str(m.rule, 40);
      const folder = str(m.folder, MAX_FOLDER);
      return pass({ type, toolCallId, optionId, ...(reason ? { reason } : {}), ...(rule ? { rule } : {}), ...(folder ? { folder } : {}) });
    }

    default:
      return { ok: false, status: 403, reason: `"${type.replace(/[^\w.-]/g, "?")}" is not allowed from a remote device` };
  }
}

function verb(p: Permission): string {
  return p === "view" ? "view chats" : p === "prompt" ? "send to the agent" : "answer approvals";
}
