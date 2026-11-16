// How VS Code windows find each other for remote access. Each window with
// remote access on publishes a small file (its loopback port and name) in one
// folder, and one window at a time holds the "hub" lock: it owns the tailnet
// address and shows every window's chats to the phone. A window that closes or
// crashes is noticed by its process id. Plain files, polled: nothing here has
// to survive a crash. Uses the file system only (no vscode import).

import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";

export interface WindowInfo {
  id: string;
  /** Shown next to its chats on the phone (the workspace name). */
  name: string;
  /** The window's loopback server. */
  port: number;
  pid: number;
}

export interface HubLock {
  id: string;
  pid: number;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // exists, but is someone else's
  }
}

function isWindowInfo(v: unknown): v is WindowInfo {
  const w = v as Partial<WindowInfo> | null;
  return (
    !!w &&
    typeof w.id === "string" &&
    /^[0-9a-f]{8}$/.test(w.id) &&
    typeof w.name === "string" &&
    Number.isInteger(w.port) &&
    (w.port as number) > 0 &&
    (w.port as number) < 65536 &&
    Number.isInteger(w.pid)
  );
}

export class WindowRegistry {
  private readonly windowsDir: string;
  private readonly lockFile: string;
  private readonly tokenFile: string;

  constructor(
    dir: string,
    private readonly alive: (pid: number) => boolean = pidAlive
  ) {
    this.windowsDir = path.join(dir, "windows");
    this.lockFile = path.join(dir, "hub.lock");
    this.tokenFile = path.join(dir, "link-token");
  }

  /** A fresh window id. */
  static newId(): string {
    return randomBytes(4).toString("hex");
  }

  private ensure(): void {
    fs.mkdirSync(this.windowsDir, { recursive: true, mode: 0o700 });
  }

  /** The secret the windows use with each other (made once, readable by this user only). */
  token(): string {
    this.ensure();
    try {
      fs.writeFileSync(this.tokenFile, randomBytes(32).toString("base64url"), { flag: "wx", mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }
    const token = fs.readFileSync(this.tokenFile, "utf8").trim();
    if (token.length < 32) {
      throw new Error("The remote access link token is damaged. Delete the file " + this.tokenFile + " and start again.");
    }
    return token;
  }

  /** Say this window is here (replaces its earlier file). */
  publish(info: WindowInfo): void {
    this.ensure();
    const file = path.join(this.windowsDir, `${info.id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  /** This window is leaving: remove its file and give up the hub lock if it holds it. */
  withdraw(id: string): void {
    this.release(id);
    try {
      fs.unlinkSync(path.join(this.windowsDir, `${id}.json`));
    } catch {
      // Already gone.
    }
  }

  /** The windows that are here, dropping the files of windows that are not. */
  windows(): WindowInfo[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.windowsDir);
    } catch {
      return [];
    }
    const out: WindowInfo[] = [];
    for (const name of names) {
      if (!/^[0-9a-f]{8}\.json$/.test(name)) {
        continue;
      }
      const file = path.join(this.windowsDir, name);
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
        if (isWindowInfo(parsed) && `${parsed.id}.json` === name && this.alive(parsed.pid)) {
          out.push(parsed);
          continue;
        }
        fs.unlinkSync(file);
      } catch {
        // Unreadable (being written, or damaged): the next look decides.
      }
    }
    return out;
  }

  /** Who holds the hub lock, if that window is still here. */
  hub(): HubLock | undefined {
    const lock = this.readLock();
    if (lock && this.alive(lock.pid) && fs.existsSync(path.join(this.windowsDir, `${lock.id}.json`))) {
      return lock;
    }
    return undefined;
  }

  /** Try to become the hub. True when this window holds the lock afterwards. */
  claimHub(id: string, pid = process.pid): boolean {
    this.ensure();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(this.lockFile, JSON.stringify({ id, pid }), { flag: "wx", mode: 0o600 });
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw err;
        }
      }
      const held = this.readLock();
      if (held?.id === id) {
        return true;
      }
      if (this.hub()) {
        return false; // a live window has it
      }
      try {
        fs.unlinkSync(this.lockFile); // left by a window that is gone; two windows may race here, wx decides
      } catch {
        // Someone else removed it first.
      }
    }
    return false;
  }

  /** Give the lock up, if this window holds it. */
  release(id: string): void {
    if (this.readLock()?.id === id) {
      try {
        fs.unlinkSync(this.lockFile);
      } catch {
        // Already gone.
      }
    }
  }

  private readLock(): HubLock | undefined {
    try {
      const v = JSON.parse(fs.readFileSync(this.lockFile, "utf8")) as Partial<HubLock>;
      return typeof v.id === "string" && Number.isInteger(v.pid) ? { id: v.id, pid: v.pid as number } : undefined;
    } catch {
      return undefined;
    }
  }
}
