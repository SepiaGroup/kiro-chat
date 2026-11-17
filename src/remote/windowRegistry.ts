// How VS Code windows find each other for remote access. Each window with
// remote access on publishes a small file (its loopback port and name) in one
// folder, and one window at a time holds the "hub" lock: it owns the tailnet
// address and shows every window's chats to the phone. A window that closes or
// crashes is noticed by its process id (and the computer's boot time, as process ids
// are reused after a restart). Plain files, polled: nothing here has to
// survive a crash. Files are written in full, then linked or renamed into
// place, so nobody reads one half written. Uses the file system only (no
// vscode import).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomBytes } from "crypto";

/** Leftover temp files (a window died while writing) are removed after this. */
const TEMP_MAX_AGE_MS = 60_000;
/** Boot times further apart than this are different restarts (allows for clock changes). */
const BOOT_SLACK_S = 120;

/** When this computer started, in seconds. */
function bootTime(): number {
  return Math.round(Date.now() / 1000 - os.uptime());
}

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

/** What the files hold besides their own fields: the boot time of the Mac that wrote them. */
interface Stamped {
  boot?: number;
}

function parseLock(raw: string | undefined): (HubLock & Stamped) | undefined {
  if (raw === undefined) {
    return undefined;
  }
  try {
    const v = JSON.parse(raw) as Partial<HubLock> & Stamped;
    return typeof v.id === "string" && Number.isInteger(v.pid)
      ? { id: v.id, pid: v.pid as number, boot: typeof v.boot === "number" ? v.boot : undefined }
      : undefined;
  } catch {
    return undefined;
  }
}

function readRaw(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function unlinkQuietly(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // Already gone.
  }
}

/** A name next to `file` that nobody else uses. */
function tempName(file: string, ext: "tmp" | "stale"): string {
  return `${file}.${process.pid}.${randomBytes(4).toString("hex")}.${ext}`;
}

/** Create `file` with this content, whole, only if it does not exist. */
function createExclusive(file: string, content: string): boolean {
  const tmp = tempName(file, "tmp");
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  try {
    fs.linkSync(tmp, file); // fails if it exists; when it works, the content is already complete
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw err;
  } finally {
    unlinkQuietly(tmp);
  }
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
    private readonly dir: string,
    private readonly alive: (pid: number) => boolean = pidAlive,
    private readonly boot: number = bootTime()
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
    createExclusive(this.tokenFile, randomBytes(32).toString("base64url"));
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
    const tmp = tempName(file, "tmp");
    try {
      fs.writeFileSync(tmp, JSON.stringify({ ...info, boot: this.boot }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } finally {
      unlinkQuietly(tmp); // only there if the rename failed
    }
  }

  /** The process wrote this file since this computer last started, and still runs. */
  private live(pid: number, boot: number | undefined): boolean {
    return (boot === undefined || Math.abs(boot - this.boot) <= BOOT_SLACK_S) && this.alive(pid);
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
    this.sweep();
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
        if (isWindowInfo(parsed) && `${parsed.id}.json` === name && this.live(parsed.pid, (parsed as Stamped).boot)) {
          out.push({ id: parsed.id, name: parsed.name, port: parsed.port, pid: parsed.pid });
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
    const lock = parseLock(readRaw(this.lockFile));
    return lock && this.lockLive(lock) ? { id: lock.id, pid: lock.pid } : undefined;
  }

  private lockLive(lock: HubLock & Stamped): boolean {
    return this.live(lock.pid, lock.boot) && fs.existsSync(path.join(this.windowsDir, `${lock.id}.json`));
  }

  /** Try to become the hub. True when this window holds the lock afterwards. */
  claimHub(id: string, pid = process.pid): boolean {
    this.ensure();
    const mine = JSON.stringify({ id, pid, boot: this.boot });
    for (let attempt = 0; attempt < 2; attempt++) {
      if (createExclusive(this.lockFile, mine)) {
        return true;
      }
      const raw = readRaw(this.lockFile);
      if (raw === undefined) {
        continue; // removed in between: try again
      }
      const held = parseLock(raw);
      if (held?.id === id) {
        return true;
      }
      if (held && this.lockLive(held)) {
        return false; // a live window has it
      }
      if (!this.removeIfUnchanged(this.lockFile, raw)) {
        return false; // another window took it over just now
      }
    }
    return false;
  }

  /**
   * Remove a stale file, but only the one that was read: another window may
   * have replaced it with a live one since. Moving it aside first is atomic, so
   * the check and the removal cannot be split by the other window.
   */
  private removeIfUnchanged(file: string, expected: string): boolean {
    const aside = tempName(file, "stale");
    try {
      fs.renameSync(file, aside);
    } catch {
      return true; // gone already
    }
    const moved = readRaw(aside);
    if (moved !== expected) {
      try {
        fs.linkSync(aside, file); // it was a new one: put it back (unless yet another was made)
      } catch {
        // There is a lock again either way.
      }
      unlinkQuietly(aside);
      return false;
    }
    unlinkQuietly(aside);
    return true;
  }

  /** Give the lock up, if this window holds it. */
  release(id: string): void {
    if (parseLock(readRaw(this.lockFile))?.id === id) {
      try {
        fs.unlinkSync(this.lockFile);
      } catch {
        // Already gone.
      }
    }
  }

  /** Remove temp files left by a window that died while writing. */
  private sweep(): void {
    const now = Date.now();
    for (const folder of [this.dir, this.windowsDir]) {
      let names: string[] = [];
      try {
        names = fs.readdirSync(folder);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!/\.\d+\.[0-9a-f]{8}\.(tmp|stale)$/.test(name)) {
          continue;
        }
        const file = path.join(folder, name);
        try {
          if (now - fs.statSync(file).mtimeMs > TEMP_MAX_AGE_MS) {
            fs.unlinkSync(file);
          }
        } catch {
          // Gone already.
        }
      }
    }
  }
}
