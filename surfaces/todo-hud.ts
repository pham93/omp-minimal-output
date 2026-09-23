// Hide the native TODO HUD and keep the transcript todo card on the same
// live snapshot the plugin widget uses. No official hide setting exists
// (only compact-terminal collapse); identity is the HUD Text banner
// (`TODO` + tree) and ToolExecutionComponent's updateResult/seal pair.

import { getContainerInterceptor } from "../core/container-interceptor.ts";

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

// Native HUD is a Text whose head is a bold "TODO": 18.2.9 appends the tree-spine rows to that same
// Text, older hosts used a separate banner line ("", "TODO"). Transcript cards title "Todo" in mixed
// case and are Containers, so a Text headed by exactly `TODO` (or `TODO …`) is the HUD, not a card.
export function isTodoHudBanner(child: unknown): boolean {
  if (typeof child !== "object" || child === null) return false;
  const text = getTextOf(child);
  if (!text) return false;
  const lines = text
    .replace(ANSI_RE, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const head = lines[0] ?? "";
  return head === "TODO" || head.startsWith("TODO ");
}

/** 18.2.9 renamed the HUD container, so identity also comes from its structure. */
export function isTodoHudContainer(value: unknown): boolean {
  return ctorNameOf(value) === "TodoHudContainer";
}

/** The HUD container holds only text: the banner plus its tree rows. A status container holds widgets. */
function holdsOnlyText(children: readonly unknown[]): boolean {
  return (
    children.length > 0 &&
    children.every(
      (child) =>
        typeof child === "object" &&
        child !== null &&
        typeof (child as { getText?: unknown }).getText === "function",
    )
  );
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
  hideCard?: () => boolean;
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
    if (deps.active?.() === false || !isTodo) return origRender(width);
    try {
      if (deps.hideCard?.()) return [];
    } catch {
      // Native transcript card remains the safe fallback.
    }
    if (!deps.skinCard()) return origRender(width);
    try {
      return deps.paintCard(width, expanded);
    } catch {
      return origRender(width);
    }
  };
  skinned.add(child);
}

export function installTodoChrome(ContainerCtor: unknown, deps: TodoChromeDeps): () => void {
  if (installed) return () => {};
  const interceptor = getContainerInterceptor(ContainerCtor);
  if (!interceptor.isAvailable) return () => {};
  const unregister = interceptor.registerHook((container, args) => {
    if (deps.active?.() === false) return;
    let hideHud = false;
    try {
      hideHud = deps.hideHud();
    } catch {
      hideHud = false;
    }
    // Identity by class name for hosts that still expose it, and by structure for 18.2.9+ where the
    // class was renamed: a container of nothing but text that carries the HUD banner is the HUD.
    const holdsHudBanner = args.some((arg) => isTodoHudBanner(arg));
    const dropHudChildren =
      hideHud && (isTodoHudContainer(container) || (holdsHudBanner && holdsOnlyText(args)));
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
            }
          } else if (!skinned.has(arg) && isTodoCardHost(arg)) {
            skinTodoCard(arg, deps);
          }
        }
      } catch {
        // One bad child must not break the container.
      }
    }
    if (dropHudChildren) return { children: [] };
  });
  if (!unregister) return () => {};
  depsRef = deps;
  installed = true;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    depsRef = undefined;
    unregister();
    installed = false;
    skinned = new WeakSet<object>();
  };
}
