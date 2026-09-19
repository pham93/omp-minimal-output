import { Container, visibleWidth } from "@oh-my-pi/pi-tui";
import { TextScroller } from "./scrolling-text.ts";
import { getPluginConfig } from "../core/config.ts";
import { wrapLatestLines } from "../core/text.ts";
import { LINE_WIDTH_RATIO, TOOL_INDENT, paintAt, formatRowLine, elapsedSuffix } from "../core/theme.ts";

export const THOUGHT_PREVIEW_LINES = 3;
export const THOUGHT_WIDGET_KEY = "minimal-thinking";

export interface ThinkingWidgetDeps {
  owns: () => boolean;
  activityRunId: () => string | null;
  onSyncThought?: (fp: string, thought: { body: string; live: boolean; right: string; startedAt: number; detail?: string }) => void;
}

export function extractThinking(message: unknown): { text: string; live: boolean } {
  try {
    const content = (message as { content?: unknown })?.content;
    if (!Array.isArray(content)) return { text: "", live: false };
    let text = "";
    let lastIsThinking = false;
    for (const item of content as Array<{ type?: unknown; thinking?: unknown; text?: unknown }>) {
      const kind = item?.type;
      if (kind === "thinking" || kind === "reasoning" || kind === "redactedThinking") {
        const chunk =
          typeof item.thinking === "string" ? item.thinking : typeof item.text === "string" ? item.text : "";
        if (chunk) text = chunk;
        lastIsThinking = true;
      } else if (kind === "text" || kind === "toolCall") {
        lastIsThinking = false;
      }
    }
    return { text, live: lastIsThinking };
  } catch {
    return { text: "", live: false };
  }
}

export function thinkingRailLines(theme: unknown, width: number, text: string, indent: boolean): string[] {
  if (!text.trim()) return [];
  const pad = indent ? TOOL_INDENT : "  ";
  const bar = `${pad}│ `;
  const innerW = Math.max(8, Math.floor((Math.floor(width) || 0) * LINE_WIDTH_RATIO) - visibleWidth(bar));
  const lines: string[] = [];
  const op = getPluginConfig().opacity;
  const barOp = Math.max(0.05, op - 0.25);
  for (const preview of wrapLatestLines(text, innerW, THOUGHT_PREVIEW_LINES)) {
    lines.push(`${paintAt(theme, bar, "toolOutput", barOp)}${paintAt(theme, preview, "toolOutput", op)}`);
  }
  return lines;
}

export function ensureThinkingAboveStatus(tui: unknown, visualContainer?: unknown): void {
  if (!tui || typeof tui !== "object" || !("children" in tui)) return;
  const children = (tui as { children: unknown[]; invalidate?: () => void }).children;
  if (!Array.isArray(children) || children.length < 3) return;

  // 1. Locate hookWidgetContainerAbove
  let hookIdx = -1;
  if (visualContainer) {
    hookIdx = children.findIndex((c) => {
      if (!c || typeof c !== "object" || !("children" in (c as Record<string, unknown>))) return false;
      const ch = (c as { children: unknown[] }).children;
      return (
        Array.isArray(ch) &&
        (ch.includes(visualContainer) ||
          ch.some((item: unknown) => (item as Record<string, unknown>)?.isThinkingWidget || item === visualContainer))
      );
    });
  }

  if (hookIdx < 0) {
    hookIdx = children.findIndex((c) => {
      if (!c || typeof c !== "object" || !("children" in (c as Record<string, unknown>))) return false;
      const ch = (c as { children: unknown[] }).children;
      return (
        Array.isArray(ch) &&
        ch.some(
          (item: unknown) =>
            (item as Record<string, unknown>)?.isThinkingWidget ||
            (item as Record<string, unknown>)?.constructor?.name === "EditorTopGap" ||
            (item as Record<string, unknown>)?.constructor?.name === "Spacer",
        )
      );
    });
  }

  if (hookIdx < 0) {
    const editorIdx = children.findIndex((c) => {
      if (!c || typeof c !== "object") return false;
      if ("getText" in (c as Record<string, unknown>) || "handleInput" in (c as Record<string, unknown>)) return true;
      const ch = (c as { children?: unknown[] }).children;
      return (
        Array.isArray(ch) &&
        ch.some(
          (item: unknown) =>
            item &&
            typeof item === "object" &&
            ("getText" in (item as Record<string, unknown>) || "handleInput" in (item as Record<string, unknown>)),
        )
      );
    });
    if (editorIdx > 0) {
      hookIdx = editorIdx - 1;
    }
  }

  if (hookIdx < 0) return;

  // 2. Locate statusContainer
  let statusIdx = children.findIndex(
    (c) =>
      c &&
      typeof c === "object" &&
      ((c as Record<string, unknown>).mode?.statusContainer === c ||
        (c as Record<string, unknown>).mode?.statusRowOccupied !== undefined ||
        (c as Record<string, unknown>).constructor?.name === "StatusHudContainer" ||
        "statusRowOccupied" in (c as Record<string, unknown>)),
  );

  if (statusIdx < 0 && hookIdx >= 2) {
    statusIdx = hookIdx - 2;
  }

  if (statusIdx >= 0 && hookIdx > statusIdx) {
    const [hookContainer] = children.splice(hookIdx, 1);
    if (hookContainer) {
      children.splice(statusIdx, 0, hookContainer);
      (tui as { invalidate?: () => void }).invalidate?.();
    }
  }
}

