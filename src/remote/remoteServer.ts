// The HTTP server behind remote access. It listens on the loopback address
// only (Tailscale or another tunnel carries traffic to it), serves the chat
// page, pairs devices, streams a chat's messages (Server-Sent Events) and
// takes a device's messages after the policy has checked them.
// Pure (no vscode import): chats come in through the RemoteChat interface.

import * as http from "http";
import { AddressInfo } from "net";
import {
  hashSecret,
  safeEqual,
  clearedCookie,
  cleanDeviceName,
  COOKIE_NAME,
  deviceCookie,
  DeviceRecord,
  DeviceStore,
  deviceNameFromUserAgent,
  PairingCode,
  parseCookies,
  RateLimiter,
} from "./remoteAuth";
import { EventLog } from "./eventLog";
import { checkRemoteMessage, Permission, RemoteMessage } from "./remotePolicy";
import { remotePageHtml, SECURITY_HEADERS } from "./remotePage";

/** What the server needs from a chat (ChatSession implements it). */
export interface RemoteChat {
  readonly id: string;
  readonly title: string;
  readonly busy: boolean;
  /** The chat so far, as messages for a page that has none yet. */
  snapshot(): unknown[];
  /** A message from a remote device that passed the policy. `granted` is what the device may do (a chat checks the commands it runs against it). */
  send(msg: RemoteMessage, device: { id: string; name: string }, granted: readonly Permission[]): Promise<void>;
  /** Live messages, in order. Returns the way to stop. */
  subscribe(listener: (msg: unknown) => void): () => void;
}

/**
 * A chat that lives in another VS Code window. The window that owns the
 * address (the hub) lists it and passes its stream and messages through.
 */
export interface MemberChat {
  /** The id the phone uses (it carries the window's id, so it cannot clash). */
  readonly id: string;
  readonly title: string;
  readonly busy: boolean;
  /** The window's name, shown next to the chat. */
  readonly window: string;
  /** Open the chat's stream in its window. `lastEventId` asks for a catch-up. Rejects when the window does not answer. */
  stream(lastEventId: string | undefined): Promise<http.IncomingMessage>;
  send(msg: RemoteMessage, device: { id: string; name: string }, granted: readonly Permission[]): Promise<void>;
}

/** What only the hub can do, offered to the other windows (they call it instead of doing it themselves). */
export interface HubApi {
  /** A new one-use pairing link. `retry` first tries again to share the address on the tailnet. */
  pairLink(retry: boolean): Promise<{ link: string; shared: boolean; problem?: { advice: string; enableUrl?: string } }>;
  devices(): Array<{ id: string; name: string; lastSeen: number }>;
  removeDevices(ids: string[] | "all"): void;
}

export interface RemoteAsset {
  body: string | Buffer;
  type: string;
}

export interface RemoteServerOptions {
  chats(): readonly RemoteChat[];
  /** This window's name, shown next to its chats on the phone. */
  windowName?: string;
  /** Chats of other windows (set on the hub). */
  members?(): readonly MemberChat[];
  /**
   * The routes the other windows use (under /internal/, loopback only, with this
   * secret). Without it there are none.
   */
  internal?: { token: string };
  /** False while this window is not the hub: the page and the device API then do not answer. Default true. */
  publicApi?(): boolean;
  /** Set on the hub. */
  hubApi?: HubApi;
  devices: DeviceStore;
  pairing: PairingCode;
  /** What devices may do right now (read per request, so a setting change applies at once). */
  permissions(): readonly Permission[];
  /** Files under /static/ (script, styles, manifest, icon); undefined = not found. */
  assets(name: string): RemoteAsset | undefined;
  /** Cookies get `Secure` unless the request came straight to loopback over plain HTTP (a proxy in front means HTTPS). */
  secureCookies?(host: string | undefined): boolean;
  /** Host names the server answers to besides loopback (e.g. the tailnet name). */
  allowedHosts?(): readonly string[];
  /** A device just paired. */
  onPaired?(device: DeviceRecord): void;
  /** A device opened or closed a stream (count changed). */
  onClients?(): void;
  log?(line: string): void;
  /** Messages kept per chat for catching up. */
  logSize?: number;
  heartbeatMs?: number;
  now?: () => number;
}

