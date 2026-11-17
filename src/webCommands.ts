// The slash commands of a chat tab: the terminal chat's commands (they run
// the same code), minus the few that only make sense in a terminal, plus how
// a typed line is routed. Pure (the webview bundle uses the list too).

import { style } from "./terminal/ansi";
import { COMMANDS, findCommand, type CommandSpec } from "./terminal/slashCommands";
import { machine } from "./machine";

/** Terminal chat commands a chat tab doesn't run, and what to do instead. */
export const TAB_UNAVAILABLE: Record<string, string> = {
  paste: "In a chat tab, paste an image into the message box with Cmd+V.",
  editor: "/editor is for the terminal chat. Here the message box takes several lines (Shift+Enter).",
  reply: "/reply is for the terminal chat.",
  rewind: "/rewind works in the terminal chat only, for now.",
  spawn: "/spawn is for the terminal chat. Use ＋ to open another chat tab.",
  cls: "/cls is for the terminal chat. /clear starts a new conversation.",
  quit: "Close the tab to end this chat.",
};

/**
 * What a remote device may run: an allow-list, so a new command is blocked
 * until it is decided here. Left out is whatever acts on the Mac itself:
 * opens an editor, a dialog or a terminal there, writes a file to a path the
 * device names, reads a path into the context, or touches the clipboard.
 */
const REMOTE_ALLOWED = new Set([
  "help", "clear", "new", "resume", "compact", "title", "model", "effort", "plan", "prompts",
  "mcp", "hooks", "code", "config", "usage", "stats", "changelog", "restart",
  "chat", "context", "knowledge", "agent", "tools", "autopilot", "set",
]);

/** Allowed first words of the argument, for the commands that are only partly allowed (the rest names a path on the Mac or opens something). */
const REMOTE_SUBS: Record<string, { subs: string[]; why: string }> = {
  chat: { subs: ["", "new", "load"], why: `/chat save writes a file on the ${machine()}.` },
  context: { subs: ["", "show", "remove", "clear"], why: `/context add reads a path on the ${machine()} into the context.` },
  knowledge: { subs: ["", "show", "remove", "clear", "cancel"], why: `/knowledge add and update read a path on the ${machine()}.` },
};

/** Settings a device may change with /set (the Settings panel's), and the one that takes approvals away. */
const REMOTE_SET_IDS = ["model", "effortLevel", "autopilot", "memoryReflection", "contentCollection"];

export type RemoteCheck = { ok: true; needsApprove?: boolean } | { ok: false; reason: string };

/** Whether a remote device may run this command, and whether it also needs the approve permission (anything that turns Autopilot on or off). */
export function remoteCheck(name: string, arg: string): RemoteCheck {
  if (!REMOTE_ALLOWED.has(name)) {
    return { ok: false, reason: `/${name} acts on the ${machine()} itself (an editor, a terminal, a file or the clipboard there), so it isn't available from a remote device.` };
  }
  const words = arg.trim().split(/\s+/);
  const sub = (words[0] ?? "").toLowerCase();
  const partly = REMOTE_SUBS[name];
  if (partly && !partly.subs.includes(sub)) {
    return { ok: false, reason: `${partly.why} It isn't available from a remote device.` };
  }
  if (name === "agent" && (sub === "create" || sub === "edit")) {
    return { ok: false, reason: `/agent ${sub} opens a file in VS Code on the ${machine()}, so it isn't available from a remote device.` };
  }
  if (name === "autopilot") {
    return sub ? { ok: true, needsApprove: true } : { ok: true };
  }
  if (name === "tools" && sub) {
    return sub === "trust-all" || sub === "reset" ? { ok: true, needsApprove: true } : { ok: true };
  }
  if (name === "set" && sub) {
    return REMOTE_SET_IDS.includes(words[0])
      ? words[0] === "autopilot" ? { ok: true, needsApprove: true } : { ok: true }
      : { ok: false, reason: `A remote device can change these settings with /set: ${REMOTE_SET_IDS.join(", ")}.` };
  }
  return { ok: true };
}

