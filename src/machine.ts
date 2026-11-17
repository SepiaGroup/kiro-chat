// What to call this machine in text the user reads: "Mac" on macOS, "computer"
// elsewhere ("remote access is on for this Mac only"). Pure. The slash command
// list that uses it is also bundled into the webview, which has no `process`,
// so the default platform comes from the browser there.

export function machine(platform: string = currentPlatform()): string {
  return platform === "darwin" ? "Mac" : "computer";
}

function currentPlatform(): string {
  const g = globalThis as { process?: { platform?: string }; navigator?: { userAgent?: string } };
  if (typeof g.process?.platform === "string") {
    return g.process.platform;
  }
  return /Macintosh|Mac OS X/.test(g.navigator?.userAgent ?? "") ? "darwin" : "other";
}