interface Client {
  res: http.ServerResponse;
  device: string;
  timer: NodeJS.Timeout;
  /** Another window of ours, not a device: not counted. */
  internal?: boolean;
}

/** A phone's stream of a chat that lives in another window. */
interface Relay {
  res: http.ServerResponse;
  device: string;
  chatId: string;
  up: http.IncomingMessage;
}

interface Feed {
  chat: RemoteChat;
  log: EventLog;
  clients: Set<Client>;
  unsubscribe(): void;
}

/** How long a message waits for its chat before the answer (see handOver). */
const ACCEPT_MS = 1000;
/** A prompt with a few photos as base64 in JSON. Smaller than the chat's own limits (10 images of 10 MB): this comes over the network. */
const MAX_BODY = 32 * 1024 * 1024;
const MAX_SMALL_BODY = 4 * 1024;
const MAX_STREAMS_PER_DEVICE = 8;
/** A browser that cannot keep up is dropped; it reconnects and catches up. */
const MAX_BUFFERED = 4 * 1024 * 1024;

export class RemoteServer {
  private server?: http.Server;
  private readonly feeds = new Map<string, Feed>();
  private readonly listClients = new Set<Client>();
  private readonly internalLists = new Set<Client>();
  private readonly relays = new Set<Relay>();
  /** Relays being opened (waiting for the other window), counted against the device's limit. */
  private readonly pendingRelays = new Map<string, number>();
  private readonly pairLimiter: RateLimiter;

  constructor(private readonly opts: RemoteServerOptions) {
    this.pairLimiter = new RateLimiter(10, 60_000, opts.now);
  }

