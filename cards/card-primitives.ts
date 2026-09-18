// Small shared mechanics for card renderers. Tool-specific parsing stays local.
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { getPluginConfig } from "../core/config.ts";
import { detailProfile, minimalToolSummary, type DetailProfile } from "../core/density.ts";
import { isToolError, toolResultText, resultDetails, stashedResultText } from "../core/results.ts";
export { resultDetails, stashedResultText };
import { LINE_WIDTH_RATIO, TOOL_INDENT, dimAnsi, formatRowLine, isSettling, paintAt } from "../core/theme.ts";
import { truncatePlain } from "../core/text.ts";

export const CARD_LIFECYCLE_STATE = {
  running: "running",
  success: "success",
  error: "error",
} as const;

export type CardLifecycleState = (typeof CARD_LIFECYCLE_STATE)[keyof typeof CARD_LIFECYCLE_STATE];

export interface CardLifecycleInput {
  error?: boolean;
}

export interface CardLifecycle {
  state: CardLifecycleState;
  partial: boolean;
  expanded: boolean;
  running: boolean;
  settled: boolean;
  error: boolean;
  detail: DetailProfile;
}

export type ParentCardLabel = string | (() => string);

export interface CardHeaderOptions {
  body: string;
  lifecycle: CardLifecycle;
  right?: string;
  fingerprint?: string;
  settledMark?: string;
}
export interface ParentCardHeaderOptions extends CardHeaderOptions {
  parentLabel?: ParentCardLabel;
}

export interface ConciseErrorOptions {
  fallback: string;
  max?: number;
  skipPattern?: RegExp;
}

export interface CardItemLimit<T> {
  visible: readonly T[];
  hidden: number;
}

export function stashedOrResultText(result: unknown): string {
  return stashedResultText(result) || toolResultText(result);
}

function sanitizeCardText(value: string): string {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 27) {
      const marker = value.charCodeAt(index + 1);
      if (marker === 91) {
        index += 1;
        while (index + 1 < value.length) {
          const next = value.charCodeAt(index + 1);
          index += 1;
          if (next >= 64 && next <= 126) break;
        }
      } else if (marker === 93) {
        index += 1;
        while (index + 1 < value.length) {
          const next = value.charCodeAt(index + 1);
          if (next === 7) {
            index += 1;
            break;
          }
          if (next === 27 && value.charCodeAt(index + 2) === 92) {
            index += 2;
            break;
          }
          index += 1;
        }
      } else if (index + 1 < value.length) {
        index += 1;
      }
      continue;
    }
    const control =
      code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || (code >= 127 && code <= 159);
    out += control ? " " : value[index];
  }
  return out;
}

export function compactCardText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const one = sanitizeCardText(value).replace(/\s+/gu, " ").trim();
  if (!one) return "";
  return one.length > max ? `${one.slice(0, Math.max(1, max - 1))}…` : one;
}

export function conciseErrorText(result: unknown, options: ConciseErrorOptions): string {
  const max = options.max ?? 120;
  const nativeError = compactCardText(resultDetails(result)?.["error"], max);
  if (nativeError) return nativeError;
  for (const line of stashedOrResultText(result).split("\n")) {
    const one = compactCardText(line.replace(/^\s*(?:error|failed?)\s*:?\s*/i, ""), max);
    if (one && !options.skipPattern?.test(one)) return one;
  }
  return options.fallback;
}

export function cardIsPartial(options: unknown): boolean {
  return typeof options === "object" && options !== null && "isPartial" in options && options.isPartial === true;
}

export function cardIsExpanded(options: unknown): boolean {
  return typeof options === "object" && options !== null && "expanded" in options && options.expanded === true;
}

