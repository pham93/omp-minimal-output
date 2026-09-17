import { Container } from "@oh-my-pi/pi-tui";
import { getPluginConfig } from "../core/config.ts";
import {
  latestTodoDetailsFromEntries,
  parseTodoPhases,
  parseTodoResult,
  renderDensityTodoHeader,
  todoItemKey,
  todoNeedsPump,
  type TodoHeaderState,
} from "./todos-header.ts";
export { parseTodoResult, parseTodoPhases };

export const TODOS_WIDGET_KEY = "minimal-todos";

export function todoRawText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content as Array<{ type?: unknown; text?: unknown }>) {
    if (item?.type === "text" && typeof item.text === "string") parts.push(item.text);
  }
  return parts.join("\n");
}

export interface TodoWidgetDeps {
  owns: () => boolean;
  kickPump?: () => void;
}

export class TodoWidget {
  #ui: unknown = undefined;
  #headerState: TodoHeaderState | null = null;
  readonly #completingAt = new Map<string, number>();
  readonly #todoSeen = new Map<string, string>();
  #agentRunning = false;
  #todosCollapsed = true;
  #widgetOn = false;
  #headerSig = "";
  #todoSource: (() => { phases: unknown } | undefined) | undefined;
  #sessionVisible = false;
  readonly #deps: TodoWidgetDeps;

  constructor(deps: TodoWidgetDeps) {
    this.#deps = deps;
  }

  get headerState(): TodoHeaderState | null {
    return this.#headerState;
  }

  get completingAt(): ReadonlyMap<string, number> {
    return this.#completingAt;
  }

  get agentRunning(): boolean {
    return this.#agentRunning;
  }

  set agentRunning(value: boolean) {
    this.#agentRunning = value;
  }

  get todosCollapsed(): boolean {
    return this.#todosCollapsed;
  }

  set todosCollapsed(value: boolean) {
    this.#todosCollapsed = value;
  }

  get widgetOn(): boolean {
    return this.#widgetOn;
  }

  get sessionVisible(): boolean {
    return this.#sessionVisible;
  }

  set sessionVisible(value: boolean) {
    this.#sessionVisible = value;
  }

