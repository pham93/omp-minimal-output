// Compact eval output card (grok-build row grammar, theme-derived colors).
// Display-only: execution and delegation stay in index.ts.
//
// Replaces the native boxed `Output` panel: one header row, a short input
// preview (3 lines collapsed, 60 expanded), then stdout in full color but
// dim-blended to row opacity — indented, no border, no background. A dim
// labeled rule (`── output ──`) separates input from output, with an accent
// pulse sweeping it while running. Core re-invokes renderResult with partial
// results (`isPartial`); the card streams those as a live tail (last 3 lines
// collapsed, 60 expanded).
// Full text sits behind Ctrl+O.
import { Container, visibleWidth } from "@oh-my-pi/pi-tui";
import { resolveParentCardLabel, type ParentCardLabel } from "./card-primitives.ts";
import { markFlush } from "./loaders.ts";
import { durationSuffix, isToolError, toolResultText } from "./results.ts";
import {
  LINE_WIDTH_RATIO,
  TOOL_INDENT,
  dimAnsi,
  elapsedSuffix,
  formatRowLine,
  paintAt,
  rowOpacity,
  setSpinFrame,
  stripSgr,
} from "./theme.ts";
import { evalCell, evalLabelText, truncatePlain } from "./text.ts";
import { highlightCell } from "./edit-card.ts";

// Collapsed rows stay small: 3 input lines, 5 output lines, 3 streamed
// lines. Expanded rows match the edit card budget (60/60/60); anything
// beyond sits behind Ctrl+O.
const INPUT_COLLAPSED_LINES = 3;
const INPUT_EXPANDED_LINES = 60;
const OUTPUT_COLLAPSED_LINES = 5;
const OUTPUT_EXPANDED_LINES = 60;
const STREAM_COLLAPSED_LINES = 3;
const STREAM_EXPANDED_LINES = 60;

function contentWidth(width: number): number {
  return Math.max(1, Math.floor((Math.floor(width) || 0) * LINE_WIDTH_RATIO) - TOOL_INDENT.length);
}

// Scanning divider pulse: width in dashes, step cadence in ms.
const SCAN_WIDTH = 6;
const SCAN_STEP_MS = 17;

// Labeled rule. While running, a SCAN_WIDTH pulse in the theme accent sweeps
// the whole line end to end — label included, index 0 to the last dash —
// ping-pong (position read at render time so every repaint advances it);
// settled rows keep the static dim rule.
function paintRule(theme: unknown, label: string, fill: number, scanning: boolean, op: number): string {
  const full = `${label}${"─".repeat(fill)}`;
  const chars = Array.from(full);
  const width = Math.min(SCAN_WIDTH, Math.max(1, chars.length));
  if (!scanning) return paintAt(theme, full, "dim", op);
  const slots = Math.max(1, chars.length - width + 1);
  const period = slots === 1 ? 1 : 2 * (slots - 1);
  const phase = Math.floor(Date.now() / SCAN_STEP_MS) % period;
  const start = phase < slots ? phase : 2 * (slots - 1) - phase;
  return (
    paintAt(theme, chars.slice(0, start).join(""), "dim", op) +
    paintAt(theme, chars.slice(start, start + width).join(""), "accent", 1) +
    paintAt(theme, chars.slice(start + width).join(""), "dim", op)
  );
}

// Run start per tool fingerprint. Core rebuilds (re-invoking renderers) on
// every partial result, so a closure-captured timestamp would pin elapsed to
// ~0s; first sighting per fp wins, settled results clear it.
const evalRunSince = new Map<string, number>();

function runSince(fp: string | undefined): number {
  if (!fp) return Date.now();
  const seen = evalRunSince.get(fp);
  if (seen !== undefined) return seen;
  const now = Date.now();
  evalRunSince.set(fp, now);
  if (evalRunSince.size > 40) {
    const oldest = evalRunSince.keys().next();
    if (!oldest.done && oldest.value !== fp) evalRunSince.delete(oldest.value);
  }
  return now;
}

// Full output text for the card. Prefers the pre-collapse stash our
// tool_result handler saves in details: the live result content may already
// start with the ◆ one-liner prepended for Ctrl+O, which would otherwise
// duplicate the header as the first output line. Falls back to dropping our
// own one-liner when the stash is absent.
function evalResultText(result: unknown, header: string): string {
  const details =
    typeof result === "object" && result !== null
      ? ((result as { details?: unknown }).details as Record<string, unknown> | undefined)
      : undefined;
  const stashed = details !== undefined && typeof details === "object" ? details["minimalFullText"] : undefined;
  if (typeof stashed === "string" && stashed) return stashed;
  const raw = toolResultText(result);
  const nl = raw.indexOf("\n");
  const first = (nl === -1 ? raw : raw.slice(0, nl)).trim();
  if (nl !== -1 && first === `◆ ${stripSgr(header).trim()}`) return raw.slice(nl + 1);
  return raw;
}

