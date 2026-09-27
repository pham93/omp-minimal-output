import {
  latestTodoDetailsFromEntries,
  parseTodoPhases,
  parseTodoResult,
  todoItemKey,
  todoNeedsPump,
  todoHasActiveTransition,
  type TodoHeaderState,
} from "./todos-header.ts";
export { parseTodoResult, parseTodoPhases };

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

/**
 * Todo session state: the parsed snapshot, completion transitions, and the panel's pump gate. The
 * summary itself is painted by the status-row skin (`todo-status-row.ts`) and the full list by the
 * panel, so this class owns no widget of its own.
 */
export class TodoWidget {
  #headerState: TodoHeaderState | null = null;
  readonly #completingAt = new Map<string, number>();
  readonly #todoSeen = new Map<string, string>();
  #agentRunning = false;
  #panelOpen = false;
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

  /** Whether the full-list panel is on screen. The panel is the only animated todo surface. */
  get panelOpen(): boolean {
    return this.#panelOpen;
  }

  set panelOpen(value: boolean) {
    this.#panelOpen = value;
  }

  /** Whether the inline segment lists todos (as opposed to reporting an empty list). */
  showsTodos(): boolean {
    return this.#headerState !== null && this.#headerState.items.length > 0;
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
    return this.#panelOpen && todoNeedsPump(this.#headerState, this.#completingAt, this.#agentRunning);
  }

  hasFastAnimation(): boolean {
    return this.#panelOpen && todoHasActiveTransition(this.#completingAt);
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

  resetSessionState(): void {
    this.#todoSource = undefined;
    this.#panelOpen = false;
    this.#sessionVisible = false;
    this.#headerSig = "";
    this.#headerState = null;
    this.#todoSeen.clear();
    this.#completingAt.clear();
  }

  dispose(): void {
    this.resetSessionState();
  }
}
