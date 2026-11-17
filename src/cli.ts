// Locating the kiro-cli binary and running short-lived helper commands
// (whoami, --list-models, --help, health checks). Node-only; no vscode import.

import { spawn, spawnSync } from "child_process";
import { accessSync, constants, existsSync, statSync } from "fs";
import { homedir } from "os";
import { delimiter, join, win32 } from "path";

/**
 * Candidate locations checked when no explicit path is configured. On Windows
 * the installer (`install.ps1`) puts `kiro-cli.exe` in `%LOCALAPPDATA%\Kiro-Cli`
 * (seen in reports; not checked on a Windows machine by this project).
 */
export function candidateCliPaths(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string[] {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || win32.join(home, "AppData", "Local");
    return [win32.join(local, "Kiro-Cli", "kiro-cli.exe"), win32.join(home, ".local", "bin", "kiro-cli.exe")];
  }
  return [join(home, ".local", "bin", "kiro-cli"), "/usr/local/bin/kiro-cli", "/opt/homebrew/bin/kiro-cli"];
}

/**
 * The program from the output of `where kiro-cli` (one path per line). Prefers a
 * `.exe`: a `.cmd` or `.bat` can't be started without a shell.
 */
export function pickFromWhere(stdout: string): string | undefined {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  return lines.find((l) => /\.exe$/i.test(l)) ?? lines[0];
}

/** Where kiro-cli is on PATH, or undefined. A login shell on macOS and Linux, `where` on Windows. */
function findOnPath(platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === "win32") {
    // The full path, so a PATH that VS Code was started with can't hide where.exe.
    const where = win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "where.exe");
    const r = spawnSync(where, ["kiro-cli"], { encoding: "utf8", windowsHide: true });
    return r.status === 0 ? pickFromWhere(r.stdout) : undefined;
  }
  const r = spawnSync("bash", ["-lc", "command -v kiro-cli"], { encoding: "utf8" });
  const p = r.status === 0 ? r.stdout.trim() : "";
  return p.length > 0 ? p : undefined;
}

/**
 * Resolve the kiro-cli path. If `configured` is set it must be an executable
 * file (throws with a clear message otherwise). If not set, try `kiro-cli` on
 * PATH, then well-known locations. Returns undefined if nothing is found.
 */
export function resolveCliPath(configured?: string): string | undefined {
  if (configured && configured.trim().length > 0) {
    const p = configured.trim();
    const problem = executableProblem(p);
    if (problem) {
      throw new Error(`kiroChat.kiroCliPath is set to "${p}", which ${problem}. Fix or clear the setting.`);
    }
    return p;
  }
  const onPath = findOnPath();
  if (onPath) {
    return onPath;
  }
  for (const c of candidateCliPaths()) {
    if (existsSync(c)) {
      return c;
    }
  }
  return undefined;
}

/** Why `p` can't be run, or undefined if it can. */
export function executableProblem(p: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(p)) {
    return "is a script; use the kiro-cli.exe it starts";
  }
  try {
    if (!statSync(p).isFile()) {
      return "isn't a file";
    }
    accessSync(p, constants.X_OK);
    return undefined;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? "doesn't exist" : code === "EACCES" ? "isn't executable" : `can't be used (${code ?? "error"})`;
  }
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run a kiro-cli command to completion with an optional stdin payload and a
 * timeout. Used for quick, non-interactive helper calls.
 */
export function runCli(
  cliPath: string,
  args: string[],
  opts: { input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {}
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cliPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: opts.env ?? sanitizedEnv(),
      cwd: opts.cwd,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ code, stdout, stderr });
    };

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          finish(null);
        }, opts.timeoutMs)
      : undefined;

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", () => finish(null));
    child.on("exit", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      finish(code);
    });

    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
}

/**
 * Build an environment that excludes the AVX-dependent bundled Bun inside the
 * Kiro app bundles from PATH, so nothing AVX-only is ever invoked. A copy of
 * `process.env` is a plain object, and on Windows its variable is named `Path`,
 * so the PATH key is found without regard to case and keeps its own name.
 */
export function sanitizedEnv(base: NodeJS.ProcessEnv = process.env, sep: string = delimiter): NodeJS.ProcessEnv {
  const env = { ...base };
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  env[key] = (env[key] ?? "")
    .split(sep)
    .filter((seg) => !/Kiro( CLI)?\.app\/Contents/i.test(seg))
    .join(sep);
  return env;
}
