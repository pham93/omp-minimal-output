// Display-only bridge for provider-tagged assistant commentary that precedes tool calls.

export const ASSISTANT_TEXT_PHASE = {
  commentary: "commentary",
  finalAnswer: "final_answer",
} as const;

export type AssistantTextPhase = (typeof ASSISTANT_TEXT_PHASE)[keyof typeof ASSISTANT_TEXT_PHASE];

export interface AssistantCommentarySkinDeps {
  enabled: () => boolean;
  active?: () => boolean;
}

interface ContainerConstructor {
  prototype?: {
    addChild?: unknown;
  };
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

/**
 * Builds the content view consumed by the native assistant renderer. The source
 * message and its blocks stay unchanged; every provider-tagged commentary block
 * is blanked while content indexes remain stable for thinking renderers.
 */
export function contentWithoutCommentary(message: unknown): unknown[] | undefined {
  const content = contentOf(message);
  if (!content) return undefined;

  let displayContent: unknown[] | undefined;
  for (let index = 0; index < content.length; index++) {
    const block = content[index];
    if (!commentaryText(block)) continue;
    displayContent ??= content.slice();
    displayContent[index] = { ...(block as Record<string, unknown>), text: "" };
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

function skinAssistantMessageComponent(target: object, deps: AssistantCommentarySkinDeps): void {
  if (skinned.has(target)) return;
  const component = target as Record<string, unknown>;
  const nativeUpdate = methodOf(component, "updateContent");
  if (!nativeUpdate) return;

  const patchedUpdate = function (this: unknown, message: unknown, options?: unknown): unknown {
    if (deps.active?.() === false || !deps.enabled()) {
      return nativeUpdate.call(this, message, options);
    }

    const displayContent = contentWithoutCommentary(message);
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
export function installAssistantCommentarySkin(
  Container: ContainerConstructor,
  deps: AssistantCommentarySkinDeps,
): () => void {
  if (installed) return () => {};
  const prototype = Container?.prototype;
  const nativeAddChild = prototype?.addChild;
  if (!prototype || typeof nativeAddChild !== "function") return () => {};

  const patchedAddChild = function (this: unknown, ...children: unknown[]): unknown {
    if (deps.active?.() === false) return nativeAddChild.apply(this, children);
    try {
      if (isAssistantMessageComponentLike(this)) {
        skinAssistantMessageComponent(this, deps);
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
    return nativeAddChild.apply(this, children);
  };

  try {
    prototype.addChild = patchedAddChild;
  } catch {
    return () => {};
  }

  installed = true;
  return () => {
    try {
      if (prototype.addChild === patchedAddChild) {
        prototype.addChild = nativeAddChild;
      }
    } catch {
      // Another extension generation may own the current hook.
    }
    installed = false;
    skinned = new WeakSet<object>();
    phaseCache.clear();
  };
}
