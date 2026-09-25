import { Container, visibleWidth } from "@oh-my-pi/pi-tui";
import { TextScroller } from "./scrolling-text.ts";
import { getPluginConfig } from "../core/config.ts";
import { installStatusRowGuard, restoreStatusRowGuard } from "./composer-status.ts";
import { definedChildren } from "../core/container-interceptor.ts";
import { wrapLatestLines } from "../core/text.ts";
import { LINE_WIDTH_RATIO, formatRowLine, elapsedSuffix } from "../core/theme.ts";
import { THOUGHT_RAIL_PREFIX, thoughtRailLine } from "../cards/card-primitives.ts";

export const THOUGHT_PREVIEW_LINES = 3;
export const THOUGHT_WIDGET_KEY = "minimal-thinking";

export interface ThinkingWidgetDeps {
  owns: () => boolean;
  activityRunId: () => string | null;
  /** Whether the host hides thinking blocks. The widget then renders no thought text. */
  onSyncThought?: (
    fp: string,
    thought: { body: string; live: boolean; right: string; startedAt: number; detail?: string },
  ) => void;
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

export function thinkingRailLines(theme: unknown, width: number, text: string): string[] {
  if (!text.trim()) return [];
  const innerW = Math.max(
    8,
    Math.floor((Math.floor(width) || 0) * LINE_WIDTH_RATIO) - visibleWidth(THOUGHT_RAIL_PREFIX),
  );
  return wrapLatestLines(text, innerW, THOUGHT_PREVIEW_LINES).map((preview) => thoughtRailLine(theme, width, preview));
}

interface ComposerLike {
  ui?: unknown;
  setRuntimeChildren?: (children: readonly unknown[]) => void;
}

interface ComposerRuntimeHost {
  /** Bound native `Composer.setRuntimeChildren` captured before the wrapper is installed. */
  applyRuntimeChildren: (children: readonly unknown[]) => void;
  composer: ComposerLike;
  statusContainer: unknown;
  hookWidgetContainerAbove: unknown;
  attachmentChipsContainer: unknown;
}

/**
 * Restoration state for the runtime-children wrapper, keyed per composer instance. Registered
 * rather than module-local so a hot-reloaded generation still finds the wrapper its predecessor
 * installed — module-local symbols would leave the composer patched after the old module unloads.
 */
const RUNTIME_REORDER_STATE = Symbol.for("@local/omp-minimal-output/composer-runtime-reorder");

interface RuntimeReorderState {
  wrapper: (children: readonly unknown[]) => void;
  native: (children: readonly unknown[]) => void;
}

/**
 * The composer lays out its bottom chrome from a private runtime-children array, not from
 * `TUI.children`. Reach that composer through the status HUD container, which owns the mode it
 * renders for and whose `mode.composer` is the single InteractiveMode composer.
 */
function runtimeHostFor(tui: unknown): ComposerRuntimeHost | undefined {
  if (!tui || typeof tui !== "object") return undefined;
  const children = (tui as { children?: unknown }).children;
  if (!Array.isArray(children)) return undefined;
  for (const child of children) {
    if (!child || typeof child !== "object") continue;
    const mode = (child as { mode?: unknown }).mode;
    if (!mode || typeof mode !== "object") continue;
    const candidate = mode as {
      statusContainer?: unknown;
      hookWidgetContainerAbove?: unknown;
      attachmentChipsContainer?: unknown;
      composer?: ComposerLike;
    };
    if (candidate.statusContainer !== child) continue;
    const composer = candidate.composer;
    if (!composer || typeof composer !== "object") continue;
    if (composer.ui !== tui) continue;
    const state = (composer as Record<symbol, unknown>)[RUNTIME_REORDER_STATE] as RuntimeReorderState | undefined;
    const setRuntimeChildren = state ? state.native : composer.setRuntimeChildren;
    if (typeof setRuntimeChildren !== "function") continue;
    if (!candidate.hookWidgetContainerAbove) continue;
    return {
      applyRuntimeChildren: setRuntimeChildren.bind(composer),
      composer,
      statusContainer: candidate.statusContainer,
      hookWidgetContainerAbove: candidate.hookWidgetContainerAbove,
      attachmentChipsContainer: candidate.attachmentChipsContainer,
    };
  }
  return undefined;
}

interface RecoveredRuntimeChildren {
  children: readonly unknown[];
  /** True when the composer's stored list held a non-component that was dropped. */
  pruned: boolean;
}

/** The composer mounts its status wrapper as the last child of the TUI (`setComponent` host). */
function statusWrapperFor(tui: unknown): unknown {
  const children = (tui as { children?: unknown } | undefined)?.children;
  if (!Array.isArray(children) || children.length === 0) return undefined;
  const last = children[children.length - 1] as { setComponent?: unknown; render?: unknown } | undefined;
  if (!last || typeof last.setComponent !== "function" || typeof last.render !== "function") return undefined;
  return last;
}

/** Composer runtime children recovered from `[header, ...runtimeChildren, statusHost]`. */
function currentRuntimeChildren(tui: unknown, host: ComposerRuntimeHost): RecoveredRuntimeChildren | undefined {
  const children = (tui as { children?: unknown }).children;
  if (!Array.isArray(children) || children.length < 4) return undefined;
  const last = children[children.length - 1] as { setComponent?: unknown } | undefined;
  if (!last || typeof last.setComponent !== "function") return undefined;
  const stored = children.slice(1, children.length - 1);
  if (!stored.includes(host.statusContainer)) return undefined;
  if (!stored.includes(host.hookWidgetContainerAbove)) return undefined;
  // The composer renders every entry of this list as a component, so a slot the
  // host never constructed (an undefined chrome container) would crash the frame
  // loop on the next paint.
  const runtime = definedChildren(stored);
  return { children: runtime, pruned: runtime !== stored };
}

/**
 * Repair a chrome container whose stored child list holds a non-component. The
 * composer renders these containers itself and dereferences every child
 * (`Composer.renderFrame` → `rowTargetCandidates`), so a slot left undefined by
 * a host or widget factory before our seam existed crashes the frame loop. The
 * array is replaced, never spliced: an in-flight `Container.render` keeps the
 * list it captured, and the container is invalidated on a microtask.
 */
function repairContainerChildren(container: unknown): void {
  if (!container || typeof container !== "object") return;
  const target = container as { children?: unknown; invalidate?: () => void };
  const children = target.children;
  if (!Array.isArray(children)) return;
  const kept = definedChildren(children);
  if (kept === children) return;
  target.children = kept;
  queueMicrotask(() => {
    try {
      target.invalidate?.();
    } catch {
      // Cache invalidation is best-effort; the next render recomputes anyway.
    }
  });
}

/**
 * Keep the composer's stored child list component-only, and keep the hook
 * container before the status row. Every host handoff goes through the wrapper,
 * and a list the host already stored is repaired by re-mounting it here.
 */
function syncRuntimeChildren(tui: unknown, host: ComposerRuntimeHost): void {
  if (!(host.composer as Record<symbol, unknown>)[RUNTIME_REORDER_STATE]) {
    const native = host.applyRuntimeChildren;
    const wrapper = (children: readonly unknown[]): void =>
      native(moveBefore(definedChildren(children), host.hookWidgetContainerAbove, host.statusContainer));
    host.composer.setRuntimeChildren = wrapper;
    (host.composer as Record<symbol, unknown>)[RUNTIME_REORDER_STATE] = { wrapper, native } as RuntimeReorderState;
  }
  installStatusRowGuard(statusWrapperFor(tui));
  const runtime = currentRuntimeChildren(tui, host);
  if (!runtime) return;
  const fixed = moveBefore(runtime.children, host.hookWidgetContainerAbove, host.statusContainer);
  if (fixed !== runtime.children || runtime.pruned) host.applyRuntimeChildren(fixed);
  for (const root of fixed) repairContainerChildren(root);
}

/**
 * Re-assert the thinking-above-todos order. The host rebuilds its hook container after every
 * `setWidget`, i.e. after our factories ran, so both widget render callbacks call this each frame;
 * the lookup is a couple of indexOf scans, and it no-ops once the order is right.
 */
export function ensureThinkingBeforeTodos(tui: unknown): void {
  const host = runtimeHostFor(tui);
  if (!host) return;
  orderHookWidgets(host);
  syncRuntimeChildren(tui, host);
}

/**
 * Keep the `aboveEditor` widget container before the status row, with the thinking block above the
 * todos widget, so the composer stack reads thinking → todos → working status → editor.
 */
export function ensureThinkingAboveStatus(tui: unknown): void {
  const host = runtimeHostFor(tui);
  if (!host) return;
  orderHookWidgets(host);
  syncRuntimeChildren(tui, host);
}

/** Copy with `target` immediately before `anchor`; returns the input array when already there. */
function moveBefore(children: readonly unknown[], target: unknown, anchor: unknown): readonly unknown[] {
  const targetIdx = children.indexOf(target);
  const anchorIdx = children.indexOf(anchor);
  if (targetIdx < 0 || anchorIdx < 0 || targetIdx === anchorIdx - 1) return children;
  const next = children.slice();
  const [moved] = next.splice(targetIdx, 1);
  next.splice(anchorIdx > targetIdx ? anchorIdx - 1 : anchorIdx, 0, moved);
  return next;
}

/** Copy with `target` immediately after `anchor`; returns the input array when already there. */
function moveAfter(children: readonly unknown[], target: unknown, anchor: unknown): readonly unknown[] {
  const targetIdx = children.indexOf(target);
  const anchorIdx = children.indexOf(anchor);
  if (targetIdx < 0 || anchorIdx < 0 || targetIdx === anchorIdx + 1) return children;
  const next = children.slice();
  const [moved] = next.splice(targetIdx, 1);
  next.splice(anchorIdx > targetIdx ? anchorIdx : anchorIdx + 1, 0, moved);
  return next;
}

/** Flags the composer ordering helper uses to find the plugin's two hook widgets. */
export const THINKING_WIDGET_FLAG = "isThinkingWidget";
export const TODOS_WIDGET_FLAG = "isTodosWidget";

/**
 * Keep the live thinking block above the todos widget inside the host's shared hook container. Both
 * widgets are `aboveEditor`, and the host re-adds them in registration order after every rebuild, so
 * the order is re-asserted whenever either side (re)mounts.
 */
function orderHookWidgets(host: ComposerRuntimeHost): void {
  const container = host.hookWidgetContainerAbove as { children?: unknown } | undefined;
  const children = container?.children;
  if (!Array.isArray(children)) return;
  const flagged = (child: unknown, flag: string): boolean =>
    typeof child === "object" && child !== null && (child as Record<string, unknown>)[flag] === true;
  const thinkingIdx = children.findIndex((child) => flagged(child, THINKING_WIDGET_FLAG));
  const todosIdx = children.findIndex((child) => flagged(child, TODOS_WIDGET_FLAG));
  if (thinkingIdx < 0 || todosIdx < 0 || thinkingIdx < todosIdx) return;
  // Reorder through a fresh array: the host's `Container.render` captures `children` and its length
  // before its loop, so splicing in place shifts the indices it is about to read and renders one
  // widget twice. Replacing the array leaves an in-flight frame untouched.
  const next = children.slice();
  const [thinking] = next.splice(thinkingIdx, 1);
  next.splice(todosIdx, 0, thinking);
  container.children = next;
  // Invalidate on a microtask, never inline: the host's `Container.render` decides whether its cached
  // frame is still valid *before* it iterates children, then returns that cache — so clearing it from
  // inside a child's render hands this frame back as `undefined`. A microtask lands after the
  // synchronous render pass and still keeps the positional cache honest for the next one.
  queueMicrotask(() => {
    try {
      container.invalidate?.();
    } catch {
      // Cache invalidation is best-effort; the next render recomputes anyway.
    }
  });
}

/** Restore the native order (hook container after the status/chip band) and drop the wrapper. */
export function restoreStatusOrder(tui: unknown): void {
  restoreStatusRowGuard(statusWrapperFor(tui));
  const host = runtimeHostFor(tui);
  if (!host) return;
  const state = (host.composer as Record<symbol, unknown>)[RUNTIME_REORDER_STATE] as RuntimeReorderState | undefined;
  if (state) {
    if (host.composer.setRuntimeChildren === state.wrapper) delete host.composer.setRuntimeChildren;
    delete (host.composer as Record<symbol, unknown>)[RUNTIME_REORDER_STATE];
  }
  const runtime = currentRuntimeChildren(tui, host);
  if (!runtime) return;
  const anchor = host.attachmentChipsContainer ?? host.statusContainer;
  const restored = moveAfter(runtime.children, host.hookWidgetContainerAbove, anchor);
  if (restored !== runtime.children || runtime.pruned) host.applyRuntimeChildren(restored);
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
    if (!tui || typeof tui !== "object") return;
    this.#tui = tui;
    ensureThinkingAboveStatus(tui);
  }

