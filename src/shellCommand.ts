// How to start a program in a VS Code terminal. For the shells whose quoting is
// known (PowerShell, cmd, POSIX shells including Git Bash) the program is typed
// into the user's shell, quoted for it. For anything else (WSL, fish or nu on
// Windows), or when a value can't be quoted safely (a `%` for cmd), the program
// is started directly as the terminal's own process, which needs no quoting.
// Pure (no vscode import).

export type ShellKind = "posix" | "powershell" | "cmd" | "other";

/** Which kind of shell `shellPath` is. Anything but Windows is POSIX. */
export function shellKind(shellPath: string | undefined, platform: NodeJS.Platform = process.platform): ShellKind {
  if (platform !== "win32") {
    return "posix";
  }
  const full = shellPath ?? "";
  const name = full.split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, "") ?? "";
  if (name === "") {
    return "powershell"; // no shell named: the default on Windows
  }
  if (name === "cmd") {
    return "cmd";
  }
  if (name === "powershell" || name === "pwsh") {
    return "powershell";
  }
  // System32\bash.exe is the WSL launcher, not Git Bash: it can't take a Windows path.
  if ((name === "bash" || name === "sh" || name === "zsh") && !/[\\/]system32[\\/]/i.test(full)) {
    return "posix";
  }
  return "other";
}

// Characters that need no quoting. Left out for PowerShell and cmd: `,` (an
// array in PowerShell), `@` (splatting) and `%` (variable expansion).
const SAFE_POSIX = /^[\w@%+=:,./-]+$/;
const SAFE_WINDOWS = /^[\w+=:./\\-]+$/;

/** PowerShell reads these as single quotes too, and a doubled one is that character itself. */
const POWERSHELL_QUOTES = /['\u2018\u2019\u201A\u201B]/g;

/** `s` quoted for the shell, or undefined if that can't be done safely. */
function quote(s: string, kind: ShellKind): string | undefined {
  if (kind === "posix") {
    return SAFE_POSIX.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
  }
  if (kind === "powershell") {
    return SAFE_WINDOWS.test(s) ? s : `'${s.replace(POWERSHELL_QUOTES, (q) => q + q)}'`;
  }
  if (kind === "cmd") {
    // Inside double quotes cmd still expands %VAR%, and a path has no `"`.
    if (s.includes("%") || s.includes('"')) {
      return undefined;
    }
    return SAFE_WINDOWS.test(s) ? s : `"${s}"`;
  }
  return undefined;
}

export type TerminalLaunch =
  /** Create a terminal and type this line into it. */
  | { sendText: string }
  /** Create a terminal that runs the program itself. */
  | { shellPath: string; shellArgs: string[] };

export function terminalLaunch(
  program: string,
  args: string[],
  shellPath: string | undefined,
  platform: NodeJS.Platform = process.platform
): TerminalLaunch {
  const kind = shellKind(shellPath, platform);
  const prog = quote(program, kind);
  const quotedArgs = args.map((a) => quote(a, kind));
  if (prog === undefined || quotedArgs.some((a) => a === undefined)) {
    return { shellPath: program, shellArgs: args };
  }
  // PowerShell reads a quoted word at the start of a line as text, not as a program.
  const head = kind === "powershell" && prog !== program ? `& ${prog}` : prog;
  return { sendText: [head, ...quotedArgs].join(" ") };
}
