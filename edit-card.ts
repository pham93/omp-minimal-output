// Compact edit diff card (grok-build row grammar, theme-derived colors).
// Display-only: execution and delegation stay in index.ts.

import { Container, visibleWidth } from "@oh-my-pi/pi-tui";
import { isAbsolute, relative } from "node:path";
import { resolveParentCardLabel, type ParentCardLabel } from "./card-primitives.ts";
import { diffStat, parsePipeDiff, parseUnifiedDiff, selectPrettyRows } from "./filters.ts";
import type { PrettyRow } from "./filters.ts";
import { markFlush } from "./loaders.ts";
import { durationSuffix, isToolError, toolResultText } from "./results.ts";
import { LINE_WIDTH_RATIO, TOOL_INDENT, formatRowLine, paintAt, themeBgRgb, themeTokenRgb } from "./theme.ts";
import { shortPathText, showWhitespace, truncatePlain } from "./text.ts";
import { getPluginConfig } from "./config.ts";

import("@oh-my-pi/pi-coding-agent/modes/theme/theme")
  .then((m) => {
    if (m && typeof m.highlightCode === "function") {
      coreHighlight = m as CoreHighlight;
      try {
        (m as CoreHighlight).warmHighlighter?.();
      } catch {
        // Warmup is best-effort; first paint pays for itself.
      }
    }
  })
  .catch(() => {});

export type CoreHighlight = {
  highlightCode?: (code: string, lang?: string) => string[];
  getLanguageFromPath?: (p: string) => string | undefined;
  warmHighlighter?: () => unknown;
};

// Native syntax colors via core's own highlighter (Rust tokenizer, memoized).
// Same lazy-with-fallback shape as markFlush above: unknown core layout or a
// missing engine degrades to today's flat card instead of breaking this file.
export let coreHighlight: CoreHighlight | undefined;

export function highlightCell(text: string, lang: string | undefined): string {
  try {
    const hl = coreHighlight?.highlightCode;
    if (typeof hl !== "function" || !text) return text;
    const out = hl.call(coreHighlight, text, lang);
    if (Array.isArray(out) && typeof out[0] === "string") return out.join("\n");
    if (typeof out === "string") return out;
  } catch {
    // Tokenizer hiccup: fall through to plain text.
  }
  return text;
}

// ── edit pretty-diff card (grok-build row grammar, theme-derived only) ──
// Gutter shows the new-side number (deleted rows show the old number);
// -/+ rows carry a background band blended from their fg token. Unknown
// theme tokens degrade to plain text via paintAt/themeTokenRgb. Everything
// below is display-only: execute/description/parameters flow from `source`.
export const DIFF_BG_BLEND = 0.22;

// Last-resort hues when the theme defines neither diff nor status tokens —
// without these the card degrades to monochrome soup (paintAt plain fallback).
export const DIFF_FALLBACK_RGB: Record<string, [number, number, number]> = {
  toolDiffAdded: [63, 185, 80],
  toolDiffRemoved: [248, 81, 73],
};