  isAnimating(): boolean {
    return this.#scroller.isAnimating();
  }
  thoughtFadeKey(): string {
    const runId = this.#deps.activityRunId();
    return runId ? `thought:${runId}` : "thought:live";
  }

  animatedThinkingRailLines(theme: unknown, width: number, text: string): string[] {
    const innerW = Math.max(
      8,
      Math.floor((Math.floor(width) || 0) * LINE_WIDTH_RATIO) - visibleWidth(THOUGHT_RAIL_PREFIX),
    );
    this.#scroller.update(text, innerW);
    const cfgOp = getPluginConfig().opacity;
    const lines: string[] = [];

    for (const item of this.#scroller.render()) {
      // The stagger rides on a card detail row, so the animated block keeps the card rail, `dim`
      // token and configured rest opacity instead of painting its own brighter rail.
      const effectiveOp = item.isPlaceholder ? Math.max(0.05, cfgOp - 0.25) * 0.35 : item.opacity * cfgOp;
      lines.push(thoughtRailLine(theme, width, item.isPlaceholder ? "" : item.text, effectiveOp));
    }

    return lines;
  }

  paintThinkingVisual(tuiOrTheme: unknown, theme?: unknown): Container {
    const effectiveTheme = theme !== undefined ? theme : tuiOrTheme;
    if (theme !== undefined) this.setTui(tuiOrTheme);
    const c = new Container();
    (c as Record<string, unknown>)[THINKING_WIDGET_FLAG] = true;
    c.addChild({
      render: (width: number): readonly string[] => {
        if (!this.#deps.owns()) return [];
        if (this.#tui) ensureThinkingBeforeTodos(this.#tui);
        if (!this.#live) {
          return ["", "", "", ""];
        }
        const lines: string[] = [
          formatRowLine(effectiveTheme, width, {
            body: "Thinking...",
            live: true,
            fadeKey: this.thoughtFadeKey(),
            right: this.#startedAt > 0 ? elapsedSuffix(this.#startedAt) : "",
            header: true,
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
    if (!ui) return;
    // A new UI host means the previous widget registration is gone with it.
    if (this.#ui !== ui) this.#widgetOn = false;
    this.#ui = ui;
    if (typeof ui === "object" && "children" in (ui as Record<string, unknown>)) {
      this.setTui(ui);
    }
    this.installWidget();
  }

  installWidget(): void {
    if (!this.#deps.owns()) return;
    const ui = this.#ui;
    if (!ui || typeof ui !== "object" || typeof (ui as { setWidget?: unknown }).setWidget !== "function") return;
    try {
      if (this.#widgetOn) {
        if (this.#tui) ensureThinkingAboveStatus(this.#tui);
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

  /**
   * Drop the "already registered" belief without talking to the host. OMP's `clearHookWidgets()`
   * (session change / session switch) disposes and forgets every extension widget, so the next
   * `installWidget()` must register again instead of trusting a stale flag.
   */
  resetRegistration(): void {
    this.#widgetOn = false;
  }

  setWidget(show: boolean): void {
    const ui = this.#ui;
    if (!ui || typeof ui !== "object" || typeof (ui as { setWidget?: unknown }).setWidget !== "function") return;
    try {
      if (!show) {
        (ui as { setWidget: (key: string, value: unknown) => void }).setWidget(THOUGHT_WIDGET_KEY, undefined);
        // Unmounting must hand the composer back its native order; a stray blank gap
        // above the status row would otherwise outlive /minimal-off.
        if (this.#tui) restoreStatusOrder(this.#tui);
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
    this.#tui = undefined;
    this.#ui = undefined;
    this.reset();
  }
}