  /** Start on a loopback address. Port 0 picks a free one; returns the port. */
  async start(port = 0, host = "127.0.0.1"): Promise<number> {
    if (host !== "127.0.0.1" && host !== "::1") {
      throw new Error("Remote access only listens on the loopback address.");
    }
    if (this.server) {
      throw new Error("Remote access is already running.");
    }
    const server = http.createServer((req, res) => void this.handle(req, res));
    server.requestTimeout = 0; // streams stay open; bodies are limited by size instead
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (err) {
      this.server = undefined; // so a retry (another port) is allowed
      throw err;
    }
    return (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const feed of this.feeds.values()) {
      feed.unsubscribe();
      for (const c of feed.clients) {
        this.endClient(c);
      }
    }
    this.feeds.clear();
    for (const c of this.listClients) {
      this.endClient(c);
    }
    this.listClients.clear();
    for (const c of this.internalLists) {
      this.endClient(c);
    }
    this.internalLists.clear();
    for (const r of [...this.relays]) {
      this.endRelay(r);
    }
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /** Number of open streams (a device with the chat open counts once per chat). */
  get streamCount(): number {
    let n = this.listClients.size + this.relays.size;
    for (const f of this.feeds.values()) {
      f.clients.forEach((c) => c.internal || n++);
    }
    return n;
  }

  /** Devices with at least one open stream. */
  get connectedDevices(): string[] {
    const ids = new Set<string>();
    for (const f of this.feeds.values()) {
      f.clients.forEach((c) => c.internal || ids.add(c.device));
    }
    this.listClients.forEach((c) => ids.add(c.device));
    this.relays.forEach((r) => ids.add(r.device));
    return [...ids];
  }

  /** The set of chats or a title changed: tell lists, and drop streams of chats that are gone. */
  chatsChanged(): void {
    const live = new Set([...this.opts.chats(), ...(this.opts.members?.() ?? [])].map((c) => c.id));
    for (const r of [...this.relays]) {
      if (!live.has(r.chatId)) {
        r.res.write("event: gone\ndata: {}\n\n");
        this.endRelay(r);
      }
    }
    for (const [id, feed] of [...this.feeds]) {
      if (!live.has(id)) {
        feed.unsubscribe();
        for (const c of feed.clients) {
          this.sse(c, "gone", "{}");
          this.endClient(c);
        }
        this.feeds.delete(id);
      }
    }
    const list = JSON.stringify(this.chatList());
    for (const c of this.listClients) {
      this.sse(c, "chats", list);
    }
    const own = JSON.stringify(this.internalList());
    for (const c of this.internalLists) {
      this.sse(c, "chats", own);
    }
  }

  /** A device was removed: close its streams. Its cookie stops working with the store entry. */
  disconnectDevice(id: string): void {
    for (const feed of this.feeds.values()) {
      for (const c of [...feed.clients]) {
        if (c.device === id) {
          this.endClient(c);
        }
      }
    }
    for (const c of [...this.listClients]) {
      if (c.device === id) {
        this.endClient(c);
      }
    }
    for (const r of [...this.relays]) {
      if (r.device === id) {
        this.endRelay(r);
      }
    }
  }

  // --- requests ---

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
        res.setHeader(k, v);
      }
      if (!this.hostAllowed(req.headers.host)) {
        return this.fail(res, 421, "unknown host");
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";

      if (path.startsWith("/internal/")) {
        return await this.internalRoute(req, res, method, path, url);
      }
      if (this.opts.publicApi && !this.opts.publicApi()) {
        return this.fail(res, 404, "not found"); // another window answers for remote access
      }

      if (method === "GET" && (path === "/" || path === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(remotePageHtml());
        return;
      }
      if (method === "GET" && path.startsWith("/static/")) {
        return this.serveAsset(res, path.slice("/static/".length));
      }
      if (!path.startsWith("/api/")) {
        return this.fail(res, 404, "not found");
      }
      res.setHeader("Cache-Control", "no-store");
      if (!this.sameOrigin(req)) {
        return this.fail(res, 403, "cross-site request");
      }
      if (method === "POST" && path === "/api/pair") {
        return await this.pair(req, res);
      }

      const device = this.opts.devices.authenticate(parseCookies(req.headers.cookie)[COOKIE_NAME]);
      if (!device) {
        return this.fail(res, 401, "not paired");
      }
      const granted = this.opts.permissions();

      if (method === "GET" && path === "/api/me") {
        return this.json(res, 200, { device: { id: device.id, name: device.name }, permissions: granted });
      }
      if (method === "POST" && path === "/api/logout") {
        this.opts.devices.remove(device.id);
        this.disconnectDevice(device.id);
        res.setHeader("Set-Cookie", clearedCookie(this.secure(req)));
        return this.json(res, 200, { ok: true });
      }
      if (method === "GET" && path === "/api/chats") {
        if (!granted.includes("view")) {
          return this.fail(res, 403, "this device may not view chats");
        }
        return this.json(res, 200, this.chatList());
      }
      if (method === "GET" && path === "/api/chats/events") {
        if (!granted.includes("view")) {
          return this.fail(res, 403, "this device may not view chats");
        }
        return this.openListStream(req, res, device);
      }
      const m = /^\/api\/chats\/([^/]+)\/(events|message)$/.exec(path);
      if (m) {
        const found = this.findChat(decodeURIComponent(m[1]));
        if (!found) {
          return this.fail(res, 404, "no such chat");
        }
        if (method === "GET" && m[2] === "events") {
          if (!granted.includes("view")) {
            return this.fail(res, 403, "this device may not view chats");
          }
          const last = lastEventId(req, url);
          return found.kind === "here" ? this.openChatStream(req, res, device, found.chat, last) : await this.openRelay(req, res, device, found.chat, last);
        }
        if (method === "POST" && m[2] === "message") {
          return await this.message(req, res, device, found.chat, granted);
        }
      }
      return this.fail(res, method === "GET" || method === "POST" ? 404 : 405, "not found");
    } catch (err) {
      this.opts.log?.(`request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        this.fail(res, 500, "server error");
      } else {
        res.end();
      }
    }
  }

  private async pair(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.pairLimiter.allow("pair")) {
      return this.fail(res, 429, "too many attempts, wait a minute");
    }
    const body = await this.readJson(req, res, MAX_SMALL_BODY);
    if (body === undefined) {
      return;
    }
    const b = body as { secret?: unknown; name?: unknown };
    if (!this.opts.pairing.redeem(b.secret)) {
      this.opts.log?.("pairing refused: wrong or expired code");
      return this.fail(res, 401, "this pairing link is not valid any more");
    }
    const name = cleanDeviceName(b.name) || deviceNameFromUserAgent(req.headers["user-agent"]);
    const { device, token } = this.opts.devices.add(name);
    res.setHeader("Set-Cookie", deviceCookie(token, this.secure(req)));
    this.opts.log?.(`paired device ${device.id} (${device.name})`);
    this.opts.onPaired?.(device);
    this.json(res, 200, { device: { id: device.id, name: device.name } });
  }

  private async message(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    device: DeviceRecord,
    chat: RemoteChat | MemberChat,
    granted: readonly Permission[]
  ): Promise<void> {
    const body = await this.readJson(req, res, MAX_BODY);
    if (body === undefined) {
      return;
    }
    const checked = checkRemoteMessage(body, granted);
    if (!checked.ok) {
      const type = (body as { type?: unknown } | null)?.type;
      this.opts.log?.(`refused ${typeof type === "string" ? type.slice(0, 40) : "?"} from ${device.id}: ${checked.reason}`);
      return this.fail(res, checked.status, checked.reason);
    }
    if (!(await this.handOver(() => chat.send(checked.msg, { id: device.id, name: device.name }, granted), device.id))) {
      return this.fail(res, 500, "the chat could not take that");
    }
    res.writeHead(204);
    res.end();
  }

  /**
   * Give a message to its chat and say whether it took it. A prompt's send
   * lasts until the reply ends, so this waits only ACCEPT_MS: after that it
   * counts as taken (the chat shows its own errors; a late failure is logged).
   */
  private async handOver(send: () => Promise<void>, deviceId: string): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = send().then(
      () => true,
      (err: unknown) => {
        this.opts.log?.(`message from ${deviceId} failed: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    );
    const ok = await Promise.race([settled, new Promise<boolean>((r) => (timer = setTimeout(() => r(true), ACCEPT_MS)))]);
    clearTimeout(timer);
    return ok;
  }

  // --- streams ---

  private feedFor(chat: RemoteChat): Feed {
    let feed = this.feeds.get(chat.id);
    if (!feed) {
      const created: Feed = {
        chat,
        log: new EventLog(this.opts.logSize ?? 2000),
        clients: new Set(),
        unsubscribe: () => undefined,
      };
      created.unsubscribe = chat.subscribe((msg) => {
        const seq = created.log.push(msg);
        const data = JSON.stringify(msg);
        for (const c of created.clients) {
          this.sse(c, undefined, data, created.log.idOf(seq));
        }
      });
      this.feeds.set(chat.id, created);
      feed = created;
    }
    return feed;
  }

  private openChatStream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    device: DeviceRecord,
    chat: RemoteChat,
    lastEventId: string | undefined,
    internal = false
  ): void {
    if (!internal && this.streamsOf(device.id) >= MAX_STREAMS_PER_DEVICE) {
      return this.fail(res, 429, "too many open chats on this device");
    }
    const feed = this.feedFor(chat);
    const client = this.startStream(req, res, device, feed.clients, internal);
    const last = feed.log.parseId(lastEventId);
    const missed = last === undefined ? undefined : feed.log.after(last);
    if (missed) {
      for (const e of missed) {
        this.sse(client, undefined, JSON.stringify(e.msg), feed.log.idOf(e.seq));
      }
    } else {
      // Tells a page that already shows this chat to clear it before the snapshot arrives.
      this.sse(client, "snapshot", "{}");
      for (const msg of chat.snapshot()) {
        this.sse(client, undefined, JSON.stringify(msg));
      }
      // The snapshot is as of now: this id is where live messages continue.
      this.sse(client, "sync", "{}", feed.log.idOf(feed.log.lastSeq));
    }
    if (!internal) {
      this.opts.onClients?.();
    }
  }

