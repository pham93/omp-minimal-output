// Display-only skin for native ToolExecutionComponent instances. It never registers or executes tools.

import { compactCardText } from "./card-primitives.ts";
import { isDebugCardData, renderDebugCardLines } from "./debug-card.ts";
import { isHubCardData, renderHubCardLines } from "./hub-card.ts";
import { isLspCardData, renderLspCardLines } from "./lsp-card.ts";
import {
  fingerprintForToolCall,
  identityForToolCall,
  toolFingerprint,
  toolFpBase,
} from "./results.ts";
import { isAstGrepCardData, renderSearchCardLines, SEARCH_CARD_KIND } from "./search-card.ts";
import { isTaskCardData, renderTaskCardLines } from "./task-card.ts";

export const NATIVE_TOOL_CARD_KIND = {
  astGrep: "ast_grep",
  debug: "debug",
  hub: "hub",
  lsp: "lsp",
  task: "task",
} as const;

export type NativeToolCardKind =
  (typeof NATIVE_TOOL_CARD_KIND)[keyof typeof NATIVE_TOOL_CARD_KIND];

interface CapturedToolExecutionState {
  args: unknown;
  result: unknown;
  partial: boolean;
  expanded: boolean;
  toolCallId: string;
  sealed: boolean;
  kind?: NativeToolCardKind;
}

export interface NativeToolCardSkinDeps {
  enabled: (kind: NativeToolCardKind) => boolean;
  theme: () => unknown;
  pump?: () => void;
}

function methodOf(
  record: Record<string, unknown>,
  name: string,
): ((...args: unknown[]) => unknown) | undefined {
  const value = record[name];
  return typeof value === "function"
    ? (value as (...args: unknown[]) => unknown)
    : undefined;
}

/** Strictly distinguish a native ToolExecutionComponent from read-group and unrelated containers. */
export function isToolExecutionComponentLike(child: unknown): child is object {
  if (typeof child !== "object" || child === null) return false;
  const component = child as Record<string, unknown>;
  return (
    methodOf(component, "render") !== undefined &&
    methodOf(component, "updateArgs") !== undefined &&
    methodOf(component, "setExecutionStarted") !== undefined &&
    methodOf(component, "updateResult") !== undefined &&
    methodOf(component, "setExpanded") !== undefined &&
    methodOf(component, "seal") !== undefined &&
    methodOf(component, "removeEntry") === undefined &&
    methodOf(component, "attachUsage") === undefined
  );
}

function nativeRendererMatches(native: unknown, labels: readonly string[]): boolean {
  if (!Array.isArray(native)) return false;
  const first = native
    .slice(0, 3)
    .filter((line): line is string => typeof line === "string")
    .map((line) => compactCardText(line, 500))
    .find(Boolean);
  if (!first) return false;
  return labels.some((label) =>
    new RegExp(`^[^A-Za-z0-9]{0,24}${label}(?:\\b|:)`, "iu").test(first),
  );
}

interface SelectedNativeCard {
  kind: NativeToolCardKind;
  args: unknown;
}

function selectionForIdentity(
  toolName: string,
  args: unknown,
  result: unknown,
): SelectedNativeCard | undefined {
  switch (toolName) {
    case NATIVE_TOOL_CARD_KIND.astGrep:
      return isAstGrepCardData(args)
        ? { kind: NATIVE_TOOL_CARD_KIND.astGrep, args }
        : undefined;
    case NATIVE_TOOL_CARD_KIND.debug:
      return isDebugCardData(args, result)
        ? { kind: NATIVE_TOOL_CARD_KIND.debug, args }
        : undefined;
    case NATIVE_TOOL_CARD_KIND.hub:
      return isHubCardData(args, result)
        ? { kind: NATIVE_TOOL_CARD_KIND.hub, args }
        : undefined;
    case NATIVE_TOOL_CARD_KIND.lsp:
      return isLspCardData(args, result)
        ? { kind: NATIVE_TOOL_CARD_KIND.lsp, args }
        : undefined;
    case NATIVE_TOOL_CARD_KIND.task:
      return isTaskCardData(args, result)
        ? { kind: NATIVE_TOOL_CARD_KIND.task, args }
        : undefined;
    default:
      return undefined;
  }
}

