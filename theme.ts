// Theme-derived color, animation-frame, and row-styling primitives.
// Owns the shared mutable render clocks (spin frame, fades, settle marks) so
// every painter reads one identity. Imports text utils and plugin config.

import { visibleWidth } from "@oh-my-pi/pi-tui";
import { stripKindSuffix, truncatePlain } from "./text.ts";
import { getPluginConfig, indicatorFrames, indicatorSettled } from "./config.ts";

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

export const TEXT_FADE_MS = 1600;

export const MARK_OPACITY = 1;

export const SETTLE_MS = 500;

export const TOOL_INDENT = "  ";

export const LINE_WIDTH_RATIO = 0.95;

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

// Basic/bright foreground color number → sRGB.
const BASIC_FG_RGB: Record<number, [number, number, number]> = {
  30: [0, 0, 0],
  31: [205, 0, 0],
  32: [0, 205, 0],
  33: [205, 205, 0],
  34: [0, 0, 238],
  35: [205, 0, 205],
  36: [0, 205, 205],
  37: [229, 229, 229],
  90: [127, 127, 127],
  91: [255, 0, 0],
  92: [0, 255, 0],
  93: [255, 255, 0],
  94: [92, 92, 255],
  95: [255, 0, 255],
  96: [0, 255, 255],
  97: [255, 255, 255],
};

function ansi256Rgb(n: number): [number, number, number] {
  if (n < 16) return BASIC_FG_RGB[n] ?? [255, 255, 255];
  if (n < 232) {
    const v = n - 16;
    const step = (c: number): number => (c === 0 ? 0 : 55 + c * 40);
    return [step(Math.floor(v / 36)), step(Math.floor((v % 36) / 6)), step(v % 6)];
  }
  const g = 8 + (n - 232) * 10;
  return [g, g, g];
}

export function stripSgr(text: string): string {
  return text.replace(/\[[0-9;]*m/g, "");
}

// Blend every foreground color in SGR-painted text toward the theme bg by
// opacity, and drop background fills. Syntax-highlighted input and
// color-emitting program output keep their hues but sit at the same rest
// opacity as every other row instead of punching through at full brightness.
// Blend one SGR parameter run: foreground colors mix toward the theme bg,
// background fills drop, everything else (bold, resets, underline) passes
// through so combined sequences like `1;31m` keep working.
function blendSgrParams(params: string, mix: (rgb: [number, number, number]) => string): string {
  const parts = params.split(";");
  const out: string[] = [];
  let i = 0;
  while (i < parts.length) {
    const p = parts[i] ?? "";
    const q = parts[i + 1] ?? "";
    if (p === "38" && q === "2") {
      const r = +(parts[i + 2] ?? NaN);
      const g = +(parts[i + 3] ?? NaN);
      const b = +(parts[i + 4] ?? NaN);
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
        out.push(mix([r, g, b]));
        i += 5;
      } else {
        out.push(p);
        i += 1;
      }
    } else if (p === "38" && q === "5") {
      const n = +(parts[i + 2] ?? NaN);
      if (Number.isFinite(n)) {
        out.push(mix(ansi256Rgb(n)));
        i += 3;
      } else {
        out.push(p);
        i += 1;
      }
    } else if (p === "48") {
      // Background fill (extra params for 48;2/48;5): drop the whole run.
      i += q === "2" ? 5 : q === "5" ? 3 : 1;
    } else if (/^(4[0-7]|10[0-7])$/.test(p)) {
      i += 1;
    } else if (/^(3[0-7]|9[0-7])$/.test(p)) {
      out.push(mix(BASIC_FG_RGB[+p] ?? [255, 255, 255]));
      i += 1;
    } else {
      out.push(p);
      i += 1;
    }
  }
  return out.join(";");
}

// Blend every foreground color in SGR-painted text toward the theme bg by
// opacity, and drop background fills. Syntax-highlighted input and
// color-emitting program output keep their hues but sit at the same rest
// opacity as every other row instead of punching through at full brightness.
export function dimAnsi(theme: unknown, text: string, opacity: number): string {
  if (!text) return text;
  const a = Math.min(1, Math.max(0, opacity));
  const bg = themeBgRgb(theme);
  const mix = (rgb: [number, number, number]): string =>
    `38;2;${Math.round(bg[0] + (rgb[0] - bg[0]) * a)};${Math.round(bg[1] + (rgb[1] - bg[1]) * a)};${Math.round(bg[2] + (rgb[2] - bg[2]) * a)}`;
  return text.replace(/\[([0-9;]*)m/g, (m: string, params: string) => {
    if (params === "") return m;
    const blended = blendSgrParams(params, mix);
    return blended === "" ? "" : `[${blended}m`;
  });
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
  const rest = getPluginConfig().opacity;
  if (!fadeKey) return rest;
  const existing = textFades.get(fadeKey);
  if (existing !== undefined) return fadeOpacity(rest, existing);
  if (!live) return rest;
  const now = Date.now();
  textFades.set(fadeKey, now);
  pruneFades(now);
  return fadeOpacity(rest, now);
}

export function elapsedSuffix(startedAt: number): string {
  if (!(startedAt > 0)) return " (0s)";
  return ` (${Math.max(0, Math.floor((Date.now() - startedAt) / 1000))}s)`;
}

// Pending rows animate: core repaints (not re-invokes) renderers, so the row
// must read the shared spin frame and fade progress at render time instead of
// snapshotting them. Only the appearing live row fades in; settled rows stay
// at rest opacity. Indicator is full-color (live accent / settled green / error red).
export function currentIndicatorFrame(cfg = getPluginConfig()): string {
  const frames = indicatorFrames(cfg);
  if (!cfg.indicatorAnimation) return frames[0] ?? "◈";
  return frames[spinFrame % frames.length] ?? "◈";
}

export function formatRowLine(
  theme: unknown,
  width: number,
  opts: {
    body: string;
    indent?: boolean | string;
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
  const cfg = getPluginConfig();
  const settled = indicatorSettled(cfg);
  const mark = opts.mark ?? (spin ? currentIndicatorFrame(cfg) : (settled ?? "◆"));
  const branch = opts.tree === "mid" ? "├─" : opts.tree === "last" ? "╰─" : "";
  const branchPaint = branch ? `${paintAt(theme, branch, opts.error ? "error" : spin ? "accent" : "dim", op)} ` : "";
  const indentPrefix =
    typeof opts.indent === "string" ? opts.indent : branch ? "" : opts.indent === true ? TOOL_INDENT : "";
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

export function advanceSpinFrame(): void {
  spinFrame = (spinFrame + 1) % Math.max(1, indicatorFrames().length);
}

// Sync the shared spinner to an external ticker (core passes spinnerFrame in
// render options on partial-streaming repaints). Our own 120ms pump keeps
// advancing it otherwise; modulo keeps foreign frame counts in range.
export function setSpinFrame(n: number): void {
  const len = Math.max(1, indicatorFrames().length);
  spinFrame = ((Math.floor(n) % len) + len) % len;
}
