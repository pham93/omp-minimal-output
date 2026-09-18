// Fullscreen inspect overlay: replay session tool cards, outline one, Enter
// toggles that card only. Display-only; does not rewrite transcript scrollback.
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { visibleWidth, type TUI } from "@oh-my-pi/pi-tui";
import * as PiTui from "@oh-my-pi/pi-tui";
import { CARD_RENDER_PHASE, CardRegistry } from "../cards/card-registry.ts";
import { cardDetailLine, colorizeConsoleLine, stashedOrResultText } from "../cards/card-primitives.ts";
import { formatSearchDetails, GroupedToolManager } from "../cards/grouped-tool-card.ts";
import { renderHubCardLines } from "../cards/hub-card.ts";
import { renderTaskCardLines } from "../cards/task-card.ts";
import { isWrappedTool, wrapTool } from "../core/config.ts";
import { detailProfile, outputRowLimit } from "../core/density.ts";
import { durationSuffix, isToolError } from "../core/results.ts";
import { boundedTextLines, toolActionLabel, truncatePlain } from "../core/text.ts";
import { formatRowLine, paintAt, TOOL_INDENT } from "../core/theme.ts";

function matchesKey(data: string, key: string): boolean {
  const fn = (PiTui as { matchesKey?: (input: string, id: string) => boolean }).matchesKey;
  return typeof fn === "function" ? fn(data, key) : data === key;
}

export interface InspectToolItem {
  id: string;
  toolName: string;
  args: unknown;
  result: unknown;
  userPrompt?: string;
}

export interface InspectHost {
  requestRender(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function userText(message: Record<string, unknown>): string | undefined {
  const content = message.content;
  if (typeof content === "string" && content.trim()) return content.trim().split("\n")[0];
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text") continue;
    if (typeof block.text === "string" && block.text.trim()) parts.push(block.text.trim());
  }
  const joined = parts.join(" ").trim();
  return joined ? joined.split("\n")[0] : undefined;
}

export function collectInspectItems(entries: readonly unknown[]): InspectToolItem[] {
  const pending = new Map<string, { toolName: string; args: unknown; userPrompt?: string }>();
  const items: InspectToolItem[] = [];
  let lastUser: string | undefined;
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    const role = message.role;
    if (role === "user") {
      lastUser = userText(message);
      continue;
    }
    if (role === "assistant") {
      const content = message.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!isRecord(block) || block.type !== "toolCall") continue;
        const id = typeof block.id === "string" ? block.id : "";
        const name = typeof block.name === "string" ? block.name : "tool";
        if (!id) continue;
        pending.set(id, {
          toolName: name,
          args: block.arguments ?? block.args,
          userPrompt: lastUser,
        });
      }
      lastUser = undefined;
      continue;
    }
    if (role !== "toolResult") continue;
    const id = typeof message.toolCallId === "string" ? message.toolCallId : "";
    const call = id ? pending.get(id) : undefined;
    if (id) pending.delete(id);
    const toolName = (typeof message.toolName === "string" && message.toolName) || call?.toolName || "tool";
    items.push({
      id: id || `result:${items.length}`,
      toolName,
      args: call?.args,
      result: message,
      userPrompt: call?.userPrompt,
    });
  }
  return items;
}

function renderHost(card: unknown, width: number): string[] {
  const host = card as {
    render?: (w: number) => readonly string[];
    children?: Array<{ render?: (w: number) => readonly string[] }>;
  };
  const fromChild = host.children?.[0]?.render?.(width);
  if (fromChild && fromChild.length > 0) return [...fromChild];
  return [...(host.render?.(width) ?? [])];
}

function isVisuallyBlank(line: string): boolean {
  return !/\S/.test(Bun.stripANSI(line));
}

function trimBlankEdges(lines: readonly string[]): string[] {
  let head = 0;
  let tail = lines.length;
  while (head < tail && isVisuallyBlank(lines[head]!)) head += 1;
  while (tail > head && isVisuallyBlank(lines[tail - 1]!)) tail -= 1;
  return lines.slice(head, tail);
}

