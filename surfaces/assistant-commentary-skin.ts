// Display-only bridge for provider-tagged assistant commentary that precedes tool calls,
// and transcript thought blocks for standalone assistant messages.

import { getPluginConfig, isHideThinkingBlock } from "../core/config.ts";
import { detailProfile, thoughtRowLimit } from "../core/density.ts";
import { formatSettledThought } from "./scrolling-text.ts";
import { formatRowLine } from "../core/theme.ts";
import { getContainerInterceptor } from "../core/container-interceptor.ts";
import { extractThinking } from "./thinking-widget.ts";
export const ASSISTANT_TEXT_PHASE = {
  commentary: "commentary",
  finalAnswer: "final_answer",
} as const;

export type AssistantTextPhase = (typeof ASSISTANT_TEXT_PHASE)[keyof typeof ASSISTANT_TEXT_PHASE];

export interface AssistantCommentarySkinDeps {
  enabled: () => boolean;
  active?: () => boolean;
  thoughtDuration?: () => string;
  /** Live theme, so thought rows are painted with the same tokens as card rows. */
  theme?: () => unknown;
}

interface AssistantMessageContent {
  content?: unknown;
}

interface AssistantTextContent {
  type?: unknown;
  text?: unknown;
  textSignature?: unknown;
}

const MAX_PHASE_CACHE_ENTRIES = 256;
const phaseCache = new Map<string, AssistantTextPhase | null>();
let installed = false;
let skinned = new WeakSet<object>();
const liveAssistantMessages = new Set<object>();
let imagesCollapsed = true;

export function areImagesCollapsed(): boolean {
  return imagesCollapsed;
}

export function setImagesCollapsed(collapsed: boolean, ui?: unknown): boolean {
  imagesCollapsed = collapsed;
  applyImagesVisibility(!collapsed, ui);
  return imagesCollapsed;
}

export function toggleImagesCollapsed(ui?: unknown): boolean {
  return setImagesCollapsed(!imagesCollapsed, ui);
}

export function resetImagesStateForTest(): void {
  imagesCollapsed = true;
  liveAssistantMessages.clear();
}

export function applyImagesVisibility(visible: boolean, ui?: unknown): void {
  for (const target of liveAssistantMessages) {
    try {
      const setToolResultImagesVisible = methodOf(target as Record<string, unknown>, "setToolResultImagesVisible");
      if (typeof setToolResultImagesVisible === "function") {
        setToolResultImagesVisible.call(target, visible);
      }
      const setImagesVisible = methodOf(target as Record<string, unknown>, "setImagesVisible");
      if (typeof setImagesVisible === "function") {
        setImagesVisible.call(target, visible);
      }
    } catch {
      // Component may be disposed
    }
  }

  if (typeof ui === "object" && ui !== null) {
    try {
      const u = ui as { clearInlineImages?: () => void; requestRender?: (force?: boolean) => void };
      if (!visible && typeof u.clearInlineImages === "function") {
        u.clearInlineImages();
      }
      if (typeof u.requestRender === "function") {
        u.requestRender();
      }
    } catch {
      // Best-effort UI repaint
    }
  }
}

function methodOf(record: Record<string, unknown>, name: string): ((...args: unknown[]) => unknown) | undefined {
  const value = record[name];
  return typeof value === "function" ? (value as (...args: unknown[]) => unknown) : undefined;
}

function phaseFromSignature(value: unknown): AssistantTextPhase | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const cached = phaseCache.get(value);
  if (cached !== undefined) return cached ?? undefined;

  let phase: AssistantTextPhase | undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed["v"] === 1) {
      const candidate = parsed["phase"];
      if (candidate === ASSISTANT_TEXT_PHASE.commentary || candidate === ASSISTANT_TEXT_PHASE.finalAnswer) {
        phase = candidate;
      }
    }
  } catch {
    // Legacy provider signatures are opaque strings, not JSON.
  }

  if (phaseCache.size >= MAX_PHASE_CACHE_ENTRIES) phaseCache.clear();
  phaseCache.set(value, phase ?? null);
  return phase;
}

function contentOf(message: unknown): unknown[] | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const content = (message as AssistantMessageContent).content;
  return Array.isArray(content) ? content : undefined;
}

function isToolCall(content: unknown): boolean {
  return typeof content === "object" && content !== null && (content as { type?: unknown }).type === "toolCall";
}

