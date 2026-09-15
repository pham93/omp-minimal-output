import { Container } from "@oh-my-pi/pi-tui";
import {
  cardLifecycle,
  conciseErrorText,
  minimalCardHeaderLine,
  parentCardHeaderLines,
  resolveParentCardLabel,
  type ParentCardLabel,
} from "./card-primitives.ts";
import { capRenderedRows, standardWriteMaxRows } from "./density.ts";
import { markFlush } from "./loaders.ts";
import { durationSuffix } from "./results.ts";
import { LINE_WIDTH_RATIO, TOOL_INDENT, paintAt } from "./theme.ts";
import { projectPathText, truncatePlain } from "./text.ts";

interface WriteData {
  path: string;
  lines: string[];
}

function writeData(args: unknown): WriteData {
  const fields = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const pathValue = fields["path"] ?? fields["file_path"] ?? fields["file"];
  const contentValue = fields["content"] ?? fields["text"] ?? fields["data"];
  const content = typeof contentValue === "string" ? contentValue : "";
  return {
    path: projectPathText(typeof pathValue === "string" ? pathValue : ""),
    lines: content ? content.split("\n") : [],
  };
}

function writeHeader(data: WriteData): string {
  const count = data.lines.length;
  return `Write ${data.path}${count > 0 ? ` — ${count} ${count === 1 ? "line" : "lines"}` : ""}`;
}

function writeContentLine(theme: unknown, width: number, line: string, index: number, gutterWidth: number): string {
  const prefix = `${TOOL_INDENT}   `;
  const rowWidth = Math.max(1, Math.floor((Math.floor(width) || 0) * LINE_WIDTH_RATIO));
  const number = String(index + 1).padStart(gutterWidth, " ");
  const marker = paintAt(theme, "│", "dim", 0.7);
  const budget = Math.max(1, rowWidth - prefix.length - gutterWidth - 3);
  return `${prefix}${paintAt(theme, number, "dim", 1)} ${marker} ${paintAt(
    theme,
    truncatePlain(line, budget),
    "toolOutput",
    1,
  )}`;
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
        const data = writeData(args);
        const lifecycle = cardLifecycle(result, options);
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
        if (lifecycle.running) return lines;
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
          return lifecycle.detail.standard ? capRenderedRows(lines, standardWriteMaxRows(), error, error) : lines;
        }

        const maxRows = lifecycle.detail.standard ? standardWriteMaxRows() : Number.POSITIVE_INFINITY;
        const available = Math.max(0, maxRows - lines.length);
        const hiddenSummary = data.lines.length > available;
        const contentCap = hiddenSummary ? Math.max(0, available - 1) : available;
        const visible = Number.isFinite(contentCap) ? data.lines.slice(0, contentCap) : data.lines;
        const gutterWidth = Math.max(1, String(data.lines.length).length);
        for (const [index, line] of visible.entries()) {
          lines.push(writeContentLine(theme, width, line, index, gutterWidth));
        }
        const hidden = data.lines.length - visible.length;
        if (hidden > 0) {
          lines.push(`${TOOL_INDENT}   ${paintAt(theme, `╰─ … ${hidden} more lines`, "dim", 1)}`);
        }
        return lines;
      } catch {
        const data = writeData(args);
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
