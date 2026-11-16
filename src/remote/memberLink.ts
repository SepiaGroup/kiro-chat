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
/** Most of a chat-list stream kept while waiting for the end of an event. */
const MAX_FRAME = 1024 * 1024;

function request(peer: { port: number }, token: string, method: string, path: string, headers: Record<string, string> = {}, body?: string): http.ClientRequest {
  const h: Record<string, string> = { Host: `127.0.0.1:${peer.port}`, Authorization: `Bearer ${token}`, ...headers };
  if (body !== undefined) {
    h["Content-Type"] = "application/json";
    h["Content-Length"] = String(Buffer.byteLength(body));
  }
  const req = http.request({ host: "127.0.0.1", port: peer.port, method, path, headers: h });
  req.end(body);
  return req;
}

/** A request to another window's internal API; resolves with the response once its headers arrive (in time). */
function open(peer: { port: number }, token: string, method: string, path: string, headers: Record<string, string> = {}): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request(peer, token, method, path, headers);
    const deadline = setTimeout(() => req.destroy(new Error("no answer in time")), CALL_TIMEOUT_MS);
    req.on("response", (res) => {
      clearTimeout(deadline);
      resolve(res);
    });
    req.on("error", (err) => {
      clearTimeout(deadline);
      reject(err);
    });
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

/**
 * One call, with one deadline for all of it (connecting, the headers and the
 * body): when it passes, the request is closed, not just given up on. The JSON
 * answer, or undefined for a 204. Throws on any other status.
 */
export function callPeer(peer: { port: number }, token: string, method: string, path: string, json?: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(peer, token, method, path, {}, json === undefined ? undefined : JSON.stringify(json));
    const deadline = setTimeout(() => req.destroy(new Error("no answer in time")), timeoutMs);
    const settle = (fn: () => void): void => {
      clearTimeout(deadline);
      fn();
    };
    req.on("error", (err) => settle(() => reject(err)));
    req.on("response", (res) => {
      if (res.statusCode === 204) {
        res.resume();
        return settle(() => resolve(undefined));
      }
      readAll(res).then(
        (text) =>
          settle(() => {
            if (res.statusCode !== 200) {
              let detail = "";
              try {
                detail = String((JSON.parse(text) as { error?: unknown }).error ?? "");
              } catch {
                // Not JSON.
              }
              return reject(new Error(`${res.statusCode}${detail ? ` ${detail}` : ""}`));
            }
            try {
              resolve(JSON.parse(text));
            } catch (err) {
              reject(err);
            }
          }),
        (err: unknown) => settle(() => reject(err))
      );
    });
  });
}

/**
 * Server-sent events from a byte stream, as the EventSource spec reads them:
 * lines end in \n, \r\n or \r, a blank line ends an event, data lines are
 * joined with \n, one space after the colon is dropped. Pure.
 */
export class SseReader {
  private buffer = "";
  /** The last chunk ended in \r: a \n first in the next one belongs to it. */
  private lastCR = false;

  constructor(private readonly onEvent: (event: string, data: string) => void) {}

  /** Feed text; false when an event grew past `max` (the caller should drop the stream). */
  push(chunk: string, max = MAX_FRAME): boolean {
    if (this.lastCR && chunk.startsWith("\n")) {
      chunk = chunk.slice(1);
    }
    this.lastCR = chunk.endsWith("\r");
    const events = (this.buffer + chunk.replace(/\r\n?/g, "\n")).split("\n\n");
    this.buffer = events.pop() ?? "";
    for (const e of events) {
      this.dispatch(e);
    }
    return this.buffer.length <= max;
  }

  private dispatch(block: string): void {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) {
        value = value.slice(1);
      }
      if (field === "event") {
        event = value;
      } else if (field === "data") {
        data.push(value);
      }
    }
    if (data.length > 0) {
      this.onEvent(event, data.join("\n"));
    }
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
        const reader = new SseReader((event, data) => event === "chats" && this.list(data));
        res.on("data", (chunk: string) => {
          if (!reader.push(chunk)) {
            this.log(`window ${this.name} sent an event that is too large`);
            req.destroy();
            this.again();
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

  private list(data: string): void {
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
