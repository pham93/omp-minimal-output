/**
 * Full-list todos panel: an on-demand overlay (`ctx.ui.custom` with `overlay: true`) that renders the
 * same snapshot as the sticky summary, expanded and animated. The summary stays timer-free and one row
 * high, so the composer never reflows; the scan and strike animations live here, where a repaint is
 * bounded to the floating panel instead of the prompt block.
 */
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import * as PiTui from "@oh-my-pi/pi-tui";
import { renderDensityTodoHeader, type TodoAnim, type TodoHeaderState } from "./todos-header.ts";

const ESC = "\x1b";
const MIN_WIDTH = 24;
const PANEL_HINT = "↑↓ scroll · esc close";
const PANEL_HEIGHT_RATIO = 0.7;
const FRAME_ROWS = 2;
/** `ctrl+alt+t` as the terminal delivers it: an ESC-prefixed control byte. */
const TOGGLE_KEY = "\x1b\x14";

interface BoxGlyphs {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  horizontal: string;
  vertical: string;
}

const ASCII_BOX: BoxGlyphs = {
  topLeft: "+",
  topRight: "+",
  bottomLeft: "+",
  bottomRight: "+",
  horizontal: "-",
  vertical: "|",
};

function matchesKey(data: string, key: string): boolean {
  const fn = (PiTui as { matchesKey?: (input: string, id: string) => boolean }).matchesKey;
  return typeof fn === "function" ? fn(data, key) : data === key;
}

function isUp(data: string): boolean {
  return data === "\x1b[A" || matchesKey(data, "up");
}

function isDown(data: string): boolean {
  return data === "\x1b[B" || matchesKey(data, "down");
}

function isClose(data: string): boolean {
  return data === ESC || matchesKey(data, "escape");
}

/**
 * The panel owns the keyboard while it is visible, so the shortcut that opened it has to close it
 * here as well: the host routes keys to the focused overlay instead of running global shortcuts.
 */
function isToggle(data: string): boolean {
  return data === TOGGLE_KEY || matchesKey(data, "ctrl+alt+t");
}

/** The host theme's rounded box glyphs, with an ASCII fallback for themes that carry none. */
function boxGlyphs(theme: unknown): BoxGlyphs {
  const box = (theme as { boxRound?: Partial<BoxGlyphs> } | undefined)?.boxRound;
  if (!box) return ASCII_BOX;
  return {
    topLeft: box.topLeft ?? ASCII_BOX.topLeft,
    topRight: box.topRight ?? ASCII_BOX.topRight,
    bottomLeft: box.bottomLeft ?? ASCII_BOX.bottomLeft,
    bottomRight: box.bottomRight ?? ASCII_BOX.bottomRight,
    horizontal: box.horizontal ?? ASCII_BOX.horizontal,
    vertical: box.vertical ?? ASCII_BOX.vertical,
  };
}

/** Paint through the host theme when it exposes `fg`, otherwise leave the text plain. */
function paintToken(theme: unknown, token: string, text: string): string {
  const fg = (theme as { fg?: (color: string, value: string) => string } | undefined)?.fg;
  if (typeof fg !== "function") return text;
  try {
    return fg(token, text);
  } catch {
    return text;
  }
}

export interface TodoPanelDeps {
  /** Live snapshot; null once the list is cleared. */
  state: () => TodoHeaderState | null;
  /** Animation clock for the active row's scan and the settle strike. */
  anim: () => TodoAnim;
  /** Repaint the overlay after a key that only moves the viewport. */
  requestRender: () => void;
  /** Called when the panel is dismissed or disposed; releases the host overlay entry. */
  done: () => void;
}

/**
 * Overlay component: a framed, scrollable list of every phase and task. The keyboard belongs to the
 * overlay while it is visible (the host focuses the topmost overlay), so `esc` — or the shortcut that
 * opened it — always closes, and scroll keys repaint only the panel.
 */
export class TodoPanel {
  readonly #theme: unknown;
  readonly #deps: TodoPanelDeps;
  #scroll = 0;

  constructor(theme: unknown, deps: TodoPanelDeps) {
    this.#theme = theme;
    this.#deps = deps;
  }

  scrollOffset(): number {
    return this.#scroll;
  }

