import { tmpdir } from "node:os";
import { writeFile } from "node:fs/promises";
import type { ExtensionAPI, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import { getPluginConfig, isWrappedTool, wrapTool, WRAPPED_TOOL_REGISTRY } from "./config.ts";
import { CARD_RENDER_PHASE, CardRegistry } from "../cards/card-registry.ts";
import type { GroupedToolManager } from "../cards/grouped-tool-card.ts";
import type { ActivityTracker } from "./activity-tracker.ts";

export type TextItem = { type: string; text?: string };

export function textItemOf(content: unknown): { list: TextItem[]; item: TextItem } | undefined {
  if (!Array.isArray(content)) return undefined;
  const list = content as TextItem[];
  const item = list.find((c) => c?.type === "text" && typeof c.text === "string");
  return item ? { list, item } : undefined;
}

export function stripFence(text: string): string {
  const t = text.trim();
  const m = t.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  return m ? m[1].trim() : t;
}

export function unwrapResultEnvelope(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(stripFence(text));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const content = obj["content"];
      if (Array.isArray(content)) {
        const textItem = content.find(
          (c) => typeof c === "object" && c !== null && (c as Record<string, unknown>)["type"] === "text",
        );
        if (textItem && typeof (textItem as Record<string, unknown>)["text"] === "string") {
          return (textItem as Record<string, unknown>)["text"] as string;
        }
      }
    }
  } catch {
    // Not valid JSON or envelope; use raw text.
  }
  return null;
}

export function isMcpEnvelopeDuplicate(text: string, raw: string): boolean {
  if (!text || !raw) return false;
  if (text === raw) return true;
  const t = stripFence(text).trim();
  const r = raw.trim();
  if (t === r) return true;
  const inner = unwrapResultEnvelope(text);
  if (inner !== null && inner.trim() === r) return true;
  const head = r.slice(0, 120);
  if (head.length <= 40) return false;
  if (t.includes(head)) return true;
  return inner !== null && inner.includes(head);
}

export function pruneMcpEnvelopes(list: TextItem[], anchor: TextItem, raw: string): TextItem[] {
  return list.filter(
    (c) => c === anchor || c.type !== "text" || !isMcpEnvelopeDuplicate(typeof c.text === "string" ? c.text : "", raw),
  );
}

export function nativeToolCardSkinActive(toolName: string, enabled: boolean): boolean {
  if (!enabled) return false;
  const cfg = getPluginConfig();
  return (toolName === "task" && cfg.nativeTask !== true) || (toolName === "hub" && cfg.nativeHub !== true);
}

export function isCollapseTarget(event: ToolResultEvent, enabled: boolean): boolean {
  if (event.toolName === "web_search" && !wrapTool("web_search")) return false;
  if ((event.toolName === "task" || event.toolName === "hub") && !nativeToolCardSkinActive(event.toolName, enabled)) {
    return false;
  }
  return (
    event.type === "tool_result" &&
    ([
      "edit",
      "read",
      "bash",
      "ast_grep",
      "debug",
      "eval",
      "github",
      "glob",
      "grep",
      "lsp",
      "checkpoint",
      "rewind",
      "context_notes",
      "new_context",
      "security_scan",
      "task",
      "hub",
      "web_search",
      "write",
      "memory_edit",
      "retain",
      "recall",
      "reflect",
      "learn",
      "manage_skill",
    ].includes(event.toolName) ||
      event.toolName.startsWith("mcp__") ||
      event.toolName.includes("/"))
  );
}

export async function spillToolOutput(toolName: string, original: string): Promise<string | null> {
  try {
    const safe = toolName.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 32) || "tool";
    const path = `${tmpdir()}/omp-minimal-${safe}-${Date.now()}.log`;
    await writeFile(path, original, "utf-8");
    return path;
  } catch {
    return null;
  }
}

export function summarizeEvent(event: unknown): string {
  try {
    const e = event as Record<string, unknown>;
    const tool = String(e["toolName"] ?? e["name"] ?? "tool");
    const input = (e["input"] ?? e["args"] ?? {}) as Record<string, unknown>;
    const raw = input["command"] ?? input["path"] ?? input["pattern"] ?? input["query"] ?? input["file"] ?? "";
    const oneLine = String(raw ?? "")
      .replace(/\s+/g, " ")
      .trim();
    const short = oneLine;
    return short ? `${tool} ${short}` : tool;
  } catch {
    return "tool";
  }
}

