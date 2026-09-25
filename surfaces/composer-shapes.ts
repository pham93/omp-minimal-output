/**
 * Prompt-dock frames: the grayscale palette, chrome rules, the composer styles
 * the plugin registers, and the shape list `/settings` → Composer Shape shows.
 * Status text comes from `composer-status.ts`; the editor subclass that
 * re-frames rows lives in `composer-editor.ts`.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  padding,
  truncateToWidth,
  visibleWidth,
  type ComposerChromeContext,
  type ComposerRowContext,
  type ComposerStyle,
} from "@oh-my-pi/pi-tui";
import { ensureGaugeVisible } from "./composer-gauge.ts";
import { fitStatusContent } from "./composer-primitives.ts";
import {
  currentContextUsage,
  decorateStatusContent,
  fallbackModeStatus,
  splitProjectGitStatus,
  workingPrefix,
} from "./composer-status.ts";

export const MINIMAL_COMPOSER_STYLE = {
  bottomDock: "minimal-bottom-dock",
  topDock: "minimal-top-dock",
  grayscaleBottomDock: "minimal-grayscale-bottom-dock",
  grayscaleTopDock: "minimal-grayscale-top-dock",
  belowDock: "minimal-below-dock",
} as const;

export type MinimalComposerStyleId = (typeof MINIMAL_COMPOSER_STYLE)[keyof typeof MINIMAL_COMPOSER_STYLE];

export const MINIMAL_COMPOSER_STYLE_IDS = new Set<string>(Object.values(MINIMAL_COMPOSER_STYLE));
export const GRAYSCALE_COMPOSER_STYLE_IDS = new Set<string>([
  MINIMAL_COMPOSER_STYLE.grayscaleBottomDock,
  MINIMAL_COMPOSER_STYLE.grayscaleTopDock,
]);
/** Styles that place the status line on its own row under the frame. */
export const BELOW_STATUS_COMPOSER_STYLES: Record<string, true> = {
  [MINIMAL_COMPOSER_STYLE.belowDock]: true,
};

const GRAYSCALE_FRAME_RGB = "\x1b[38;2;142;142;142m";
const GRAYSCALE_STATUS_RGB = "\x1b[38;2;176;176;176m";
const GRAYSCALE_GUTTER_RGB = "\x1b[38;2;206;206;206m";
const ANSI_FOREGROUND_RESET = "\x1b[39m";

function grayscaleColor(text: string, color: string): string {
  return `${color}${text}${ANSI_FOREGROUND_RESET}`;
}

export function grayscaleFrameColor(text: string): string {
  return grayscaleColor(text, GRAYSCALE_FRAME_RGB);
}

function grayscaleStatusColor(text: string): string {
  return grayscaleColor(text, GRAYSCALE_STATUS_RGB);
}