function fallbackLines(theme: unknown, item: InspectToolItem): string[] {
  return [paintAt(theme, `● ${toolActionLabel(item.toolName, item.args)}`, "dim", 1)];
}

function searchPattern(args: unknown): string {
  if (!isRecord(args)) return "";
  const raw = args.pattern ?? args.query;
  return typeof raw === "string" ? raw : "";
}

function paintGroupedInspect(theme: unknown, width: number, item: InspectToolItem, expanded: boolean): string[] {
  const options = expanded ? { expanded: true } : {};
  const profile = detailProfile(options);
  const error = isToolError(item.result, options);
  const header = formatRowLine(theme, width, {
    body: toolActionLabel(item.toolName, item.args),
    live: false,
    error,
    fadeKey: item.id,
    right: durationSuffix(item.result),
  });
  if (profile.minimal) return [header];
  const bounded = boundedTextLines(stashedOrResultText(item.result), outputRowLimit(profile));
  let details = bounded.lines;
  if (item.toolName === "grep" || item.toolName === "ast_grep") {
    details = formatSearchDetails(theme, details, searchPattern(item.args));
  }
  const prefix = `${TOOL_INDENT}   `;
  const lines = [header];
  for (const detail of details) {
    const painted = item.toolName === "bash" ? colorizeConsoleLine(theme, detail) : detail;
    lines.push(cardDetailLine(theme, width, painted, prefix, error));
  }
  const hidden = Math.max(0, bounded.total - details.length);
  if (hidden > 0) lines.push(cardDetailLine(theme, width, `… ${hidden} more lines`, prefix, error));
  return trimBlankEdges(lines);
}

function paintToolCard(theme: unknown, width: number, item: InspectToolItem, expanded: boolean): string[] {
  const options = expanded ? { expanded: true } : {};
  const inner = Math.max(8, width);
  try {
    if (item.toolName === "task") {
      const lines = renderTaskCardLines(theme, inner, item.args, item.result, options, item.id);
      if (lines) return trimBlankEdges([...lines]);
    } else if (item.toolName === "hub") {
      const lines = renderHubCardLines(theme, inner, item.args, item.result, options, item.id);
      if (lines) return trimBlankEdges([...lines]);
    } else if (
      (item.toolName === "bash" || item.toolName === "read" || item.toolName === "grep" || item.toolName === "glob") &&
      wrapTool(item.toolName)
    ) {
      return paintGroupedInspect(theme, inner, item, expanded);
    } else if (isWrappedTool(item.toolName) && wrapTool(item.toolName)) {
      const groupedTools = new GroupedToolManager({
        rowIsLive: () => false,
        activityLabel: () => "",
        activityRunId: () => item.id,
        activityStartedAt: () => 0,
      });
      const registry = new CardRegistry({
        active: () => true,
        groupedTools,
        parentLabelForCard: () => "",
      });
      const card = registry.render({
        toolName: item.toolName,
        phase: CARD_RENDER_PHASE.result,
        theme,
        args: item.args,
        options,
        result: item.result,
      });
      const lines = trimBlankEdges(renderHost(card, inner));
      if (lines.length > 0) return lines;
    }
  } catch {
    // Fall through to a one-line identity so inspect never hides a tool.
  }
  return fallbackLines(theme, item);
}

function outlineBlock(lines: readonly string[], width: number, theme: unknown): string[] {
  const core = trimBlankEdges(lines);
  const rows = core.length > 0 ? core : [""];
  const inner = Math.max(0, width - 4);
  const rule = "┈".repeat(inner + 2);
  const top = paintAt(theme, `┌${rule}┐`, "accent", 1);
  const bottom = paintAt(theme, `└${rule}┘`, "accent", 1);
  const rail = paintAt(theme, "┆", "accent", 1);
  const middle = rows.map((line) => {
    const body = truncatePlain(line, inner);
    const pad = Math.max(0, inner - visibleWidth(body));
    return `${rail} ${body}${" ".repeat(pad)} ${rail}`;
  });
  return [top, ...middle, bottom];
}

function isUp(data: string): boolean {
  return data === "k" || data === "\x1b[A" || matchesKey(data, "up") || matchesKey(data, "k");
}

