/**
 * The plugin's prompt editor: re-frames the host editor's rows into the minimal
 * rounded dock, paints the grayscale frame when the active style asks for it,
 * places the below-dock status row, and owns the composer refresh timer.
 */
import { CustomEditor, type ContextUsage, type ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import {
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  type ComposerBox,
  type EditorTheme,
  type KeybindingsManager,
  type TUI,
} from "@oh-my-pi/pi-tui";
import { getPluginConfig } from "../core/config.ts";
import {
  BELOW_STATUS_COMPOSER_STYLES,
  GRAYSCALE_COMPOSER_STYLE_IDS,
  MINIMAL_COMPOSER_STYLE_IDS,
  grayscaleFrameColor,
} from "./composer-shapes.ts";
import {
  resetStatusContentProviders,
  updateMinimalPromptEditorProviders,
  type MinimalPlanStatus,
  type MinimalWorkingStatus,
} from "./composer-status.ts";
import { ensureThinkingAboveStatus } from "./thinking-widget.ts";

const EDITOR_FRAME_CHROME = 4;
const EDITOR_FRAME_MIN_WIDTH = 10;
function padToVisible(text: string, width: number): string {
  const current = visibleWidth(text);
  if (current === width) return text;
  if (current > width) return truncateToWidth(text, width, "");
  return `${text}${padding(width - current)}`;
}
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
    if (visibleWidth(plain) === innerWidth && plain.startsWith(box.bottomLeft) && plain.endsWith(box.bottomRight)) {
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
    syncComposerRefreshTimer(tui);
  }

  override render(width: number): string[] {
    syncComposerRefreshTimer(this.tui);
    const safeWidth = Math.max(0, Math.trunc(width));
    try {
      const styleId = this.getBorderStyle();
      if (!MINIMAL_COMPOSER_STYLE_IDS.has(styleId) || safeWidth < EDITOR_FRAME_MIN_WIDTH) {
        return [...super.render(safeWidth)];
      }
      const borderColor = GRAYSCALE_COMPOSER_STYLE_IDS.has(styleId) ? grayscaleFrameColor : this.borderColor;

      const innerWidth = safeWidth - EDITOR_FRAME_CHROME;
      // The host wraps and scrolls the prompt at the width it is handed, and every row past the frame
      // is truncated to the inner width: asking for the outer width would silently drop the last
      // `EDITOR_FRAME_CHROME` columns of a long prompt line.
      const inner = [...super.render(innerWidth)];
      const bottom = bottomChromeIndex(inner, innerWidth, this.#box);
      if (inner.length === 0 || bottom < 1) return inner.map((line) => truncateToWidth(line, safeWidth, ""));
      // The below-dock style emits its status row directly under the closing rule
      // (see `belowStatusComposerStyle`); the rows past it are autocomplete.
      const belowStatusRowIndex = Object.hasOwn(BELOW_STATUS_COMPOSER_STYLES, styleId) ? bottom + 1 : -1;

      const bodyWidth = safeWidth - 2;
      const framed: string[] = [
        framedChrome(
          inner[0] ?? "",
          bodyWidth,
          this.#box.topLeft,
          this.#box.topRight,
          this.#box.horizontal,
          borderColor,
        ),
      ];

      for (let index = 1; index < bottom; index += 1) {
        framed.push(framedRow(inner[index] ?? "", innerWidth, this.#box, borderColor));
      }

      framed.push(
        framedChrome(
          inner[bottom] ?? "",
          bodyWidth,
          this.#box.bottomLeft,
          this.#box.bottomRight,
          this.#box.horizontal,
          borderColor,
        ),
      );

      for (let index = bottom + 1; index < inner.length; index += 1) {
        if (index === belowStatusRowIndex) {
          framed.push(truncateToWidth(inner[index] ?? "", safeWidth, ""));
          continue;
        }
        framed.push(`  ${truncateToWidth(inner[index] ?? "", Math.max(0, safeWidth - 2), "")}`);
      }

      return framed.map((line) => truncateToWidth(line, safeWidth, ""));
    } catch {
      return [...super.render(safeWidth)];
    }
  }
}
let activeTui: TUI | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let currentTimerIntervalMs = 0;

export function getComposerRefreshIntervalMs(): number {
  try {
    const seconds = getPluginConfig().composerRefreshInterval;
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
      return Math.floor(seconds) * 1000;
    }
  } catch {
    // Default fallback
  }
  return 60_000;
}

export function syncComposerRefreshTimer(tui?: TUI): void {
  if (tui) activeTui = tui;
  if (!activeTui) return;

  const intervalMs = getComposerRefreshIntervalMs();
  if (refreshTimer && currentTimerIntervalMs === intervalMs) return;

  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }

  currentTimerIntervalMs = intervalMs;
  refreshTimer = setInterval(() => {
    try {
      if (typeof activeTui?.requestRender === "function") {
        activeTui.requestRender();
      }
    } catch {
      // Best-effort render
    }
  }, intervalMs);
  refreshTimer.unref?.();
}

export function stopComposerRefreshTimer(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
  currentTimerIntervalMs = 0;
  activeTui = undefined;
}
export function installMinimalPromptEditor(
  ui: ExtensionUIContext,
  getContextUsage: () => ContextUsage | undefined,
  getPlanStatus: () => MinimalPlanStatus | undefined,
  getWorkingStatus?: () => MinimalWorkingStatus | undefined,
  getSessionName?: () => string | undefined,
): () => void {
  updateMinimalPromptEditorProviders(getContextUsage, getPlanStatus, getWorkingStatus, getSessionName);
  ui.setEditorComponent((tui, theme, keybindings) => {
    ensureThinkingAboveStatus(tui);
    return new MinimalPromptEditor(tui, theme, keybindings);
  });
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    stopComposerRefreshTimer();
    resetStatusContentProviders();
    try {
      ui.setEditorComponent(undefined);
    } catch {
      // Interactive UI teardown may already have released the editor host.
    }
  };
}
