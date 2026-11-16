// The card a slash command prints into (the terminal chat's output, with its
// colors as classes), and the Yes/No card a command asks with. Browser context.

import type { Segment } from "../ansiSegments";
import { div, isAtBottom, messagesEl, scrollToBottom, vscode } from "./ui";

const STYLES = new Set(["bold", "dim", "italic", "underline", "strike", "red", "green", "yellow", "blue", "magenta", "cyan", "gray"]);

function cardFor(run: number): HTMLElement | null {
  return messagesEl.querySelector<HTMLElement>(`.cmd-card[data-run="${run}"]`);
}

/** A command was typed: a card with the line, which its output fills. */
export function startCommandCard(run: number, text: string): void {
  const card = div("cmd-card");
  card.dataset.run = String(run);
  const head = div("cmd-card-head");
  head.textContent = text;
  card.appendChild(head);
  messagesEl.appendChild(card);
  scrollToBottom();
}

/** Output of command `run`. A card the chat no longer shows (it was cleared) is made again. */
export function addCommandOutput(run: number, segments: Segment[]): void {
  const follow = isAtBottom();
  let card = cardFor(run);
  if (!card) {
    card = div("cmd-card");
    card.dataset.run = String(run);
    messagesEl.appendChild(card);
  }
  const pre = document.createElement("pre");
  pre.className = "cmd-out";
  for (const seg of Array.isArray(segments) ? segments : []) {
    const span = document.createElement("span");
    span.textContent = String(seg?.text ?? "");
    for (const s of Array.isArray(seg?.styles) ? seg.styles : []) {
      if (STYLES.has(s)) {
        span.classList.add("ansi-" + s);
      }
    }
    pre.appendChild(span);
  }
  card.appendChild(pre);
  if (follow) {
    scrollToBottom();
  }
}

/** Someone answered on another screen: drop this one's question. */
export function dropConfirm(id: number): void {
  messagesEl.querySelector(`.cmd-confirm[data-id="${id}"]`)?.remove();
}

/** A command asks Yes or No (Esc or No: no). */
export function askConfirm(id: number, question: string): void {
  const card = div("cmd-confirm");
  card.dataset.id = String(id);
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", question);
  const q = div("cmd-confirm-q");
  q.textContent = question;
  card.appendChild(q);
  const row = div("approval-row");
  const answer = (yes: boolean): void => {
    vscode.postMessage({ type: "confirmAnswer", id, yes });
    card.replaceWith(Object.assign(div("msg system"), { textContent: `${question} ${yes ? "Yes" : "No"}` }));
  };
  for (const [label, yes, cls] of [["Yes", true, "allow"], ["No", false, "deny"]] as const) {
    const b = document.createElement("button");
    b.className = "approval-btn " + cls;
    b.textContent = label;
    b.addEventListener("click", () => answer(yes));
    row.appendChild(b);
  }
  card.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      answer(false);
    }
  });
  card.appendChild(row);
  (cardFor(id) ?? messagesEl).appendChild(card);
  row.querySelector("button")?.focus();
  scrollToBottom();
}