  /** A chat of this window, or of another one (on the hub). */
  private findChat(id: string): { kind: "here"; chat: RemoteChat } | { kind: "member"; chat: MemberChat } | undefined {
    const here = this.opts.chats().find((c) => c.id === id);
    if (here) {
      return { kind: "here", chat: here };
    }
    const member = this.opts.members?.().find((c) => c.id === id);
    return member ? { kind: "member", chat: member } : undefined;
  }

  /** A phone's stream of a chat in another window: the other window's own stream, passed through. */
  private async openRelay(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    device: DeviceRecord,
    chat: MemberChat,
    lastEventId: string | undefined
  ): Promise<void> {
    if (this.streamsOf(device.id) >= MAX_STREAMS_PER_DEVICE) {
      return this.fail(res, 429, "too many open chats on this device");
    }
    // Hold the slot while waiting, so several at once cannot all pass the check above.
    this.pendingRelays.set(device.id, (this.pendingRelays.get(device.id) ?? 0) + 1);
    let up: http.IncomingMessage;
    try {
      up = await chat.stream(lastEventId);
    } catch (err) {
      this.opts.log?.(`stream of ${chat.window} failed: ${err instanceof Error ? err.message : String(err)}`);
      return this.fail(res, 502, "that VS Code window does not answer");
    } finally {
      const n = (this.pendingRelays.get(device.id) ?? 1) - 1;
      if (n > 0) {
        this.pendingRelays.set(device.id, n);
      } else {
        this.pendingRelays.delete(device.id);
      }
    }
    if (req.destroyed) {
      up.destroy();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders(); // the page knows the stream is open before the other window sends anything
    const relay: Relay = { res, device: device.id, chatId: chat.id, up };
    this.relays.add(relay);
    up.on("data", (chunk: Buffer) => {
      res.write(chunk);
      if (res.writableLength > MAX_BUFFERED) {
        this.opts.log?.(`dropping a slow stream of ${device.id}`);
        this.endRelay(relay);
      }
    });
    up.on("end", () => this.endRelay(relay));
    up.on("error", () => this.endRelay(relay));
    req.on("close", () => this.endRelay(relay));
    this.opts.onClients?.();
  }

  private endRelay(r: Relay): void {
    if (!this.relays.delete(r)) {
      return;
    }
    r.up.destroy();
    if (!r.res.writableEnded) {
      r.res.end();
    }
    this.opts.onClients?.();
  }

  private openListStream(req: http.IncomingMessage, res: http.ServerResponse, device: DeviceRecord): void {
    if (this.streamsOf(device.id) >= MAX_STREAMS_PER_DEVICE) {
      return this.fail(res, 429, "too many open streams on this device");
    }
    const client = this.startStream(req, res, device, this.listClients);
    this.sse(client, "chats", JSON.stringify(this.chatList()));
    this.opts.onClients?.();
  }

  private startStream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    device: DeviceRecord,
    into: Set<Client>,
    internal = false
  ): Client {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");
    const timer = setInterval(() => res.write(": ping\n\n"), this.opts.heartbeatMs ?? 15_000);
    timer.unref();
    const client: Client = { res, device: device.id, timer, internal };
    into.add(client);
    req.on("close", () => {
      clearInterval(timer);
      into.delete(client);
      if (!internal) {
        this.opts.onClients?.();
      }
    });
    return client;
  }

