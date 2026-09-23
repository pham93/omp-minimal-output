import type { Container } from "@oh-my-pi/pi-tui";
import { isMcpTool, isWrappedTool, wrapTool, type McpTool, type WrappedTool } from "../core/config.ts";
import { toolFingerprint } from "../core/results.ts";
import { cardIsPartial } from "./card-primitives.ts";
import { renderGroupedToolCard, type GroupedToolManager } from "./grouped-tool-card.ts";
import { renderCollapsedToolCard } from "./collapsed-tool-card.ts";
import { renderWriteCard } from "./write-card.ts";
import { renderPrettyEditCard } from "./edit-card.ts";
import { renderEvalCard } from "./eval-card.ts";
import { renderWebSearchCard } from "./web-search-card.ts";

export const CARD_RENDER_PHASE = {
  call: "call",
  result: "result",
} as const;

type CardRenderPhase = (typeof CARD_RENDER_PHASE)[keyof typeof CARD_RENDER_PHASE];

export interface CardRenderRequest {
  toolName: WrappedTool | McpTool;
  phase: CardRenderPhase;
  theme: unknown;
  args: unknown;
  options: unknown;
  result?: unknown;
}

export interface CardRenderContext extends CardRenderRequest {
  fingerprint: string;
  parentLabel: () => string;
  groupedTools: GroupedToolManager;
}

interface ToolCardRenderer {
  grouped: boolean;
  render(context: CardRenderContext): Container;
}

const GROUPED_RENDERER: ToolCardRenderer = { grouped: true, render: renderGroupedToolCard };

/** MCP tools arrive as `mcp__server__tool`, so they cannot be table keys: the family shares one card. */
function rendererFor(toolName: string): ToolCardRenderer | undefined {
  const known = (CARD_RENDERERS as Record<string, ToolCardRenderer | undefined>)[toolName];
  if (known) return known;
  return isMcpTool(toolName) ? COLLAPSED_RENDERER : undefined;
}

// Tools with no dedicated layout: their collapsed one-liner becomes the header, rendered by the
// plugin instead of the host.
const COLLAPSED_RENDERER: ToolCardRenderer = {
  grouped: false,
  render({ theme, toolName, args, result, options, fingerprint, parentLabel }) {
    return renderCollapsedToolCard(theme, toolName, args, result, options, fingerprint, parentLabel);
  },
};

const CARD_RENDERERS = {
  bash: GROUPED_RENDERER,
  read: GROUPED_RENDERER,
  grep: GROUPED_RENDERER,
  glob: GROUPED_RENDERER,
  write: {
    grouped: false,
    render({ theme, args, result, options, fingerprint, parentLabel }) {
      return renderWriteCard(theme, args, result, options, fingerprint, parentLabel);
    },
  },
  edit: {
    grouped: false,
    render({ theme, args, result, options, phase, parentLabel }) {
      return renderPrettyEditCard(
        theme,
        args,
        result,
        options,
        phase === CARD_RENDER_PHASE.call && cardIsPartial(options),
        parentLabel,
      );
    },
  },
  eval: {
    grouped: false,
    render({ theme, args, result, options, phase, fingerprint, parentLabel }) {
      return renderEvalCard(
        theme,
        args,
        result,
        options,
        phase === CARD_RENDER_PHASE.call && cardIsPartial(options),
        fingerprint,
        parentLabel,
      );
    },
  },
  web_search: {
    grouped: false,
    render({ theme, args, result, options, fingerprint, parentLabel }) {
      return renderWebSearchCard(theme, args, result, options, fingerprint, parentLabel);
    },
  },
  lsp: COLLAPSED_RENDERER,
  ast_grep: COLLAPSED_RENDERER,
  security_scan: COLLAPSED_RENDERER,
  context_notes: COLLAPSED_RENDERER,
  recall: COLLAPSED_RENDERER,
  reflect: COLLAPSED_RENDERER,
  debug: COLLAPSED_RENDERER,
  github: COLLAPSED_RENDERER,
  checkpoint: COLLAPSED_RENDERER,
  rewind: COLLAPSED_RENDERER,
  new_context: COLLAPSED_RENDERER,
  memory_edit: COLLAPSED_RENDERER,
  retain: COLLAPSED_RENDERER,
  learn: COLLAPSED_RENDERER,
  manage_skill: COLLAPSED_RENDERER,
} satisfies Record<WrappedTool, ToolCardRenderer>;

export interface CardRegistryDeps {
  active: () => boolean;
  groupedTools: GroupedToolManager;
  parentLabelForCard: (fingerprint: string, result?: unknown) => string;
}

export class CardRegistry {
  readonly #deps: CardRegistryDeps;

  constructor(deps: CardRegistryDeps) {
    this.#deps = deps;
  }

  usesGroupedStatus(toolName: string): boolean {
    return isWrappedTool(toolName) && rendererFor(toolName)?.grouped === true;
  }

  render(request: CardRenderRequest): Container {
    if (!this.#deps.active() || !wrapTool(request.toolName)) {
      throw new Error(`minimal-output: native rendering required for ${request.toolName}`);
    }
    const fingerprint = toolFingerprint(request.toolName, request.args);
    // The host catches both adapter and deferred component errors and restores
    // native output. Returning undefined instead would suppress the transcript.
    const renderer = rendererFor(request.toolName);
    // Fail open: the host restores its own renderer when a card cannot be produced.
    if (!renderer) throw new Error(`minimal-output: native rendering required for ${request.toolName}`);
    return renderer.render({
      ...request,
      fingerprint,
      parentLabel: () => this.#deps.parentLabelForCard(fingerprint, request.result),
      groupedTools: this.#deps.groupedTools,
    });
  }
}
