import type { ContextUsage, ExtensionAPI, ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import {
  padding,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  type ComposerBox,
  type ComposerChromeContext,
  type ComposerRowContext,
  type ComposerStyle,
  type EditorTheme,
  type KeybindingsManager,
  type TUI,
} from "@oh-my-pi/pi-tui";

export const MINIMAL_COMPOSER_STYLE = {
  bottomDock: "minimal-bottom-dock",
  topDock: "minimal-top-dock",
  bottomFill: "minimal-bottom-fill",
} as const;

export type MinimalComposerStyleId = (typeof MINIMAL_COMPOSER_STYLE)[keyof typeof MINIMAL_COMPOSER_STYLE];

const MINIMAL_COMPOSER_STYLE_IDS = new Set<string>(Object.values(MINIMAL_COMPOSER_STYLE));
const PROMPT_GUTTER = "❯ ";
const EDITOR_FRAME_CHROME = 4;
const EDITOR_FRAME_MIN_WIDTH = 10;
const PROJECT_ICON_VARIANTS = [
  { host: "📁", replacement: "⌂" },
  { host: "\uf115", replacement: "" },
  { host: "[D]", replacement: "~" },
] as const;
const NERD_STATUS_ICON_VARIANTS = [
  { host: "\uec19", replacement: "󰚩" },
  { host: "\uf2d2", replacement: "" },
] as const;
const GIT_DETAIL_VARIANTS = [
  { hostBranch: "⑂", branch: "⎇", modified: "Δ" },
  { hostBranch: "\uf126", branch: "\uf126", modified: "\uf044" },
  { hostBranch: "@", branch: "@", modified: "~" },
] as const;
const CONTEXT_GAUGE_CAPS = [
  { left: "▶", right: "◀" },
  { left: "\ue0b0", right: "\ue0b2" },
  { left: ">", right: "<" },
] as const;
const NO_CONTEXT_USAGE = (): ContextUsage | undefined => undefined;
let contextUsageProvider: () => ContextUsage | undefined = NO_CONTEXT_USAGE;

function padToVisible(text: string, width: number): string {
  const current = visibleWidth(text);
  if (current === width) return text;
  if (current > width) return truncateToWidth(text, width, "");
  return `${text}${padding(width - current)}`;
}
function replaceFolderIcon(content: string): string {
  for (const variant of PROJECT_ICON_VARIANTS) {
    const host = `${variant.host} `;
    if (content.includes(host)) return content.replace(host, `${variant.replacement} `);
  }
  return content;
}
function replaceNerdStatusIcons(content: string): string {
  let result = content;
  for (const variant of NERD_STATUS_ICON_VARIANTS) {
    result = result.replace(`${variant.host} `, `${variant.replacement} `);
  }
  return result;
}
function replaceGitDetails(content: string): string {
  for (const variant of GIT_DETAIL_VARIANTS) {
    const hostBranch = `${variant.hostBranch} `;
    const branchStart = content.indexOf(hostBranch);
    if (branchStart < 0) continue;

    const prefix = content.slice(0, branchStart);
    const gitAndFollowing = content
      .slice(branchStart)
      .replace(hostBranch, `${variant.branch} `)
      .replace(/\*(\d+)/gu, `${variant.modified}$1`);
    return `${prefix}${gitAndFollowing}`;
  }
  return content;
}

function formatContextPercent(percent: number): string {
  return `${percent > 0 && percent < 1 ? percent.toFixed(1) : Math.round(percent)}%`;
}

function formatContextWindow(contextWindow: number): string {
  if (contextWindow >= 1_000_000) {
    const millions = Math.round((contextWindow / 1_000_000) * 10) / 10;
    return `${millions}M`;
  }
  if (contextWindow >= 1_000) return `${Math.round(contextWindow / 1_000)}K`;
  return `${Math.max(0, Math.round(contextWindow))}`;
}

function explicitContextGauge(ctx: ComposerChromeContext, width: number, usage: ContextUsage): string | undefined {
  const percent = Number.isFinite(usage.percent) ? usage.percent : 0;
  const label = `${formatContextPercent(percent)}/${formatContextWindow(usage.contextWindow)}`;
  const trackWidth = width - visibleWidth(label) - 3;
  if (trackWidth < 4) return undefined;

  const clamped = Math.min(100, Math.max(0, percent));
  const used = Math.min(trackWidth, Math.max(0, Math.round((clamped / 100) * trackWidth)));
  const remaining = trackWidth - used;
  return `${ctx.borderColor("[")}${ctx.accentColor("█".repeat(used))}${ctx.borderColor("░".repeat(remaining))}${ctx.borderColor("]")} ${label}`;
}

function embeddedGaugeColumns(content: string): { start: number; end: number } | undefined {
  const plain = Bun.stripANSI(content);
  let best: { start: number; end: number; width: number } | undefined;

  for (const match of plain.matchAll(/\S*%\S*/gu)) {
    const text = match[0];
    const index = match.index;
    if (index === undefined || !/[\u2500-\u259f]/u.test(text)) continue;

    const start = visibleWidth(plain.slice(0, index));
    const width = visibleWidth(text);
    if (width < 8 || (best && best.width >= width)) continue;
    best = { start, end: start + width, width };
  }

  return best ? { start: best.start, end: best.end } : undefined;
}

function replaceContextGauge(content: string, ctx: ComposerChromeContext): string {
  const usage = contextUsageProvider();
  if (!usage || usage.contextWindow <= 0) return content;

  for (const caps of CONTEXT_GAUGE_CAPS) {
    const right = content.lastIndexOf(caps.right);
    if (right < 0) continue;
    const left = content.lastIndexOf(caps.left, right - 1);
    if (left < 0) continue;

    const end = right + caps.right.length;
    const gauge = explicitContextGauge(ctx, visibleWidth(content.slice(left, end)), usage);
    if (gauge) return `${content.slice(0, left)}${gauge}${content.slice(end)}`;
  }

  const columns = embeddedGaugeColumns(content);
  if (!columns) return content;

  const gauge = explicitContextGauge(ctx, columns.end - columns.start, usage);
  if (!gauge) return content;

  const totalWidth = visibleWidth(content);
  const left = sliceByColumn(content, 0, columns.start, true);
  const right = sliceByColumn(content, columns.end, totalWidth - columns.end, true);
  return `${left}${gauge}${right}`;
}

function decorateStatusContent(content: string, ctx: ComposerChromeContext): string {
  const icons = replaceNerdStatusIcons(replaceFolderIcon(content));
  const details = replaceGitDetails(icons);
  return replaceContextGauge(details, ctx);
}



function chromeBody(ctx: ComposerChromeContext, status: boolean): string {
  const width = Math.max(0, ctx.width - 2);
  if (!status || !ctx.topBorder?.content) return ctx.borderColor(ctx.box.horizontal.repeat(width));

  const content = truncateToWidth(decorateStatusContent(ctx.topBorder.content, ctx), width, "");
  return `${content}${ctx.borderColor(ctx.box.horizontal.repeat(Math.max(0, width - visibleWidth(content))))}`;
}

function chromeLine(ctx: ComposerChromeContext, edge: "top" | "bottom", status: boolean): string {
  const left = edge === "top" ? ctx.box.topLeft : ctx.box.bottomLeft;
  const right = edge === "top" ? ctx.box.topRight : ctx.box.bottomRight;
  return `${ctx.borderColor(left)}${chromeBody(ctx, status)}${ctx.borderColor(right)}`;
}

function innerRow(ctx: ComposerRowContext, filled: boolean): string[] {
  const row = `${ctx.gutter}${ctx.text}${ctx.pad}`;
  return [filled ? ctx.surfaceColor(row) : row];
}

function composerStyle(id: MinimalComposerStyleId, statusEdge: "top" | "bottom", filled: boolean): ComposerStyle {
  return {
    id,
    filledSurface: filled,
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
      return chromeLine(ctx, "top", statusEdge === "top");
    },

    renderRow(ctx: ComposerRowContext): string[] {
      return innerRow(ctx, filled);
    },

    renderBottom(ctx: ComposerChromeContext): string {
      return chromeLine(ctx, "bottom", statusEdge === "bottom");
    },
  };
}

