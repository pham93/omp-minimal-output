/**
 * Inline todos on the host's status HUD row — the line that carries the working indicator and the
 * right-docked tok/s trailer. The segment is spliced in immediately before that trailer, so the row
 * reads `◠ Working…   ◆ Todos 3 open, 1 done — Task  ·  12.3 tok/s`.
 *
 * The row belongs to the host, so this is a display-only wrapper around the status container's render:
 * the host's own row is returned untouched when there are no todos, and when the host renders nothing
 * at all (no tok/s reading yet) the segment gets a row of its own rather than disappearing.
 */
import { padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { getContainerInterceptor, type ContainerInterceptor } from "../core/container-interceptor.ts";
import { rawOffsetForPlainIndex } from "./composer-primitives.ts";
import { runtimeHostFor } from "./thinking-widget.ts";

/** Wrapper bookkeeping that survives hot reload: the native render plus the installed wrapper. */
const STATUS_ROW_SEGMENT = Symbol.for("@local/omp-minimal-output/todo-status-row");
/** Two cells between the segment and the trailer, matching the host's own segment spacing. */
const TRAILER_GAP = "  ";
const MIN_BUDGET = 12;
/** Cap on the segment: the row also has to keep room for the working indicator and the trailer. */
const MAX_SEGMENT_CELLS = 56;
/** The tok/s readout is the marker that anchors the trailer, whatever the icon set spells it as. */
const RATE_MARKER = "tok/s";

export interface TodoStatusRowDeps {
  /** Process-global lease: false during hot reload or after the plugin was replaced. */
  owns: () => boolean;
  /** False when the plugin is disabled from `/minimal-off`. */
  enabled: () => boolean;
  /** Segment text for a cell budget; empty string hides the segment. */
  segment: (budget: number) => string;
}

interface SegmentState {
  /** The host's own render, restored verbatim on teardown. */
  original: (width: number) => readonly string[];
  /** The same render bound to the container, used by the wrapper. */
  native: (width: number) => readonly string[];
  wrapper: (width: number) => readonly string[];
  deps: TodoStatusRowDeps;
}

interface SegmentHost {
  render: (width: number) => readonly string[];
  [STATUS_ROW_SEGMENT]?: SegmentState;
}

/** Index where a text run starts, walking back over the dock padding before it. */
function runStartBefore(plain: string, index: number): number {
  const before = plain.slice(0, index);
  const gaps = [...before.matchAll(/ {2,}/gu)];
  const gap = gaps.at(-1);
  if (gap) return (gap.index ?? 0) + gap[0].length;
  return before.length - before.trimStart().length;
}

/**
 * Index where the row's right-docked trailer starts, in plain-text cells. The trailer is anchored on
 * the tok/s readout when the host has one; otherwise it is the row's final text run (the idle HUD is
 * dock padding plus the reading, and a row with no reading is all trailer).
 */
export function trailerStart(plain: string): number {
  const marker = plain.lastIndexOf(RATE_MARKER);
  if (marker >= 0) return runStartBefore(plain, marker);
  const trimmed = plain.replace(/\s+$/u, "");
  if (!trimmed) return plain.length;
  const gaps = [...trimmed.matchAll(/ {2,}/gu)];
  const gap = gaps.at(-1);
  if (gap) return (gap.index ?? 0) + gap[0].length;
  return trimmed.length - trimmed.trimStart().length;
}

/**
 * Index of the row that carries the right-docked trailer, or -1 when the host rendered no trailer.
 *
 * The host's idle HUD is two rows — a leading blank line and the reading line (`renderIdleStatusHud` in
 * `interactive-mode.ts`) — so painting every row would draw the segment twice: once alone in the blank
 * row the host reserved, once before the reading. The rate marker picks the reading row; with no reading
 * the last row carrying visible text is the trailer.
 */
export function trailerRowIndex(rows: readonly string[]): number {
  const rate = rows.findIndex((row) => Bun.stripANSI(row ?? "").includes(RATE_MARKER));
  if (rate >= 0) return rate;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (Bun.stripANSI(rows[index] ?? "").trim()) return index;
  }
  return -1;
}

/**
 * Splice the segment into one host row, immediately before the right-docked trailer. The row is
 * width-fitted already, so the dock padding before the trailer is what the segment takes; when the
 * host content leaves too little room the segment shrinks, and below a readable width the row is left
 * exactly as the host painted it.
 */
