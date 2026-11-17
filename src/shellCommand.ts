// The text to type into a VS Code terminal to run a program. The terminal is
// the user's default shell, and the quoting differs: PowerShell (the default on
// Windows) needs `&` before a quoted program, cmd takes double quotes, and a
// POSIX shell (also Git Bash) takes single quotes. Pure (no vscode import).

export type ShellKind = "posix" | "powershell" | "cmd";

/** Which kind of shell `shellPath` is. Anything but Windows is POSIX. */
export function shellKind(shellPath: string | undefined, platform: NodeJS.Platform = process.platform): ShellKind {
  if (platform !== "win32") {
    return "posix";
  }
  const name = (shellPath ?? "").split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, "") ?? "";
  if (name === "cmd") {
    return "cmd";
  }
  // The default on Windows is PowerShell; Git Bash and WSL say so in their name.
  return name === "bash" || name === "sh" || name === "wsl" || name === "zsh" ? "posix" : "powershell";
}

const SAFE = /^[\w@%+=:,./\\-]+$/;

function quote(s: string, kind: ShellKind): string {
  if (SAFE.test(s) && !(kind === "posix" && s.includes("\\"))) {
    return s;
  }
  if (kind === "cmd") {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return `'${s.replace(/'/g, kind === "powershell" ? "''" : "'\\''")}'`;
}

/** One command line to send to a terminal that runs `shellPath`. */
export function shellCommandLine(
  program: string,
  args: string[],
  shellPath: string | undefined,
  platform: NodeJS.Platform = process.platform
): string {
  const kind = shellKind(shellPath, platform);
  const prog = quote(program, kind);
  // PowerShell reads a quoted word at the start of a line as text, not as a program.
  const head = kind === "powershell" && prog !== program ? `& ${prog}` : prog;
  return [head, ...args.map((a) => quote(a, kind))].join(" ");
}