const COMPOSER_SHAPES = [
  {
    label: "Minimal Output · Bottom Dock",
    description: "Rounded prompt with the configured OMP status and context gauge in the bottom rule",
    style: composerStyle(MINIMAL_COMPOSER_STYLE.bottomDock, "bottom", false),
  },
  {
    label: "Minimal Output · Top Dock",
    description: "Rounded prompt with the configured OMP status and context gauge in the top rule",
    style: composerStyle(MINIMAL_COMPOSER_STYLE.topDock, "top", false),
  },
  {
    label: "Minimal Output · Filled Dock",
    description: "Rounded filled prompt with the configured OMP status and context gauge in the bottom rule",
    style: composerStyle(MINIMAL_COMPOSER_STYLE.bottomFill, "bottom", true),
  },
] as const;

function framedChrome(
  line: string,
  bodyWidth: number,
  leftCap: string,
  rightCap: string,
  horizontal: string,
  borderColor: (text: string) => string,
): string {
  const lineWidth = visibleWidth(line);
  const body = lineWidth >= 2 ? sliceByColumn(line, 1, lineWidth - 2, true) : "";
  const fitted = truncateToWidth(body, bodyWidth, "");
  const missing = Math.max(0, bodyWidth - visibleWidth(fitted));
  const leftFill = horizontal.repeat(Math.floor(missing / 2));
  const rightFill = horizontal.repeat(missing - visibleWidth(leftFill));
  return `${borderColor(leftCap)}${borderColor(leftFill)}${fitted}${borderColor(rightFill)}${borderColor(rightCap)}`;
}