export function cardLifecycle(result: unknown, options: unknown, input?: CardLifecycleInput): CardLifecycle {
  const partial = result !== undefined && cardIsPartial(options);
  const running = result === undefined || partial;
  const settled = !running;
  const error = settled && (input?.error === true || isToolError(result, options));
  const detail = detailProfile(options);
  const state = running
    ? CARD_LIFECYCLE_STATE.running
    : error
      ? CARD_LIFECYCLE_STATE.error
      : CARD_LIFECYCLE_STATE.success;
  return { state, partial, expanded: detail.detailed, running, settled, error, detail };
}

export function cardHeaderLine(theme: unknown, width: number, options: CardHeaderOptions): string {
  const settling = options.fingerprint !== undefined && isSettling(options.fingerprint);
  return formatRowLine(theme, width, {
    body: options.body,
    live: options.lifecycle.running,
    error: options.lifecycle.error,
    right: options.right,
    fadeKey: options.fingerprint,
    mark: options.lifecycle.running || settling ? undefined : options.settledMark,
  });
}

export function minimalCardHeaderLine(theme: unknown, width: number, options: ParentCardHeaderOptions): string {
  const parentLabel = resolveParentCardLabel(options.parentLabel);
  return cardHeaderLine(theme, width, {
    body: minimalToolSummary(parentLabel, options.body),
    lifecycle: options.lifecycle,
    right: options.right,
    fingerprint: options.fingerprint,
    settledMark: options.settledMark,
  });
}
export function resolveParentCardLabel(parentLabel: ParentCardLabel | undefined): string {
  const value = typeof parentLabel === "function" ? parentLabel() : parentLabel;
  return compactCardText(value, 200);
}

export function parentCardHeaderLines(theme: unknown, width: number, options: ParentCardHeaderOptions): string[] {
  const parentLabel = resolveParentCardLabel(options.parentLabel);
  if (!parentLabel) return [cardHeaderLine(theme, width, options)];
  return [
    cardHeaderLine(theme, width, {
      body: parentLabel,
      lifecycle: options.lifecycle,
      fingerprint: options.fingerprint,
    }),
    formatRowLine(theme, width, {
      body: options.body,
      tree: "last",
      error: options.lifecycle.error,
      right: options.right,
    }),
  ];
}

export function cardTitleLine(theme: unknown, width: number, title: string, error = false): string {
  return formatRowLine(theme, width, { body: title, indent: true, tree: "last", error });
}