export function editTextField(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

export function diffBaseRgb(theme: unknown, token: string): [number, number, number] | undefined {
  return (
    themeTokenRgb(theme, token) ??
    themeTokenRgb(theme, token === "toolDiffAdded" ? "success" : "error") ??
    DIFF_FALLBACK_RGB[token]
  );
}

export function prettyDiffCell(theme: unknown, text: string, token: string, band: boolean): string {
  const fg = diffBaseRgb(theme, token);
  if (!fg) return paintAt(theme, text, token, 1);
  const fgSgr = `\x1b[38;2;${fg[0]};${fg[1]};${fg[2]}m`;
  if (!band) return `${fgSgr}${text}\x1b[39m`;
  const bg = themeBgRgb(theme);
  const r = Math.round(bg[0] + (fg[0] - bg[0]) * DIFF_BG_BLEND);
  const g = Math.round(bg[1] + (fg[1] - bg[1]) * DIFF_BG_BLEND);
  const b = Math.round(bg[2] + (fg[2] - bg[2]) * DIFF_BG_BLEND);
  const bgSgr = `\x1b[48;2;${r};${g};${b}m`;
  // Syntax-highlighted spans carry nested resets that would otherwise kill
  // the band mid-line. Resume fg/bg after each reset, mirroring core's
  // bgFill/fgResolved (same reset patterns, diff-blended colors).
  const resumed = text
    .replace(/\x1b\[0m/g, `\x1b[0m${fgSgr}${bgSgr}`)
    .replace(/\x1b\[49m/g, `\x1b[49m${bgSgr}`)
    .replace(/\x1b\[39m/g, `\x1b[39m${fgSgr}`);
  return `${fgSgr}${bgSgr}${resumed}\x1b[0m`;
}

// Colorize the trailing ` — +a/−b` stat in row headers. The stat rides inside
// formatRowLine's uniform body, so paint it beforehand: inner SGR overrides
// the outer body color and the shared truncate stays width-correct (ANSI-aware).
export function paintDiffStat(theme: unknown, added: number, removed: number): string {
  const addedText = prettyDiffCell(theme, `+${added}`, "toolDiffAdded", false);
  const removedText = prettyDiffCell(theme, `−${removed}`, "toolDiffRemoved", false);
  return `${addedText}/${removedText}`;
}

export function paintHeaderStat(theme: unknown, header: string): string {
  const m = / — \+(\d+)\/−(\d+)$/u.exec(header);
  if (!m) return header;
  return `${header.slice(0, m.index)} — ${paintDiffStat(theme, Number(m[1]), Number(m[2]))}`;
}

function editDisplayPath(path: string): string {
  const raw = path.trim();
  if (!raw) return "file";
  if (isAbsolute(raw)) {
    try {
      const local = relative(process.cwd(), raw);
      if (local && !local.startsWith("..") && !isAbsolute(local)) return shortPathText(local);
    } catch {
      // Unknown host cwd; retain the original path.
    }
  }
  return shortPathText(raw);
}

function editParentStatus(parentLabel: ParentCardLabel | undefined): string {
  const label = resolveParentCardLabel(parentLabel)
    .replace(/^(?:Edit|Create|Delete|Write):\s*/iu, "")
    .trim();
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : "";
}

const EDIT_FILE_INDENT = `${TOOL_INDENT}   `;

export interface PrettyEditSection {
  path: string;
  added: number;
  removed: number;
  rows: PrettyRow[];
  lang: string | undefined;
  // Syntax-highlighted full text, parallel to rows (falls back to raw text
  // per line when the engine or language is unknown).
  cells: string[];
}

export function collectPrettyEdit(
  args: unknown,
  result: unknown,
  options: unknown,
): {
  header: string;
  error: boolean;
  right: string;
  errorLines: string[];
  multi: boolean;
  sections: PrettyEditSection[];
} {
  const detailsRaw = (result as { details?: unknown } | null | undefined)?.details;
  const details = typeof detailsRaw === "object" && detailsRaw !== null ? (detailsRaw as Record<string, unknown>) : {};
  const argsFields = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const expanded = (options as { expanded?: boolean } | null | undefined)?.expanded === true;
  const error = isToolError(result, options);
  const argsEdits = argsFields["edits"];
  const editPaths: string[] = [];
  let argsOp = "";
  let argsMove = "";
  if (Array.isArray(argsEdits)) {
    for (const entry of argsEdits) {
      if (typeof entry !== "object" || entry === null) continue;
      const fields = entry as Record<string, unknown>;
      const p = editTextField(fields["path"]);
      if (p && !editPaths.includes(p)) editPaths.push(p);
      if (!argsOp) argsOp = editTextField(fields["op"]);
      if (!argsMove) {
        argsMove = editTextField(fields["rename"]) || editTextField(fields["move"]) || editTextField(fields["moveTo"]);
      }
    }
  }
  const rawPath =
    editTextField(details["path"]) ||
    editTextField(details["sourcePath"]) ||
    editTextField(argsFields["path"]) ||
    editTextField(argsFields["file_path"]) ||
    editTextField(argsFields["file"]) ||
    editPaths[0] ||
    "";
  const rawOp = editTextField(details["op"]) || editTextField(argsFields["op"]) || argsOp;
  const rawMove =
    editTextField(details["move"]) ||
    editTextField(argsFields["move"]) ||
    editTextField(argsFields["moveTo"]) ||
    editTextField(argsFields["rename"]) ||
    argsMove;
  const perFile = details["perFileResults"];
  const entries: { path: string; diff: string }[] = [];
  if (Array.isArray(perFile) && perFile.length > 0) {
    for (const entry of perFile) {
      if (typeof entry !== "object" || entry === null) continue;
      const fields = entry as Record<string, unknown>;
      entries.push({
        path: editTextField(fields["path"]),
        diff: typeof fields["diff"] === "string" ? (fields["diff"] as string) : "",
      });
    }
  }
  if (entries.length === 0) {
    let diff = typeof details["diff"] === "string" ? (details["diff"] as string) : "";
    if (!diff) {
      const body = toolResultText(result).split("\n");
      diff = body.length > 1 ? body.slice(1).join("\n") : "";
    }
    entries.push({ path: rawPath, diff });
  }
  const sections: PrettyEditSection[] = [];
  let totalAdded = 0;
  let totalRemoved = 0;
  for (const entry of entries) {
    const stat = diffStat(entry.diff || "");
    totalAdded += stat.added;
    totalRemoved += stat.removed;
    let rows: PrettyRow[] = [];
    if (entry.diff.trim()) {
      const hunks = parseUnifiedDiff(entry.diff);
      rows = selectPrettyRows(hunks.length > 0 ? hunks : parsePipeDiff(entry.diff), { expanded });
      if (rows.length === 0) {
        const rawLines = entry.diff.split("\n");
        const cap = expanded ? 60 : 10;
        rows = rawLines.slice(0, cap).map((text) => ({ kind: " " as const, num: null, text }));
        if (rawLines.length > cap) {
          rows.push({ kind: "|" as const, num: null, text: `… (${rawLines.length - cap} more lines)` });
        }
      }
    }
    let lang: string | undefined;
    try {
      lang = coreHighlight?.getLanguageFromPath?.(entry.path) ?? undefined;
    } catch {
      lang = undefined;
    }
    sections.push({
      path: editDisplayPath(entry.path),
      added: stat.added,
      removed: stat.removed,
      rows,
      lang,
      cells: rows.map((row) =>
        row.kind === "|"
          ? row.text
          : showWhitespace(highlightCell(row.text, lang), {
              tabs: getPluginConfig().editShowTabs,
              spaces: getPluginConfig().editShowSpaces,
            }),
      ),
    });
  }
  const multi = entries.length > 1 || editPaths.length > 1;
  const verb = rawOp === "create" ? "Create" : rawOp === "delete" ? "Delete" : "Edit";
  const statSuffix = totalAdded === 0 && totalRemoved === 0 ? "" : ` — +${totalAdded}/−${totalRemoved}`;
  const header = multi
    ? `${verb} ${Math.max(entries.length, editPaths.length)} files${statSuffix}`
    : `${verb} ${editDisplayPath(rawPath)}${rawMove ? ` → ${editDisplayPath(rawMove)}` : ""}${statSuffix}`;
  const errorLines: string[] = [];
  if (error) {
    const rawErr = details["displayErrorText"] ?? details["errorText"];
    const errSrc =
      typeof rawErr === "string" && rawErr.trim()
        ? rawErr.trim()
        : (toolResultText(result)
            .split("\n")
            .slice(1)
            .map((l) => l.trim())
            .find((l) => l) ?? "");
    for (const line of errSrc.split("\n").slice(0, 10)) {
      if (line.trim()) errorLines.push(line);
    }
  }
  return { header, error, right: durationSuffix(result), errorLines, multi, sections };
}

export function renderPrettyEditCard(
  theme: unknown,
  args: unknown,
  result: unknown,
  options: unknown,
  live: boolean,
  parentLabel?: ParentCardLabel,
): Container {
  try {
    const data = collectPrettyEdit(args, result, options);
    const error = !live && data.error;
    const expanded = (options as { expanded?: boolean } | null | undefined)?.expanded === true;
    const c = new Container();
    c.addChild({
      render: (width: number): readonly string[] => {
        try {
          const parent = editParentStatus(parentLabel);
          const lines = parent
            ? [
                formatRowLine(theme, width, { body: parent, live, error }),
                formatRowLine(theme, width, {
                  body: paintHeaderStat(theme, data.header),
                  tree: "last",
                  error,
                  right: live ? "" : data.right,
                }),
              ]
            : [
                formatRowLine(theme, width, {
                  body: paintHeaderStat(theme, data.header),
                  live,
                  error,
                  right: live ? "" : data.right,
                }),
              ];
          const childIndent = parent ? EDIT_FILE_INDENT : TOOL_INDENT;
          if (live || error || !expanded) {
            if (error) {
              const errorWidth = Math.max(
                1,
                Math.floor((Math.floor(width) || 0) * LINE_WIDTH_RATIO) - childIndent.length,
              );
              for (const line of data.errorLines) {
                lines.push(`${childIndent}${paintAt(theme, truncatePlain(line, errorWidth), "error", 1)}`);
              }
            }
            return lines;
          }

          const rowWidth = Math.max(1, Math.floor((Math.floor(width) || 0) * LINE_WIDTH_RATIO));
          for (const [sectionIndex, section] of data.sections.entries()) {
            const lastSection = sectionIndex === data.sections.length - 1;
            if (data.multi) {
              const stat =
                section.added === 0 && section.removed === 0
                  ? ""
                  : paintDiffStat(theme, section.added, section.removed);
              lines.push(
                formatRowLine(theme, width, {
                  body: section.path || "file",
                  tree: lastSection ? "last" : "mid",
                  indent: EDIT_FILE_INDENT,
                  right: stat,
                }),
              );
            }

            const contentPrefix = data.multi ? `${EDIT_FILE_INDENT}${lastSection ? "   " : "│  "}` : childIndent;
            let gutterWidth = 0;
            for (const row of section.rows) {
              if (row.num !== null) gutterWidth = Math.max(gutterWidth, String(row.num).length);
            }
            const codeBudget = Math.max(1, rowWidth - contentPrefix.length - gutterWidth - 3);
            const bandWidth = Math.max(0, codeBudget);
            for (const [rowIndex, row] of section.rows.entries()) {
              const cell = truncatePlain(section.cells[rowIndex] ?? row.text, codeBudget);
              if (row.kind === "|") {
                if (cell.startsWith("···")) lines.push(contentPrefix.trimEnd());
                lines.push(`${contentPrefix}${" ".repeat(gutterWidth)}   ${paintAt(theme, cell, "dim", 1)}`);
                if (cell.startsWith("···")) lines.push(contentPrefix.trimEnd());
                continue;
              }

              const number = row.num === null ? " ".repeat(gutterWidth) : String(row.num).padStart(gutterWidth, " ");
              if (row.kind === " ") {
                const gutter = paintAt(theme, number, "dim", 1);
                const marker = paintAt(theme, "│", "dim", 0.7);
                lines.push(`${contentPrefix}${gutter} ${marker} ${paintAt(theme, cell, "toolDiffContext", 1)}`);
                continue;
              }

              const token = row.kind === "+" ? "toolDiffAdded" : "toolDiffRemoved";
              const padded = cell + " ".repeat(Math.max(0, bandWidth - visibleWidth(cell)));
              lines.push(`${contentPrefix}${prettyDiffCell(theme, `${number} ${row.kind} ${padded}`, token, true)}`);
            }
            if (data.multi && !lastSection) lines.push(`${EDIT_FILE_INDENT}${paintAt(theme, "│", "dim", 0.7)}`);
          }
          return lines;
        } catch {
          return [formatRowLine(theme, width, { body: paintHeaderStat(theme, data.header), live, error })];
        }
      },
    });
    markFlush?.(c);
    return c;
  } catch {
    const c = new Container();
    c.addChild({
      render: (width: number): readonly string[] => [formatRowLine(theme, width, { body: "Edit", live, error: true })],
    });
    markFlush?.(c);
    return c;
  }
}