  todoAnim(): { now: number; completingAt: Map<string, number>; running: boolean } {
    return { now: Date.now(), completingAt: this.#completingAt, running: this.#agentRunning };
  }

  needsPump(): boolean {
    return todoNeedsPump(this.#headerState, this.#completingAt, this.#agentRunning);
  }

  bindUi(ctx: unknown): void {
    if (!this.#deps.owns() || typeof ctx !== "object" || ctx === null || !("ui" in ctx)) return;
    const ui = (ctx as { ui?: unknown }).ui;
    if (ui) this.#ui = ui;
  }

  bindSource(ctx: unknown): void {
    if (typeof ctx !== "object" || ctx === null) return;
    const rec = ctx as {
      session?: { getTodoPhases?: () => unknown };
      sessionManager?: { getBranch?: () => unknown; getEntries?: () => unknown };
    };
    const session = rec.session;
    const sm = rec.sessionManager;
    if (!session && !sm) return;
    this.#todoSource = () => {
      try {
        const phases = session?.getTodoPhases?.();
        if (Array.isArray(phases)) return { phases };
      } catch {
        // Session getter is best-effort.
      }
      try {
        const entries = typeof sm?.getBranch === "function" ? sm.getBranch() : sm?.getEntries?.();
        return latestTodoDetailsFromEntries(entries);
      } catch {
        return undefined;
      }
    };
  }

  noteTodoTransitions(next: TodoHeaderState): void {
    const live = new Set<string>();
    for (const item of next.items) {
      const key = todoItemKey(item);
      live.add(key);
      const prev = this.#todoSeen.get(key);
      if (item.status === "done" && prev !== undefined && prev !== "done" && !this.#completingAt.has(key)) {
        this.#completingAt.set(key, Date.now());
      }
      this.#todoSeen.set(key, item.status);
    }
    for (const key of [...this.#todoSeen.keys()]) {
      if (!live.has(key)) {
        this.#todoSeen.delete(key);
        this.#completingAt.delete(key);
      }
    }
  }

  applyState(next: TodoHeaderState): void {
    this.noteTodoTransitions(next);
    const sig = JSON.stringify(next.items);
    const hide = next.items.length === 0;
    if (sig === this.#headerSig && hide === (this.#headerState === null)) {
      this.#deps.kickPump?.();
      return;
    }
    this.#headerSig = sig;
    this.#headerState = hide ? null : next;
    this.installWidget();
    this.refreshWidget();
    this.#deps.kickPump?.();
  }

  peekState(): TodoHeaderState | null {
    if (!this.#sessionVisible) return null;
    try {
      const raw = this.#todoSource?.();
      if (raw) {
        const next = parseTodoPhases(raw);
        if (next) {
          this.noteTodoTransitions(next);
          this.#headerSig = JSON.stringify(next.items);
          this.#headerState = next.items.length > 0 ? next : null;
        }
      }
    } catch {
      // Keep last cache.
    }
    this.#deps.kickPump?.();
    return this.#headerState;
  }

  syncFromSession(ctx?: unknown): void {
    if (ctx) this.bindSource(ctx);
    try {
      if (!this.#sessionVisible) return;
      const raw = this.#todoSource?.();
      const next = raw ? parseTodoPhases(raw) : null;
      if (next) this.applyState(next);
    } catch {
      // History scan is best-effort.
    }
  }

  paintTodosWidget(theme: unknown): Container {
    const c = new Container();
    c.addChild({
      render: (width: number): readonly string[] => {
        if (!this.#deps.owns()) return [];
        let show = true;
        try {
          show = getPluginConfig().todosHeader !== false;
        } catch {
          // Config read is best-effort.
        }
        const state = this.peekState();
        if (!show || !state || state.items.length === 0) return [];
        return renderDensityTodoHeader(theme, width, state, !this.#todosCollapsed, this.todoAnim());
      },
    });
    return c;
  }

  setWidget(show: boolean): void {
    const ui = this.#ui;
    if (!ui || typeof ui !== "object" || typeof (ui as { setWidget?: unknown }).setWidget !== "function") return;
    try {
      if (!show) {
        (ui as { setWidget: (key: string, val: unknown) => void }).setWidget(TODOS_WIDGET_KEY, undefined);
        this.#widgetOn = false;
        return;
      }
      if (!this.#deps.owns()) return;
      if (this.#widgetOn) {
        const requestRender = (ui as { requestRender?: unknown }).requestRender;
        if (typeof requestRender === "function") requestRender.call(ui);
        return;
      }
      (ui as { setWidget: (key: string, fn: unknown, opts: unknown) => void }).setWidget(
        TODOS_WIDGET_KEY,
        (_tui: unknown, theme: unknown) => this.paintTodosWidget(theme),
        { placement: "aboveEditor" },
      );
      this.#widgetOn = true;
    } catch {
      this.#widgetOn = false;
    }
  }

  installWidget(): void {
    let show = true;
    try {
      show = getPluginConfig().todosHeader !== false;
    } catch {
      // Config reload is best-effort.
    }
    this.setWidget(show && !!this.#headerState && this.#headerState.items.length > 0);
  }

  refreshWidget(): void {
    if (!this.#widgetOn) this.installWidget();
    else this.setWidget(true);
  }

  resetSessionState(): void {
    this.#todoSource = undefined;
    this.#todosCollapsed = true;
    this.#sessionVisible = false;
    this.#headerSig = "";
    this.#headerState = null;
    this.#todoSeen.clear();
    this.#completingAt.clear();
    this.setWidget(false);
  }

  dispose(): void {
    this.setWidget(false);
    this.#ui = undefined;
    this.resetSessionState();
  }
}
