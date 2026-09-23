// Bounded, syntax-highlighted projection of the Write input. The full content
// is known at call time, so running cards show a live preview without faking incremental output.
import { Container } from "@oh-my-pi/pi-tui";
import {
  cardLifecycle,
  conciseErrorText,
  minimalCardHeaderLine,
  parentCardHeaderLines,
  cardDetailLine,
  resolveParentCardLabel,
  type ParentCardLabel,
} from "./card-primitives.ts";
import { getPluginConfig } from "../core/config.ts";
import { detailedRowLimit, standardWriteMaxRows } from "../core/density.ts";
import { highlightCell, languageForPath } from "./edit-card.ts";
import { markFlush } from "../core/loaders.ts";
import { durationSuffix } from "../core/results.ts";
import { LINE_WIDTH_RATIO, TOOL_INDENT, dimAnsi, isSettling, markSettling, paintAt, stripSgr } from "../core/theme.ts";
import { projectPathText, truncatePlain } from "../core/text.ts";

interface WriteData {
  path: string;
  lines: string[];
  lineCount: number;
}

function writeData(args: unknown, previewLimit: number): WriteData {
  const fields = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const pathValue = fields["path"] ?? fields["file_path"] ?? fields["file"];
  const contentValue = fields["content"] ?? fields["text"] ?? fields["data"];
  const content = typeof contentValue === "string" ? contentValue : "";
  if (!content) {
    return {
      path: projectPathText(typeof pathValue === "string" ? pathValue : ""),
      lines: [],
      lineCount: 0,
    };
  }

  const cap = Math.max(0, Math.floor(previewLimit));
  let lineCount = 1;
  const ringStarts: number[] = [0];
  const ringEnds: number[] = [];

  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) !== 10) continue;
    ringEnds.push(content.charCodeAt(index - 1) === 13 ? index - 1 : index);
    if (ringStarts.length > cap) {
      ringStarts.shift();
      ringEnds.shift();
    }
    lineCount += 1;
    ringStarts.push(index + 1);
  }
  ringEnds.push(content.length);
  if (ringStarts.length > cap) {
    ringStarts.shift();
    ringEnds.shift();
  }

  const lines: string[] = [];
  if (cap > 0) {
    for (let i = 0; i < ringStarts.length; i += 1) {
      const s = ringStarts[i] ?? 0;
      const e = ringEnds[i] ?? s;
      lines.push(content.slice(s, e));
    }
  }

  return {
    path: projectPathText(typeof pathValue === "string" ? pathValue : ""),
    lines,
    lineCount,
  };
}

function writeHeader(data: WriteData): string {
  const count = data.lineCount;
  return `Write ${data.path}${count > 0 ? ` — ${count} ${count === 1 ? "line" : "lines"}` : ""}`;
}

function writeContentLine(
  theme: unknown,
  width: number,
  line: string,
  lineNumber: number,
  gutterWidth: number,
  language: string | undefined,
  opacity: number,
): string {
  const prefix = `${TOOL_INDENT}   `;
  const rowWidth = Math.max(1, Math.floor((Math.floor(width) || 0) * LINE_WIDTH_RATIO));
  const number = String(lineNumber).padStart(gutterWidth, " ");
  const marker = paintAt(theme, "│", "dim", 0.7);
  const budget = Math.max(1, rowWidth - prefix.length - gutterWidth - 3);
  const highlighted = dimAnsi(theme, highlightCell(line, language), opacity);
  const content = stripSgr(line).trim()
    ? paintAt(theme, truncatePlain(highlighted, budget), "toolOutput", opacity)
    : "";
  return `${prefix}${paintAt(theme, number, "dim", 1)} ${marker} ${content}`;
}

const writeCardFades = new Map<string, number>();

export const WRITE_LINE_FADE_DURATION_MS = 350;
export const WRITE_CASCADE_STAGGER_MS = 90;
export const WRITE_CASCADE_TOTAL_MS = 1200;
export function writeCardsNeedPump(): boolean {
  const now = Date.now();
  for (const started of writeCardFades.values()) {
    if (now - started < WRITE_CASCADE_TOTAL_MS) return true;
  }
  return false;
}

export function pruneWriteCardFades(now: number): void {
  if (writeCardFades.size <= 80) return;
  for (const [key, started] of writeCardFades) {
    if (now - started >= 3000) writeCardFades.delete(key);
  }
}

