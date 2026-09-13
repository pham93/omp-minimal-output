// Compact edit diff card (grok-build row grammar, theme-derived colors).
// Display-only: execution and delegation stay in index.ts.

import { Container, visibleWidth } from "@oh-my-pi/pi-tui";
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
export function paintHeaderStat(theme: unknown, header: string): string {
  const m = / — \+(\d+)\/−(\d+)$/u.exec(header);
  if (!m) return header;
  const label = header.slice(0, m.index);
  const added = prettyDiffCell(theme, `+${m[1]}`, "toolDiffAdded", false);
  const removed = prettyDiffCell(theme, `−${m[2]}`, "toolDiffRemoved", false);
  return `${label} — ${added}/${removed}`;
}

export interface PrettyEditSection {
  subhead: string;
  added: number;
  removed: number;
  rows: PrettyRow[];
  lang: string | undefined;
  // Syntax-highlighted full text, parallel to rows (falls back to raw text
  // per line when the engine is missing or the language is unknown).
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
    const statSuffix = stat.added === 0 && stat.removed === 0 ? "" : ` — +${stat.added}/−${stat.removed}`;
    let lang: string | undefined;
    try {
      lang = coreHighlight?.getLanguageFromPath?.(entry.path) ?? undefined;
    } catch {
      lang = undefined;
    }
    sections.push({
      subhead: entry.path ? `${shortPathText(entry.path) || "file"}${statSuffix}` : "",
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
    : `${verb} ${shortPathText(rawPath) || "file"}${rawMove ? ` → ${shortPathText(rawMove)}` : ""}${statSuffix}`;
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
): Container {
  try {
    const data = collectPrettyEdit(args, result, options);
    const error = !live && data.error;
    const rows: PrettyRow[] = [];
    const texts: string[] = [];
    if (!live && !error) {
      for (const section of data.sections) {
        if (data.multi && section.subhead) {
          rows.push({ kind: "|", num: null, text: section.subhead });
          texts.push(section.subhead);
        }
        section.rows.forEach((row, i) => {
          rows.push(row);
          texts.push(section.cells[i] ?? row.text);
        });
      }
    }
    const c = new Container();
    c.addChild({
      render: (width: number): readonly string[] => {
        try {
          const lines = [
            formatRowLine(theme, width, {
              body: paintHeaderStat(theme, data.header),
              live,
              error,
              right: live ? "" : data.right,
            }),
          ];
          if (live || error) {
            if (error) {
              const w = Math.max(1, Math.floor((Math.floor(width) || 0) * LINE_WIDTH_RATIO) - TOOL_INDENT.length);
              for (const line of data.errorLines) {
                lines.push(`${TOOL_INDENT}${paintAt(theme, truncatePlain(line, w), "error", 1)}`);
              }
            }
            return lines;
          }
          const w = Math.max(1, Math.floor((Math.floor(width) || 0) * LINE_WIDTH_RATIO));
          let gutterW = 0;
          for (const row of rows) {
            if (row.num !== null) gutterW = Math.max(gutterW, String(row.num).length);
          }
          const budget = Math.max(1, w - TOOL_INDENT.length - gutterW - 3);
          const cells = rows.map((row, i) => truncatePlain(texts[i] ?? row.text, budget));
          // Full-bleed bands: every -/+ row fills the content width so
          // the card reads as red/green bars, not a tinted fragment.
          // No +/- sign column: the background band alone carries the
          // added/removed signal, gutter + code stay aligned with context.
          const bandW = Math.max(0, budget - 2);
          rows.forEach((row, i) => {
            const cell = cells[i] ?? "";
            if (row.kind === "|") {
              lines.push(`${TOOL_INDENT}${" ".repeat(gutterW)}  ${paintAt(theme, cell, "dim", 1)}`);
              return;
            }
            const gutter = paintAt(
              theme,
              row.num === null ? " ".repeat(gutterW) : String(row.num).padStart(gutterW, " "),
              "dim",
              1,
            );
            if (row.kind === " ") {
              lines.push(`${TOOL_INDENT}${gutter}${paintAt(theme, `  ${cell}`, "toolDiffContext", 1)}`);
            } else {
              const token = row.kind === "+" ? "toolDiffAdded" : "toolDiffRemoved";
              const num = row.num === null ? " ".repeat(gutterW) : String(row.num).padStart(gutterW, " ");
              const padded = cell + " ".repeat(Math.max(0, bandW - visibleWidth(cell)));
              lines.push(prettyDiffCell(theme, `${TOOL_INDENT}${num}  ${padded}`, token, true));
            }
          });
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
