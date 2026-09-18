import { Container } from "@oh-my-pi/pi-tui";
import { isHideThinkingBlock } from "../core/config.ts";
import {
  detailProfile,
  outputRowLimit,
  thoughtRowLimit,
  minimalToolSummary,
  type DetailProfile,
} from "../core/density.ts";
import { formatRowLine, elapsedSuffix, paintAt, TOOL_INDENT } from "../core/theme.ts";
import { markFlush } from "../core/loaders.ts";
import { highlightCell, languageForPath } from "./edit-card.ts";
import { cardDetailLine, cardIsPartial, stashedOrResultText } from "./card-primitives.ts";
import { formatSettledThought } from "../surfaces/scrolling-text.ts";
import { thinkingRailLines } from "../surfaces/thinking-widget.ts";
import { durationSuffix, isToolError } from "../core/results.ts";
import { toolActionLabel } from "../core/text.ts";
import type { CardRenderContext } from "./card-registry.ts";

export interface GroupRow {
  fp: string;
  body: string;
  live: boolean;
  error: boolean;
  right: string;
  startedAt: number;
  details: string[];
  detail?: DetailProfile | string;
}

export interface ToolGroup {
  label: string;
  rows: Map<string, GroupRow>;
}

export interface GroupedToolDeps {
  rowIsLive: (fp: string) => boolean;
  activityLabel: () => string;
  activityRunId: () => string | null;
  activityStartedAt: () => number;
  getSessionContext?: () => unknown;
}

interface FrozenGroup {
  gid: string;
  label: string;
}

export class GroupedToolManager {
  readonly #toolGroups = new Map<string, ToolGroup>();
  readonly #fpToGroup = new Map<string, string>();
  readonly #deps: GroupedToolDeps;

  constructor(deps: GroupedToolDeps) {
    this.#deps = deps;
  }