  /** Visible list rows: the panel grows with its content up to 70% of the terminal. */
  #bodyHeight(listRows: number, terminalRows: number): number {
    const cap = Math.max(1, Math.floor(Math.max(4, terminalRows) * PANEL_HEIGHT_RATIO) - FRAME_ROWS);
    return Math.max(1, Math.min(listRows, cap));
  }

  #lines(width: number): string[] {
    const state = this.#deps.state();
    if (!state || state.items.length === 0) return [];
    return renderDensityTodoHeader(this.#theme, width, state, true, this.#deps.anim(), PANEL_HINT);
  }

  render(width: number, terminalRows = process.stdout.rows ?? 24): readonly string[] {
    const box = boxGlyphs(this.#theme);
    const panelWidth = Math.max(MIN_WIDTH, Math.floor(width));
    // `row`-style chrome insets one column on each side, plus the borders themselves.
    const contentWidth = Math.max(0, panelWidth - 4);
    const lines = this.#lines(contentWidth);
    const bodyHeight = this.#bodyHeight(lines.length, terminalRows);
    this.#scroll = Math.min(this.#scroll, Math.max(0, lines.length - bodyHeight));

    const paint = (text: string, token: string): string => paintToken(this.#theme, token, text);
    const body: string[] = [];
    for (let index = this.#scroll; index < lines.length && body.length < bodyHeight; index += 1) {
      body.push(this.#row(lines[index] ?? "", panelWidth, box));
    }
    while (body.length < bodyHeight) body.push(this.#row("", panelWidth, box));

    const title = " Todos ";
    const fill = Math.max(0, panelWidth - 2 - visibleWidth(title) - 1);
    const topRule = `${paint(box.topLeft + box.horizontal, "border")}${paint(title, "accent")}${paint(
      box.horizontal.repeat(fill) + box.topRight,
      "border",
    )}`;
    const bottomRule = paint(`${box.bottomLeft}${box.horizontal.repeat(panelWidth - 2)}${box.bottomRight}`, "border");
    return [topRule, ...body, bottomRule];
  }

  #row(content: string, width: number, box: BoxGlyphs): string {
    const inner = Math.max(0, width - 4);
    const clipped = truncateToWidth(content, inner, "…");
    const pad = padding(Math.max(0, inner - visibleWidth(clipped)));
    const edge = paintToken(this.#theme, "border", box.vertical);
    return `${edge} ${clipped}${pad} ${edge}`;
  }

  handleInput(data: string): void {
    if (isClose(data) || isToggle(data)) {
      this.#deps.done();
      return;
    }
    if (isUp(data)) {
      if (this.#scroll === 0) return;
      this.#scroll -= 1;
      this.#deps.requestRender();
      return;
    }
    if (isDown(data)) {
      this.#scroll += 1;
      this.#deps.requestRender();
    }
  }
}

interface PanelHandle {
  hide?: () => void;
}

interface CustomOptions {
  overlay?: boolean;
  overlayOptions?: Record<string, unknown>;
  onHandle?: (handle: PanelHandle) => void;
  signal?: AbortSignal;
}

interface PanelHost {
  custom?: (
    factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => unknown,
    options?: CustomOptions,
  ) => Promise<unknown>;
}

export interface OpenTodoPanelDeps {
  state: () => TodoHeaderState | null;
  anim: () => TodoAnim;
  /** Called with true while the panel is on screen so the pump can drive its animations. */
  onOpenChange: (open: boolean) => void;
}

let panelOpen = false;
let dismissPanel: (() => void) | undefined;
let panelHandle: PanelHandle | undefined;
let panelDeps: OpenTodoPanelDeps | undefined;

export function isTodoPanelOpen(): boolean {
  return panelOpen;
}

/**
 * Dismiss the panel if it is on screen. Every teardown path calls this: the host overlay entry, the
 * pump gate, and the "open" flag all have to be released even if the host never resolves `custom()`.
 */
export function closeTodoPanel(): void {
  const dismiss = dismissPanel;
  dismissPanel = undefined;
  const wasOpen = panelOpen;
  panelOpen = false;
  // Release the pump gate first: the host may resolve `custom()` asynchronously, and a tick in
  // between would keep animating a panel that is already gone.
  if (wasOpen) panelDeps?.onOpenChange(false);
  if (dismiss) {
    try {
      dismiss();
      return;
    } catch {
      // Fall through to the handle: a host that failed to close must not keep the overlay mounted.
    }
  }
  try {
    panelHandle?.hide?.();
  } catch {
    // Overlay teardown is best-effort.
  }
  panelHandle = undefined;
}

/**
 * Show the panel. Resolves when the overlay closes; a host without `ui.custom` (or one that refuses
 * the overlay) simply leaves the summary row as the only todo surface.
 */
export async function openTodoPanel(ctx: ExtensionContext, deps: OpenTodoPanelDeps): Promise<void> {
  if (panelOpen) return;
  const ui = (ctx as { ui?: PanelHost }).ui;
  if (!ui || typeof ui.custom !== "function") return;

  panelOpen = true;
  panelDeps = deps;
  deps.onOpenChange(true);
  try {
    await ui.custom(
      (tui: unknown, theme: unknown, _keybindings: unknown, done: (result: unknown) => void) => {
        const host = tui as { requestRender?: () => void } | undefined;
        dismissPanel = (): void => {
          try {
            done(undefined);
          } catch {
            // The host may already have closed the overlay.
          }
        };
        return new TodoPanel(theme, {
          state: deps.state,
          anim: deps.anim,
          requestRender: () => {
            try {
              host?.requestRender?.();
            } catch {
              // Repaint is best-effort.
            }
          },
          done: () => closeTodoPanel(),
        });
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "70%",
          maxHeight: "70%",
          margin: 1,
        },
        onHandle: (handle) => {
          panelHandle = handle;
        },
      },
    );
  } catch {
    // A refused overlay (older host, no alternate screen) is not a failure: the summary still works.
  } finally {
    dismissPanel = undefined;
    panelHandle = undefined;
    panelDeps = undefined;
    if (panelOpen) {
      panelOpen = false;
      deps.onOpenChange(false);
    }
  }
}