export function resetWriteCardFadesForTest(): void {
  writeCardFades.clear();
}

export function cascadingLineOpacity(
  lineIndex: number,
  totalVisibleLines: number,
  startedAt: number | undefined,
  restOpacity: number,
  now = Date.now(),
): number | null {
  if (startedAt === undefined || !(startedAt > 0)) return restOpacity;
  const elapsed = now - startedAt;
  const stagger = Math.max(
    50,
    Math.min(
      WRITE_CASCADE_STAGGER_MS,
      Math.floor((WRITE_CASCADE_TOTAL_MS - WRITE_LINE_FADE_DURATION_MS) / Math.max(1, totalVisibleLines - 1)),
    ),
  );
  const lineStart = lineIndex * stagger;
  const lineElapsed = elapsed - lineStart;
  // Streaming reveal: lines ahead of the wave front have not appeared yet
  if (lineElapsed < 0) return null;
  if (lineElapsed >= WRITE_LINE_FADE_DURATION_MS) return restOpacity;
  const t = lineElapsed / WRITE_LINE_FADE_DURATION_MS;
  const eased = 1 - (1 - t) ** 3;
  return 1.0 - eased * (1.0 - restOpacity);
}

export function renderWriteCard(
  theme: unknown,
  args: unknown,
  result: unknown,
  options: unknown,
  fingerprint?: string,
  parentLabel?: ParentCardLabel,
): Container {
  const card = new Container();
  card.addChild({
    render: (width: number): readonly string[] => {
      try {
        const lifecycle = cardLifecycle(result, options);
        const maxRows = lifecycle.detail.standard
          ? standardWriteMaxRows()
          : lifecycle.detail.detailed
            ? detailedRowLimit()
            : 1;
        const data = writeData(args, maxRows);
        const body = writeHeader(data);
        const right = lifecycle.settled ? durationSuffix(result) : "";
        if (lifecycle.detail.minimal) {
          return [
            minimalCardHeaderLine(theme, width, {
              body,
              lifecycle,
              right,
              fingerprint,
              parentLabel,
            }),
          ];
        }

        const lines = parentCardHeaderLines(theme, width, {
          body,
          lifecycle,
          right,
          fingerprint,
          parentLabel,
        });
        if (lifecycle.error) {
          // Through `cardDetailLine` like every other detail row: it clamps to the row width, so a
          // long native error cannot emit a row wider than the terminal.
          lines.push(
            cardDetailLine(
              theme,
              width,
              conciseErrorText(result, {
                fallback: "Write failed",
                skipPattern: /^◆?\s*Write\b/iu,
              }),
              undefined,
              true,
            ),
          );
          return lines;
        }

        const visible = data.lines;
        const gutterWidth = Math.max(1, String(data.lineCount).length);
        const language = languageForPath(data.path);
        const restOpacity = getPluginConfig().opacity;

        const hidden = data.lineCount - visible.length;
        if (hidden > 0) {
          const hintPrefix = `${TOOL_INDENT}   ${" ".repeat(gutterWidth)} ${paintAt(theme, "│", "dim", 0.7)} `;
          lines.push(`${hintPrefix}${paintAt(theme, `(...${hidden} previous lines)`, "dim", restOpacity)}`);
        }

        let startedAt: number | undefined;
        const fadeKey = fingerprint ?? (data.path ? `write:${data.path}` : undefined);
        if (fadeKey) {
          const existing = writeCardFades.get(fadeKey);
          if (existing !== undefined) {
            startedAt = existing;
          } else if (lifecycle.running || isSettling(fadeKey)) {
            const now = Date.now();
            writeCardFades.set(fadeKey, now);
            startedAt = now;
            pruneWriteCardFades(now);
          }
        }

        for (const [index, line] of visible.entries()) {
          const lineNumber = data.lineCount - visible.length + index + 1;
          const lineOp = cascadingLineOpacity(index, visible.length, startedAt, restOpacity);
          if (lineOp === null) continue;
          lines.push(writeContentLine(theme, width, line, lineNumber, gutterWidth, language, lineOp));
        }
        return lines;
      } catch {
        const data = writeData(args, 0);
        const lifecycle = cardLifecycle(result, options, { error: true });
        return [
          minimalCardHeaderLine(theme, width, {
            body: writeHeader(data),
            lifecycle,
            parentLabel: resolveParentCardLabel(parentLabel),
          }),
        ];
      }
    },
  });
  markFlush?.(card);
  return card;
}
