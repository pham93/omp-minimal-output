import { visibleWidth } from "@oh-my-pi/pi-tui";
import { getPluginConfig } from "../core/config.ts";
import { wrapToWidth } from "../core/text.ts";
import { LINE_WIDTH_RATIO, TOOL_INDENT, paintAt } from "../core/theme.ts";

export interface TextScrollerOptions {
  /** Maximum number of visible lines (default: 3) */
  maxLines?: number;
  /** Duration of shift / fade animation in ms (default: 250) */
  animationSpeed?: number;
  /** Base opacity multiplier (default: 1.0) */
  baseOpacity?: number;
  /** Custom opacity targets for slots from oldest to newest (length = maxLines). Defaults to [0.4, 0.7, 1.0] for 3 lines */
  opacities?: number[];
  /** Whether lines fill bottom-to-top (new lines at bottom) or top-to-bottom (default: "bottom-to-top") */
  fillDirection?: "bottom-to-top" | "top-to-bottom";
}
export interface RenderedLine {
  /** The text content of the line */
  text: string;
  /** The computed opacity for this line (0 to 1) */
  opacity: number;
  /** Whether this line is an empty placeholder */
  isPlaceholder: boolean;
}

interface TransitionSource {
  text: string;
  opacity: number;
}

/**
 * Computes default target opacities for N slots from oldest (index 0) to newest (index maxLines - 1).
 * The newest line always has the highest opacity (baseOpacity * 1.0), with older lines fading down.
 */
export function defaultSlotOpacities(maxLines: number, baseOpacity = 1.0): number[] {
  if (maxLines <= 0) return [];
  if (maxLines === 1) return [baseOpacity];
  if (maxLines === 2) return [0.55 * baseOpacity, 1.0 * baseOpacity];
  if (maxLines === 3) return [0.4 * baseOpacity, 0.7 * baseOpacity, 1.0 * baseOpacity];

  const minOp = 0.35 * baseOpacity;
  const maxOp = 1.0 * baseOpacity;
  const result: number[] = [];
  for (let i = 0; i < maxLines; i++) {
    const t = i / (maxLines - 1);
    result.push(minOp + (maxOp - minOp) * t);
  }
  return result;
}

/**
 * Cubic ease-out curve.
 */
function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

/**
 * Reusable text scrolling animator.
 *
 * Manages a fixed-size window of visible lines. When new lines enter:
 * - New line fades in at the latest slot.
 * - Older lines shift upward, transitioning to lower opacity.
 * - The oldest line shifts out of existence.
 * - Empty slots remain as placeholders to keep the layout height constant.
 */
export class TextScroller {
  private readonly maxLines: number;
  private readonly animationSpeed: number;
  private readonly baseOpacity: number;
  private readonly slotOpacities: number[];
  private readonly fillDirection: "top-to-bottom" | "bottom-to-top";

  private currentLines: string[] = [];
  private prevRendered: TransitionSource[] = [];
  private transitionStartTime = 0;
  private lastWidth = 0;
  private rawText = "";

  constructor(options?: TextScrollerOptions) {
    this.maxLines = Math.max(1, options?.maxLines ?? 3);
    this.animationSpeed = Math.max(1, options?.animationSpeed ?? 250);
    this.baseOpacity = Math.max(0, Math.min(1, options?.baseOpacity ?? 1.0));
    this.fillDirection = options?.fillDirection ?? "bottom-to-top";

    if (options?.opacities && options.opacities.length === this.maxLines) {
      this.slotOpacities = options.opacities.map((o) => Math.max(0, Math.min(1, o * this.baseOpacity)));
    } else {
      this.slotOpacities = defaultSlotOpacities(this.maxLines, this.baseOpacity);
    }
  }

  /**
   * Resets all internal state and clears displayed lines.
   */
  reset(): void {
    this.currentLines = [];
    this.prevRendered = [];
    this.transitionStartTime = 0;
    this.lastWidth = 0;
    this.rawText = "";
  }

  /**
   * Returns true if a line shift or fade transition is currently in progress.
   */
  isAnimating(now = Date.now()): boolean {
    if (this.transitionStartTime === 0) return false;
    return now - this.transitionStartTime < this.animationSpeed;
  }

  /**
   * Updates the scroller from raw text and column width.
   */
  update(text: string, width: number, now = Date.now()): void {
    const trimmed = text.trim();
    if (!trimmed) {
      this.reset();
      return;
    }

    if (trimmed === this.rawText && width === this.lastWidth) {
      return;
    }

    this.rawText = trimmed;
    this.lastWidth = width;
    const wrapped = wrapToWidth(trimmed, width);
    this.setLines(wrapped, now);
  }

  /**
   * Updates the scroller with pre-wrapped lines.
   */
  setLines(allLines: string[], now = Date.now()): void {
    if (allLines.length === 0) {
      this.reset();
      return;
    }

    const prevCount = this.currentLines.length;
    const nextCount = allLines.length;

    if (prevCount === 0) {
      // First line(s) appearing: start fade-in
      this.prevRendered = this.render(now).map((r) => ({ text: r.text, opacity: 0 }));
      this.currentLines = [...allLines];
      this.transitionStartTime = now;
      return;
    }

    if (nextCount > prevCount) {
      // One or more new lines entered!
      // Snapshot current state for smooth transition
      this.prevRendered = this.render(now).map((r) => ({ text: r.text, opacity: r.opacity }));
      this.currentLines = [...allLines];
      this.transitionStartTime = now;
      return;
    }

    // Same line count or text extension on current line:
    // Update line contents without restarting shift transition
    this.currentLines = [...allLines];
  }