export function intentFromUnknown(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function intentFromToolArgs(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  return intentFromUnknown((args as Record<string, unknown>)["i"]);
}

export function intentFromAssistantMessage(message: unknown): string | undefined {
  try {
    const content = (message as { content?: unknown })?.content;
    if (!Array.isArray(content)) return undefined;
    let found: string | undefined;
    for (const item of content as Array<{ type?: unknown; arguments?: unknown }>) {
      if (item?.type !== "toolCall") continue;
      const next = intentFromToolArgs(item.arguments);
      if (next) found = next;
    }
    return found;
  } catch {
    return undefined;
  }
}

export function intentFromEvent(event: unknown): string | undefined {
  try {
    const e = event as { intent?: unknown; args?: unknown; input?: unknown };
    return intentFromUnknown(e?.intent) ?? intentFromToolArgs(e?.args ?? e?.input);
  } catch {
    return undefined;
  }
}

export interface ToolWrapperDeps {
  owns: () => boolean;
  enabled: () => boolean;
  activityTracker: ActivityTracker;
  groupedTools: GroupedToolManager;
}

export class ToolWrapper {
  readonly #wrapApplied = new Set<string>();
  readonly #pi: ExtensionAPI;
  readonly #deps: ToolWrapperDeps;
  readonly #cards: CardRegistry;

  constructor(pi: ExtensionAPI, deps: ToolWrapperDeps) {
    this.#pi = pi;
    this.#deps = deps;
    this.#cards = new CardRegistry({
      active: () => deps.owns() && deps.enabled(),
      groupedTools: deps.groupedTools,
      parentLabelForCard: (fingerprint, result) => deps.activityTracker.parentLabelForCard(fingerprint, result),
    });
  }

  isWrapped(name: string): boolean {
    return this.#wrapApplied.has(name);
  }

  toolUsesGroupedStatus(toolName: string): boolean {
    return this.#wrapApplied.has(toolName) && this.#cards.usesGroupedStatus(toolName);
  }

  frozenGroupKeys(toolName: string): Record<string, unknown> {
    if (!wrapTool(toolName) || this.#deps.activityTracker.activityRunId === null) return {};
    return {
      minimalGroupRun: this.#deps.activityTracker.activityRunId,
      minimalGroupLabel: this.#deps.activityTracker.activityLabel,
    };
  }

  tryWrapTool(name: string, source?: unknown): void {
    if (!name || this.#wrapApplied.has(name)) return;
    if (!isWrappedTool(name) || !wrapTool(name)) return;
    const src = typeof source === "object" && source !== null ? (source as Record<string, unknown>) : {};
    if (src["parameters"] == null) return;
    const definition = WRAPPED_TOOL_REGISTRY[name];
    const approval = "approval" in definition ? definition.approval : undefined;
    const description = typeof src["description"] === "string" ? src["description"] : name;
    const parameters = src["parameters"];

    try {
      this.#pi.registerTool({
        name,
        description,
        parameters: parameters as never,
        ...(approval !== undefined ? { approval: approval as never } : {}),
        mergeCallAndResult: true,
        execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
          const c = ctx as unknown as {
            invokeTool?: (
              p: Record<string, unknown>,
              o?: { signal?: AbortSignal; onUpdate?: unknown },
            ) => Promise<unknown>;
          };
          if (typeof c?.invokeTool !== "function") {
            throw new Error(`minimal-output: native ${name} unavailable`);
          }
          return (await c.invokeTool(params as Record<string, unknown>, {
            signal: signal as AbortSignal,
            onUpdate: onUpdate as unknown,
          })) as never;
        },
        renderCall: (args, options, theme) =>
          this.#cards.render({
            toolName: name,
            phase: CARD_RENDER_PHASE.call,
            theme,
            args,
            options,
          }),
        renderResult: (result, options, theme, args) =>
          this.#cards.render({
            toolName: name,
            phase: CARD_RENDER_PHASE.result,
            theme,
            args,
            options,
            result,
          }),
      });
      this.#wrapApplied.add(name);
    } catch {
      // Already registered or host rejected wrap.
    }
  }

  wrapAllTools(): void {
    const api = this.#pi as unknown as { getAllTools?: () => unknown };
    if (typeof api.getAllTools !== "function") return;
    try {
      const tools = api.getAllTools();
      if (!Array.isArray(tools)) return;
      for (const tool of tools) {
        const name =
          typeof tool === "string"
            ? tool
            : typeof tool === "object" &&
                tool !== null &&
                "name" in tool &&
                typeof (tool as { name: unknown }).name === "string"
              ? (tool as { name: string }).name
              : "";
        if (name) this.tryWrapTool(name, tool);
      }
    } catch {
      // Registry not ready.
    }
  }

  clear(): void {
    this.#wrapApplied.clear();
  }
}
