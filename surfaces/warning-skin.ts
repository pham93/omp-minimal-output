// One-line skin for host warning/error panes. Same addChild hook as
// read-group.ts: replace render with a ⚠/✗ row, no inverse Box.
// No fade-in: host freezes present()'d Text after first paint, so a ramp
// stuck at ~0.35 looks black until click. Pulse still reads spinFrame if
// the live region re-paints; otherwise the mark stays full-bright.
//
// Positive identity (union), never "lacks methods":
//   1. TodoReminder: todos[{content,status}] + attempt/maxAttempts
//   2. TTSR: addRules + setExpanded + isExpanded
//   3. showWarning/showError Text: getText() starts Warning: / Error:
//   4. ErrorBanner: dismiss caption or shipped class name
// Ctrl+O: TTSR isExpanded() → original render. Todo has no expand.

import { truncatePlain } from "../core/text.ts";
import { spinFrame, stripSgr, themeBgRgb, themeTokenRgb } from "../core/theme.ts";
import { getContainerInterceptor } from "../core/container-interceptor.ts";

const ALERT_KIND = {
  warning: "warning",
  error: "error",
} as const;
type AlertKind = (typeof ALERT_KIND)[keyof typeof ALERT_KIND];

const FALLBACK_RGB: Record<AlertKind, [number, number, number]> = {
  warning: [234, 179, 8],
  error: [239, 68, 68],
};

