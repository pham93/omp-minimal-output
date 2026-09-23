// Compact eval output card (grok-build row grammar, theme-derived colors).
// Display-only: execution and delegation stay in index.ts.
//
// Replaces the native boxed `Output` panel: one header row, a short input
// preview, then stdout in full color but dim-blended to row opacity —
// indented, no border, no background. A dim labeled rule (`── output ──`)
// separates input from output, with an accent pulse sweeping it while
// running. Core re-invokes renderResult with partial results (`isPartial`);
// Ctrl+O uses the configured Detailed content-row ceiling.
import { Container, visibleWidth } from "@oh-my-pi/pi-tui";
import { cardLifecycle, colorizeConsoleLine, minimalCardHeaderLine, parentCardHeaderLines, resolveParentCardLabel, type ParentCardLabel, CARD_CONTENT_PREFIX, } from "./card-primitives.ts";
import { inputRowLimit, outputRowLimit } from "../core/density.ts";
import { markFlush } from "../core/loaders.ts";
import { durationSuffix, isToolError, toolResultText } from "../core/results.ts";
import {
  LINE_WIDTH_RATIO,
  dimAnsi,
  elapsedSuffix,
  formatRowLine,
  paintAt,
  rowOpacity,
  setSpinFrame,
  stripSgr,
} from "../core/theme.ts";
import { boundedTextLines, evalCell, evalLabelText, truncatePlain } from "../core/text.ts";
import { highlightCell } from "./edit-card.ts";

// Input and output previews use independent content-row budgets from
// density.ts; headers, rules, and hints sit outside those allowances.

function contentWidth(width: number): number {
  return Math.max(1, Math.floor((Math.floor(width) || 0) * LINE_WIDTH_RATIO) - CARD_CONTENT_PREFIX.length);
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
  // Compare without the leading mark: the one-liner is prefixed with whatever `indicator` resolves to.
  const withoutMark = (line: string): string => line.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  const first = withoutMark(nl === -1 ? raw : raw.slice(0, nl));
  if (nl !== -1 && first === stripSgr(header).trim()) return raw.slice(nl + 1);
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
    const lifecycle = cardLifecycle(result, options);
    const running = live || lifecycle.running;
    const error = lifecycle.error;
    if (lifecycle.settled && fp) evalRunSince.delete(fp);
    const since = running ? runSince(fp) : 0;
    const cell = evalCell(args);
    const inputCap = Math.max(0, Math.floor(inputRowLimit(lifecycle.detail)));
    const inputWindow = boundedTextLines(cell.code ?? "", inputCap);
    const input = inputWindow.lines;
    const inputMore = inputWindow.total - input.length;

    let output: string[] = [];
    let more = 0;
    let earlierHint = false;
    const errorLines: string[] = [];
    if (result !== undefined) {
      const rawText = evalResultText(result, header);
      const outputCap = Math.max(0, Math.floor(outputRowLimit(lifecycle.detail)));
      if (error) {
        let start = 0;
        const stripped = stripSgr(rawText);
        while (errorLines.length < outputCap && start <= stripped.length) {
          const nl = stripped.indexOf("\n", start);
          const end = nl === -1 ? stripped.length : nl;
          const line = stripped.slice(start, end).trim();
          if (line) errorLines.push(line);
          if (nl === -1) break;
          start = nl + 1;
        }
      } else {
        const window = boundedTextLines(rawText, outputCap, lifecycle.partial ? "tail" : "head");
        output = window.lines;
        more = window.total - output.length;
        earlierHint = lifecycle.partial && more > 0;
      }
    }

    const c = new Container();
    c.addChild({
      render: (width: number): readonly string[] => {
        try {
          const coreFrame = (options as { spinnerFrame?: unknown })?.spinnerFrame;
          if (typeof coreFrame === "number" && Number.isFinite(coreFrame)) setSpinFrame(coreFrame);
          const right = running ? elapsedSuffix(since) : lifecycle.settled ? durationSuffix(result) : "";
          if (lifecycle.detail.minimal) {
            return [
              minimalCardHeaderLine(theme, width, {
                body: error ? `${header} — failed` : header,
                lifecycle,
                right,
                fingerprint: fp,
                parentLabel,
              }),
            ];
          }

          const lines = parentCardHeaderLines(theme, width, {
            body: header,
            lifecycle,
            right,
            fingerprint: fp,
            parentLabel,
          });
          const w = contentWidth(width);
          const op = rowOpacity(false, undefined);
          for (const line of input) {
            const cellText = dimAnsi(theme, highlightCell(line, cell.language), op);
            lines.push(
              stripSgr(line).trim()
                ? `${CARD_CONTENT_PREFIX}${paintAt(theme, truncatePlain(cellText, w), "toolOutput", op)}`
                : "",
            );
          }
          if (inputMore > 0) {
            lines.push(
              `${CARD_CONTENT_PREFIX}${paintAt(theme, truncatePlain(`… (${inputMore} more input lines)`, w), "dim", op)}`,
            );
          }
          if (result !== undefined && (output.length > 0 || more > 0 || error)) {
            if (input.length > 0) {
              const sepLabel = `── ${error ? "error" : "output"} `;
              const sepFill = Math.max(2, w - CARD_CONTENT_PREFIX.length - visibleWidth(sepLabel));
              lines.push(`${CARD_CONTENT_PREFIX}${paintRule(theme, sepLabel, sepFill, running, op)}`);
            }
            if (error) {
              for (const line of errorLines) {
                lines.push(`${CARD_CONTENT_PREFIX}${paintAt(theme, truncatePlain(line, w), "error", 1)}`);
              }
            } else {
              if (earlierHint && more > 0) {
                lines.push(
                  `${CARD_CONTENT_PREFIX}${paintAt(theme, truncatePlain(`… (${more} earlier lines)`, w), "dim", op)}`,
                );
              }
              for (const line of output) {
                const cellText = dimAnsi(theme, colorizeConsoleLine(theme, line), op);
                lines.push(
                  stripSgr(line).trim()
                    ? `${CARD_CONTENT_PREFIX}${paintAt(theme, truncatePlain(cellText, w), "toolOutput", op)}`
                    : "",
                );
              }
              if (!earlierHint && more > 0) {
                lines.push(
                `${CARD_CONTENT_PREFIX}${paintAt(theme, truncatePlain(`… (${more} more lines)`, w), "dim", op)}`,
              );
              }
            }
          }
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
