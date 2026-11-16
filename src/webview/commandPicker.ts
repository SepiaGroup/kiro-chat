// The "/" command picker above the input, and the argument hint shown after
// choosing a command. Browser context.

import { tabCommandList } from "../webCommands";
import { autoGrow, byId, div, inputEl } from "./ui";

export interface CommandLike {
  name: string;
  description?: string;
  inputHint?: string;
  type?: string;
}

const pickerEl = byId("cmd-picker");
const hintEl = byId("cmd-hint");

// The tab's own commands (the terminal chat's, see webCommands.ts); the engine
// adds agents and skills. A terminal chat shown on a remote page takes every
// line as text for the agent, so there the page offers only the engine's.
const remotePage = document.body.classList.contains("remote-page");
let BUILTIN_COMMANDS: CommandLike[] = remotePage ? [] : tabCommandList();
let engineCommands: CommandLike[] = [];

let allCommands: CommandLike[] = [...BUILTIN_COMMANDS];

/**
 * The chat shown runs "/" commands (a chat tab) or not (a terminal chat on a
 * remote page). Only the look: the extension decides what runs. Order doesn't
 * matter: `setCommands` keeps the engine's list and merges it with these.
 */
export function setSlashChat(on: boolean): void {
  document.body.classList.toggle("slash-chat", on);
  BUILTIN_COMMANDS = on ? tabCommandList(remotePage) : [];
  setCommands(engineCommands);
}
let pickerMatches: CommandLike[] = [];
let pickerIndex = 0;

export function setCommands(cmds: CommandLike[]): void {
  engineCommands = cmds;
  // Merge engine-provided commands with built-ins, de-duplicating by name.
  const byName = new Map<string, CommandLike>();
  for (const c of BUILTIN_COMMANDS) {
    byName.set(c.name, c);
  }
  for (const c of cmds) {
    if (c && c.name) {
      byName.set(c.name, c);
    }
  }
  allCommands = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The leading "/token" at the start of the input, or null. */
function slashQuery(): string | null {
  const v = inputEl.value;
  // Only trigger when the slash is the very first character and there is no
  // space yet (i.e. still typing the command name, not its arguments).
  const m = /^\/([a-zA-Z0-9_-]*)$/.exec(v);
  return m ? m[1] : null;
}

export function updatePicker(): void {
  const q = slashQuery();
  if (q === null) {
    hidePicker();
    return;
  }
  const ql = q.toLowerCase();
  pickerMatches = allCommands.filter((c) => c.name.toLowerCase().includes(ql));
  if (pickerMatches.length === 0) {
    hidePicker();
    return;
  }
  pickerIndex = 0;
  renderPicker();
}

function renderPicker(): void {
  pickerEl.innerHTML = "";
  pickerMatches.forEach((c, i) => {
    const item = div("cmd-item" + (i === pickerIndex ? " active" : ""));
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", i === pickerIndex ? "true" : "false");
    const name = div("cmd-name");
    name.textContent = "/" + c.name;
    item.appendChild(name);
    if (c.type && c.type !== "builtin") {
      const tag = div("cmd-tag");
      tag.textContent = c.type;
      item.appendChild(tag);
    }
    if (c.description) {
      const desc = div("cmd-desc");
      desc.textContent = c.description;
      item.appendChild(desc);
    }
    item.addEventListener("mousedown", (e) => {
      // mousedown (not click) so it fires before the textarea blur.
      e.preventDefault();
      chooseCommand(c);
    });
    pickerEl.appendChild(item);
  });
  pickerEl.classList.remove("hidden");
}

export function hidePicker(): void {
  pickerEl.classList.add("hidden");
  pickerEl.innerHTML = "";
  pickerMatches = [];
}

function pickerOpen(): boolean {
  return !pickerEl.classList.contains("hidden") && pickerMatches.length > 0;
}

/** Returns true if the picker consumed the key event. */
export function handlePickerKeydown(e: KeyboardEvent): boolean {
  if (!pickerOpen()) {
    return false;
  }
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      pickerIndex = (pickerIndex + 1) % pickerMatches.length;
      renderPicker();
      return true;
    case "ArrowUp":
      e.preventDefault();
      pickerIndex =
        (pickerIndex - 1 + pickerMatches.length) % pickerMatches.length;
      renderPicker();
      return true;
    case "Enter":
    case "Tab":
      e.preventDefault();
      chooseCommand(pickerMatches[pickerIndex]);
      return true;
    case "Escape":
      e.preventDefault();
      hidePicker();
      return true;
    default:
      return false;
  }
}

/** Insert the chosen command into the input (does not send). */
function chooseCommand(c: CommandLike): void {
  // Insert "/name " so the user can append arguments, then press Enter.
  inputEl.value = "/" + c.name + " ";
  const pos = inputEl.value.length;
  inputEl.setSelectionRange(pos, pos);
  inputEl.focus();
  hidePicker();
  autoGrow();
  // If the command expects an argument, show its hint as a ghost label.
  if (c.inputHint) {
    showHint(c.inputHint);
  } else {
    hideHint();
  }
}

function showHint(text: string): void {
  hintEl.textContent = "argument: " + text;
  hintEl.classList.remove("hidden");
}

export function hideHint(): void {
  hintEl.classList.add("hidden");
  hintEl.textContent = "";
}

/** Hide the hint once the user has typed an argument or cleared the command. */
export function updateHint(): void {
  if (hintEl.classList.contains("hidden")) {
    return;
  }
  const v = inputEl.value;
  const m = /^\/([a-zA-Z0-9_-]+)\s(.*)$/.exec(v);
  // Keep the hint only while the line is "/cmd " with no argument typed yet.
  if (!m || m[2].trim().length > 0) {
    hideHint();
  }
}