function alertPaint(theme: unknown, text: string, token: AlertKind, opacity: number): string {
  if (!text) return text;
  const a = Math.min(1, Math.max(0, opacity));
  const fg = themeTokenRgb(theme, token) ?? FALLBACK_RGB[token];
  const bg = themeBgRgb(theme);
  const r = Math.round(bg[0] + (fg[0] - bg[0]) * a);
  const g = Math.round(bg[1] + (fg[1] - bg[1]) * a);
  const b = Math.round(bg[2] + (fg[2] - bg[2]) * a);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

export const TODO_REMINDER_PREVIEW_RE = /incomplete todos?/i;
export const ALERT_PREFIX_RE = /^(Warning|Error):\s*/i;
const DISMISS_RE = /Dismissed when you send[^\n]*/i;
const RULE_LINE_RE = /^[─━═\-]+$/u;

function ctorNameOf(child: unknown): string {
  try {
    const c = child as { constructor?: { name?: unknown } };
    return typeof c.constructor?.name === "string" ? (c.constructor.name as string) : "";
  } catch {
    return "";
  }
}

function childTextOf(child: unknown): string {
  try {
    if (typeof child !== "object" || child === null) return "";
    const c = child as {
      debugState?: () => unknown;
      getText?: () => unknown;
      children?: unknown;
    };
    if (typeof c.getText === "function") {
      try {
        const t = c.getText();
        if (typeof t === "string") return t;
      } catch {
        // Fall through to debugState/children walk.
      }
    }
    if (typeof c.debugState === "function") {
      const s = c.debugState() as Record<string, unknown> | undefined;
      const preview = s?.["textPreview"];
      if (typeof preview === "string" && preview) return preview;
    }
    if (Array.isArray(c.children)) return c.children.map(childTextOf).join("\n");
  } catch {
    // Display-only; fall through.
  }
  return "";
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stripLeadMark(text: string): string {
  return text.replace(/^[^A-Za-z0-9]+/u, "").trim();
}

function getTextOf(child: unknown): string {
  if (typeof child !== "object" || child === null) return "";
  const getText = (child as { getText?: unknown }).getText;
  if (typeof getText !== "function") return "";
  try {
    const t = getText.call(child);
    return typeof t === "string" ? t : "";
  } catch {
    return "";
  }
}

function isFn(c: Record<string, unknown>, key: string): boolean {
  return typeof c[key] === "function";
}

function isTodoItem(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const t = value as { content?: unknown; status?: unknown };
  return typeof t.content === "string" && typeof t.status === "string";
}

function isTodoReminderLike(c: Record<string, unknown>): boolean {
  if (
    Array.isArray(c["todos"]) &&
    c["todos"].every(isTodoItem) &&
    typeof c["attempt"] === "number" &&
    typeof c["maxAttempts"] === "number"
  )
    return true;
  if (/todo.?reminder/i.test(ctorNameOf(c))) return true;
  return (
    isFn(c, "setToolActivityVisible") &&
    !isFn(c, "setExpanded") &&
    !isFn(c, "addRules") &&
    !isFn(c, "updateArgs") &&
    !isFn(c, "seal") &&
    TODO_REMINDER_PREVIEW_RE.test(childTextOf(c))
  );
}

function isTtsrLike(c: Record<string, unknown>): boolean {
  return isFn(c, "addRules") && isFn(c, "setExpanded") && isFn(c, "isExpanded");
}

function isAlertTextLike(c: Record<string, unknown>): boolean {
  return ALERT_PREFIX_RE.test(getTextOf(c).trimStart());
}

function isErrorBannerLike(c: Record<string, unknown>): boolean {
  if (/error.?banner/i.test(ctorNameOf(c))) return true;
  const children = c["children"];
  if (!Array.isArray(children) || children.length === 0 || children.length > 8) return false;
  if (isFn(c, "setExpanded") || isFn(c, "setToolActivityVisible")) return false;
  return DISMISS_RE.test(childTextOf(c));
}

function isActivityAlertLike(c: Record<string, unknown>): boolean {
  if (!isFn(c, "setToolActivityVisible") || !isFn(c, "setExpanded")) return false;
  if (isFn(c, "addRules") || isFn(c, "updateArgs") || isFn(c, "seal")) return false;
  return ALERT_PREFIX_RE.test(childTextOf(c).trimStart());
}

export function isAlertLike(child: unknown): boolean {
  if (typeof child !== "object" || child === null) return false;
  const c = child as Record<string, unknown>;
  if (!isFn(c, "render")) return false;
  return isTodoReminderLike(c) || isTtsrLike(c) || isAlertTextLike(c) || isErrorBannerLike(c) || isActivityAlertLike(c);
}

function todoHeaderOf(c: Record<string, unknown>): string | undefined {
  const todos = c["todos"];
  const attempt = c["attempt"];
  const maxAttempts = c["maxAttempts"];
  if (!Array.isArray(todos) || typeof attempt !== "number" || typeof maxAttempts !== "number") return undefined;
  const n = todos.length;
  const word = n === 1 ? "todo" : "todos";
  return `${n} incomplete ${word} — reminder ${attempt}/${maxAttempts}`;
}

function prefixKind(text: string): AlertKind | undefined {
  const m = text.trimStart().match(ALERT_PREFIX_RE);
  if (!m) return undefined;
  return m[1]?.toLowerCase() === "error" ? ALERT_KIND.error : ALERT_KIND.warning;
}

export function alertKindOf(child: unknown): AlertKind {
  if (typeof child !== "object" || child === null) return ALERT_KIND.warning;
  const c = child as Record<string, unknown>;
  if (isErrorBannerLike(c)) return ALERT_KIND.error;
  const fromGet = prefixKind(getTextOf(c));
  if (fromGet) return fromGet;
  const fromWalk = prefixKind(childTextOf(c));
  if (fromWalk) return fromWalk;
  return ALERT_KIND.warning;
}

function bodyFromNativeRender(origRender: ((width: number) => readonly string[]) | undefined, width: number): string {
  if (typeof origRender !== "function") return "";
  try {
    const lines = origRender(Math.max(40, Math.floor(width) || 80));
    for (const line of lines) {
      const plain = stripSgr(line).trim();
      if (!plain) continue;
      if (RULE_LINE_RE.test(plain)) continue;
      if (DISMISS_RE.test(plain)) continue;
      const stripped = stripLeadMark(plain);
      if (stripped) return stripped;
    }
  } catch {
    // Native render is a fallback only.
  }
  return "";
}

function alertBodyOf(
  child: unknown,
  origRender: ((width: number) => readonly string[]) | undefined,
  width: number,
): string {
  if (typeof child === "object" && child !== null) {
    const rec = child as Record<string, unknown>;
    const header = todoHeaderOf(rec);
    if (header) return header;
    if (isErrorBannerLike(rec)) return bodyFromNativeRender(origRender, width) || "error";
  }
  const got = getTextOf(child);
  if (got) {
    const stripped = stripLeadMark(collapse(got.replace(ALERT_PREFIX_RE, "")));
    if (stripped && !DISMISS_RE.test(stripped)) return stripped;
  }
  let raw = stripLeadMark(collapse(childTextOf(child).replace(DISMISS_RE, "")));
  raw = raw.replace(ALERT_PREFIX_RE, "").trim();
  if (!raw) raw = bodyFromNativeRender(origRender, width);
  if (!raw) return alertKindOf(child) === ALERT_KIND.error ? "error" : "warning";
  return raw;
}

export const WARNING_PULSE_STEPS = 5;
export function warningPulseStep(): number {
  return Math.floor(spinFrame / WARNING_PULSE_STEPS) % 2;
}
export function warningIconFrame(theme: unknown): string {
  const dim = warningPulseStep() === 1;
  return alertPaint(theme, "⚠", ALERT_KIND.warning, dim ? 0.6 : 1);
}

export function errorIconFrame(theme: unknown): string {
  return alertPaint(theme, "✗", ALERT_KIND.error, 1);
}

export function paintAlertLine(
  theme: unknown,
  width: number,
  child: unknown,
  origRender?: (width: number) => readonly string[],
): string[] {
  const kind = alertKindOf(child);
  const budget = Math.max(10, Math.floor(width) - 4);
  const body = truncatePlain(alertBodyOf(child, origRender, width), budget);
  const icon = kind === ALERT_KIND.error ? errorIconFrame(theme) : warningIconFrame(theme);
  return [` ${icon} ${alertPaint(theme, body, kind, 1)}`];
}

const liveAlerts = new Set<object>();
/** Host container each skinned alert was inserted into; drives the newest-block test below. */
let alertHosts = new WeakMap<object, { children?: unknown }>();

/**
 * The transcript commits blocks in order: a block that never reports finalized pins the frontier
 * and no later block is ever written to scrollback. Alerts stay unfinalized (animatable) only
 * while they are the newest block of their host container — nothing can sit behind them there —
 * and finalize as soon as any later block arrives so the commit cursor advances again.
 */
function alertIsNewest(child: object): boolean {
  const host = alertHosts.get(child);
  const children = host?.children;
  if (!Array.isArray(children) || children.length === 0) return false;
  return children[children.length - 1] === child;
}

export function alertSkinActive(): boolean {
  for (const child of liveAlerts) {
    if (alertIsNewest(child)) return true;
  }
  return false;
}

export function invalidateLiveAlerts(): void {
  for (const child of liveAlerts) {
    if (!alertIsNewest(child)) {
      // No longer the newest block of its container, so it can never pulse again: stop tracking it
      // instead of rescanning an ever-growing set on every pump tick.
      liveAlerts.delete(child);
      continue;
    }
    const inv = (child as { invalidate?: unknown }).invalidate;
    if (typeof inv === "function") {
      try {
        (inv as () => void).call(child);
      } catch {
        // Invalidate is best-effort; the next pump tick retries.
      }
    }
  }
}

let skinned = new WeakSet<object>();
let installed = false;

export interface WarningSkinDeps {
  enabled: () => boolean;
  theme: () => unknown;
  pump?: () => void;
  active?: () => boolean;
}

export function installWarningSkin(ContainerCtor: unknown, deps: WarningSkinDeps): () => void {
  if (installed) return () => {};
  const interceptor = getContainerInterceptor(ContainerCtor);
  if (!interceptor.isAvailable) return () => {};

  const unregister = interceptor.registerHook((container, args) => {
    if (deps.active?.() === false) return;
    for (const arg of args) {
      try {
        if (arg && typeof arg === "object" && !skinned.has(arg as object) && isAlertLike(arg)) {
          skinAlert(arg as object, deps, container);
        }
      } catch {
        // One bad child must not break the container.
      }
    }
  });
  if (!unregister) return () => {};
  installed = true;
  let active = true;

  return () => {
    if (!active) return;
    active = false;
    liveAlerts.clear();
    alertHosts = new WeakMap<object, { children?: unknown }>();
    unregister();
    installed = false;
    skinned = new WeakSet<object>();
  };
}

function skinAlert(child: object, deps: WarningSkinDeps, host: unknown): void {
  const c = child as Record<string, unknown> & {
    render?: (width: number) => readonly string[];
    setToolActivityVisible?: (visible: boolean) => void;
    isExpanded?: () => boolean;
  };
  if (typeof c.render !== "function") return;
  if (host && typeof host === "object") alertHosts.set(child, host as { children?: unknown });
  const origRender = c.render.bind(child);
  let toolActivityVisible = true;
  const origSetToolActivityVisible =
    typeof c.setToolActivityVisible === "function" ? c.setToolActivityVisible.bind(child) : undefined;
  try {
    if (origSetToolActivityVisible) {
      (c as Record<string, unknown>)["setToolActivityVisible"] = function (visible: boolean) {
        toolActivityVisible = visible !== false;
        return (origSetToolActivityVisible as (v: boolean) => unknown)(visible);
      };
    }
    // Host: an alert that never finalizes pins the transcript frontier, so every later block —
    // including whole assistant messages — is dropped from the live window and never committed.
    // Keep the pulse while this alert is the newest block (nothing behind it to pin); finalize
    // once anything follows so scrollback keeps growing.
    (c as Record<string, unknown>)["isTranscriptBlockFinalized"] = function (): boolean {
      return !alertIsNewest(child);
    };
    (c as Record<string, unknown>)["getTranscriptBlockVersion"] = function (): number {
      return alertIsNewest(child) ? spinFrame : 0;
    };
    (c as Record<string, unknown>)["render"] = function (width: number): readonly string[] {
      if (!toolActivityVisible) return [];
      if (deps.active?.() === false || !deps.enabled()) return origRender(width);
      try {
        if (typeof c.isExpanded === "function" && c.isExpanded() === true) return origRender(width);
        return paintAlertLine(deps.theme(), width, child, origRender);
      } catch {
        return origRender(width);
      }
    };
  } catch {
    return;
  }
  if (deps.active?.() === false) return;
  liveAlerts.add(child);
  try {
    deps.pump?.();
  } catch {}
  skinned.add(child);
}
