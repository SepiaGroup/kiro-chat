// What to call this machine in text the user reads: "Mac" on macOS, "computer"
// elsewhere ("remote access is on for this Mac only"). Pure.

export function machine(platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? "Mac" : "computer";
}
