import { Container } from "@oh-my-pi/pi-tui";
import { isHideThinkingBlock } from "../core/config.ts";
import {
  detailProfile,
  detailedRowLimit,
  standardRowLimit,
  thoughtRowLimit,
  minimalToolSummary,
  type DetailProfile,
} from "../core/density.ts";
import { formatRowLine, elapsedSuffix, TOOL_INDENT } from "../core/theme.ts";
import { markFlush } from "../core/loaders.ts";
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
        const profile = bodies[0]?.detail ?? detailProfile();
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
        const hasOutput = bodies.some((row) => row.details.length > 0);
        const toolLimit = profile.detailed ? detailedRowLimit() : standardRowLimit(hasOutput);
        const sessionCtx = this.#deps.getSessionContext?.();
        const thoughtRowsCount = isHideThinkingBlock(sessionCtx)
          ? 0
          : rows.filter((row) => row.fp.startsWith("thought:")).length;
        const thoughtAllowance = (thoughtRowLimit(profile) + 2) * thoughtRowsCount;
        const maxRows = toolLimit + thoughtAllowance;
        let totalRows = lines.length;
        const hasHeader = lines.length > 0;
        const isStandalone = !hasHeader;
        let terminalError: string | undefined;
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
          totalRows += 1;
          if (lines.length < maxRows) lines.push(rowLine);
          if (row.error) terminalError = rowLine;
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
            totalRows += thoughtLines.length;
            lines.push(...thoughtLines.slice(0, Math.max(0, maxRows - lines.length)));
          }
          const detailPrefix = isStandalone || isLastTool ? `${TOOL_INDENT}   ` : "│    ";
          totalRows += row.details.length;
          const visibleDetails = Math.min(row.details.length, Math.max(0, maxRows - lines.length));
          for (let detailIndex = 0; detailIndex < visibleDetails; detailIndex += 1) {
            lines.push(cardDetailLine(theme, width, row.details[detailIndex]!, detailPrefix, row.error));
          }
        }
        if (totalRows <= maxRows) return lines;
        const hiddenRows = totalRows - maxRows + 1;
        const overflow = isStandalone
          ? cardDetailLine(theme, width, `… ${hiddenRows} more rows`)
          : formatRowLine(theme, width, {
              body: `… ${hiddenRows} more rows`,
              indent: true,
              tree: "last",
            });
        return [...lines.slice(0, maxRows - 1), terminalError ?? overflow];
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
  return groupedTools.renderToolVisual(
    theme,
    fingerprint,
    {
      body: toolActionLabel(toolName, args),
      live: isCall && cardIsPartial(options),
      error: !isCall && isToolError(result, options),
      right: isCall ? "" : durationSuffix(result),
      details: isCall ? [] : groupedOutputLines(result),
      detail: detailProfile(options),
    },
    isCall ? undefined : frozenGroupOf(result),
  );
}