function framedRow(line: string, innerWidth: number, box: ComposerBox, borderColor: (text: string) => string): string {
  return `${borderColor(box.vertical)} ${padToVisible(line, innerWidth)} ${borderColor(box.vertical)}`;
}

function bottomChromeIndex(lines: readonly string[], innerWidth: number, box: ComposerBox): number {
  for (let index = lines.length - 1; index >= 1; index -= 1) {
    const plain = Bun.stripANSI(lines[index] ?? "");
    if (
      visibleWidth(plain) === innerWidth &&
      plain.startsWith(box.bottomLeft) &&
      plain.endsWith(box.bottomRight)
    ) {
      return index;
    }
  }
  return -1;
}

export class MinimalPromptEditor extends CustomEditor {
  readonly #box: ComposerBox;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
    super(tui, theme, keybindings);
    this.#box = theme.symbols.boxRound;
  }

  override render(width: number): string[] {
    const safeWidth = Math.max(0, Math.trunc(width));
    if (!MINIMAL_COMPOSER_STYLE_IDS.has(this.getBorderStyle()) || safeWidth < EDITOR_FRAME_MIN_WIDTH) {
      return [...super.render(safeWidth)];
    }

    const innerWidth = safeWidth - EDITOR_FRAME_CHROME;
    const inner = [...super.render(innerWidth)];
    const bottom = bottomChromeIndex(inner, innerWidth, this.#box);
    if (inner.length === 0 || bottom < 1) return inner.map((line) => truncateToWidth(line, safeWidth, ""));

    const bodyWidth = safeWidth - 2;
    const framed: string[] = [
      framedChrome(
        inner[0] ?? "",
        bodyWidth,
        this.#box.topLeft,
        this.#box.topRight,
        this.#box.horizontal,
        this.borderColor,
      ),
    ];

    for (let index = 1; index < bottom; index += 1) {
      framed.push(framedRow(inner[index] ?? "", innerWidth, this.#box, this.borderColor));
    }

    framed.push(
      framedChrome(
        inner[bottom] ?? "",
        bodyWidth,
        this.#box.bottomLeft,
        this.#box.bottomRight,
        this.#box.horizontal,
        this.borderColor,
      ),
    );

    for (let index = bottom + 1; index < inner.length; index += 1) {
      framed.push(`  ${truncateToWidth(inner[index] ?? "", Math.max(0, safeWidth - 2), "")}`);
    }

    return framed.map((line) => truncateToWidth(line, safeWidth, ""));
  }
}

export function registerMinimalComposerShapes(pi: ExtensionAPI): void {
  for (const shape of COMPOSER_SHAPES) pi.registerComposerShape(shape);
}

export function installMinimalPromptEditor(
  ui: ExtensionUIContext,
  getContextUsage: () => ContextUsage | undefined,
): () => void {
  contextUsageProvider = getContextUsage;
  ui.setEditorComponent((tui, theme, keybindings) => new MinimalPromptEditor(tui, theme, keybindings));
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (contextUsageProvider === getContextUsage) contextUsageProvider = NO_CONTEXT_USAGE;
    try {
      ui.setEditorComponent(undefined);
    } catch {
      // Interactive UI teardown may already have released the editor host.
    }
  };
}
