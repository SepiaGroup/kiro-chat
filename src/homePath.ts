// `~/x` means the home folder; on Windows `~\x` does too. On macOS and Linux a
// backslash is an ordinary character, so a file named `~\x` stays what it says. Pure.

/** The part after `~/` (or `~\` on Windows), or undefined if `p` doesn't start in the home folder. */
export function homeRest(p: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const m = (platform === "win32" ? /^~[\\/]([\s\S]*)$/ : /^~\/([\s\S]*)$/).exec(p);
  return m ? m[1] : undefined;
}