function selectedCard(
  state: CapturedToolExecutionState,
  native: unknown,
): SelectedNativeCard | undefined {
  const identity = state.toolCallId
    ? identityForToolCall(state.toolCallId)
    : undefined;
  if (identity) {
    return selectionForIdentity(
      identity.toolName,
      state.args ?? identity.args,
      state.result,
    );
  }
  if (state.result === undefined) return undefined;
  const candidates = [
    (isTaskCardData(state.args, state.result) ||
      isTaskCardData(undefined, state.result)) &&
    nativeRendererMatches(native, ["Task"])
      ? { kind: NATIVE_TOOL_CARD_KIND.task, args: state.args }
      : undefined,
    (isHubCardData(state.args, state.result) ||
      isHubCardData(undefined, state.result)) &&
    nativeRendererMatches(native, ["Hub"])
      ? { kind: NATIVE_TOOL_CARD_KIND.hub, args: state.args }
      : undefined,
    isLspCardData(state.args, state.result) &&
    nativeRendererMatches(native, ["LSP", "Lsp"])
      ? { kind: NATIVE_TOOL_CARD_KIND.lsp, args: state.args }
      : undefined,
    isDebugCardData(state.args, state.result) &&
    nativeRendererMatches(native, ["Debug"])
      ? { kind: NATIVE_TOOL_CARD_KIND.debug, args: state.args }
      : undefined,
    isAstGrepCardData(state.args) &&
    nativeRendererMatches(native, ["AST Grep", "Ast Grep", "Search"])
      ? { kind: NATIVE_TOOL_CARD_KIND.astGrep, args: state.args }
      : undefined,
  ].filter((candidate): candidate is SelectedNativeCard => candidate !== undefined);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function captureCallIdentity(
  state: CapturedToolExecutionState,
  value: unknown,
): void {
  if (typeof value !== "string" || value.length === 0) return;
  state.toolCallId = value;
}

function skinFingerprint(
  kind: NativeToolCardKind,
  args: unknown,
  state: CapturedToolExecutionState,
): string {
  if (state.toolCallId) {
    const known = fingerprintForToolCall(state.toolCallId);
    if (known) return known;
  }
  const base = toolFpBase(kind, args);
  if (state.toolCallId) return `${base}#${state.toolCallId}`;
  return toolFingerprint(kind, args);
}
function renderSelectedCardLines(
  kind: NativeToolCardKind,
  theme: unknown,
  width: number,
  args: unknown,
  result: unknown,
  options: unknown,
  fingerprint: string,
): readonly string[] | undefined {
  switch (kind) {
    case NATIVE_TOOL_CARD_KIND.astGrep:
      return renderSearchCardLines(
        theme,
        width,
        SEARCH_CARD_KIND.astGrep,
        args,
        result,
        options,
        fingerprint,
      );
    case NATIVE_TOOL_CARD_KIND.debug:
      return renderDebugCardLines(theme, width, args, result, options, fingerprint);
    case NATIVE_TOOL_CARD_KIND.hub:
      return renderHubCardLines(theme, width, args, result, options, fingerprint);
    case NATIVE_TOOL_CARD_KIND.lsp:
      return renderLspCardLines(theme, width, args, result, options, fingerprint);
    case NATIVE_TOOL_CARD_KIND.task:
      return renderTaskCardLines(theme, width, args, result, options, fingerprint);
  }
}

function requestPump(deps: NativeToolCardSkinDeps): void {
  try {
    deps.pump?.();
  } catch {
    // Repaint is best-effort; native lifecycle already completed.
  }
}

const pumpingCards = new Set<CapturedToolExecutionState>();

function syncPartialPump(
  state: CapturedToolExecutionState,
  deps: NativeToolCardSkinDeps,
): void {
  if (state.kind && state.partial && !state.sealed && deps.enabled(state.kind))
    pumpingCards.add(state);
  else pumpingCards.delete(state);
}

export function nativeToolCardsNeedPump(): boolean {
  return pumpingCards.size > 0;
}

export function resetNativeToolCardPump(): void {
  pumpingCards.clear();
}
const skinned = new WeakSet<object>();
let installed = false;

function skinToolExecution(child: object, deps: NativeToolCardSkinDeps): void {
  if (skinned.has(child)) return;
  const component = child as Record<string, unknown>;
  const render = methodOf(component, "render");
  const updateArgs = methodOf(component, "updateArgs");
  const updateResult = methodOf(component, "updateResult");
  const setExpanded = methodOf(component, "setExpanded");
  const setExecutionStarted = methodOf(component, "setExecutionStarted");
  const stopAnimation = methodOf(component, "stopAnimation");
  const seal = methodOf(component, "seal");
  if (
    !render ||
    !updateArgs ||
    !updateResult ||
    !setExecutionStarted ||
    !setExpanded ||
    !seal
  )
    return;

  const state: CapturedToolExecutionState = {
    args: undefined,
    result: undefined,
    partial: false,
    expanded: false,
    toolCallId: "",
    kind: undefined,
    sealed: false,
  };
  try {
    component["updateArgs"] = (...args: unknown[]): unknown => {
      const native = updateArgs.apply(child, args);
      try {
        state.args = args[0];
        captureCallIdentity(state, args[1]);
        requestPump(deps);
      } catch {
        // State capture is display-only.
      }
      return native;
    };
    component["setExecutionStarted"] = (...args: unknown[]): unknown => {
      const native = setExecutionStarted.apply(child, args);
      try {
        captureCallIdentity(state, args[0]);
        requestPump(deps);
      } catch {
        // State capture is display-only.
      }
      return native;
    };
    component["updateResult"] = (...args: unknown[]): unknown => {
      const native = updateResult.apply(child, args);
      try {
        state.result = args[0];
        state.partial = args[1] === true;
        syncPartialPump(state, deps);
        captureCallIdentity(state, args[2]);
        requestPump(deps);
      } catch {
        // State capture is display-only.
      }
      return native;
    };
    component["setExpanded"] = (...args: unknown[]): unknown => {
      const native = setExpanded.apply(child, args);
      try {
        state.expanded = args[0] === true;
        syncPartialPump(state, deps);
      } catch {
        // State capture is display-only.
      }
      return native;
    };
    component["seal"] = (...args: unknown[]): unknown => {
      const native = seal.apply(child, args);
      try {
        state.sealed = true;
        syncPartialPump(state, deps);
      } catch {
        // State capture is display-only.
      }
      return native;
    };
    if (stopAnimation) {
      component["stopAnimation"] = (...args: unknown[]): unknown => {
        const native = stopAnimation.apply(child, args);
        pumpingCards.delete(state);
        return native;
      };
    }
    component["render"] = (...args: unknown[]): unknown => {
      const native = render.apply(child, args);
      try {
        const selected = selectedCard(state, native);
        state.kind = selected?.kind;
        syncPartialPump(state, deps);
        if (!selected || !deps.enabled(selected.kind)) return native;
        if (state.sealed && (state.result === undefined || state.partial))
          return native;
        const width = args[0];
        if (typeof width !== "number") return native;
        const options = { expanded: state.expanded, isPartial: state.partial };
        const fingerprint = skinFingerprint(
          selected.kind,
          selected.args,
          state,
        );
      const painted = renderSelectedCardLines(
        selected.kind,
        deps.theme(),
        width,
        selected.args,
        state.result,
        options,
        fingerprint,
      );
        return painted ?? native;
      } catch {
        return native;
      }
    };
  } catch {
    for (const [name, native] of [
      ["render", render],
      ["updateArgs", updateArgs],
      ["updateResult", updateResult],
      ["setExecutionStarted", setExecutionStarted],
      ["setExpanded", setExpanded],
      ["seal", seal],
    ] as const) {
      try {
        component[name] = native;
      } catch {
        // A non-writable component stays native for every method we can restore.
      }
    }
    if (stopAnimation) {
      try {
        component["stopAnimation"] = stopAnimation;
      } catch {
        // A non-writable component stays native.
      }
    }
    return;
  }
  skinned.add(child);
}

export function installNativeToolCardSkin(
  ContainerCtor: { prototype: { addChild: (...args: unknown[]) => unknown } },
  deps: NativeToolCardSkinDeps,
): void {
  if (installed) return;
  const prototype = ContainerCtor?.prototype;
  const addChild = prototype?.addChild;
  if (typeof addChild !== "function") return;
  try {
    prototype.addChild = function (this: unknown, ...args: unknown[]): unknown {
      try {
        if (isToolExecutionComponentLike(this)) skinToolExecution(this, deps);
      } catch {
        // Constructor-time parent probing is display-only.
      }
      for (const child of args) {
        try {
          if (isToolExecutionComponentLike(child))
            skinToolExecution(child, deps);
        } catch {
          // One unfamiliar child must never affect its native parent insertion.
        }
      }
      return addChild.apply(this, args);
    };
  } catch {
    return;
  }
  installed = true;
}