  upsertGroupRow(fp: string, row: Omit<GroupRow, "fp">, frozen?: FrozenGroup): string {
    let gid = frozen?.gid ?? this.#fpToGroup.get(fp);
    if (!gid) {
      gid = this.#deps.activityRunId() ?? `_anon:${fp}`;
      this.#fpToGroup.set(fp, gid);
    } else if (frozen?.gid) {
      this.#fpToGroup.set(fp, gid);
    }
    let group = this.#toolGroups.get(gid);
    if (!group) {
      group = { label: frozen?.label ?? this.#deps.activityLabel(), rows: new Map() };
      this.#toolGroups.set(gid, group);
    } else if (frozen?.label) {
      if (!group.label) group.label = frozen.label;
    } else if (this.#deps.activityLabel()) {
      group.label = this.#deps.activityLabel();
    }
    const prev = group.rows.get(fp);
    group.rows.set(fp, {
      fp,
      body: row.body,
      live: row.live,
      error: row.error,
      right: row.right,
      startedAt: prev?.startedAt ?? row.startedAt,
      detail: row.detail ?? prev?.detail,
      details: row.details ?? prev?.details ?? [],
    });
    if (this.#toolGroups.size > 40) {
      const oldest = this.#toolGroups.keys().next();
      if (!oldest.done && oldest.value !== gid) this.#toolGroups.delete(oldest.value);
    }
    return gid;
  }

  isGroupLead(gid: string, fp: string): boolean {
    if (fp.startsWith("thought:")) return false;
    const group = this.#toolGroups.get(gid);
    if (!group) return false;
    for (const key of group.rows.keys()) {
      if (key.startsWith("thought:")) continue;
      return key === fp;
    }
    return false;
  }

  emptyBlock(): Container {
    const c = new Container();
    c.addChild({ render: (): readonly string[] => [] });
    markFlush?.(c);
    return c;
  }

  paintGroup(theme: unknown, gid: string): Container {
    const c = new Container();
    c.addChild({
      render: (width: number): readonly string[] => {
        const group = this.#toolGroups.get(gid);
        if (!group) return [];
        const rows = [...group.rows.values()].sort((a, b) => a.startedAt - b.startedAt);
        const bodies = rows.filter((row) => !row.fp.startsWith("thought:"));
        const firstDetail = bodies[0]?.detail;
        const profile = typeof firstDetail === "object" ? firstDetail : detailProfile(undefined);
        const headerLive = rows.some((row) => this.#deps.rowIsLive(row.fp));
        const header = group.label;
        const readCount = bodies.filter((row) => row.fp.startsWith("read:")).length;
        const headerBody = bodies.length > 1 && readCount === bodies.length ? `Read ${readCount} files` : header;
        const anyError = bodies.some((row) => row.error);
        if (profile.minimal) {
          const summary =
            headerBody.trim() && bodies.length === 1
              ? minimalToolSummary(headerBody, bodies[0]?.body ?? "")
              : headerBody || bodies[0]?.body || "Tool";
          return [
            formatRowLine(theme, width, {
              body: summary,
              live: headerLive,
              error: anyError,
              fadeKey: `act:${gid}`,
              right: headerLive ? elapsedSuffix(this.#deps.activityStartedAt()) : "",
              mark: headerLive ? undefined : "●",
            }),
          ];
        }
        const lines: string[] = [];
        if (headerBody.trim()) {
          lines.push(
            formatRowLine(theme, width, {
              body: headerBody,
              live: headerLive,
              fadeKey: `act:${gid}`,
              right: headerLive ? elapsedSuffix(this.#deps.activityStartedAt()) : "",
              mark: headerLive ? undefined : "●",
            }),
          );
        }
        const sessionCtx = this.#deps.getSessionContext?.();
        const hasHeader = lines.length > 0;
        const isStandalone = !hasHeader;
        for (const [idx, row] of rows.entries()) {
          const live = this.#deps.rowIsLive(row.fp);
          const isThought = row.fp.startsWith("thought:");
          if (isThought && isHideThinkingBlock(sessionCtx)) continue;
          const isLastTool = idx === rows.length - 1;
          const rowLine = formatRowLine(theme, width, {
            body: row.body,
            indent: !isStandalone,
            tree: isStandalone ? undefined : isLastTool ? "last" : "mid",
            live,
            error: row.error,
            fadeKey: row.fp,
            right: live ? (isThought ? "" : elapsedSuffix(row.startedAt)) : row.right,
            mark: isStandalone && !live ? "●" : undefined,
          });
          lines.push(rowLine);
          if (isThought) {
            const rawThought = typeof row.detail === "string" && row.detail ? row.detail : row.details.join("\n");
            const thoughtLines = live
              ? thinkingRailLines(theme, width, rawThought, !isStandalone)
              : formatSettledThought(rawThought, {
                  maxLines: thoughtRowLimit(profile),
                  width,
                  theme,
                  indent: !isStandalone,
                });
            lines.push(...thoughtLines);
            continue;
          }
          const detailPrefix = isStandalone || isLastTool ? `${TOOL_INDENT}   ` : "│    ";
          const rowProfile = typeof row.detail === "object" ? row.detail : profile;
          const visibleDetails = Math.min(row.details.length, outputRowLimit(rowProfile));
          for (let detailIndex = 0; detailIndex < visibleDetails; detailIndex += 1) {
            lines.push(cardDetailLine(theme, width, row.details[detailIndex]!, detailPrefix, row.error));
          }
          const hidden = row.details.length - visibleDetails;
          if (hidden > 0) {
            lines.push(cardDetailLine(theme, width, `… ${hidden} more lines`, detailPrefix, row.error));
          }
        }
        return lines;
      },
    });
    markFlush?.(c);
    return c;
  }

  renderToolVisual(
    theme: unknown,
    fp: string,
    opts: {
      body: string;
      live: boolean;
      error: boolean;
      right?: string;
      details?: string[];
      detail?: DetailProfile;
    },
    frozen?: FrozenGroup,
  ): Container {
    const gid = this.upsertGroupRow(
      fp,
      {
        body: opts.body,
        live: opts.live,
        error: opts.error,
        right: opts.right ?? "",
        startedAt: Date.now(),
        details: opts.details ?? [],
        detail: opts.detail,
      },
      frozen,
    );
    if (!this.isGroupLead(gid, fp)) return this.emptyBlock();
    return this.paintGroup(theme, gid);
  }

  clear(): void {
    this.#toolGroups.clear();
    this.#fpToGroup.clear();
  }
}

function groupedOutputLines(result: unknown): string[] {
  const text = stashedOrResultText(result);
  if (!text) return [];
  const rows = text.split(/\r?\n/u);
  while (rows.length > 0 && !Bun.stripANSI(rows[rows.length - 1]!).trim()) rows.pop();
  return rows;
}
function highlightPatternMatches(theme: unknown, text: string, pattern: string): string {
  if (!pattern || pattern.length === 0) return text;
  try {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(${escaped})`, "gi");
    const highlightToken = paintAt(theme, "$1", "accent", 1);
    return text.replace(re, `\x1b[1m${highlightToken}\x1b[22m`);
  } catch {
    return text;
  }
}

export function formatSearchDetails(theme: unknown, lines: string[], pattern?: string): string[] {
  let currentFile: string | undefined;
  return lines.map((line) => {
    // 1. File summary header line: e.g. "src/server.ts: 3 hits (first 3 shown)"
    const headerMatch = line.match(/^([^:]+):\s*(\d+\s+hits.*)$/);
    if (headerMatch) {
      currentFile = headerMatch[1].trim();
      const fileStyled = paintAt(theme, currentFile, "accent", 0.95);
      const hitsStyled = paintAt(theme, headerMatch[2], "dim", 0.7);
      return `${fileStyled}: ${hitsStyled}`;
    }

    // 2. Search match line: e.g. "src/server.ts:15:export class MicroserviceServer {"
    const match = line.match(/^(\s*(?:\*\s*)?)(.+?):(\d+)(?::(\d+))?:(.*)$/);
    if (match) {
      const marker = match[1] ?? "";
      const file = match[2]?.trim() ?? "";
      const lineNum = match[3];
      const col = match[4];
      const code = match[5] ?? "";
      currentFile = file || currentFile;
      const lang = currentFile ? languageForPath(currentFile) : undefined;
      let highlighted = lang ? highlightCell(code, lang) : code;
      if (pattern) {
        highlighted = highlightPatternMatches(theme, highlighted, pattern);
      }
      const markerStyled = marker ? paintAt(theme, marker, "accent", 0.8) : "";
      const fileStyled = file ? paintAt(theme, file, "accent", 0.85) : "";
      const coordStyled = paintAt(theme, `:${lineNum}${col ? `:${col}` : ""}:`, "dim", 0.7);
      return `${markerStyled}${fileStyled}${coordStyled} ${highlighted}`;
    }

    // 3. Line number under a file header: e.g. "  15:export class ..." or "*15:..."
    const lineNumMatch = line.match(/^(\s*\*?\s*)(\d+)(?::(\d+))?:(.*)$/);
    if (lineNumMatch && currentFile) {
      const marker = lineNumMatch[1] ?? "";
      const lineNum = lineNumMatch[2];
      const col = lineNumMatch[3];
      const code = lineNumMatch[4] ?? "";
      const lang = languageForPath(currentFile);
      let highlighted = lang ? highlightCell(code, lang) : code;
      if (pattern) {
        highlighted = highlightPatternMatches(theme, highlighted, pattern);
      }
      const markerStyled = marker ? paintAt(theme, marker, "accent", 0.8) : "";
      const coordStyled = paintAt(theme, `${lineNum}${col ? `:${col}` : ""}:`, "dim", 0.7);
      return `${markerStyled}${coordStyled} ${highlighted}`;
    }

    return line;
  });
}
function frozenGroupOf(result: unknown): FrozenGroup | undefined {
  try {
    const details = (result as { details?: unknown } | null | undefined)?.details;
    if (typeof details !== "object" || details === null) return undefined;
    const gid = (details as Record<string, unknown>)["minimalGroupRun"];
    const label = (details as Record<string, unknown>)["minimalGroupLabel"];
    if (typeof gid === "string" && gid && typeof label === "string") return { gid, label };
  } catch {}
  return undefined;
}

export function renderGroupedToolCard(context: CardRenderContext): Container {
  const { theme, toolName, args, result, options, fingerprint, phase, groupedTools } = context;
  const isCall = phase === "call";
  let details = isCall ? [] : groupedOutputLines(result);
  if (!isCall && (toolName === "grep" || toolName === "ast_grep")) {
    const rawPattern =
      typeof args === "object" && args !== null
        ? (args as Record<string, unknown>)["pattern"] ?? (args as Record<string, unknown>)["query"] ?? ""
        : "";
    const pattern = typeof rawPattern === "string" ? rawPattern : "";
    details = formatSearchDetails(theme, details, pattern);
  }
  return groupedTools.renderToolVisual(
    theme,
    fingerprint,
    {
      body: toolActionLabel(toolName, args),
      live: isCall && cardIsPartial(options),
      error: !isCall && isToolError(result, options),
      right: isCall ? "" : durationSuffix(result),
      details,
      detail: detailProfile(options),
    },
    isCall ? undefined : frozenGroupOf(result),
  );
}
