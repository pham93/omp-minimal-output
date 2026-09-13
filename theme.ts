// Theme-derived color, animation-frame, and row-styling primitives.
// Owns the shared mutable render clocks (spin frame, fades, settle marks) so
// every painter reads one identity. Imports text utils; nothing else.

import { visibleWidth } from "@oh-my-pi/pi-tui";
import { stripKindSuffix, truncatePlain } from "./text.ts";

// Initialized at import so tool_result works before session_start fires.
// Shared row-animation frame, read at render time by pending rows.
export let spinFrame = 0;

// Fade start (ms epoch) for rows that are appearing now. Missing keys are
// rest opacity — never start a fade on a rebuild of existing transcript rows.
export const textFades = new Map<string, number>();

export type MinimalTheme = { fg: (kind: string, text: string) => string };

export function isMinimalTheme(value: unknown): value is MinimalTheme {
  if (typeof value !== "object" || value === null) return false;
  if (!("fg" in value)) return false;
  return typeof (value as { fg: unknown }).fg === "function";
}

export const TOOL_TEXT_OPACITY = 0.5;

export const TEXT_FADE_MS = 1600;

export const MARK_OPACITY = 1;

export const SETTLE_MS = 500;

export const TOOL_INDENT = "  ";

export const LINE_WIDTH_RATIO = 0.7;

export const settleAt = new Map<string, number>();

