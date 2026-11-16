// The slash commands of a chat tab: the terminal chat's commands (they run
// the same code), minus the few that only make sense in a terminal, plus how
// a typed line is routed. Pure (the webview bundle uses the list too).

import { style } from "./terminal/ansi";
import { COMMANDS, findCommand, type CommandSpec } from "./terminal/slashCommands";

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

/** Commands that would act on the Mac's own screen, so a remote device is told instead. */
export const REMOTE_UNAVAILABLE: Record<string, string> = {
  copy: "/copy would copy to the Mac's clipboard. Use the Copy button on a code block.",
  login: "/login opens a terminal on the Mac. Log in there, then use /restart.",
  remote: "/remote starts or stops remote access on the Mac; stopping it would cut this device off.",
};

export interface TabCommand {
  name: string;
  description: string;
  inputHint?: string;
  type: "builtin";
}

function usable(c: CommandSpec, remote = false): boolean {
  return !c.unavailable && !TAB_UNAVAILABLE[c.name] && !(remote && REMOTE_UNAVAILABLE[c.name]);
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
  | { kind: "run"; name: string; arg: string; text: string }
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
    const reason = spec.unavailable ?? TAB_UNAVAILABLE[spec.name] ?? (remote ? REMOTE_UNAVAILABLE[spec.name] : undefined);
    return reason ? { kind: "unavailable", text: trimmed, reason } : { kind: "run", name: spec.name, arg: (m?.[2] ?? "").trim(), text: trimmed };
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
    style.gray(`Not available here: ${Object.keys(remote ? { ...TAB_UNAVAILABLE, ...REMOTE_UNAVAILABLE } : TAB_UNAVAILABLE).map((n) => "/" + n).join(", ")}.`)
  );
  return lines.join("\n");
}