export function renderEvalCard(
  theme: unknown,
  args: unknown,
  result: unknown,
  options: unknown,
  live: boolean,
  fp?: string,
  parentLabel?: ParentCardLabel,
): Container {
  try {
    const header = evalLabelText(args);
    const partial =
      !live && result !== undefined && (options as { isPartial?: boolean } | null | undefined)?.isPartial === true;
    const settled = !live && result !== undefined && !partial;
    const running = live || partial;
    const error = settled && isToolError(result, options);
    const expanded = (options as { expanded?: boolean } | null | undefined)?.expanded === true;
    if (settled && fp) evalRunSince.delete(fp);
    const since = running ? runSince(fp) : 0;
    const cell = evalCell(args);
    const inputCap = expanded ? INPUT_EXPANDED_LINES : INPUT_COLLAPSED_LINES;
    const outputCap = expanded ? OUTPUT_EXPANDED_LINES : OUTPUT_COLLAPSED_LINES;
    const streamCap = expanded ? STREAM_EXPANDED_LINES : STREAM_COLLAPSED_LINES;
    const codeLines = cell.code ? cell.code.split("\n") : [];
    while (codeLines.length > 0 && !stripSgr(codeLines[codeLines.length - 1] ?? "").trim()) codeLines.pop();
    const input = codeLines.slice(0, inputCap);
    const inputMore = codeLines.length - input.length;
    // Settled body: first N output lines. Streaming body: last N lines of
    // the partial output so far (a live tail, not a head).
    let output: string[] = [];
    let more = 0;
    let earlierHint = false;
    let errorLines: string[] = [];
    if (settled || partial) {
      // Output keeps its ANSI colors; dimAnsi blends them to row opacity
      // and drops background fills (no boxes).
      const rawText = evalResultText(result, header);
      if (error) {
        const errSrc =
          stripSgr(rawText)
            .split("\n")
            .map((l) => l.trim())
            .find((l) => l) ?? "";
        for (const line of errSrc.split("\n").slice(0, 10)) {
          if (line.trim()) errorLines.push(line);
        }
      } else {
        const raw = rawText.split("\n");
        while (raw.length > 0 && !stripSgr(raw[raw.length - 1] ?? "").trim()) raw.pop();
        if (partial) {
          const tail = raw.slice(-streamCap);
          output = tail.length > 0 || raw.length > 0 ? tail : [];
          more = raw.length - output.length;
          earlierHint = true;
        } else {
          output = raw.slice(0, outputCap);
          more = raw.length - output.length;
        }
      }
    }
    const c = new Container();
    c.addChild({
      render: (width: number): readonly string[] => {
        try {
          // Drive our shared spinner off core's ticker when it ticks (partial
          // streaming repaints): falls back to our own 120ms pump otherwise.
          const coreFrame = (options as { spinnerFrame?: unknown })?.spinnerFrame;
          if (typeof coreFrame === "number" && Number.isFinite(coreFrame)) setSpinFrame(coreFrame);
          const parent = resolveParentCardLabel(parentLabel);
          const right = running ? elapsedSuffix(since) : settled ? durationSuffix(result) : "";
          const lines = parent
            ? [
                formatRowLine(theme, width, { body: parent, live: running, error }),
                formatRowLine(theme, width, { body: header, tree: "last", error, right }),
              ]
            : [
                formatRowLine(theme, width, {
                  body: header,
                  live: running,
                  error,
                  // Settled outcome is a ● dot: green on success, red on error.
                  mark: settled ? "●" : undefined,
                  right,
                }),
              ];
          const w = contentWidth(width);
          const op = rowOpacity(false, undefined);
          for (const line of input) {
            const cellText = dimAnsi(theme, highlightCell(line, cell.language), op);
            lines.push(
              stripSgr(line).trim()
                ? `${TOOL_INDENT}${paintAt(theme, truncatePlain(cellText, w), "toolOutput", op)}`
                : "",
            );
          }
          if (inputMore > 0) lines.push(`${TOOL_INDENT}${paintAt(theme, `… (${inputMore} more lines)`, "dim", op)}`);
          if (!settled && !partial) return lines;
          if (input.length > 0 && (output.length > 0 || more > 0 || error)) {
            const sepLabel = `── ${error ? "error" : "output"} `;
            const sepFill = Math.max(2, w - TOOL_INDENT.length - visibleWidth(sepLabel));
            lines.push(`${TOOL_INDENT}${paintRule(theme, sepLabel, sepFill, running, op)}`);
          }
          if (error) {
            for (const line of errorLines) {
              lines.push(`${TOOL_INDENT}${paintAt(theme, truncatePlain(line, w), "error", 1)}`);
            }
            return lines;
          }
          if (earlierHint && more > 0)
            lines.push(`${TOOL_INDENT}${paintAt(theme, `… (${more} earlier lines)`, "dim", op)}`);
          for (const line of output) {
            const cellText = dimAnsi(theme, line, op);
            lines.push(
              stripSgr(line).trim()
                ? `${TOOL_INDENT}${paintAt(theme, truncatePlain(cellText, w), "toolOutput", op)}`
                : "",
            );
          }
          if (!earlierHint && more > 0)
            lines.push(`${TOOL_INDENT}${paintAt(theme, `… (${more} more lines)`, "dim", op)}`);
          return lines;
        } catch {
          return [formatRowLine(theme, width, { body: header, live: running, error })];
        }
      },
    });
    markFlush?.(c);
    return c;
  } catch {
    const c = new Container();
    c.addChild({
      render: (width: number): readonly string[] => [formatRowLine(theme, width, { body: "Eval", live, error: true })],
    });
    markFlush?.(c);
    return c;
  }
}
