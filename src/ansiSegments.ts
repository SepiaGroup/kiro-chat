// Terminal text (the terminal chat's command output, with ANSI colors) as
// plain segments with style names, so a chat tab can show it with CSS classes
// and textContent. Pure.

export interface Segment {
  text: string;
  /** Style names: bold, dim, italic, underline, strike, red, green, yellow, blue, magenta, cyan, gray. */
  styles?: string[];
}

const COLORS: Record<number, string> = { 31: "red", 32: "green", 33: "yellow", 34: "blue", 35: "magenta", 36: "cyan", 90: "gray" };
const ON: Record<number, string> = { 1: "bold", 2: "dim", 3: "italic", 4: "underline", 9: "strike" };
// Codes that turn styles off again.
const OFF: Record<number, string[]> = { 22: ["bold", "dim"], 23: ["italic"], 24: ["underline"], 29: ["strike"] };

// SGR (colors) is kept; every other escape (cursor moves, OSC) is dropped.
// eslint-disable-next-line no-control-regex
const ESCAPE_RE = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function ansiSegments(input: string): Segment[] {
  const out: Segment[] = [];
  let color: string | undefined;
  const flags = new Set<string>();
  const push = (text: string): void => {
    if (!text) {
      return;
    }
    const styles = [...flags, ...(color ? [color] : [])];
    const last = out[out.length - 1];
    if (last && (last.styles ?? []).join() === styles.join()) {
      last.text += text;
      return;
    }
    out.push(styles.length ? { text, styles } : { text });
  };
  let at = 0;
  for (const m of input.matchAll(ESCAPE_RE)) {
    push(input.slice(at, m.index));
    at = (m.index ?? 0) + m[0].length;
    if (m[1] === undefined) {
      continue;
    }
    for (const code of (m[1] || "0").split(";").map(Number)) {
      if (code === 0) {
        flags.clear();
        color = undefined;
      } else if (code === 39) {
        color = undefined;
      } else if (COLORS[code]) {
        color = COLORS[code];
      } else if (ON[code]) {
        flags.add(ON[code]);
      } else if (OFF[code]) {
        OFF[code].forEach((f) => flags.delete(f));
      }
    }
  }
  push(input.slice(at));
  return out;
}
