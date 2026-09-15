// Bounded, syntax-highlighted projection of the Write input. The full content
// is known at call time, so running cards show a live preview without faking incremental output.
import { Container } from "@oh-my-pi/pi-tui";
import {
  cardLifecycle,
  conciseErrorText,
  minimalCardHeaderLine,
  parentCardHeaderLines,
  resolveParentCardLabel,
  type ParentCardLabel,
} from "./card-primitives.ts";
import { capRenderedRows, detailedRowLimit, standardWriteMaxRows } from "./density.ts";
import { highlightCell, languageForPath } from "./edit-card.ts";
import { markFlush } from "./loaders.ts";
import { durationSuffix } from "./results.ts";
import { LINE_WIDTH_RATIO, TOOL_INDENT, dimAnsi, paintAt, rowOpacity, stripSgr } from "./theme.ts";
import { projectPathText, truncatePlain } from "./text.ts";

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
  const lines: string[] = [];
  const cap = Math.max(0, Math.floor(previewLimit));
  let lineCount = content ? 1 : 0;
  let lineStart = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) !== 10) continue;
    if (lines.length < cap) lines.push(content.slice(lineStart, index));
    lineCount += 1;
    lineStart = index + 1;
  }
  if (content && lines.length < cap) lines.push(content.slice(lineStart));
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
  index: number,
  gutterWidth: number,
  language: string | undefined,
  opacity: number,
): string {
  const prefix = `${TOOL_INDENT}   `;
  const rowWidth = Math.max(1, Math.floor((Math.floor(width) || 0) * LINE_WIDTH_RATIO));
  const number = String(index + 1).padStart(gutterWidth, " ");
  const marker = paintAt(theme, "│", "dim", 0.7);
  const budget = Math.max(1, rowWidth - prefix.length - gutterWidth - 3);
  const highlighted = dimAnsi(theme, highlightCell(line, language), opacity);
  const content = stripSgr(line).trim()
    ? paintAt(theme, truncatePlain(highlighted, budget), "toolOutput", opacity)
    : "";
  return `${prefix}${paintAt(theme, number, "dim", 1)} ${marker} ${content}`;
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
          const error = `${TOOL_INDENT} ${paintAt(
            theme,
            conciseErrorText(result, {
              fallback: "Write failed",
              skipPattern: /^◆?\s*Write\b/iu,
            }),
            "error",
            1,
          )}`;
          lines.push(error);
          return capRenderedRows(lines, maxRows, error, error);
        }

        const available = Math.max(0, maxRows - lines.length);
        const hiddenSummary = data.lineCount > available;
        const contentCap = hiddenSummary ? Math.max(0, available - 1) : available;
        const visible = data.lines.slice(0, contentCap);
        const gutterWidth = Math.max(1, String(data.lineCount).length);
        const language = languageForPath(data.path);
        const opacity = rowOpacity(lifecycle.running, undefined);
        for (const [index, line] of visible.entries()) {
          lines.push(writeContentLine(theme, width, line, index, gutterWidth, language, opacity));
        }
        const hidden = data.lineCount - visible.length;
        if (hidden > 0) {
          lines.push(`${TOOL_INDENT}   ${paintAt(theme, `╰─ … ${hidden} more lines`, "dim", 1)}`);
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
