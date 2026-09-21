// Pure todo-header parse/paint for the sticky todos header. No host imports,
// no I/O, no module state — all state lives in index.ts. Reuses only
// formatRowLine (theme.ts) and truncatePlain (text.ts).
import { currentIndicatorFrame, formatRowLine, paintAt, paintBold, LINE_WIDTH_RATIO } from "../core/theme.ts";
import { capRenderedRows, detailedRowLimit } from "../core/density.ts";
import { truncatePlain } from "../core/text.ts";

export type TodoStatus = "done" | "active" | "open" | "blocked" | "dropped";

export interface TodoItem {
  label: string;
  status: TodoStatus;
  phase?: string;
  note?: string;
}

export interface TodoHeaderState {
  items: TodoItem[];
  open: number;
  done: number;
  blocked: number;
  activeLabel: string;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const MAX_ITEMS = 50;
// Suffix style (live tool format): `- label [status] (Phase)` — the trailing
// phase paren is part of the raw output and must be tolerated.
const SUFFIX_RE = /^\s*[-*]\s+(.+?)\s*\[([^\]]*)\]\s*(?:\([^)]*\)\s*)?$/;
// Checkbox style (`/todo` markdown): `- [!] label <!-- blocker: reason -->`.
// Markers mirror STATUS_TO_MARKER: space pending, / in-progress, x done,
// - abandoned, ! blocked.
const CHECK_RE = /^\s*[-*]\s+\[([ xX/\-!])\]\s+(.+?)\s*(?:\([^)]*\)\s*)?$/;
const BLOCKER_COMMENT_RE = /^(.*?)\s*<!--\s*blocker:\s*(.*?)\s*-->\s*$/;
const ACTIVE_PHASE_RE = /^\s*Active phase[:\s]+(.+?)\s*$/i;
const QUOTED_RE = /"([^"]+)"/;
function toStatus(token: string): TodoStatus {
  const t = token.trim().toLowerCase();
  if (t === "x" || t === "done" || t === "completed") return "done";
  if (t === "in_progress" || t === "active" || t === "doing" || t === "/") return "active";
  if (t === "blocked" || t === "!") return "blocked";
  if (t === "abandoned" || t === "dropped" || t === "-") return "dropped";
  return "open";
}