export function restoreStatusOrder(tui: unknown, visualContainer?: unknown): void {
  if (!tui || typeof tui !== "object" || !("children" in tui)) return;
  const children = (tui as { children: unknown[]; invalidate?: () => void }).children;
  if (!Array.isArray(children) || children.length < 3) return;

  let hookIdx = -1;
  if (visualContainer) {
    hookIdx = children.findIndex((c) => {
      if (!c || typeof c !== "object" || !("children" in (c as Record<string, unknown>))) return false;
      const ch = (c as { children: unknown[] }).children;
      return (
        Array.isArray(ch) &&
        (ch.includes(visualContainer) ||
          ch.some((item: unknown) => (item as Record<string, unknown>)?.isThinkingWidget || item === visualContainer))
      );
    });
  }

  if (hookIdx < 0) {
    hookIdx = children.findIndex((c) => {
      if (!c || typeof c !== "object" || !("children" in (c as Record<string, unknown>))) return false;
      const ch = (c as { children: unknown[] }).children;
      return (
        Array.isArray(ch) &&
        ch.some(
          (item: unknown) =>
            (item as Record<string, unknown>)?.isThinkingWidget ||
            (item as Record<string, unknown>)?.constructor?.name === "EditorTopGap" ||
            (item as Record<string, unknown>)?.constructor?.name === "Spacer",
        )
      );
    });
  }

  if (hookIdx < 0) return;

  let statusIdx = children.findIndex(
    (c) =>
      c &&
      typeof c === "object" &&
      ((c as Record<string, unknown>).mode?.statusContainer === c ||
        (c as Record<string, unknown>).mode?.statusRowOccupied !== undefined ||
        (c as Record<string, unknown>).constructor?.name === "StatusHudContainer" ||
        "statusRowOccupied" in (c as Record<string, unknown>)),
  );

  if (statusIdx < 0 && hookIdx >= 0 && hookIdx + 1 < children.length) {
    statusIdx = hookIdx + 1;
  }

  if (statusIdx >= 0 && hookIdx < statusIdx) {
    const [hookContainer] = children.splice(hookIdx, 1);
    if (hookContainer) {
      children.splice(statusIdx, 0, hookContainer);
      (tui as { invalidate?: () => void }).invalidate?.();
    }
  }
}

