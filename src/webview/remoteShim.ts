// Stands in for VS Code's webview API when the chat page runs in a plain
// browser (remote access). It pairs the device, lets the user pick a chat,
// streams that chat's messages into the page as `message` events and sends the
// page's messages to the extension. Loaded before webview.js, which asks for
// `acquireVsCodeApi()` as soon as it runs.

import { ChatInfo, chatLabel, fragmentSecret, GATE_TEXT, GateKind, parseChatList, pickChat } from "./remoteBoot";

type Msg = { type: string; [k: string]: unknown };

const LAST_CHAT_KEY = "kcc.lastChat";
const MAX_QUEUED = 20;

let chatId: string | undefined;
let source: EventSource | undefined;
let connected = false;
let flushing = false;
const queue: Msg[] = [];
let pageState: unknown;

// --- the API the chat page uses ---

(window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
  postMessage: (msg: Msg): void => {
    void transmit(msg);
  },
  getState: (): unknown => pageState,
  setState: (state: unknown): void => {
    pageState = state;
  },
});

const touchScreen = window.matchMedia("(pointer: coarse)").matches;

/** Hand a message to the chat page, as VS Code would. */
function deliver(data: unknown): void {
  // A phone keyboard has no Shift+Enter: Enter adds a line and the Send button sends.
  if (touchScreen && (data as Msg | undefined)?.type === "ready") {
    data = { ...(data as Msg), enterToSend: false };
  }
  window.dispatchEvent(new MessageEvent("message", { data }));
}

function notice(text: string): void {
  deliver({ type: "event", event: { kind: "notice", text, isError: true } });
}

// --- start-up screen and connection bar ---

const gate = document.createElement("div");
gate.id = "remote-gate";
gate.className = "remote-gate hidden";
gate.setAttribute("role", "dialog");
gate.setAttribute("aria-live", "polite");
const gateText = document.createElement("p");
const gateList = document.createElement("div");
gate.append(gateText, gateList);

const bar = document.createElement("div");
bar.id = "remote-bar";
bar.className = "remote-bar hidden";
bar.setAttribute("role", "status");
bar.textContent = "Reconnecting…";

// The chat being shown, and a way to change it: every chat of every window that shares remote access.
const chatSelect = document.createElement("select");
chatSelect.id = "remote-chats";
chatSelect.className = "toolbar-model";
chatSelect.title = "Chat";
chatSelect.setAttribute("aria-label", "Chat");
chatSelect.addEventListener("change", () => chatSelect.value && openChat(chatSelect.value));
document.getElementById("toolbar")?.prepend(chatSelect);
let knownChats: ChatInfo[] = [];
let listSource: EventSource | undefined;

function renderChatSelect(): void {
  chatSelect.replaceChildren(
    ...knownChats.map((c) => {
      const o = document.createElement("option");
      o.value = c.id;
      o.textContent = chatLabel(c, knownChats);
      return o;
    })
  );
  chatSelect.value = chatId ?? "";
}

/** Keep the dropdown current while the page is open (chats come and go, in any window). */
function followChats(): void {
  if (listSource) {
    return;
  }
  const es = new EventSource("/api/chats/events");
  listSource = es;
  es.addEventListener("chats", (e) => {
    try {
      knownChats = parseChatList(JSON.parse((e as MessageEvent<string>).data));
      renderChatSelect();
    } catch {
      // A malformed update is skipped; the next one replaces it.
    }
  });
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      listSource = undefined; // refused (unpaired): the chat's own stream says so
    }
  };
}

document.body.append(gate, bar);
document.body.classList.add("remote-page");
document.getElementById("input")?.setAttribute("placeholder", "Message Kiro…");

// On iOS the keyboard covers the page instead of shrinking it: follow the visible area.
const viewport = window.visualViewport;
if (viewport) {
  const fit = (): void => {
    document.documentElement.style.setProperty("--app-height", `${Math.round(viewport.height)}px`);
    window.scrollTo(0, 0);
  };
  viewport.addEventListener("resize", fit);
  viewport.addEventListener("scroll", fit);
  fit();
} // hides what only works on the desktop (see remote.css)

function showGate(kind: GateKind, chats: readonly ChatInfo[] = []): void {
  closeStream();
  bar.classList.add("hidden");
  gateText.textContent = GATE_TEXT[kind];
  const buttons = chats.map((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = chatLabel(c, chats);
    b.addEventListener("click", () => openChat(c.id));
    return b;
  });
  gateList.replaceChildren(...buttons);
  gate.classList.remove("hidden");
}

