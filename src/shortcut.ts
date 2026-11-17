// The keyboard shortcut a command has in the extension's own package.json, as
// text for a tooltip ("⌘⌥K" on macOS, "Ctrl+Alt+K" elsewhere). It is the default:
// VS Code has no way to ask for what the user rebound. Pure.

const MAC_SYMBOLS: Record<string, string> = { cmd: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" };

export function shortcutLabel(keybindings: unknown, command: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (!Array.isArray(keybindings)) {
    return undefined;
  }
  const entry = keybindings.find((k) => typeof k === "object" && k !== null && (k as { command?: unknown }).command === command) as
    | Record<string, unknown>
    | undefined;
  if (!entry) {
    return undefined;
  }
  const platformKey = platform === "darwin" ? entry.mac : platform === "win32" ? entry.win : entry.linux;
  const key = typeof platformKey === "string" ? platformKey : entry.key;
  if (typeof key !== "string" || key.trim() === "") {
    return undefined;
  }
  const parts = key.toLowerCase().split("+").map((p) => p.trim());
  if (platform === "darwin") {
    return parts.map((p) => MAC_SYMBOLS[p] ?? p.toUpperCase()).join("");
  }
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("+");
}