export class ThinkingWidget {
  readonly #scroller = new TextScroller({
    maxLines: THOUGHT_PREVIEW_LINES,
    animationSpeed: 250,
    fillDirection: "bottom-to-top",
    baseOpacity: 1.0,
    staggerOpacities: [0.35, 0.7, 1.0],
  });

  #ui: unknown = undefined;
  #tui: unknown = undefined;
  #visualContainer: unknown = undefined;
  #widgetOn = false;
  #live = false;
  #startedAt = 0;
  #lastDurationSec = 0;
  #text = "";
  #settledLabel = "";
  readonly #deps: ThinkingWidgetDeps;

  constructor(deps: ThinkingWidgetDeps) {
    this.#deps = deps;
  }

  get live(): boolean {
    return this.#live;
  }

  set live(value: boolean) {
    this.#live = value;
  }

  get startedAt(): number {
    return this.#startedAt;
  }

  set startedAt(value: number) {
    this.#startedAt = value;
  }

  get text(): string {
    return this.#text;
  }

  set text(value: string) {
    this.#text = value;
  }

  get settledLabel(): string {
    return this.#settledLabel;
  }

  get widgetOn(): boolean {
    return this.#widgetOn;
  }

  get lastThoughtDuration(): string {
    return this.#lastDurationSec > 0 ? ` (${this.#lastDurationSec}s)` : "";
  }

  setTui(tui: unknown): void {
    if (tui && typeof tui === "object") {
      this.#tui = tui;
      if (this.#visualContainer) {
        ensureThinkingAboveStatus(tui, this.#visualContainer);
      } else {
        ensureThinkingAboveStatus(tui);
      }
    }
  }

  isAnimating(): boolean {
    return this.#scroller.isAnimating();
  }
  thoughtFadeKey(): string {
    const runId = this.#deps.activityRunId();
    return runId ? `thought:${runId}` : "thought:live";
  }

  animatedThinkingRailLines(theme: unknown, width: number, text: string): string[] {
    const pad = "  ";
    const bar = `${pad}│ `;
    const innerW = Math.max(8, Math.floor((Math.floor(width) || 0) * LINE_WIDTH_RATIO) - visibleWidth(bar));
    this.#scroller.update(text, innerW);
    const rendered = this.#scroller.render();
    const cfgOp = getPluginConfig().opacity;
    const lines: string[] = [];

    for (const item of rendered) {
      if (item.isPlaceholder) {
        lines.push(paintAt(theme, bar, "toolOutput", Math.max(0.05, cfgOp - 0.25) * 0.35));
      } else {
        const effectiveOp = item.opacity * cfgOp;
        const barOp = Math.max(0.05, effectiveOp - 0.25);
        lines.push(`${paintAt(theme, bar, "toolOutput", barOp)}${paintAt(theme, item.text, "toolOutput", effectiveOp)}`);
      }
    }

    return lines;
  }

  paintThinkingVisual(tuiOrTheme: unknown, theme?: unknown): Container {
    const effectiveTheme = theme !== undefined ? theme : tuiOrTheme;
    const tui = theme !== undefined ? tuiOrTheme : undefined;
    if (tui) {
      this.#tui = tui;
    }
    const c = new Container();
    (c as Record<string, unknown>).isThinkingWidget = true;
    this.#visualContainer = c;
    if (this.#tui) {
      ensureThinkingAboveStatus(this.#tui, c);
    }
    c.addChild({
      render: (width: number): readonly string[] => {
        if (this.#tui) {
          ensureThinkingAboveStatus(this.#tui, c);
        }
        if (!this.#deps.owns()) return [];
        if (!this.#live) {
          return ["", "", "", ""];
        }
        const lines: string[] = [
          formatRowLine(effectiveTheme, width, {
            body: "Thinking...",
            live: true,
            fadeKey: this.thoughtFadeKey(),
            right: this.#startedAt > 0 ? elapsedSuffix(this.#startedAt) : "",
          }),
        ];
        lines.push(...this.animatedThinkingRailLines(effectiveTheme, width, this.#text));
        return lines;
      },
    });
    return c;
  }

  bindUi(ctx: unknown): void {
    if (!this.#deps.owns() || typeof ctx !== "object" || ctx === null || !("ui" in ctx)) return;
    const ui = (ctx as { ui?: unknown }).ui;
    if (ui) {
      this.#ui = ui;
      if (typeof ui === "object" && "children" in (ui as Record<string, unknown>)) {
        this.setTui(ui);
      }
      this.installWidget();
    }
  }

  installWidget(): void {
    if (!this.#deps.owns()) return;
    const ui = this.#ui;
    if (!ui || typeof ui !== "object" || typeof (ui as { setWidget?: unknown }).setWidget !== "function") return;
    try {
      if (this.#widgetOn) {
        const requestRender = (ui as { requestRender?: unknown }).requestRender;
        if (typeof requestRender === "function") requestRender.call(ui);
        return;
      }
      (ui as { setWidget: (key: string, fn: unknown, opts: unknown) => void }).setWidget(
        THOUGHT_WIDGET_KEY,
        (tui: unknown, theme: unknown) => this.paintThinkingVisual(tui, theme),
        { placement: "aboveEditor" },
      );
      this.#widgetOn = true;
    } catch {
      this.#widgetOn = false;
    }
  }

  setWidget(show: boolean): void {
    const ui = this.#ui;
    if (!ui || typeof ui !== "object" || typeof (ui as { setWidget?: unknown }).setWidget !== "function") return;
    try {
      if (!show) {
        (ui as { setWidget: (key: string, value: unknown) => void }).setWidget(THOUGHT_WIDGET_KEY, undefined);
        this.#widgetOn = false;
        return;
      }
      this.installWidget();
    } catch {
      this.#widgetOn = false;
    }
  }

  syncThought(): void {
    const runId = this.#deps.activityRunId();
    if (!runId) return;
    const fp = `thought:${runId}`;
    if (this.#live) {
      if (this.#startedAt === 0) this.#startedAt = Date.now();
      this.#settledLabel = "";
      this.#deps.onSyncThought?.(fp, {
        body: "Thinking...",
        live: true,
        right: "",
        startedAt: this.#startedAt,
      });
      return;
    }
    const sec = this.#startedAt > 0 ? Math.max(0, Math.floor((Date.now() - this.#startedAt) / 1000)) : 0;
    this.#lastDurationSec = sec;
    this.#settledLabel = sec > 0 ? `Thought for ${sec}s` : "Thought";
    this.#deps.onSyncThought?.(fp, {
      body: "Thought",
      live: false,
      right: sec > 0 ? ` (${sec}s)` : "",
      startedAt: this.#startedAt > 0 ? this.#startedAt : Date.now(),
      detail: this.#text,
    });
    this.#startedAt = 0;
  }

  reset(): void {
    this.#live = false;
    this.#startedAt = 0;
    this.#text = "";
    this.#settledLabel = "";
    this.#scroller.reset();
    const ui = this.#ui;
    if (this.#widgetOn && ui && typeof (ui as { requestRender?: unknown }).requestRender === "function") {
      try {
        (ui as { requestRender: () => void }).requestRender();
      } catch {
        // Best-effort repaint
      }
    }
  }

  dispose(): void {
    this.setWidget(false);
    if (this.#tui) {
      restoreStatusOrder(this.#tui, this.#visualContainer);
      this.#tui = undefined;
    }
    this.#visualContainer = undefined;
    this.#ui = undefined;
    this.reset();
  }
}