function commentaryText(content: unknown): string | undefined {
  if (typeof content !== "object" || content === null) return undefined;
  const block = content as AssistantTextContent;
  if (block.type !== "text") return undefined;
  if (phaseFromSignature(block.textSignature) !== ASSISTANT_TEXT_PHASE.commentary) {
    return undefined;
  }
  if (typeof block.text !== "string") return undefined;
  const text = block.text.trim();
  return text || undefined;
}

/** Returns provider-tagged commentary only when the assistant message also calls a tool. */
export function commentaryStatusFromMessage(message: unknown): string | undefined {
  const content = contentOf(message);
  if (!content) return undefined;

  let hasToolCall = false;
  let commentary: string | undefined;
  for (const block of content) {
    if (isToolCall(block)) hasToolCall = true;
    const text = commentaryText(block);
    if (text) commentary = text;
  }
  return hasToolCall ? commentary : undefined;
}

export function messageHasToolCall(message: unknown): boolean {
  const content = contentOf(message);
  if (!content) return false;
  return content.some(isToolCall);
}

export function messageHasGroupedToolCall(message: unknown): boolean {
  const content = contentOf(message);
  if (!content) return false;
  for (const block of content) {
    if (isToolCall(block)) {
      const name = typeof (block as { name?: unknown }).name === "string" ? (block as { name: string }).name : "";
      if (name === "bash" || name === "read" || name === "grep" || name === "glob") {
        return true;
      }
    }
  }
  return false;
}
export function extractThinkingFromMessage(message: unknown): string | undefined {
  const content = contentOf(message);
  if (!content) return undefined;
  for (const block of content) {
    if (typeof block === "object" && block !== null) {
      const b = block as Record<string, unknown>;
      const kind = b["type"];
      if (
        (kind === "thinking" || kind === "reasoning" || kind === "redactedThinking") &&
        typeof b["thinking"] === "string"
      ) {
        const t = b["thinking"].trim();
        if (t) return t;
      }
      if ((kind === "thinking" || kind === "reasoning") && typeof b["text"] === "string") {
        const t = b["text"].trim();
        if (t) return t;
      }
    }
  }
  return undefined;
}

const THOUGHT_SLOT_KEY = Symbol("minimalOutputThoughtSlot");

interface ThoughtSlotState {
  thinkingText?: string;
  live?: boolean;
  options?: unknown;
}

function createThoughtSlot(target: object, deps: AssistantCommentarySkinDeps): {
  render: (width: number) => readonly string[];
  setThought: (text: string | undefined, hasGroupedToolCall: boolean, live: boolean, options?: unknown) => void;
} {
  let state: ThoughtSlotState = {};
  return {
    setThought(text, hasGroupedToolCall, live, options) {
      if (hasGroupedToolCall || !text) {
        state = {};
      } else {
        state = { thinkingText: text, live, options };
      }
    },
    render(width: number): readonly string[] {
      if (!state.thinkingText || state.live) return [];
      const cfg = getPluginConfig();
      const profile = detailProfile(state.options, cfg);
      const maxLines = thoughtRowLimit(profile, cfg);
      const duration = deps.thoughtDuration?.() ?? "";
      const theme = deps.theme?.();
      const lines: string[] = [
        formatRowLine(theme, width, {
          body: "Thought",
          right: duration,
          live: false,
        }),
      ];
      if (!isHideThinkingBlock(target)) {
        lines.push(
          ...formatSettledThought(state.thinkingText, {
            maxLines,
            width,
            theme,
          }),
        );
      }
      return lines;
    },
  };
}

/**
 * Builds the content view consumed by the native assistant renderer.
 * Provider-tagged commentary blocks are blanked, and native thinking blocks are
 * blanked so Ohmypi's native raw markdown dump is replaced by our formatted thought block.
 */
export function contentWithoutCommentary(message: unknown, hideNativeThinking = true): unknown[] | undefined {
  const content = contentOf(message);
  if (!content) return undefined;

  let displayContent: unknown[] | undefined;
  for (let index = 0; index < content.length; index++) {
    const block = content[index];
    if (typeof block === "object" && block !== null) {
      const b = block as Record<string, unknown>;
      if (commentaryText(block)) {
        displayContent ??= content.slice();
        displayContent[index] = { ...b, text: "" };
        continue;
      }
      if (hideNativeThinking && (b["type"] === "thinking" || b["type"] === "reasoning")) {
        displayContent ??= content.slice();
        displayContent[index] = { ...b, thinking: "", text: "" };
        continue;
      }
    }
  }
  return displayContent;
}