function isDown(data: string): boolean {
  return data === "j" || data === "\x1b[B" || matchesKey(data, "down") || matchesKey(data, "j");
}

function isConfirm(data: string): boolean {
  return data === "\n" || data === "\r" || data === "l" || matchesKey(data, "enter") || matchesKey(data, "l");
}

function isCollapse(data: string): boolean {
  return data === "h" || data === "\x1b[D" || matchesKey(data, "left") || matchesKey(data, "h");
}

function isCancel(data: string): boolean {
  return data === "\x1b" || matchesKey(data, "escape");
}

export class InspectOverlay {
  readonly #tui: InspectHost;
  readonly #theme: unknown;
  readonly #items: readonly InspectToolItem[];
  readonly #done: (result: unknown) => void;
  readonly #rows: number;
  #index = 0;
  #expanded = new Set<string>();
  #scroll = 0;
  readonly #painted = new Map<string, { inner: number; expanded: boolean; lines: readonly string[] }>();

  constructor(options: {
    tui: InspectHost;
    theme: unknown;
    items: readonly InspectToolItem[];
    done: (result: unknown) => void;
    rows?: number;
  }) {
    this.#tui = options.tui;
    this.#theme = options.theme;
    this.#items = options.items;
    this.#done = options.done;
    this.#rows = Math.max(8, Math.floor(options.rows ?? process.stdout.rows ?? 24));
    this.#index = Math.max(0, options.items.length - 1);
  }