function hideGate(): void {
  gate.classList.add("hidden");
}

// --- talking to the extension ---

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, { credentials: "same-origin", ...init });
}

async function transmit(msg: Msg): Promise<void> {
  if (!connected || !chatId) {
    if (queue.length < MAX_QUEUED) {
      queue.push(msg);
    }
    return;
  }
  try {
    const r = await api(`/api/chats/${encodeURIComponent(chatId)}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg),
    });
    if (r.status === 204) {
      return;
    }
    if (r.status === 401) {
      showGate("removed");
      return;
    }
    const body = (await r.json().catch(() => ({}))) as { error?: unknown };
    notice(`Not sent: ${typeof body.error === "string" ? body.error : `error ${r.status}`}.`);
  } catch {
    // The network dropped: keep the message and send it when the stream is back.
    queue.unshift(msg);
    connected = false;
    bar.classList.remove("hidden");
  }
}

async function flush(): Promise<void> {
  if (flushing) {
    return;
  }
  flushing = true;
  try {
    while (queue.length > 0 && connected) {
      await transmit(queue.shift() as Msg);
    }
  } finally {
    flushing = false;
  }
}

function closeStream(): void {
  source?.close();
  source = undefined;
  connected = false;
}

function openChat(id: string): void {
  closeStream();
  chatId = id;
  try {
    localStorage.setItem(LAST_CHAT_KEY, id);
  } catch {
    // Storage can be blocked; the chat just is not remembered.
  }
  hideGate();
  followChats();
  renderChatSelect();
  const es = new EventSource(`/api/chats/${encodeURIComponent(id)}/events`);
  source = es;
  es.onmessage = (e) => {
    try {
      deliver(JSON.parse(e.data));
    } catch {
      // Ignore a malformed message rather than breaking the page.
    }
  };
  // A fresh snapshot follows: the page clears what it shows first.
  es.addEventListener("snapshot", () => deliver({ type: "cleared" }));
  es.addEventListener("gone", () => void showChoice("gone"));
  es.onopen = () => {
    connected = true;
    bar.classList.add("hidden");
    void flush();
  };
  es.onerror = () => {
    connected = false;
    if (es.readyState === EventSource.CLOSED) {
      // The server refused the stream (not paired any more, or the chat is gone).
      void showChoice("removed");
      return;
    }
    bar.classList.remove("hidden"); // the browser reconnects by itself and catches up
  };
}

/** Show the chats to choose from, or why there is nothing to show. */
async function showChoice(kind: GateKind): Promise<void> {
  const me = await api("/api/me").catch(() => undefined);
  if (!me) {
    return showGate("offline");
  }
  if (me.status === 401) {
    return showGate(kind === "gone" ? "unpaired" : "removed");
  }
  const list = await api("/api/chats").catch(() => undefined);
  if (!list || list.status === 403) {
    return showGate(list ? "denied" : "offline");
  }
  const chats = parseChatList(await list.json().catch(() => []));
  showGate(chats.length === 0 ? "noChats" : kind === "gone" ? "gone" : "pick", chats);
}

async function boot(): Promise<void> {
  const secret = fragmentSecret(location.hash);
  if (secret) {
    // The secret goes to the server once and leaves the address bar at once.
    history.replaceState(null, "", location.pathname + location.search);
    const r = await api("/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret }),
    }).catch(() => undefined);
    if (!r) {
      return showGate("offline");
    }
    if (!r.ok) {
      return showGate("badLink");
    }
  }
  const me = await api("/api/me").catch(() => undefined);
  if (!me) {
    return showGate("offline");
  }
  if (me.status === 401) {
    return showGate("unpaired");
  }
  const list = await api("/api/chats").catch(() => undefined);
  if (!list || !list.ok) {
    return showGate(list?.status === 403 ? "denied" : "offline");
  }
  const chats = parseChatList(await list.json().catch(() => []));
  if (chats.length === 0) {
    return showGate("noChats");
  }
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(LAST_CHAT_KEY);
  } catch {
    // Not remembered.
  }
  const open = pickChat(chats, saved);
  if (open) {
    openChat(open);
  } else {
    showGate("pick", chats);
  }
}

void boot();