function grayscaleGutterColor(text: string): string {
  return grayscaleColor(text, GRAYSCALE_GUTTER_RGB);
}
const PROMPT_GUTTER = "❯ ";
const CHROME_STATUS_PART = {
  none: "none",
  full: "full",
  projectGit: "project-git",
  rest: "rest",
} as const;
type ChromeStatusPart = (typeof CHROME_STATUS_PART)[keyof typeof CHROME_STATUS_PART];
export function chromeBody(ctx: ComposerChromeContext, part: ChromeStatusPart): string {
  try {
    const width = Math.max(0, ctx.width - 2);
    if (part === CHROME_STATUS_PART.none || !ctx.topBorder?.content || width < 2) {
      return ctx.borderColor(ctx.box.horizontal.repeat(width));
    }

    const pad = ctx.borderColor(" ");
    const contentWidth = width - 2;
    const gaugeWidthReduction = part === CHROME_STATUS_PART.rest ? 2 : 0;
    const decorated = decorateStatusContent(ctx.topBorder.content, ctx, gaugeWidthReduction);
    if (part === CHROME_STATUS_PART.full) {
      const separated = splitProjectGitStatus(decorated, ctx);
      const prefix = workingPrefix(ctx);
      const prefixed = prefix
        ? `${prefix} ${separated.leadingThroughProjectGit}`.trim()
        : separated.leadingThroughProjectGit;
      const statusBody = prefixed;
      const modeStatus = fallbackModeStatus(decorated, ctx);
      const modeGap = modeStatus ? 1 : 0;
      const bodyWidth = Math.max(0, contentWidth - visibleWidth(modeStatus) - modeGap);
      const fitted = fitStatusContent(statusBody, bodyWidth, false);
      const body = ensureGaugeVisible(statusBody, fitted, bodyWidth, ctx, currentContextUsage());
      const fill = ctx.borderColor(ctx.box.horizontal.repeat(Math.max(0, bodyWidth - visibleWidth(body))));
      const pinnedMode = modeStatus ? `${pad}${modeStatus}` : "";
      return `${pad}${body}${fill}${pinnedMode}${pad}`;
    }
    const split = splitProjectGitStatus(decorated, ctx);
    if (part === CHROME_STATUS_PART.projectGit) {
      const title = fitStatusContent(split.projectGit, contentWidth, true);
      const fill = ctx.borderColor(ctx.box.horizontal.repeat(Math.max(0, contentWidth - visibleWidth(title))));
      return `${pad}${fill}${title}${pad}`;
    }

    const prefix = workingPrefix(ctx);
    const prefixedRest = prefix ? `${prefix} ${split.rest}`.trim() : split.rest;
    const modeStatus = fallbackModeStatus(decorated, ctx);
    const modeGap = modeStatus ? 1 : 0;
    const bodyWidth = Math.max(0, contentWidth - visibleWidth(modeStatus) - modeGap);
    const fitted = fitStatusContent(prefixedRest, bodyWidth, false);
    const body = ensureGaugeVisible(prefixedRest, fitted, bodyWidth, ctx, currentContextUsage());
    const fill = ctx.borderColor(ctx.box.horizontal.repeat(Math.max(0, bodyWidth - visibleWidth(body))));
    const pinnedMode = modeStatus ? `${pad}${modeStatus}` : "";
    return `${pad}${body}${fill}${pinnedMode}${pad}`;
  } catch {
    const width = Math.max(0, ctx.width - 2);
    return ctx.borderColor(ctx.box.horizontal.repeat(width));
  }
}

export function chromeLine(
  ctx: ComposerChromeContext,
  edge: "top" | "bottom",
  part: ChromeStatusPart,
  grayscale: boolean,
): string {
  try {
    const left = edge === "top" ? ctx.box.topLeft : ctx.box.bottomLeft;
    const right = edge === "top" ? ctx.box.topRight : ctx.box.bottomRight;
    if (grayscale) {
      return `${grayscaleFrameColor(left)}${grayscaleStatusColor(Bun.stripANSI(chromeBody(ctx, part)))}${grayscaleFrameColor(right)}`;
    }
    return `${ctx.borderColor(left)}${chromeBody(ctx, part)}${ctx.borderColor(right)}`;
  } catch {
    const left = edge === "top" ? ctx.box.topLeft : ctx.box.bottomLeft;
    const right = edge === "top" ? ctx.box.topRight : ctx.box.bottomRight;
    return `${ctx.borderColor(left)}${ctx.borderColor(ctx.box.horizontal.repeat(Math.max(0, ctx.width - 2)))}${ctx.borderColor(right)}`;
  }
}

export function innerRow(ctx: ComposerRowContext, grayscale: boolean): string[] {
  const gutter = grayscale ? grayscaleGutterColor(Bun.stripANSI(ctx.gutter)) : ctx.gutter;
  return [`${gutter}${ctx.text}${ctx.pad}`];
}

export function composerStyle(
  id: MinimalComposerStyleId,
  statusEdge: "top" | "bottom",
  grayscale = false,
): ComposerStyle {
  return {
    id,
    filledSurface: false,
    sideBorders: false,
    verticalChrome: 2,
    statusAttachment: "top-border",
    bottomBar: "none",
    bottomBarGap: false,
    defaultPromptGutter: PROMPT_GUTTER,

    defaultPaddingX(): number {
      return 0;
    },

    sideChromeWidth(): number {
      return 0;
    },

    renderTop(ctx: ComposerChromeContext): string {
      const part = statusEdge === "top" ? CHROME_STATUS_PART.full : CHROME_STATUS_PART.projectGit;
      return chromeLine(ctx, "top", part, grayscale);
    },

    renderRow(ctx: ComposerRowContext): string[] {
      return innerRow(ctx, grayscale);
    },

    renderBottom(ctx: ComposerChromeContext): string {
      const part = statusEdge === "bottom" ? CHROME_STATUS_PART.rest : CHROME_STATUS_PART.none;
      return chromeLine(ctx, "bottom", part, grayscale);
    },
  };
}