export function spliceStatusSegment(row: string, width: number, segment: string): string {
  if (!segment) return row;
  const start = trailerStart(Bun.stripANSI(row));
  const rawStart = rawOffsetForPlainIndex(row, start);
  const left = row.slice(0, rawStart);
  const trailer = row.slice(rawStart);
  const trailerWidth = visibleWidth(trailer);
  // The left run ends in the dock padding: keep the host content, drop padding as the segment needs it.
  const content = left.replace(/ +$/u, "");
  const contentWidth = visibleWidth(content);
  const room = width - contentWidth - trailerWidth - TRAILER_GAP.length;
  if (room < MIN_BUDGET) return row;
  const shown = truncateToWidth(segment, Math.min(visibleWidth(segment), room), "");
  const shownWidth = visibleWidth(shown);
  const pad = padding(Math.max(0, width - contentWidth - shownWidth - TRAILER_GAP.length - trailerWidth));
  return `${content}${pad}${shown}${TRAILER_GAP}${trailer}`;
}

/** Paint the status HUD with the todo segment: the trailer row, or a row of our own when it has none. */
function paintRows(rows: readonly string[], width: number, deps: TodoStatusRowDeps): readonly string[] {
  if (!deps.owns() || !deps.enabled()) return rows;
  const target = trailerRowIndex(rows);
  if (target < 0) {
    // No reading and no working row yet: keep the host's own rows and add the segment below them, so a
    // summary never disappears just because the host has nothing to dock it next to.
    const segment = deps.segment(Math.min(MAX_SEGMENT_CELLS, Math.max(0, width)));
    if (!segment) return rows;
    return [...rows, `${padding(Math.max(0, width - visibleWidth(segment)))}${segment}`];
  }
  const segment = deps.segment(Math.min(MAX_SEGMENT_CELLS, Math.max(0, width - MIN_BUDGET - TRAILER_GAP.length)));
  if (!segment) return rows;
  // Exactly one row: the host's blank spacer rows stay as painted.
  return rows.map((row, index) => (index === target ? spliceStatusSegment(row, width, segment) : row));
}

/** The host's status HUD container owns the mode it renders for, and that mode owns it back. */
export function isStatusHudContainer(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const mode = (value as { mode?: { statusContainer?: unknown } }).mode;
  return !!mode && typeof mode === "object" && mode.statusContainer === value;
}

let installed: SegmentHost | undefined;

/**
 * Install the status-row segment on the host's status container. Idempotent per container, and a no-op
 * when the composer runtime cannot be resolved (older host, headless run): the panel and the transcript
 * card still work, so nothing depends on this seam being present.
 */
export function ensureTodoStatusRow(tui: unknown, deps: TodoStatusRowDeps): void {
  const container = runtimeHostFor(tui)?.statusContainer as SegmentHost | undefined;
  ensureTodoStatusRowOnContainer(container, deps);
}

/** Install the segment on a known status container. Safe to call repeatedly and from any generation. */
export function ensureTodoStatusRowOnContainer(value: unknown, deps: TodoStatusRowDeps): void {
  const container = value as SegmentHost | undefined;
  if (!container || typeof container.render !== "function") return;
  const existing = container[STATUS_ROW_SEGMENT];
  if (existing) {
    existing.deps = deps;
    installed = container;
    return;
  }
  const original = container.render;
  const native = original.bind(container);
  const state: SegmentState = {
    original,
    native,
    deps,
    wrapper: (width: number): readonly string[] => {
      const rows = state.native(width);
      try {
        return paintRows(rows, width, state.deps);
      } catch {
        // Display-only: a failed splice must hand back the host's own row.
        return rows;
      }
    },
  };
  container[STATUS_ROW_SEGMENT] = state;
  container.render = state.wrapper;
  installed = container;
}

/**
 * Install the segment through the `Container.addChild` seam, so every generation finds the host's
 * status container when the composer mounts it. A hot reload re-registers the extension without
 * replaying `session_start`, which is why the TUI-handle path alone could leave the segment unpainted
 * after an edit to the plugin.
 */
export function installTodoStatusRowSkin(
  interceptor: ContainerInterceptor,
  deps: TodoStatusRowDeps,
): () => void {
  if (!interceptor.isAvailable) return () => {};
  // The host mounts the status HUD as a *child* of the composer, so the hook has to look at the
  // children it is inserting, not at the container that is receiving them.
  const unregister = interceptor.registerHook((_container, children) => {
    for (const child of children) {
      if (isStatusHudContainer(child)) ensureTodoStatusRowOnContainer(child, deps);
    }
  });
  return unregister ?? ((): void => {});
}

/** Restore the host status container's own render (disable, session teardown, hot reload). */
export function restoreTodoStatusRow(): void {
  const container = installed;
  installed = undefined;
  if (!container) return;
  const state = container[STATUS_ROW_SEGMENT];
  if (!state) return;
  if (container.render === state.wrapper) container.render = state.original;
  delete container[STATUS_ROW_SEGMENT];
}