export function parseHexRgb(hex: string): [number, number, number] | undefined {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return undefined;
  const n = Number.parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function themeTokenRgb(theme: unknown, token: string): [number, number, number] | undefined {
  if (typeof theme === "object" && theme !== null && "getColorHex" in theme) {
    const fn = (theme as { getColorHex: unknown }).getColorHex;
    if (typeof fn === "function") {
      try {
        const hex = (fn as (k: string) => unknown).call(theme, token);
        if (typeof hex === "string") {
          const rgb = parseHexRgb(hex);
          if (rgb) return rgb;
        }
      } catch {
        // Token missing or theme without a hex map.
      }
    }
  }
  if (isMinimalTheme(theme)) {
    try {
      const sample = theme.fg(token, " ");
      const m = /38;2;(\d+);(\d+);(\d+)/.exec(sample);
      if (m?.[1] !== undefined && m[2] !== undefined && m[3] !== undefined) {
        return [Number(m[1]), Number(m[2]), Number(m[3])];
      }
    } catch {
      // Unstyleable.
    }
  }
  return undefined;
}

export function themeBgRgb(theme: unknown): [number, number, number] {
  if (typeof theme === "object" && theme !== null && "isLight" in theme) {
    if ((theme as { isLight: unknown }).isLight === true) return [255, 255, 255];
  }
  return [0, 0, 0];
}

export function paintBold(theme: unknown, text: string): string {
  if (!text) return text;
  if (typeof theme === "object" && theme !== null && "bold" in theme) {
    const fn = (theme as { bold: unknown }).bold;
    if (typeof fn === "function") {
      try {
        return (fn as (s: string) => string).call(theme, text);
      } catch {
        // Fall through to SGR bold.
      }
    }
  }
  return `\x1b[1m${text}\x1b[22m`;
}

export function paintMark(theme: unknown, mark: string, token: string): string {
  let colored = mark;
  if (isMinimalTheme(theme)) {
    try {
      colored = theme.fg(token, mark);
    } catch {
      colored = paintAt(theme, mark, token, MARK_OPACITY);
    }
  } else {
    colored = paintAt(theme, mark, token, MARK_OPACITY);
  }
  return paintBold(theme, colored);
}

export function paintAt(theme: unknown, text: string, token: string, opacity: number): string {
  if (!text) return text;
  const a = Math.min(1, Math.max(0, opacity));
  const fg = themeTokenRgb(theme, token);
  if (!fg) {
    if (isMinimalTheme(theme)) {
      try {
        return theme.fg(token, text);
      } catch {
        return text;
      }
    }
    return text;
  }
  const bg = themeBgRgb(theme);
  const r = Math.round(bg[0] + (fg[0] - bg[0]) * a);
  const g = Math.round(bg[1] + (fg[1] - bg[1]) * a);
  const b = Math.round(bg[2] + (fg[2] - bg[2]) * a);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

export function markSettling(key: string): void {
  settleAt.set(key, Date.now());
}

export function isSettling(key: string): boolean {
  const started = settleAt.get(key);
  return started !== undefined && Date.now() - started < SETTLE_MS;
}

export function anySettling(): boolean {
  const now = Date.now();
  for (const started of settleAt.values()) {
    if (now - started < SETTLE_MS) return true;
  }
  return false;
}

export function fadeOpacity(target: number, startedAt: number): number {
  if (!(startedAt > 0)) return target;
  const t = Math.min(1, Math.max(0, (Date.now() - startedAt) / TEXT_FADE_MS));
  const eased = 1 - (1 - t) ** 3;
  return eased * target;
}

export function pruneFades(now: number): void {
  if (textFades.size <= 80) return;
  for (const [key, started] of textFades) {
    if (now - started >= TEXT_FADE_MS) textFades.delete(key);
  }
}

// Start a fade only for a row that is appearing now. A missing key on a
// settled/historical row means rest opacity — never treat it as a new fade.
export function rowOpacity(live: boolean, fadeKey: string | undefined): number {
  if (!fadeKey) return TOOL_TEXT_OPACITY;
  const existing = textFades.get(fadeKey);
  if (existing !== undefined) return fadeOpacity(TOOL_TEXT_OPACITY, existing);
  if (!live) return TOOL_TEXT_OPACITY;
  const now = Date.now();
  textFades.set(fadeKey, now);
  pruneFades(now);
  return fadeOpacity(TOOL_TEXT_OPACITY, now);
}

export function elapsedSuffix(startedAt: number): string {
  if (!(startedAt > 0)) return " (0s)";
  return ` (${Math.max(0, Math.floor((Date.now() - startedAt) / 1000))}s)`;
}

// Pending rows animate: core repaints (not re-invokes) renderers, so the row
// must read the shared spin frame and fade progress at render time instead of
// snapshotting them. Only the appearing live row fades in; settled rows stay
// at rest opacity. Indicator is full-color (live accent / settled green / error red).
export function formatRowLine(
  theme: unknown,
  width: number,
  opts: {
    body: string;
    indent?: boolean;
    live?: boolean;
    error?: boolean;
    right?: string;
    fadeKey?: string;
    tree?: "mid" | "last";
    mark?: string;
  },
): string {
  const live = opts.live === true;
  const settling = !live && opts.fadeKey !== undefined && isSettling(opts.fadeKey);
  const spin = live || settling;
  const op = rowOpacity(live, opts.fadeKey);
  const markToken = spin ? "accent" : opts.error ? "error" : "success";
  const mark = opts.mark ?? (spin ? (SPIN_FRAMES[spinFrame % SPIN_FRAMES.length] ?? "◈") : "◆");
  const branch = opts.tree === "mid" ? "├─" : opts.tree === "last" ? "╰─" : "";
  const branchPaint = branch ? `${paintAt(theme, branch, opts.error ? "error" : spin ? "accent" : "dim", op)} ` : "";
  const indentPrefix = branch || opts.indent === true ? TOOL_INDENT : " ";
  const pad = branch ? indentPrefix + branchPaint : indentPrefix;
  const w = Math.max(1, Math.floor((Math.floor(width) || 0) * LINE_WIDTH_RATIO));
  const prefix = branch && !spin ? pad : `${pad}${paintMark(theme, mark, markToken)} `;
  const right = opts.right ?? "";
  const tail = right ? paintAt(theme, right, "dim", op) : "";
  const bodyBudget = Math.max(1, w - visibleWidth(prefix) - (tail ? visibleWidth(tail) + 1 : 0));
  const body = truncatePlain(stripKindSuffix(opts.body), bodyBudget);
  const left = `${prefix}${paintBold(theme, paintAt(theme, body, opts.error ? "error" : "toolOutput", op))}`;
  if (!tail) return left;
  const gap = Math.max(0, w - visibleWidth(left) - visibleWidth(tail));
  return `${left}${" ".repeat(gap)}${tail}`;
}

export const SPIN_FRAMES = ["◈", "◉", "◎", "○"] as const;

export function advanceSpinFrame(): void {
  spinFrame = (spinFrame + 1) % SPIN_FRAMES.length;
}
