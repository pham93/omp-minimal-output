import { advanceSpinFrame } from "./theme.ts";
import { maybeReloadConfig } from "./config.ts";

export const ANIMATION_FAST_MS = 120;
export const ANIMATION_SLOW_MS = 1000;

export interface AnimationPumpDeps {
  owns: () => boolean;
  isIdle?: () => boolean;
  hasFastAnimation?: () => boolean;
  onTick?: () => void;
}

export function pulseTimers(
  ctx: unknown,
): { setInterval: (fn: () => void, ms: number) => unknown; clearTimer: (h: unknown) => void } | undefined {
  if (typeof ctx !== "object" || ctx === null) return undefined;
  const c = ctx as Record<string, unknown>;
  const set = typeof c["setInterval"] === "function" ? (c["setInterval"] as typeof setInterval) : undefined;
  const clr =
    typeof c["clearInterval"] === "function"
      ? (c["clearInterval"] as typeof clearInterval)
      : typeof c["clearTimeout"] === "function"
        ? (c["clearTimeout"] as typeof clearTimeout)
        : undefined;
  if (set && clr) return { setInterval: set.bind(ctx), clearTimer: clr.bind(ctx) };
  return undefined;
}

export class AnimationPump {
  #timer: unknown = undefined;
  #ui: unknown = undefined;
  #ctx: unknown = undefined;
  #currentIntervalMs: number = ANIMATION_FAST_MS;
  readonly #deps: AnimationPumpDeps;

  constructor(deps: AnimationPumpDeps) {
    this.#deps = deps;
  }

  bindUi(ui: unknown): void {
    if (typeof ui === "object" && ui !== null && "requestRender" in ui) {
      this.#ui = ui;
    }
  }

  getUi(): unknown {
    return this.#ui;
  }

  getCtx(): unknown {
    return this.#ctx;
  }

  hasTimer(): boolean {
    return this.#timer !== undefined;
  }

  currentIntervalMs(): number {
    return this.#currentIntervalMs;
  }

  desiredIntervalMs(): number {
    return this.#deps.hasFastAnimation?.() !== false ? ANIMATION_FAST_MS : ANIMATION_SLOW_MS;
  }

  clearTimer(ctx?: unknown): void {
    const target = ctx ?? this.#ctx;
    const timers = pulseTimers(target);
    if (this.#timer !== undefined) {
      try {
        if (timers) timers.clearTimer(this.#timer);
        else clearInterval(this.#timer as number | NodeJS.Timeout);
      } catch {
        // Clearing is best-effort.
      }
    }
    this.#timer = undefined;
  }

  ensureTimer(ctx: unknown): void {
    if (!this.#deps.owns()) return;
    this.#ctx = ctx;
    if (typeof ctx === "object" && ctx !== null && "ui" in ctx) {
      this.bindUi((ctx as { ui?: unknown }).ui);
    }
    if (this.#deps.isIdle?.()) {
      this.clearTimer(ctx);
      return;
    }

    const desired = this.desiredIntervalMs();
    if (this.#timer !== undefined) {
      if (this.#currentIntervalMs === desired) return;
      this.clearTimer(ctx);
    }

    this.#startTimer(ctx, desired);
  }

  #startTimer(ctx: unknown, intervalMs: number): void {
    this.#currentIntervalMs = intervalMs;
    const tick = (): void => {
      if (!this.#deps.owns()) {
        this.clearTimer(ctx);
        return;
      }
      if (this.#ctx !== undefined && this.#deps.isIdle?.()) {
        this.clearTimer(this.#ctx);
        return;
      }

      const desired = this.desiredIntervalMs();
      if (desired !== this.#currentIntervalMs) {
        this.clearTimer(this.#ctx);
        this.#startTimer(this.#ctx, desired);
      }

      advanceSpinFrame();
      maybeReloadConfig();
      this.#deps.onTick?.();

      const pump = this.#ui;
      if (typeof pump === "object" && pump !== null && "requestRender" in pump) {
        const paint = (pump as { requestRender?: unknown }).requestRender;
        if (typeof paint === "function") {
          try {
            (paint as () => void)();
          } catch {
            // Repaint is best-effort; next tick retries.
          }
        }
      }
    };

    const timers = pulseTimers(ctx);
    try {
      if (timers) {
        this.#timer = timers.setInterval(tick, intervalMs);
        return;
      }
      this.#timer = setInterval(tick, intervalMs);
    } catch {
      this.#timer = undefined;
    }
  }

  stopIfIdle(ctx: unknown): void {
    if (this.#deps.isIdle?.() && this.#timer !== undefined) {
      this.clearTimer(ctx);
    } else if (this.#timer !== undefined) {
      const desired = this.desiredIntervalMs();
      if (desired !== this.#currentIntervalMs) {
        this.clearTimer(ctx);
        this.#startTimer(ctx, desired);
      }
    }
  }
  requestRepaint(): void {
    if (!this.#deps.owns()) return;
    try {
      const pump = this.#ui;
      if (typeof pump === "object" && pump !== null && "requestRender" in pump) {
        const paint = (pump as { requestRender?: unknown }).requestRender;
        if (typeof paint === "function") (paint as () => void)();
      }
    } catch {
      // Repaint is best-effort.
    }
  }

  dispose(): void {
    this.clearTimer();
    this.#ui = undefined;
    this.#ctx = undefined;
  }
}
