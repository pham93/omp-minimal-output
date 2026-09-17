import { advanceSpinFrame } from "./theme.ts";
import { maybeReloadConfig } from "./config.ts";

export interface AnimationPumpDeps {
  owns: () => boolean;
  isIdle?: () => boolean;
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
    if (this.#timer !== undefined) return;

    const tick = (): void => {
      if (!this.#deps.owns()) {
        this.clearTimer(ctx);
        return;
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

      if (this.#ctx !== undefined && this.#deps.isIdle?.()) {
        this.clearTimer(this.#ctx);
      }
    };

    const timers = pulseTimers(ctx);
    try {
      if (timers) {
        this.#timer = timers.setInterval(tick, 120);
        return;
      }
      this.#timer = setInterval(tick, 120);
    } catch {
      this.#timer = undefined;
    }
  }

  stopIfIdle(ctx: unknown): void {
    if (this.#deps.isIdle?.() && this.#timer !== undefined) {
      this.clearTimer(ctx);
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
