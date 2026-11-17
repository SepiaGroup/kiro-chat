// Choosing which saved sessions to offer for Resume. Shared by the webview
// chat and the terminal chat. Pure (no vscode import).

import * as path from "path";
import type { SessionSummary } from "./types";

/**
 * Normalize a folder path for comparison: resolve it, strip trailing slashes
 * and drop macOS's `/private` prefix (`/private/tmp` is `/tmp`). On Windows
 * the engine and VS Code may write the same folder as `C:\Users\me\app`,
 * `c:/Users/me/app` or `C:\users\Me\App`, so a drive or UNC path gets the same
 * slashes and case. Any other path there (the engine in WSL or on another
 * machine writes `/home/me`) is only stripped of trailing slashes.
 */
export function normalizePath(p: string | undefined, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    const raw = String(p ?? "");
    if (/^[A-Za-z]:([\\/]|$)/.test(raw) || /^[\\/]{2}[^\\/]/.test(raw)) {
      const w = path.win32.normalize(raw).replace(/\\/g, "/").replace(/\/+$/, "");
      return (/^[A-Za-z]:$/.test(w) ? w + "/" : w).toLowerCase();
    }
    // Not a Windows path: the engine runs in WSL or on another machine. Case matters there.
    return raw.replace(/\/+$/, "") || "/";
  }
  let s = path.resolve(String(p ?? "")).replace(/\/+$/, "") || "/";
  if (s.startsWith("/private/")) {
    s = s.slice("/private".length);
  }
  return s;
}

/**
 * Sessions to offer, newest first: those of this engine in this folder; if
 * none, those of this engine; if none, all. `excludeId` is the open session.
 */
export function pickSessions(
  sessions: SessionSummary[],
  engine: string | undefined,
  cwd: string,
  excludeId?: string
): SessionSummary[] {
  const folder = normalizePath(cwd);
  const others = sessions.filter((s) => s.sessionId !== excludeId);
  const sameBoth = others.filter((s) => s.source === engine && normalizePath(s.cwd) === folder);
  const sameEngine = others.filter((s) => s.source === engine);
  const list = sameBoth.length ? sameBoth : sameEngine.length ? sameEngine : others;
  return [...list].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}