  #repaint(): void {
    try {
      this.#tui.requestRender();
    } catch {
      // Overlay repaint is best-effort.
    }
  }

  #cardLines(item: InspectToolItem, inner: number, expanded: boolean): readonly string[] {
    const hit = this.#painted.get(item.id);
    if (hit && hit.inner === inner && hit.expanded === expanded) return hit.lines;
    const lines = paintToolCard(this.#theme, inner, item, expanded);
    this.#painted.set(item.id, { inner, expanded, lines });
    return lines;
  }

  #cardHeight(item: InspectToolItem, inner: number, expanded: boolean, selected: boolean): number {
    const hit = this.#painted.get(item.id);
    const body = hit && hit.inner === inner && hit.expanded === expanded ? hit.lines.length : 1;
    return (selected ? body + 2 : body) + 1;
  }

  handleInput(data: string): void {
    if (isCancel(data)) {
      this.#done(undefined);
      return;
    }
    if (this.#items.length === 0) return;
    if (isUp(data)) {
      if (this.#index === 0) return;
      this.#index -= 1;
      this.#repaint();
      return;
    }
    if (isDown(data)) {
      if (this.#index === this.#items.length - 1) return;
      this.#index += 1;
      this.#repaint();
      return;
    }
    const selected = this.#items[this.#index];
    if (!selected) return;
    if (isCollapse(data)) {
      if (!this.#expanded.has(selected.id)) return;
      this.#expanded.delete(selected.id);
      this.#repaint();
      return;
    }
    if (isConfirm(data)) {
      if (this.#expanded.has(selected.id)) this.#expanded.delete(selected.id);
      else this.#expanded.add(selected.id);
      this.#repaint();
    }
  }

  render(width: number): readonly string[] {
    const cols = Math.max(20, Math.floor(width) || 80);
    const inner = Math.max(8, cols - 4);
    const header = paintAt(this.#theme, "Inspect · pick a tool card to expand", "accent", 1);
    const footer = paintAt(
      this.#theme,
      this.#items.length === 0
        ? "esc close"
        : `${this.#index + 1}/${this.#items.length}  ↑/↓ step  enter expand  h collapse  esc close`,
      "dim",
      1,
    );
    const bodyHeight = Math.max(1, this.#rows - 2);
    const selectedItem = this.#items[this.#index];
    if (selectedItem) this.#cardLines(selectedItem, inner, this.#expanded.has(selectedItem.id));

    const layout = (): { starts: number[]; promptAt: Array<string | undefined>; total: number } => {
      const starts: number[] = [];
      const promptAt: Array<string | undefined> = [];
      let cursor = 0;
      let lastPrompt: string | undefined;
      for (const [i, item] of this.#items.entries()) {
        const prompt = item.userPrompt && item.userPrompt !== lastPrompt ? item.userPrompt : undefined;
        if (prompt) lastPrompt = prompt;
        promptAt[i] = prompt;
        starts[i] = cursor;
        if (prompt) cursor += 2;
        cursor += this.#cardHeight(item, inner, this.#expanded.has(item.id), i === this.#index);
      }
      return { starts, promptAt, total: cursor };
    };

    let { starts, promptAt, total } = layout();
    const selectedRange = (): { start: number; end: number } => {
      const start = starts[this.#index] ?? 0;
      const item = this.#items[this.#index];
      if (!item) return { start, end: start };
      const prompt = promptAt[this.#index] ? 2 : 0;
      return { start, end: start + prompt + this.#cardHeight(item, inner, this.#expanded.has(item.id), true) };
    };
    const clampScroll = (range: { start: number; end: number }, doc: number): void => {
      if (range.start < this.#scroll) this.#scroll = range.start;
      if (range.end > this.#scroll + bodyHeight) this.#scroll = Math.max(0, range.end - bodyHeight);
      const maxScroll = Math.max(0, doc - bodyHeight);
      if (this.#scroll > maxScroll) this.#scroll = maxScroll;
      if (this.#scroll < 0) this.#scroll = 0;
    };
    clampScroll(selectedRange(), total);

    const paintVisible = (viewTop: number, viewBottom: number): void => {
      for (const [i, item] of this.#items.entries()) {
        const start = starts[i] ?? 0;
        const end =
          start + (promptAt[i] ? 2 : 0) + this.#cardHeight(item, inner, this.#expanded.has(item.id), i === this.#index);
        if (end <= viewTop) continue;
        if (start >= viewBottom) break;
        this.#cardLines(item, inner, this.#expanded.has(item.id));
      }
    };
    paintVisible(this.#scroll, this.#scroll + bodyHeight);
    ({ starts, promptAt, total } = layout());
    clampScroll(selectedRange(), total);
    paintVisible(this.#scroll, this.#scroll + bodyHeight);
    ({ starts, promptAt, total } = layout());
    clampScroll(selectedRange(), total);

    const top = this.#scroll;
    const bottom = this.#scroll + bodyHeight;
    const body: string[] = [];
    for (const [i, item] of this.#items.entries()) {
      const start = starts[i] ?? 0;
      const prompt = promptAt[i];
      const expanded = this.#expanded.has(item.id);
      const selected = i === this.#index;
      const estimated = start + (prompt ? 2 : 0) + this.#cardHeight(item, inner, expanded, selected);
      if (estimated <= top) continue;
      if (start >= bottom) break;
      const painted = this.#cardLines(item, inner, expanded);
      const chunk: string[] = [];
      if (prompt) {
        chunk.push(paintAt(this.#theme, `❯ ${truncatePlain(prompt, cols - 2)}`, "dim", 1), "");
      }
      const block = selected
        ? outlineBlock(painted, cols, this.#theme)
        : painted.map((line) => `${TOOL_INDENT}${line}`);
      chunk.push(...block, "");
      const skip = Math.max(0, top - start);
      for (let row = skip; row < chunk.length && body.length < bodyHeight; row += 1) {
        body.push(chunk[row]!);
      }
      if (body.length >= bodyHeight) break;
    }
    while (body.length < bodyHeight) body.push("");
    return [header, ...body, footer];
  }
}

export async function openInspectOverlay(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;
  let entries: unknown[] = [];
  try {
    entries = ctx.sessionManager.getBranch() as unknown[];
  } catch {
    entries = [];
  }
  const items = collectInspectItems(entries);
  if (items.length === 0) {
    ctx.ui.notify("No tool cards in this session to inspect", "info");
    return;
  }
  await ctx.ui.custom(
    (tui: TUI, theme, _keybindings, done) => {
      const overlay = new InspectOverlay({ tui, theme, items, done });
      return overlay;
    },
    {
      overlay: true,
      overlayOptions: {
        fullscreen: true,
        width: "100%",
        maxHeight: "100%",
        margin: 0,
        anchor: "bottom-center",
      },
    },
  );
}