  private streamsOf(device: string): number {
    let n = 0;
    for (const f of this.feeds.values()) {
      f.clients.forEach((c) => c.device === device && n++);
    }
    this.listClients.forEach((c) => c.device === device && n++);
    this.relays.forEach((r) => r.device === device && n++);
    return n + (this.pendingRelays.get(device) ?? 0);
  }

  private sse(c: Client, event: string | undefined, data: string, id?: string): void {
    if (c.res.writableEnded || c.res.destroyed) {
      return;
    }
    c.res.write(`${id ? `id: ${id}\n` : ""}${event ? `event: ${event}\n` : ""}data: ${data}\n\n`);
    if (c.res.writableLength > MAX_BUFFERED) {
      this.opts.log?.(`dropping a slow stream of ${c.device}`);
      this.endClient(c);
    }
  }

  private endClient(c: Client): void {
    clearInterval(c.timer);
    if (!c.res.writableEnded) {
      c.res.end();
    }
  }

  // --- helpers ---

  /** Every chat the phone can open: this window's, then the other windows'. */
  private chatList(): Array<{ id: string; title: string; busy: boolean; window: string }> {
    const mine = this.opts.chats().map((c) => ({ id: c.id, title: c.title, busy: c.busy, window: this.windowName() }));
    const others = (this.opts.members?.() ?? []).map((c) => ({ id: c.id, title: c.title, busy: c.busy, window: c.window }));
    return [...mine, ...others];
  }

