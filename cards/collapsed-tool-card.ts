// Card for tools the plugin wraps but has no dedicated layout for: lsp, ast_grep, debug, github,
// checkpoint, rewind, context_notes, new_context, security_scan, memory_edit, retain, recall,
// reflect, learn, manage_skill.
//
// These tools used to keep host-rendered rows with only their result text rewritten, so the mark,
// width, opacity and row shape were the host's. They now render through the same primitives as every
// other card: the collapsed one-liner becomes the header (the plugin paints the configured mark) and
// the bounded detail lines follow on the content column.
import { Container } from "@oh-my-pi/pi-tui";
import { collapseToolText } from "../core/filters.ts";
import { detailProfile, outputRowLimit } from "../core/density.ts";
import { toolActionLabel } from "../core/text.ts";
import { durationSuffix } from "../core/results.ts";
import {
  CARD_CONTENT_PREFIX,
  cardDetailLine,
  cardLifecycle,
  minimalCardHeaderLine,
  parentCardHeaderLines,
  stashedOrResultText,
} from "./card-primitives.ts";
import type { ParentCardLabel } from "./card-primitives.ts";

/** The collapsed one-liner carries the settled mark itself; the card paints the configured one. */
function withoutMark(line: string): string {
  return line.replace(/^\s*[^\sA-Za-z0-9]+\s/u, "").trim();
}

export function renderCollapsedToolCard(
  theme: unknown,
  toolName: string,
  args: unknown,
  result: unknown,
  options: unknown,
  fingerprint?: string,
  parentLabel?: ParentCardLabel,
): Container {
  const lifecycle = cardLifecycle(result, options);
  const collapsed = result === undefined ? undefined : collapseToolText(toolName, args, stashedOrResultText(result));
  const lines = collapsed && collapsed.changed ? collapsed.text.split("\n") : [];
  const summary = lines.length > 0 ? withoutMark(lines[0] ?? "") : "";
  const body = summary || toolActionLabel(toolName, args);

  const card = new Container();
  card.addChild({
    render: (width: number): readonly string[] => {
      const profile = detailProfile(options);
      const right = lifecycle.settled ? durationSuffix(result) : "";
      if (profile.minimal) {
        return [minimalCardHeaderLine(theme, width, { body, lifecycle, right, fingerprint, parentLabel })];
      }
      const rows = parentCardHeaderLines(theme, width, { body, lifecycle, right, fingerprint, parentLabel });
      const detailLimit = outputRowLimit(profile);
      for (const line of lines.slice(1, 1 + detailLimit)) {
        rows.push(cardDetailLine(theme, width, line, CARD_CONTENT_PREFIX, lifecycle.error));
      }
      const hidden = lines.length - 1 - detailLimit;
      if (hidden > 0) {
        rows.push(cardDetailLine(theme, width, `… ${hidden} more lines`, CARD_CONTENT_PREFIX, lifecycle.error));
      }
      return rows;
    },
  });
  return card;
}
