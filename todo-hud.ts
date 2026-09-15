// Hide the native TODO HUD and keep the transcript todo card on the same
// live snapshot the plugin widget uses. No official hide setting exists
// (only compact-terminal collapse); identity is the HUD Text banner
// (`TODO` + tree) and ToolExecutionComponent's updateResult/seal pair.

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function ctorNameOf(value: unknown): string {
  try {
    const c = value as { constructor?: { name?: unknown } };
    return typeof c.constructor?.name === "string" ? c.constructor.name : "";
  } catch {
    return "";
  }
}

function isFn(c: Record<string, unknown>, key: string): boolean {
  return typeof c[key] === "function";
}

function getTextOf(child: unknown): string {
  if (typeof child !== "object" || child === null) return "";
  const getText = (child as { getText?: unknown }).getText;
  if (typeof getText !== "function") return "";
  try {
    const t = getText.call(child);
    return typeof t === "string" ? t : "";
  } catch {
    return "";
  }
}

// Native HUD is one Text: blank line, bold "TODO", then tree-spine rows.
// Transcript cards title "Todo" via renderStatusLine and are Containers,
// so getText-only matching does not skin those.
export function isTodoHudBanner(child: unknown): boolean {
  if (typeof child !== "object" || child === null) return false;
  const text = getTextOf(child);
  if (!text) return false;
  const lines = text
    .replace(ANSI_RE, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[0] === "TODO" && lines.length >= 2;
}

export function isTodoHudContainer(value: unknown): boolean {
  return ctorNameOf(value) === "TodoHudContainer";
}

// ToolExecutionComponent: updateResult + seal + canBeDisplacedBy.
// Read-group has removeEntry; alerts have addRules.
export function isTodoCardHost(child: unknown): boolean {
  if (typeof child !== "object" || child === null) return false;
  const c = child as Record<string, unknown>;
  if (!isFn(c, "render") || !isFn(c, "updateResult") || !isFn(c, "seal")) return false;
  if (!isFn(c, "canBeDisplacedBy") || !isFn(c, "isDisplaceableBlock") || !isFn(c, "setExpanded")) return false;
  if (isFn(c, "removeEntry") || isFn(c, "addRules") || isFn(c, "attachUsage")) return false;
  return true;
}

function detailsHavePhases(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const details = (result as { details?: unknown }).details;
  return typeof details === "object" && details !== null && Array.isArray((details as { phases?: unknown }).phases);
}

export interface TodoChromeDeps {
  hideHud: () => boolean;
  skinCard: () => boolean;
  paintCard: (width: number, expanded: boolean) => readonly string[];
  onHud?: () => void;
  onTodoDetails?: (details: unknown) => void;
  active?: () => boolean;
}

let skinned = new WeakSet<object>();
let installed = false;

function skinEmpty(child: object): void {
  const c = child as { render?: (width: number) => readonly string[] };
  if (typeof c.render !== "function") return;
  const orig = c.render.bind(child);
  c.render = function (width: number): readonly string[] {
    try {
      // Re-check at paint so /minimal-off and todoHud:true restore the HUD.
      if (depsRef?.active?.() === false || !depsRef?.hideHud()) return orig(width);
    } catch {
      return orig(width);
    }
    return [];
  };
  skinned.add(child);
}

let depsRef: TodoChromeDeps | undefined;

function skinTodoCard(child: object, deps: TodoChromeDeps): void {
  const c = child as Record<string, unknown> & {
    render: (width: number) => readonly string[];
    updateResult: (...args: unknown[]) => unknown;
    setExpanded: (expanded: boolean) => unknown;
  };
  const origRender = c.render.bind(child);
  const origUpdate = c.updateResult.bind(child);
  const origSetExpanded = c.setExpanded.bind(child);
  let isTodo = false;
  let expanded = false;
  c.updateResult = function (result: unknown, ...rest: unknown[]) {
    try {
      if (deps.active?.() !== false && detailsHavePhases(result)) {
        isTodo = true;
        const details = (result as { details: unknown }).details;
        deps.onTodoDetails?.(details);
      }
    } catch {
      // Flag is best-effort; native update still runs.
    }
    return origUpdate(result, ...rest);
  };
  c.setExpanded = function (next: boolean) {
    expanded = next === true;
    return origSetExpanded(next);
  };
  c.render = function (width: number): readonly string[] {
    if (deps.active?.() === false || !isTodo || !deps.skinCard()) return origRender(width);
    try {
      return deps.paintCard(width, expanded);
    } catch {
      return origRender(width);
    }
  };
  skinned.add(child);
}

export function installTodoChrome(
  ContainerCtor: { prototype: { addChild: (...args: unknown[]) => unknown } },
  deps: TodoChromeDeps,
): () => void {
  depsRef = deps;
  if (installed) return () => {};
  const prototype = ContainerCtor?.prototype;
  const addChild = prototype?.addChild;
  if (typeof addChild !== "function") return () => {};
  const patchedAddChild = function (this: unknown, ...args: unknown[]): unknown {
    if (deps.active?.() === false) return addChild.apply(this, args);
    let hideHud = false;
    try {
      hideHud = deps.hideHud();
    } catch {
      hideHud = false;
    }
    const dropHudChildren = hideHud && isTodoHudContainer(this);
    const kept: unknown[] = [];
    for (const arg of args) {
      try {
        if (arg && typeof arg === "object") {
          if (isTodoHudBanner(arg)) {
            try {
              deps.onHud?.();
            } catch {
              // Sync is best-effort; widget still follows tool_result.
            }
            if (hideHud) {
              if (!skinned.has(arg)) skinEmpty(arg);
              if (dropHudChildren) continue;
            }
          } else if (!skinned.has(arg) && isTodoCardHost(arg)) {
            skinTodoCard(arg, deps);
          }
        }
      } catch {
        // One bad child must not break the container.
      }
      kept.push(arg);
    }
    return addChild.apply(this, dropHudChildren ? [] : kept.length === args.length ? args : kept);
  };
  try {
    prototype.addChild = patchedAddChild;
  } catch {
    return () => {};
  }
  installed = true;
  return () => {
    depsRef = undefined;
    try {
      if (prototype.addChild === patchedAddChild) prototype.addChild = addChild;
    } catch {
      // Another extension may own the current hook; never overwrite it.
    }
    installed = false;
    skinned = new WeakSet<object>();
  };
}