  private windowName(): string {
    return this.opts.windowName ?? "VS Code";
  }

  /** What another window is told about this one's chats. */
  private internalList(): { window: string; chats: Array<{ id: string; title: string; busy: boolean }> } {
    return { window: this.windowName(), chats: this.opts.chats().map((c) => ({ id: c.id, title: c.title, busy: c.busy })) };
  }

  // --- the routes the other windows use ---

  private async internalRoute(req: http.IncomingMessage, res: http.ServerResponse, method: string, path: string, url: URL): Promise<void> {
    const token = this.opts.internal?.token;
    const auth = req.headers.authorization;
    // Loopback Host and the secret: what comes through the tailnet address has neither.
    // The caller gets a plain 404 either way; the log says which (never the token).
    const refused = !token
      ? "this window takes no internal calls"
      : !isLoopbackHost(req.headers.host)
        ? "not a loopback Host"
        : typeof auth !== "string" || !auth.startsWith("Bearer ")
          ? "no token"
          : !safeEqual(hashSecret(auth.slice(7)), hashSecret(token))
            ? "wrong token"
            : undefined;
    if (refused) {
      this.opts.log?.(`internal ${method} ${path} refused: ${refused}`);
      return this.fail(res, 404, "not found");
    }
    res.setHeader("Cache-Control", "no-store");
    const hub = this.opts.hubApi && (this.opts.publicApi?.() ?? true) ? this.opts.hubApi : undefined;
    const internalDevice: DeviceRecord = { id: "hub", name: "hub", tokenHash: "", createdAt: 0, lastSeen: 0 };

    if (method === "GET" && path === "/internal/chats") {
      return this.json(res, 200, this.internalList());
    }
    if (method === "GET" && path === "/internal/chats/events") {
      const client = this.startStream(req, res, internalDevice, this.internalLists, true);
      this.sse(client, "chats", JSON.stringify(this.internalList()));
      return;
    }
    const m = /^\/internal\/chats\/([^/]+)\/(events|message)$/.exec(path);
    if (m) {
      const chat = this.opts.chats().find((c) => c.id === decodeURIComponent(m[1]));
      if (!chat) {
        return this.fail(res, 404, "no such chat");
      }
      if (method === "GET" && m[2] === "events") {
        return this.openChatStream(req, res, internalDevice, chat, lastEventId(req, url), true);
      }
      if (method === "POST" && m[2] === "message") {
        const body = (await this.readJson(req, res, MAX_BODY)) as { msg?: unknown; device?: { id?: unknown; name?: unknown }; permissions?: unknown } | undefined;
        if (body === undefined) {
          return;
        }
        // The hub already checked this; checking again costs nothing and covers a bug on either side.
        const granted = parsePermissionList(body.permissions);
        const checked = checkRemoteMessage(body.msg, granted);
        if (!checked.ok) {
          return this.fail(res, checked.status, checked.reason);
        }
        const device = { id: String(body.device?.id ?? "").slice(0, 40), name: cleanDeviceName(body.device?.name) || "Device" };
        if (!(await this.handOver(() => chat.send(checked.msg, device, granted), device.id))) {
          return this.fail(res, 500, "the chat could not take that");
        }
        res.writeHead(204);
        res.end();
        return;
      }
    }
    if (hub && method === "POST" && path === "/internal/pair-link") {
      const body = (await this.readJson(req, res, MAX_SMALL_BODY)) as { retry?: unknown } | undefined;
      if (body === undefined) {
        return;
      }
      return this.json(res, 200, await hub.pairLink(body.retry === true));
    }
    if (hub && method === "GET" && path === "/internal/devices") {
      return this.json(res, 200, hub.devices());
    }
    if (hub && method === "POST" && path === "/internal/devices/remove") {
      const body = (await this.readJson(req, res, MAX_SMALL_BODY)) as { ids?: unknown } | undefined;
      if (body === undefined) {
        return;
      }
      const ids = body.ids === "all" ? "all" : Array.isArray(body.ids) ? body.ids.filter((i): i is string => typeof i === "string").slice(0, 100) : [];
      hub.removeDevices(ids);
      res.writeHead(204);
      res.end();
      return;
    }
    if (!hub && /^\/internal\/(pair-link|devices)/.test(path)) {
      this.opts.log?.(`internal ${method} ${path} refused: this window is not the hub`);
    }
    return this.fail(res, 404, "not found");
  }