/** Strictly identify the host AssistantMessageComponent without importing a second bundled class copy. */
export function isAssistantMessageComponentLike(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false;
  const component = value as Record<string, unknown>;
  return (
    component["transcriptBlockMode"] === "appendOnly" &&
    methodOf(component, "updateContent") !== undefined &&
    methodOf(component, "setTextColorTransform") !== undefined &&
    methodOf(component, "setLinkTargets") !== undefined &&
    methodOf(component, "setCacheInvalidation") !== undefined
  );
}

export function skinAssistantMessageComponent(target: object, deps: AssistantCommentarySkinDeps): void {
  if (skinned.has(target)) return;
  const component = target as Record<string, unknown>;
  const nativeUpdate = methodOf(component, "updateContent");
  if (!nativeUpdate) return;

  liveAssistantMessages.add(target);
  if (imagesCollapsed) {
    try {
      const setToolResultImagesVisible = methodOf(component, "setToolResultImagesVisible");
      setToolResultImagesVisible?.call(target, false);
      const setImagesVisible = methodOf(component, "setImagesVisible");
      setImagesVisible?.call(target, false);
    } catch {
      // Best effort
    }
  }
  const targetRecord = target as Record<symbol, ReturnType<typeof createThoughtSlot>>;
  let thoughtSlot = targetRecord[THOUGHT_SLOT_KEY];
  if (!thoughtSlot) {
    thoughtSlot = createThoughtSlot(target, deps);
    targetRecord[THOUGHT_SLOT_KEY] = thoughtSlot;
    const children = (target as { children?: unknown[] }).children;
    if (Array.isArray(children)) {
      children.unshift(thoughtSlot);
    } else if (typeof (target as { addChild?: (c: unknown) => void }).addChild === "function") {
      (target as { addChild: (c: unknown) => void }).addChild(thoughtSlot);
    }
  }

  const patchedUpdate = function (this: unknown, message: unknown, options?: unknown): unknown {
    const thinking = extractThinkingFromMessage(message);
    const hasGroupedTool = messageHasGroupedToolCall(message);
    const isLive = extractThinking(message).live;
    thoughtSlot.setThought(thinking, hasGroupedTool, isLive, options);

    if (deps.active?.() === false || !deps.enabled()) {
      return nativeUpdate.call(this, message, options);
    }

    const displayContent = contentWithoutCommentary(message, true);
    if (!displayContent || typeof message !== "object" || message === null) {
      return nativeUpdate.call(this, message, options);
    }

    const source = message as AssistantMessageContent;
    const originalContent = source.content;
    try {
      source.content = displayContent;
    } catch {
      return nativeUpdate.call(this, message, options);
    }

    try {
      return nativeUpdate.call(this, message, options);
    } finally {
      source.content = originalContent;
    }
  };

  try {
    component["updateContent"] = patchedUpdate;
  } catch {
    return;
  }
  skinned.add(target);
}

/**
 * Hooks Container.addChild because AssistantMessageComponent invokes it inside
 * its constructor before the initial persisted message reaches updateContent.
 */
export function installAssistantCommentarySkin(Container: unknown, deps: AssistantCommentarySkinDeps): () => void {
  if (installed) return () => {};
  const interceptor = getContainerInterceptor(Container);
  if (!interceptor.isAvailable) return () => {};

  const unregister = interceptor.registerHook((container, children) => {
    if (deps.active?.() === false) return;
    try {
      if (isAssistantMessageComponentLike(container)) {
        skinAssistantMessageComponent(container, deps);
      }
    } catch {
      // Constructor-time probing is display-only and fail-open.
    }
    for (const child of children) {
      try {
        if (isAssistantMessageComponentLike(child)) {
          skinAssistantMessageComponent(child, deps);
        }
      } catch {
        // One unfamiliar child must never affect native insertion.
      }
    }
  });
  if (!unregister) return () => {};
  installed = true;
  let active = true;

  return () => {
    if (!active) return;
    active = false;
    unregister();
    installed = false;
    skinned = new WeakSet<object>();
    liveAssistantMessages.clear();
    imagesCollapsed = false;
    phaseCache.clear();
  };
}