export function cardDetailLine(
  theme: unknown,
  width: number,
  text: string,
  prefix = `${TOOL_INDENT}   `,
  error = false,
): string {
  const cfg = getPluginConfig();
  const rowWidth = Math.max(1, Math.floor((Math.floor(width) || 0) * LINE_WIDTH_RATIO));
  const budget = Math.max(0, rowWidth - visibleWidth(prefix));
  if (budget === 0) return " ".repeat(rowWidth);
  const truncated = truncatePlain(text, budget);
  const prefixPainted = paintAt(theme, prefix, "dim", cfg.opacity);
  if (/\x1b\[[0-9;]*m/.test(truncated)) {
    const dimmed = dimAnsi(theme, truncated, cfg.opacity);
    return `${prefixPainted}${dimmed}\x1b[0m`;
  }
  return `${prefixPainted}${paintAt(theme, truncated, error ? "error" : "dim", cfg.opacity)}`;
}

const HAS_SGR_RE = /\x1b\[[0-9;]*m/;
const DIFF_ADD_RE = /^\s*\+[^+]/;
const DIFF_DEL_RE = /^\s*-[^-]/;
const DIFF_HUNK_RE = /^\s*@@ -\d/;
const DIFF_STAT_RE = /^(.*?\|\s+\d+\s+)([+-]+)(\s*)$/;
const TEST_PASS_RE = /\d+\s+pass(?:ed)?/gi;
const TEST_FAIL_RE = /[1-9]\d*\s+fail(?:ed)?/gi;
const INSERTIONS_RE = /[1-9]\d*\s+insertions?\(\+\)/gi;
const DELETIONS_RE = /[1-9]\d*\s+deletions?\(-\)/gi;
const PASS_WORD_RE = /\bPASS\b|\(pass\)/g;
const FAIL_WORD_RE = /\bFAIL\b|\(fail\)/g;
const STATUS_GLYPH_RE = /[✔✓✖✗]/g;

type ConsoleToken = "success" | "error" | "accent";

interface ConsoleSpan {
  start: number;
  end: number;
  token: ConsoleToken;
}

function spansFrom(re: RegExp, line: string, token: ConsoleToken): ConsoleSpan[] {
  re.lastIndex = 0;
  const spans: ConsoleSpan[] = [];
  for (const match of line.matchAll(re)) {
    const start = match.index ?? 0;
    spans.push({ start, end: start + match[0].length, token });
  }
  return spans;
}

function paintSpans(theme: unknown, line: string, spans: readonly ConsoleSpan[]): string {
  if (spans.length === 0) return line;
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "";
  let cursor = 0;
  for (const span of sorted) {
    if (span.start < cursor || span.end <= span.start || span.end > line.length) continue;
    if (span.start > cursor) out += paintAt(theme, line.slice(cursor, span.start), "dim", 1);
    out += paintAt(theme, line.slice(span.start, span.end), span.token, 1);
    cursor = span.end;
  }
  if (cursor === 0) return line;
  if (cursor < line.length) out += paintAt(theme, line.slice(cursor), "dim", 1);
  return out;
}

// Presentation-only: wrap common piped CLI patterns in theme tokens so
// `git diff` / `bun test` without a TTY still scan as colored output.
// Existing SGR (pty, --color=always) is left untouched. Callers: bash
// grouped details and eval stdout — not source listings (read/grep).
export function colorizeConsoleLine(theme: unknown, line: string): string {
  if (!line || HAS_SGR_RE.test(line)) return line;
  if (!line.trim()) return line;

  if (DIFF_ADD_RE.test(line)) return paintAt(theme, line, "success", 1);
  if (DIFF_DEL_RE.test(line)) return paintAt(theme, line, "error", 1);
  if (DIFF_HUNK_RE.test(line)) return paintAt(theme, line, "accent", 1);

  const stat = DIFF_STAT_RE.exec(line);
  if (stat?.[1] !== undefined && stat[2] !== undefined) {
    const bar = stat[2];
    const barStart = stat[1].length;
    const spans: ConsoleSpan[] = [];
    let i = 0;
    while (i < bar.length) {
      const ch = bar[i]!;
      let j = i + 1;
      while (j < bar.length && bar[j] === ch) j += 1;
      if (ch === "+" || ch === "-") {
        spans.push({ start: barStart + i, end: barStart + j, token: ch === "+" ? "success" : "error" });
      }
      i = j;
    }
    return paintSpans(theme, line, spans);
  }

  STATUS_GLYPH_RE.lastIndex = 0;
  const glyphs: ConsoleSpan[] = [];
  for (const match of line.matchAll(STATUS_GLYPH_RE)) {
    const start = match.index ?? 0;
    const ch = match[0]!;
    glyphs.push({ start, end: start + ch.length, token: ch === "✖" || ch === "✗" ? "error" : "success" });
  }
  const mixed = [
    ...spansFrom(TEST_PASS_RE, line, "success"),
    ...spansFrom(TEST_FAIL_RE, line, "error"),
    ...spansFrom(INSERTIONS_RE, line, "success"),
    ...spansFrom(DELETIONS_RE, line, "error"),
    ...spansFrom(PASS_WORD_RE, line, "success"),
    ...spansFrom(FAIL_WORD_RE, line, "error"),
    ...glyphs,
  ];
  if (mixed.length > 0) return paintSpans(theme, line, mixed);
  return line;
}

export function limitCardItems<T>(items: readonly T[], max: number): CardItemLimit<T> {
  const visible = items.slice(0, Math.max(0, Math.floor(max)));
  return { visible, hidden: items.length - visible.length };
}
