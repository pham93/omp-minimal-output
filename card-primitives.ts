// Small shared mechanics for card renderers. Tool-specific parsing stays local.
import { getPluginConfig } from "./config.ts";
import { detailProfile, minimalToolSummary, type DetailProfile } from "./density.ts";
import { isToolError, toolResultText } from "./results.ts";
import { LINE_WIDTH_RATIO, TOOL_INDENT, formatRowLine, isSettling, paintAt } from "./theme.ts";
import { truncatePlain } from "./text.ts";

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

export function resultDetails(result: unknown): Record<string, unknown> | undefined {
  if (typeof result !== "object" || result === null || Array.isArray(result) || !("details" in result)) {
    return undefined;
  }
  const details = result.details;
  if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
  const fields = details as Record<string, unknown>;
  return fields;
}

export function stashedResultText(result: unknown): string {
  const stashed = resultDetails(result)?.["minimalFullText"];
  return typeof stashed === "string" ? stashed : "";
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

export function cardDetailLine(theme: unknown, width: number, text: string): string {
  const cfg = getPluginConfig();
  const prefix = `${TOOL_INDENT}   `;
  const rowWidth = Math.max(1, Math.floor((Math.floor(width) || 0) * LINE_WIDTH_RATIO));
  const budget = Math.max(1, rowWidth - prefix.length);
  return `${prefix}${paintAt(theme, truncatePlain(text, budget), "dim", cfg.opacity)}`;
}

export function limitCardItems<T>(items: readonly T[], max: number): CardItemLimit<T> {
  const visible = items.slice(0, Math.max(0, Math.floor(max)));
  return { visible, hidden: items.length - visible.length };
}
