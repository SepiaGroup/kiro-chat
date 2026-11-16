// The hub's side of talking to another VS Code window: it follows that
// window's chat list and passes streams and messages through, over the other
// window's loopback server (see the /internal/ routes in remoteServer.ts).
// Also the other direction: a window calling the hub. Pure (http only).

import * as http from "http";
import type { MemberChat } from "./remoteServer";
import type { Permission, RemoteMessage } from "./remotePolicy";

export interface Peer {
  id: string;
  name: string;
  port: number;
}

interface ListItem {
  id: string;
  title: string;
  busy: boolean;
}

const RETRY_MS = 1500;
const CALL_TIMEOUT_MS = 8000;

/** A request to another window's internal API; resolves with the response (status checked by the caller). */
function open(peer: { port: number }, token: string, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const h: Record<string, string> = { Host: `127.0.0.1:${peer.port}`, Authorization: `Bearer ${token}`, ...headers };
    if (body !== undefined) {
      h["Content-Type"] = "application/json";
      h["Content-Length"] = String(Buffer.byteLength(body));
    }
    const req = http.request({ host: "127.0.0.1", port: peer.port, method, path, headers: h }, resolve);
    req.on("error", reject);
    req.end(body);
  });
}

async function readAll(res: http.IncomingMessage, max = 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of res) {
    size += (c as Buffer).length;
    if (size > max) {
      res.destroy();
      throw new Error("answer too large");
    }
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** One call with a deadline: the JSON answer, or undefined for a 204. Throws on any other status. */
export async function callPeer(peer: { port: number }, token: string, method: string, path: string, json?: unknown): Promise<unknown> {
  const timer = new AbortController();
  const deadline = setTimeout(() => timer.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await Promise.race([
      open(peer, token, method, path, {}, json === undefined ? undefined : JSON.stringify(json)),
      new Promise<never>((_, reject) => timer.signal.addEventListener("abort", () => reject(new Error("no answer in time")))),
    ]);
    if (res.statusCode === 204) {
      res.resume();
      return undefined;
    }
    const text = await readAll(res);
    if (res.statusCode !== 200) {
      let detail = "";
      try {
        detail = String((JSON.parse(text) as { error?: unknown }).error ?? "");
      } catch {
        // Not JSON.
      }
      throw new Error(`${res.statusCode}${detail ? ` ${detail}` : ""}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(deadline);
  }
}

/** The hub's view of one other window. */
export class MemberConnection {
  private items: ListItem[] = [];
  private name: string;
  private req?: http.ClientRequest;
  private retry?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    readonly peer: Peer,
    private readonly token: string,
    /** The window's chats or title changed. */
    private readonly onChange: () => void,
    private readonly log: (line: string) => void = () => undefined
  ) {
    this.name = peer.name;
  }

  /** Start following the window's chat list. */
  start(): void {
    this.stopped = false;
    this.follow();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.req?.destroy();
    this.req = undefined;
    if (this.items.length > 0) {
      this.items = [];
      this.onChange();
    }
  }

  /** The window's chats, as the phone opens them. */
  chats(): MemberChat[] {
    return this.items.map((c) => ({
      id: `${this.peer.id}.${c.id}`,
      title: c.title,
      busy: c.busy,
      window: this.name,
      stream: (last) => this.openStream(c.id, last),
      send: (msg, device, granted) => this.send(c.id, msg, device, granted),
    }));
  }

  private async openStream(innerId: string, last: string | undefined): Promise<http.IncomingMessage> {
    const res = await open(this.peer, this.token, "GET", `/internal/chats/${encodeURIComponent(innerId)}/events`, last ? { "Last-Event-ID": last } : {});
    if (res.statusCode !== 200) {
      res.resume();
      throw new Error(`the window answered ${res.statusCode}`);
    }
    return res;
  }

  private async send(innerId: string, msg: RemoteMessage, device: { id: string; name: string }, granted: readonly Permission[]): Promise<void> {
    await callPeer(this.peer, this.token, "POST", `/internal/chats/${encodeURIComponent(innerId)}/message`, { msg, device, permissions: granted });
  }

  private follow(): void {
    if (this.stopped) {
      return;
    }
    const req = http.request(
      { host: "127.0.0.1", port: this.peer.port, method: "GET", path: "/internal/chats/events", headers: { Host: `127.0.0.1:${this.peer.port}`, Authorization: `Bearer ${this.token}` } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          this.log(`window ${this.name} answered ${res.statusCode}`);
          return this.again();
        }
        res.setEncoding("utf8");
        let buffer = "";
        res.on("data", (chunk: string) => {
          buffer += chunk;
          let at: number;
          while ((at = buffer.indexOf("\n\n")) !== -1) {
            this.frame(buffer.slice(0, at));
            buffer = buffer.slice(at + 2);
          }
        });
        res.on("end", () => this.again());
        res.on("error", () => this.again());
      }
    );
    req.on("error", () => this.again());
    req.end();
    this.req = req;
  }

  private frame(text: string): void {
    let event = "message";
    let data = "";
    for (const line of text.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        data += line.slice(5).trim();
      }
    }
    if (event !== "chats" || !data) {
      return;
    }
    try {
      const v = JSON.parse(data) as { window?: unknown; chats?: unknown };
      const chats = Array.isArray(v.chats)
        ? v.chats.filter((c): c is ListItem => !!c && typeof c.id === "string" && typeof c.title === "string").map((c) => ({ id: c.id, title: c.title.slice(0, 200), busy: c.busy === true }))
        : [];
      this.name = typeof v.window === "string" && v.window ? v.window.slice(0, 80) : this.peer.name;
      this.items = chats;
      this.onChange();
    } catch {
      // A malformed update is skipped; the next one replaces it.
    }
  }

  private again(): void {
    if (this.stopped) {
      return;
    }
    if (this.items.length > 0) {
      this.items = []; // not reachable: its chats are not offered
      this.onChange();
    }
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.follow(), RETRY_MS);
    this.retry.unref();
  }
}