export function parseTodoResult(raw: string): TodoHeaderState | null {
  const text = String(raw ?? "").replace(ANSI_RE, "");
  const items: TodoItem[] = [];
  let phaseFallback = "";
  for (const line of text.split("\n")) {
    if (items.length >= MAX_ITEMS) break;
    const check = line.match(CHECK_RE);
    if (check) {
      const marker = check[1] ?? " ";
      let label = (check[2] ?? "").trim();
      if (!label) continue;
      let note: string | undefined;
      const blocker = label.match(BLOCKER_COMMENT_RE);
      if (blocker) {
        label = (blocker[1] ?? "").trim();
        note = (blocker[2] ?? "").trim() || undefined;
        if (!label) continue;
      }
      const status =
        marker === "!" ? "blocked" : marker === "-" ? "dropped" : marker === "/" ? "active" : toStatus(marker);
      items.push({ label, status, note });
      continue;
    }
    const m = line.match(SUFFIX_RE);
    if (m) {
      const label = (m[1] ?? "").trim();
      if (!label) continue;
      items.push({ label, status: toStatus(m[2] ?? "") });
      continue;
    }
    if (!phaseFallback) {
      const phase = line.match(ACTIVE_PHASE_RE);
      if (phase) {
        const capture = (phase[1] ?? "").trim();
        phaseFallback = capture.match(QUOTED_RE)?.[1]?.trim() || capture;
      }
    }
  }
  if (items.length === 0) return null;
  const active = items.find((i) => i.status === "active");
  return {
    items,
    open: items.filter((i) => i.status === "open" || i.status === "active").length,
    done: items.filter((i) => i.status === "done" || i.status === "dropped").length,
    blocked: items.filter((i) => i.status === "blocked").length,
    activeLabel: (active?.label || phaseFallback).trim(),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function phaseTaskStatus(status: unknown): TodoStatus {
  const t = typeof status === "string" ? status.trim().toLowerCase() : "";
  if (t === "completed" || t === "done" || t === "x") return "done";
  if (t === "in_progress" || t === "active" || t === "doing" || t === "/") return "active";
  if (t === "blocked" || t === "!") return "blocked";
  if (t === "abandoned" || t === "dropped" || t === "-") return "dropped";
  return "open";
}

// Structured path: the todo tool ships its snapshot as details.phases
// (TodoPhase[] { name, tasks: [{ content, status, blocker? }] }). Native
// cards may carry no text at all, so this is tried before the text parser.
// Blocked tasks keep their reason in `note`; every item keeps its phase name.
export function parseTodoPhases(details: unknown): TodoHeaderState | null {
  if (!isRecord(details)) return null;
  const raw = (details as { phases?: unknown }).phases;
  if (!Array.isArray(raw)) return null;
  const items: TodoItem[] = [];
  for (const phase of raw) {
    if (!isRecord(phase) || !Array.isArray((phase as { tasks?: unknown }).tasks)) continue;
    const phaseName =
      typeof (phase as { name?: unknown }).name === "string" ? ((phase as { name: string }).name ?? "").trim() : "";
    for (const task of (phase as { tasks: unknown[] }).tasks) {
      if (items.length >= MAX_ITEMS) break;
      if (!isRecord(task) || typeof (task as { content?: unknown }).content !== "string") continue;
      const label = ((task as { content: string }).content ?? "").trim();
      if (!label) continue;
      const note =
        typeof (task as { blocker?: unknown }).blocker === "string"
          ? ((task as { blocker: string }).blocker ?? "").trim()
          : "";
      items.push({
        label,
        status: phaseTaskStatus((task as { status?: unknown }).status),
        phase: phaseName || undefined,
        note: note || undefined,
      });
    }
    if (items.length >= MAX_ITEMS) break;
  }
  // Empty phases is a real snapshot (rm-all / settled clear). null would
  // leave callers holding the previous list.
  if (items.length === 0) return { items: [], open: 0, done: 0, blocked: 0, activeLabel: "" };
  return {
    items,
    open: items.filter((i) => i.status === "open" || i.status === "active").length,
    done: items.filter((i) => i.status === "done" || i.status === "dropped").length,
    blocked: items.filter((i) => i.status === "blocked").length,
    activeLabel: (items.find((i) => i.status === "active")?.label ?? "").trim(),
  };
}

const USER_TODO_EDIT = "user_todo_edit";

// Host stores the canonical snapshot on `user_todo_edit` custom entries and
// `toolResult` messages (`message.details.phases`). Walking those — newest
// first, empty arrays included — matches getLatestTodoPhasesFromEntries so
// the widget cannot latch onto a stale older snapshot after a clear.
export function latestTodoDetailsFromEntries(entries: unknown): { phases: unknown } | undefined {
  if (!Array.isArray(entries)) return undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!isRecord(entry)) continue;
    if (entry.type === "custom" && entry.customType === USER_TODO_EDIT) {
      const data = entry.data;
      if (isRecord(data) && Array.isArray(data.phases)) return { phases: data.phases };
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!isRecord(message)) continue;
    if (message.role !== "toolResult" || message.toolName !== "todo" || message.isError === true) continue;
    const details = message.details;
    if (isRecord(details) && Array.isArray(details.phases)) return { phases: details.phases };
  }
  return undefined;
}

export const TODO_DONE_ANIM_MS = 500;
export const TODO_SCAN_PERIOD_MS = 1400;
export const TODO_PHASE_TASK_LIMIT = 4;

export function todoItemKey(item: TodoItem): string {
  return `${item.phase ?? ""}\0${item.label}`;
}