export interface TabCommand {
  name: string;
  description: string;
  inputHint?: string;
  type: "builtin";
}

function usable(c: CommandSpec, remote = false): boolean {
  return !c.unavailable && !TAB_UNAVAILABLE[c.name] && !(remote && !REMOTE_ALLOWED.has(c.name));
}

/** For the "/" picker in a chat tab (`remote`: on a remote device's page). */
export function tabCommandList(remote = false): TabCommand[] {
  return COMMANDS.filter((c) => usable(c, remote)).map((c) => ({
    name: c.name,
    description: c.desc,
    ...(c.args ? { inputHint: c.args } : c.subs ? { inputHint: c.subs.map((s) => s.name).join(" | ") } : {}),
    type: "builtin" as const,
  }));
}

export type SlashRoute =
  /** Not a command of ours: the agent gets the line (engine commands, paths, " /text"). */
  | { kind: "agent" }
  | { kind: "run"; name: string; arg: string; text: string; /** A remote device needs the approve permission for it. */ needsApprove?: boolean }
  | { kind: "unavailable"; text: string; reason: string }
  | { kind: "unknown"; text: string; name: string };

/** What a line typed in a chat tab is, as the terminal chat decides it. */
export function routeSlash(text: string, engineCommands: ReadonlyArray<{ name: string }>, remote = false): SlashRoute {
  // A leading space sends "/..." to the agent as plain text.
  if (!text.startsWith("/")) {
    return { kind: "agent" };
  }
  const trimmed = text.trim();
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(trimmed);
  const word = m?.[1] ?? "";
  const spec = findCommand(word);
  if (spec) {
    const arg = (m?.[2] ?? "").trim();
    const check: RemoteCheck = remote ? remoteCheck(spec.name, arg) : { ok: true };
    const reason = spec.unavailable ?? TAB_UNAVAILABLE[spec.name] ?? (check.ok ? undefined : check.reason);
    if (reason) {
      return { kind: "unavailable", text: trimmed, reason };
    }
    return { kind: "run", name: spec.name, arg, text: trimmed, ...(check.ok && check.needsApprove ? { needsApprove: true } : {}) };
  }
  if (engineCommands.some((c) => c.name.toLowerCase() === word.toLowerCase())) {
    return { kind: "agent" };
  }
  // "/Users/me/pic.png what's this?" is a normal message.
  return /^[a-z][\w-]*$/i.test(word) ? { kind: "unknown", text: trimmed, name: word } : { kind: "agent" };
}

/** /help in a chat tab. */
export function tabHelp(engineCommands: ReadonlyArray<{ name: string; description?: string }>, remote = false): string {
  const list = COMMANDS.filter((c) => usable(c, remote));
  const left = (c: CommandSpec): string => "/" + c.name + (c.args ? " " + c.args : c.subs ? " …" : "");
  const width = Math.min(26, Math.max(...list.map((c) => left(c).length)) + 2);
  const lines = [style.bold("Commands") + style.gray("  (type / for a menu)")];
  for (const c of list) {
    lines.push("  " + style.cyan(left(c).padEnd(width)) + style.gray(c.desc));
  }
  if (engineCommands.length > 0) {
    lines.push("", style.bold("Agent commands") + style.gray(" (sent to the agent)"));
    for (const c of engineCommands) {
      lines.push("  " + style.cyan(("/" + c.name).padEnd(width)) + style.gray((c.description ?? "").replace(/\s+/g, " ")));
    }
  }
  lines.push(
    "",
    style.gray("Start a line with a space to send /… to the agent as text."),
    style.gray(`Not available here: ${Object.keys(TAB_UNAVAILABLE).map((n) => "/" + n).join(", ")}.`)
  );
  return lines.join("\n");
}