  /**
   * Computes the visible window of lines (length always equals maxLines).
   * Pads with empty placeholders if currentLines has fewer lines than maxLines.
   */
  private getVisibleWindow(): string[] {
    const count = this.currentLines.length;
    const windowLines = this.currentLines.slice(-this.maxLines);
    const result: string[] = [];

    if (windowLines.length >= this.maxLines) {
      return windowLines;
    }

    const padCount = this.maxLines - windowLines.length;
    if (this.fillDirection === "bottom-to-top") {
      for (let i = 0; i < padCount; i++) result.push("");
      result.push(...windowLines);
    } else {
      result.push(...windowLines);
      for (let i = 0; i < padCount; i++) result.push("");
    }

    return result;
  }

  /**
   * Renders the current lines with their calculated opacities.
   * Always returns an array of exactly maxLines entries.
   */
  render(now = Date.now()): RenderedLine[] {
    const visible = this.getVisibleWindow();
    const isTransitioning = this.isAnimating(now);
    const results: RenderedLine[] = [];

    if (!isTransitioning) {
      this.transitionStartTime = 0;
      for (let i = 0; i < this.maxLines; i++) {
        const text = visible[i] ?? "";
        const isPlaceholder = text === "";
        const targetOp = this.slotOpacities[i] ?? this.baseOpacity;
        results.push({
          text,
          opacity: isPlaceholder ? 0 : targetOp,
          isPlaceholder,
        });
      }
      return results;
    }

    // Transition in progress
    const elapsed = Math.max(0, now - this.transitionStartTime);
    const progress = Math.min(1, elapsed / this.animationSpeed);
    const ease = easeOutCubic(progress);

    for (let i = 0; i < this.maxLines; i++) {
      const text = visible[i] ?? "";
      const isPlaceholder = text === "";
      const targetOp = isPlaceholder ? 0 : (this.slotOpacities[i] ?? this.baseOpacity);

      // Where did this slot's content come from in prevRendered?
      // When lines shift up, previous slot (i + 1) moved to slot i.
      // For the newest slot (maxLines - 1), it is a new line fading in from 0.
      let startOp = 0;
      if (this.prevRendered.length === this.maxLines) {
        if (i < this.maxLines - 1) {
          // It shifted from slot below (i + 1)
          startOp = this.prevRendered[i + 1]?.opacity ?? targetOp;
        } else {
          // Bottom slot is brand new line fading in
          startOp = 0;
        }
      }

      const opacity = isPlaceholder ? 0 : startOp + (targetOp - startOp) * ease;

      results.push({
        text,
        opacity: Math.max(0, Math.min(1, opacity)),
        isPlaceholder,
      });
    }

    return results;
  }

  /**
   * Returns current maximum lines configured.
   */
  getMaxLines(): number {
    return this.maxLines;
  }

  /**
   * Returns configured animation speed in ms.
   */
  getAnimationSpeed(): number {
    return this.animationSpeed;
  }
}

/**
 * Functional factory helper to create a TextScroller instance.
 */
export function createTextScroller(options?: TextScrollerOptions): TextScroller {
  return new TextScroller(options);
}

export interface SettledThoughtOptions {
  /** Maximum number of thinking lines to show (minimal: 1, standard: standardMaxRows, detailed: detailedMaxRows) */
  maxLines: number;
  /** Available viewport width for wrapping */
  width: number;
  /** Theme object for token coloring */
  theme?: unknown;
  /** Indent prefix before rail (default: "  " or TOOL_INDENT) */
  indent?: boolean | string;
  /** Opacity multiplier (defaults to plugin config opacity) */
  opacity?: number;
  /** Custom rail bar string if specified */
  bar?: string;
}

/**
 * Formats settled thought text for transcript display according to the minimal output standard:
 * - Wraps to available column width.
 * - If lines exceed maxLines, prepends `(...N previous lines)` in dim.
 * - Returns the last maxLines lines styled with the vertical rail (no line number gutter).
 */
export function formatSettledThought(text: string, options: SettledThoughtOptions): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const pad = typeof options.indent === "string" ? options.indent : options.indent ? TOOL_INDENT : "  ";
  const bar = options.bar ?? `${pad}│ `;
  const innerW = Math.max(8, Math.floor((Math.floor(options.width) || 0) * LINE_WIDTH_RATIO) - visibleWidth(bar));
  const allLines = wrapToWidth(trimmed, innerW);
  if (allLines.length === 0) return [];

  const maxLines = Math.max(1, Math.floor(options.maxLines));
  const op = options.opacity ?? getPluginConfig().opacity;
  const barOp = Math.max(0.05, op - 0.25);
  const result: string[] = [];

  if (allLines.length > maxLines) {
    const hidden = allLines.length - maxLines;
    const hint = `(...${hidden} previous lines)`;
    result.push(`${paintAt(options.theme, bar, "toolOutput", barOp)}${paintAt(options.theme, hint, "dim", op)}`);
  }

  const visible = allLines.slice(-maxLines);
  for (const line of visible) {
    result.push(`${paintAt(options.theme, bar, "toolOutput", barOp)}${paintAt(options.theme, line, "toolOutput", op)}`);
  }
  result.push("");
  return result;
}