  private serveAsset(res: http.ServerResponse, name: string): void {
    const asset = /^[A-Za-z0-9._-]+$/.test(name) ? this.opts.assets(name) : undefined;
    if (!asset) {
      return this.fail(res, 404, "not found");
    }
    res.writeHead(200, { "Content-Type": asset.type, "Cache-Control": "no-cache" });
    res.end(asset.body);
  }

  private secure(req: http.IncomingMessage): boolean {
    return this.opts.secureCookies ? this.opts.secureCookies(req.headers.host) : !isLoopbackHost(req.headers.host);
  }

  private hostAllowed(host: string | undefined): boolean {
    const allowed = this.opts.allowedHosts?.();
    if (!allowed) {
      return true;
    }
    const name = hostName(host);
    return isLoopbackName(name) || allowed.some((h) => h.toLowerCase() === name);
  }

  /** Same-origin only: a page on another site must not be able to use a paired browser's cookie. */
  private sameOrigin(req: http.IncomingMessage): boolean {
    const site = req.headers["sec-fetch-site"];
    if (typeof site === "string" && site !== "same-origin" && site !== "none") {
      return false;
    }
    const origin = req.headers.origin;
    if (typeof origin === "string") {
      try {
        return new URL(origin).host === req.headers.host;
      } catch {
        return false;
      }
    }
    return true;
  }

  /** The JSON body, or undefined after an error response was sent. */
  private readJson(req: http.IncomingMessage, res: http.ServerResponse, max: number): Promise<unknown> {
    return new Promise((resolve) => {
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
        this.fail(res, 415, "send JSON");
        resolve(undefined);
        return;
      }
      const declared = Number(req.headers["content-length"] ?? 0);
      if (declared > max) {
        res.setHeader("Connection", "close");
        this.fail(res, 413, "too large");
        resolve(undefined);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      req.on("data", (chunk: Buffer) => {
        if (done) {
          return;
        }
        size += chunk.length;
        if (size > max) {
          done = true;
          res.setHeader("Connection", "close"); // the rest of the body is not read
          this.fail(res, 413, "too large");
          resolve(undefined);
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (done) {
          return;
        }
        done = true;
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          this.fail(res, 400, "not valid JSON");
          resolve(undefined);
        }
      });
      req.on("error", () => {
        if (!done) {
          done = true;
          resolve(undefined);
        }
      });
    });
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }

  private fail(res: http.ServerResponse, status: number, error: string): void {
    if (res.headersSent) {
      res.end();
      return;
    }
    this.json(res, status, { error });
  }
}

/** Where a reconnecting stream continues: the EventSource header, or `?last=` from a page that reopened it. */
function lastEventId(req: http.IncomingMessage, url: URL): string | undefined {
  const header = req.headers["last-event-id"];
  return typeof header === "string" ? header : (url.searchParams.get("last") ?? undefined);
}

function parsePermissionList(raw: unknown): Permission[] {
  return Array.isArray(raw) ? raw.filter((p): p is Permission => p === "view" || p === "prompt" || p === "approve") : [];
}

function hostName(host: string | undefined): string {
  return (host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
}

function isLoopbackName(name: string): boolean {
  return name === "127.0.0.1" || name === "localhost" || name === "::1";
}

/** Whether a Host header names this machine itself (no proxy in between). */
export function isLoopbackHost(host: string | undefined): boolean {
  return isLoopbackName(hostName(host));
}