/**
 * Below-dock status row: the decorated status text on its own row under the
 * frame, with the same working prefix, gauge fitting, and pinned mode chip the
 * dock rules carry — minus the rule fill.
 */
function belowStatusRow(ctx: ComposerChromeContext): string {
  try {
    const width = Math.max(0, ctx.width);
    // An empty row is kept while the status line has nothing to show yet (startup,
    // degraded hosts) so the frame does not change height when the status attaches.
    if (!ctx.topBorder?.content || width < 2) return "";
    const decorated = decorateStatusContent(ctx.topBorder.content, ctx);
    const prefix = workingPrefix(ctx);
    const statusBody = prefix ? `${prefix} ${decorated}`.trim() : decorated;
    const modeStatus = fallbackModeStatus(decorated, ctx);
    const modeGap = modeStatus ? 1 : 0;
    const bodyWidth = Math.max(0, width - visibleWidth(modeStatus) - modeGap);
    const fitted = fitStatusContent(statusBody, bodyWidth, false);
    const body = ensureGaugeVisible(statusBody, fitted, bodyWidth, ctx, currentContextUsage());
    if (!modeStatus) return truncateToWidth(body, width, "");
    const fill = padding(Math.max(1, width - visibleWidth(body) - visibleWidth(modeStatus)));
    return truncateToWidth(`${body}${fill}${modeStatus}`, width, "");
  } catch {
    return "";
  }
}

/**
 * Rounded frame with the configured OMP status line on a row of its own below
 * the frame. The closing rule and the status row ride the last content row:
 * the host's shape preview pushes `renderRow` rows before `renderBottom`, so a
 * status row emitted there would land inside the frame. `composer-editor.ts`
 * re-frames the rows and keeps the status row flush left under the rule.
 */
function belowStatusComposerStyle(id: MinimalComposerStyleId): ComposerStyle {
  return {
    id,
    filledSurface: false,
    sideBorders: false,
    verticalChrome: 2,
    statusAttachment: "top-border",
    bottomBar: "none",
    bottomBarGap: false,
    defaultPromptGutter: PROMPT_GUTTER,

    defaultPaddingX(): number {
      return 0;
    },

    sideChromeWidth(): number {
      return 0;
    },

    renderTop(ctx: ComposerChromeContext): string {
      return chromeLine(ctx, "top", CHROME_STATUS_PART.none, false);
    },

    renderRow(ctx: ComposerRowContext): string[] {
      const row = innerRow(ctx, false);
      if (!ctx.isLastRow) return row;
      return [...row, chromeLine(ctx, "bottom", CHROME_STATUS_PART.none, false), belowStatusRow(ctx)];
    },

    renderBottom(): undefined {
      return undefined;
    },
  };
}

const COMPOSER_SHAPES = [
  {
    label: "Minimal Output · Bottom Dock",
    description: "Rounded prompt with the configured OMP status and context gauge in the bottom rule",
    style: composerStyle(MINIMAL_COMPOSER_STYLE.bottomDock, "bottom"),
  },
  {
    label: "Minimal Output · Top Dock",
    description: "Rounded prompt with the configured OMP status and context gauge in the top rule",
    style: composerStyle(MINIMAL_COMPOSER_STYLE.topDock, "top"),
  },
  {
    label: "Minimal Output · Grayscale Bottom Dock",
    description: "Neutral grayscale prompt with OMP status and context gauge in the bottom rule",
    style: composerStyle(MINIMAL_COMPOSER_STYLE.grayscaleBottomDock, "bottom", true),
  },
  {
    label: "Minimal Output · Grayscale Top Dock",
    description: "Neutral grayscale prompt with OMP status and context gauge in the top rule",
    style: composerStyle(MINIMAL_COMPOSER_STYLE.grayscaleTopDock, "top", true),
  },
  {
    label: "Minimal Output · Below Dock",
    description: "Rounded prompt with the configured OMP status and context gauge on a row below the frame",
    style: belowStatusComposerStyle(MINIMAL_COMPOSER_STYLE.belowDock),
  },
] as const;

export function registerMinimalComposerShapes(pi: ExtensionAPI): void {
  for (const shape of COMPOSER_SHAPES) pi.registerComposerShape(shape);
}