export interface TodoAnim {
  now: number;
  completingAt: ReadonlyMap<string, number>;
  running: boolean;
}

export interface TodoPhaseGroup {
  name: string;
  items: TodoItem[];
}

export function groupTodoPhases(items: readonly TodoItem[]): TodoPhaseGroup[] {
  const groups: TodoPhaseGroup[] = [];
  const index = new Map<string, TodoPhaseGroup>();
  for (const item of items) {
    const name = (item.phase ?? "").trim();
    let group = index.get(name);
    if (!group) {
      group = { name, items: [] };
      index.set(name, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

export function todoHasActiveTransition(completingAt: ReadonlyMap<string, number>, now = Date.now()): boolean {
  for (const started of completingAt.values()) {
    if (now - started < TODO_DONE_ANIM_MS) return true;
  }
  return false;
}

export function todoNeedsPump(
  state: TodoHeaderState | null,
  completingAt: ReadonlyMap<string, number>,
  running: boolean,
  now = Date.now(),
): boolean {
  if (!state || state.items.length === 0) return false;
  if (running && state.items.some((item) => item.status === "active")) return true;
  return todoHasActiveTransition(completingAt, now);
}

const STRIKE_START = "\x1b[9m";
const STRIKE_END = "\x1b[29m";
/** Settling rows hold briefly, then a line sweeps across the label. */
export const TODO_STRIKE_HOLD_MS = 120;
export const TODO_STRIKE_REVEAL_MS = TODO_DONE_ANIM_MS - TODO_STRIKE_HOLD_MS;

/** Theme box glyphs (native `checkbox.checked`/`unchecked`) with an ASCII fallback. */
function checkboxGlyphs(theme: unknown): { checked: string; unchecked: string } {
  const box = (theme as { checkbox?: { checked?: unknown; unchecked?: unknown } } | undefined)?.checkbox;
  const checked = typeof box?.checked === "string" && box.checked ? box.checked : "[x]";
  const unchecked = typeof box?.unchecked === "string" && box.unchecked ? box.unchecked : "[ ]";
  return { checked, unchecked };
}

/**
 * Intermediate box for blocked/dropped rows: the same box with a marker inside it. ASCII boxes carry
 * the marker in their interior (`[!]`, `[-]`); glyph boxes use their box-family sibling (`☒`, `⊟`),
 * so a row never mixes families.
 */
function intermediateBox(unchecked: string, marker: string, glyph: string): string {
  const interior = unchecked.indexOf(" ");
  if (interior < 0) return glyph;
  return `${unchecked.slice(0, interior)}${marker}${unchecked.slice(interior + 1)}`;
}

/** The box a row starts with; `active` keeps its indicator instead of a box. */
export function todoStatusBox(theme: unknown, status: TodoStatus): string {
  const { checked, unchecked } = checkboxGlyphs(theme);
  if (status === "done") return checked;
  if (status === "blocked") return intermediateBox(unchecked, "!", "\u2612");
  if (status === "dropped") return intermediateBox(unchecked, "-", "\u229f");
  return unchecked;
}

function strikeAll(text: string): string {
  return `${STRIKE_START}${text}${STRIKE_END}`;
}

/** Struck prefix over the first `count` characters; input is unpainted text. */
function partialStrike(text: string, count: number): string {
  if (count <= 0) return text;
  const chars = [...text];
  if (count >= chars.length) return strikeAll(text);
  return `${strikeAll(chars.slice(0, count).join(""))}${chars.slice(count).join("")}`;
}

/**
 * Settled rows are struck through. Rows that settled in this frame hold for one tick and then the
 * line sweeps across the label; settled rows from history are struck whole.
 */
function strikeFor(text: string, startedAt: number | undefined, now: number): string {
  if (startedAt === undefined) return strikeAll(text);
  const elapsed = Math.max(0, now - startedAt);
  const reveal = Math.min(1, Math.max(0, (elapsed - TODO_STRIKE_HOLD_MS) / TODO_STRIKE_REVEAL_MS));
  return partialStrike(text, Math.ceil([...text].length * reveal));
}

function isStruck(status: TodoStatus): boolean {
  return status === "done" || status === "dropped";
}

function statusMark(theme: unknown, status: TodoStatus, anim?: TodoAnim): string {
  if (status === "active") return anim?.running ? currentIndicatorFrame() : "◐";
  return todoStatusBox(theme, status);
}

function itemDetail(item: TodoItem, inPhaseTree: boolean): string {
  let tail = "";
  if (item.status === "blocked") tail = item.note ? ` — blocked: ${item.note}` : " — blocked";
  else if (item.status === "dropped") tail = " (dropped)";
  if (!inPhaseTree && item.phase) tail += ` (${item.phase})`;
  return tail;
}

function showPhaseHeaders(groups: readonly TodoPhaseGroup[]): boolean {
  if (groups.length > 1) return true;
  const name = groups[0]?.name ?? "";
  return name !== "" && name.toLowerCase() !== "todos";
}

function rowBudget(width: number, prefixLen: number): number {
  const w = Math.max(1, Math.floor((Math.floor(width) || 0) * LINE_WIDTH_RATIO));
  return Math.max(1, w - prefixLen);
}

export function scanText(
  theme: unknown,
  text: string,
  now: number,
  opts?: { periodMs?: number; baseOpacity?: number },
): string {
  if (!text) return "";
  const chars = [...text];
  const n = chars.length;
  const window = Math.max(3, Math.min(8, Math.ceil(n * 0.25) + 2));
  const period = Math.max(1, opts?.periodMs ?? TODO_SCAN_PERIOD_MS);
  const t = ((now % (period * 2)) + period * 2) % (period * 2);
  const u = t <= period ? t / period : 2 - t / period;
  const pos = u * (n + window) - window;
  let out = "";
  for (let i = 0; i < n; i++) {
    const d = i - pos;
    if (d >= 0 && d < window) {
      const u = d / window;
      const op = 0.42 + 0.58 * Math.sin(Math.PI * u);
      out += paintAt(theme, chars[i] ?? "", "accent", op);
    } else {
      out += paintAt(theme, chars[i] ?? "", "toolOutput", opts?.baseOpacity ?? 0.75);
    }
  }
  return out;
}

function paintLabel(
  theme: unknown,
  item: TodoItem,
  label: string,
  anim: TodoAnim | undefined,
  completingStarted: number | undefined,
): string {
  const now = anim?.now ?? 0;
  if (item.status === "active") {
    return anim?.running ? scanText(theme, label, now, { baseOpacity: 1 }) : paintAt(theme, label, "toolOutput", 1);
  }
  const body = isStruck(item.status) ? strikeFor(label, completingStarted, now) : label;
  if (item.status === "done") return paintAt(theme, body, "dim", 0.7);
  if (item.status === "blocked") return paintAt(theme, body, "warning", 0.85);
  if (item.status === "dropped") return paintAt(theme, body, "dim", 0.55);
  return paintAt(theme, body, "toolOutput", 0.75);
}

export const TODO_TOGGLE_SHORTCUT = "Ctrl+Alt+T";

/**
 * One extra column over the plain row indent: todo rows share the card content column (the same
 * column card detail rows and thought rails use), so the widget lines up with every other surface.
 */
export const TODO_ROW_INDENT = " ";

export function todoToggleHint(collapsed: boolean): string {
  return `${collapsed ? "▸ expand" : "▾ collapse"} · ${TODO_TOGGLE_SHORTCUT}`;
}
export function renderTodoHeader(
  theme: unknown,
  width: number,
  state: TodoHeaderState,
  collapsed: boolean,
  anim?: TodoAnim,
  phaseTaskLimit = TODO_PHASE_TASK_LIMIT,
): string[] {
  if (!state || state.items.length === 0) return [];
  const activeSuffix = state.activeLabel ? ` — ${truncatePlain(state.activeLabel.trim(), 60)}` : "";
  const blockedSuffix = state.blocked > 0 ? `, ${state.blocked} blocked` : "";
  const head = `${collapsed ? "▸" : "▾"} Todos ${state.open} open, ${state.done} done${blockedSuffix}${collapsed ? activeSuffix : ""}`;
  if (collapsed) {
    const active = state.items.find((item) => item.status === "active");
    const body =
      active && anim?.running
        ? `▸ Todos ${state.open} open, ${state.done} done${blockedSuffix} — ${scanText(theme, truncatePlain(active.label.trim(), 60), anim.now)}`
        : head;
    return [
      formatRowLine(theme, width, {
        body: `${TODO_ROW_INDENT}${body}`,
        right: todoToggleHint(true),
      }),
    ];
  }
  const rows = [
    formatRowLine(theme, width, {
      body: `${TODO_ROW_INDENT}${head}`,
      right: todoToggleHint(false),
    }),
  ];
  const groups = groupTodoPhases(state.items);
  const phased = showPhaseHeaders(groups);
  const now = anim?.now ?? Date.now();
  for (const group of groups) {
    const visibleItems = Number.isFinite(phaseTaskLimit)
      ? group.items.slice(-Math.max(0, Math.floor(phaseTaskLimit)))
      : group.items;
    const hiddenCount = group.items.length - visibleItems.length;
    if (phased) {
      const hot = visibleItems.some((item) => {
        const started = anim?.completingAt?.get?.(todoItemKey(item));
        return started !== undefined && now - started < TODO_DONE_ANIM_MS;
      });
      const name = group.name || "Todos";
      const titleText = hiddenCount > 0 ? `${name} · ${hiddenCount} older` : name;
      const prefix = `${TODO_ROW_INDENT}    `;
      const title = truncatePlain(titleText, rowBudget(width, prefix.length));
      rows.push(`${prefix}${paintBold(theme, paintAt(theme, title, hot ? "accent" : "dim", hot ? 1 : 0.7))}`);
    }
    const taskIndent = `${TODO_ROW_INDENT}${phased ? "    " : "  "}`;
    for (const [index, item] of visibleItems.entries()) {
      const key = todoItemKey(item);
      const completingStarted = anim?.completingAt?.get?.(key);
      const completing = completingStarted !== undefined && now - completingStarted < TODO_DONE_ANIM_MS;
      const glyph = statusMark(theme, item.status, anim);
      const branch = phased ? (index === visibleItems.length - 1 ? "╰─" : "├─") : "";
      const plainPrefix = `${taskIndent}${branch ? `${branch} ` : ""}${glyph} `;
      const raw = `${item.label}${itemDetail(item, phased)}`;
      const label = truncatePlain(raw, rowBudget(width, plainPrefix.length));
      const glyphPaint = paintAt(
        theme,
        glyph,
        item.status === "done" ? "success" : item.status === "blocked" ? "warning" : "dim",
        completing || item.status === "active" ? 1 : 0.8,
      );
      const rowStart = branch ? `${taskIndent}${paintAt(theme, branch, "dim", 0.7)} ` : taskIndent;
      rows.push(`${rowStart}${glyphPaint} ${paintLabel(theme, item, label, anim, completingStarted)}`);
    }
  }
  return rows;
}

export function renderDensityTodoHeader(
  theme: unknown,
  width: number,
  state: TodoHeaderState,
  expanded: boolean,
  anim?: TodoAnim,
): string[] {
  if (!expanded) return renderTodoHeader(theme, width, state, true, anim);
  const maxRows = detailedRowLimit();
  const lines = renderTodoHeader(theme, width, state, false, anim, maxRows);
  const hiddenRows = Math.max(1, lines.length - maxRows + 1);
  const overflow = formatRowLine(theme, width, {
    body: `Todos — … ${hiddenRows} more rows`,
    indent: true,
  });
  return capRenderedRows(lines, maxRows, overflow);
}
