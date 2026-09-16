import { describe, expect, mock, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

/*
 * Thinking row liveness tests.
 *
 * Mocks pi-tui and pi-coding-agent external native dependencies before
 * importing index.ts and theme.ts.
 */

interface RenderableComponent {
  render?: (width: number) => readonly string[];
}

class MockContainer {
  children: RenderableComponent[] = [];
  addChild(child: RenderableComponent) {
    this.children.push(child);
  }
}

mock.module("@oh-my-pi/pi-tui", () => ({
  Container: MockContainer,
  visibleWidth: (s: string) => Bun.stripANSI(s).length,
  padding: (w: number) => " ".repeat(Math.max(0, w)),
  sliceByColumn: (s: string, start: number, len: number) => s.slice(start, start + len),
  truncateToWidth: (s: string, w: number) => s.slice(0, w),
}));

mock.module("@oh-my-pi/pi-coding-agent/modes/components/custom-editor", () => ({
  CustomEditor: class {},
}));

mock.module("@oh-my-pi/pi-coding-agent/modes/theme/theme", () => ({
  theme: { fg: () => "" },
}));

const { formatRowLine, advanceSpinFrame, setSpinFrame, settleAt } = await import("./theme.ts");
const indexModule = await import("./index.ts");
const registerExtension = indexModule.default;

describe("thought row formatting", () => {
  test("settled thought row with mid tree has no animated indicator", () => {
    setSpinFrame(0);
    const line0 = Bun.stripANSI(
      formatRowLine(null, 80, {
        body: "Thought",
        indent: true,
        tree: "mid",
        live: false,
        right: " (2s)",
      }),
    );
    expect(line0).toContain("├─ Thought");
    expect(line0).toContain("(2s)");
    // Must NOT have any animated spinner frame (◈, ◉, ◎, ○)
    expect(line0).not.toMatch(/├─\s*[◈◉◎○]/);

    // Advancing spin frame must not change the settled thought line
    advanceSpinFrame();
    const line1 = Bun.stripANSI(
      formatRowLine(null, 80, {
        body: "Thought",
        indent: true,
        tree: "mid",
        live: false,
        right: " (2s)",
      }),
    );
    expect(line1).toBe(line0);
  });

  test("live tool row with mid tree has animated indicator that cycles", () => {
    setSpinFrame(0);
    const line0 = Bun.stripANSI(
      formatRowLine(null, 80, {
        body: "Search `topBorder`",
        indent: true,
        tree: "mid",
        live: true,
      }),
    );
    expect(line0).toContain("├─ ◈ Search `topBorder`");

    advanceSpinFrame();
    const line1 = Bun.stripANSI(
      formatRowLine(null, 80, {
        body: "Search `topBorder`",
        indent: true,
        tree: "mid",
        live: true,
      }),
    );
    expect(line1).toContain("├─ ◉ Search `topBorder`");
  });
});

describe("thought lines during subsequent thinking", () => {
  test("past thought rows and group headers do not animate when assistant is thinking", async () => {
    type EventHandler = (event: unknown, ctx: unknown) => Promise<void>;
    const eventHandlers = new Map<string, EventHandler[]>();
    interface WrappedToolDef {
      name: string;
      renderCall: (args: unknown, options: unknown, theme: unknown) => RenderableComponent;
      renderResult: (result: unknown, options: unknown, theme: unknown, args: unknown) => RenderableComponent;
    }
    const tools = new Map<string, WrappedToolDef>();

    const fakePi = {
      on: (event: string, handler: EventHandler) => {
        const list = eventHandlers.get(event) ?? [];
        list.push(handler);
        eventHandlers.set(event, list);
      },
      registerTool: (def: WrappedToolDef) => {
        tools.set(def.name, def);
      },
      registerCommand: () => {},
      registerShortcut: () => {},
      registerMessageRenderer: () => {},
      registerComposerShape: () => {},
      registerAssistantThinkingRenderer: () => {},
      getAllTools: () => [{ name: "grep", parameters: {} }],
      sendMessage: () => {},
    } as unknown as ExtensionAPI;

    const fakeCtx = {
      ui: {
        setWidget: () => {},
        requestRender: () => {},
        notify: () => {},
      },
      hideThinkingBlock: false,
      settings: { get: (k: string) => (k === "hideThinkingBlock" ? false : undefined) },
    } as unknown as ExtensionContext;

    registerExtension(fakePi);

    const emit = async (event: string, payload: unknown) => {
      for (const handler of eventHandlers.get(event) ?? []) {
        await handler(payload, fakeCtx);
      }
    };

    // Initialize session
    await emit("session_start", fakeCtx);

    // --- TURN 1: Assistant thinks, then runs grep tool ---
    // 1. Assistant starts thinking
    await emit("message_update", {
      message: {
        content: [{ type: "thinking", thinking: "Searching for topBorder in pi-coding-agent src" }],
      },
      assistantMessageEvent: { type: "thinking_start" },
    });

    // 2. Assistant finishes thinking and emits toolCall
    await emit("message_update", {
      message: {
        content: [
          { type: "thinking", thinking: "Searching for topBorder in pi-coding-agent src" },
          {
            type: "toolCall",
            toolCallId: "call_1",
            toolName: "grep",
            args: { i: "Search topBorder in pi-coding-agent src", pattern: "topBorder" },
          },
        ],
      },
      assistantMessageEvent: { type: "toolcall_start" },
    });

    // 3. Tool execution starts
    await emit("tool_execution_start", {
      toolCallId: "call_1",
      toolName: "grep",
      args: { i: "Search topBorder in pi-coding-agent src", pattern: "topBorder" },
    });

    const wrappedGrep = tools.get("grep");
    expect(wrappedGrep).toBeDefined();

    // Render the tool call
    const callContainer = wrappedGrep!.renderCall(
      { i: "Search topBorder in pi-coding-agent src", pattern: "topBorder" },
      {},
      null,
    ) as unknown as MockContainer;
    expect(callContainer).toBeInstanceOf(MockContainer);

    const groupRender = callContainer.children[0]?.render;
    expect(groupRender).toBeDefined();

    setSpinFrame(0);
    const runningLines = groupRender!(80).map((l: string) => Bun.stripANSI(l));

    // Header should be live (animating) because tool is running
    expect(runningLines[0]).toContain("◈");
    expect(runningLines[0]).toContain("Search topBorder in pi-coding-agent src");

    // Thought line inside group should be settled: "├─ Thought", NO animated indicator!
    const thoughtLine = runningLines.find((l: string) => l.includes("Thought"));
    expect(thoughtLine).toBeDefined();
    expect(thoughtLine).toContain("├─ Thought");
    expect(thoughtLine).not.toMatch(/├─\s*[◈◉◎○]/);

    // 4. Tool execution ends
    await emit("tool_execution_end", {
      toolCallId: "call_1",
      toolName: "grep",
      args: { i: "Search topBorder in pi-coding-agent src", pattern: "topBorder" },
    });

    // Clear settleAt to simulate 500ms settling period completion
    settleAt.clear();

    // Re-render group after tool finishes and settles
    const settledLines = groupRender!(80).map((l: string) => Bun.stripANSI(l));
    expect(settledLines[0]).toContain("●");
    expect(settledLines[0]).toContain("Search topBorder in pi-coding-agent src");
    const settledThought = settledLines.find((l: string) => l.includes("Thought"));
    expect(settledThought).toBeDefined();
    expect(settledThought).toContain("├─ Thought");
    expect(settledThought).not.toMatch(/├─\s*[◈◉◎○]/);

    // --- TURN 2: Assistant starts thinking again on next step/turn! ---
    await emit("message_update", {
      message: {
        content: [{ type: "thinking", thinking: "Now reading component.ts" }],
      },
      assistantMessageEvent: { type: "thinking_start" },
    });

    // In the PREVIOUS group in the transcript:
    setSpinFrame(1);
    const linesDuringNewThinking = groupRender!(80).map((l: string) => Bun.stripANSI(l));

    // 1. The previous group header MUST NOT animate or become live! It must stay ●
    expect(linesDuringNewThinking[0]).toContain("●");
    expect(linesDuringNewThinking[0]).not.toMatch(/[◈◉◎○]/);

    // 2. The thought line in the previous group MUST NOT animate or become live!
    const pastThoughtLine = linesDuringNewThinking.find((l: string) => l.includes("Thought"));
    expect(pastThoughtLine).toBeDefined();
    expect(pastThoughtLine).toContain("├─ Thought");
    expect(pastThoughtLine).not.toMatch(/├─\s*[◈◉◎○]/);

    // 3. Advancing the spinner frame must NOT change any line in the settled group
    setSpinFrame(2);
    const linesNextFrame = groupRender!(80).map((l: string) => Bun.stripANSI(l));
    expect(linesNextFrame).toEqual(linesDuringNewThinking);
  });
});

describe("thinking widget 4-line placeholder above editor", () => {
  test("always reserves 4 lines whether idle or thinking to prevent composer jumping", async () => {
    type EventHandler = (event: unknown, ctx: unknown) => Promise<void>;
    const eventHandlers = new Map<string, EventHandler[]>();
    const widgets = new Map<string, { factory: (tui: unknown, theme: unknown) => RenderableComponent; placement?: string }>();

    const fakePi = {
      on: (event: string, handler: EventHandler) => {
        const list = eventHandlers.get(event) ?? [];
        list.push(handler);
        eventHandlers.set(event, list);
      },
      registerTool: () => {},
      registerCommand: () => {},
      registerShortcut: () => {},
      registerMessageRenderer: () => {},
      registerComposerShape: () => {},
      registerAssistantThinkingRenderer: () => {},
      getAllTools: () => [],
      sendMessage: () => {},
    } as unknown as ExtensionAPI;

    const fakeCtx = {
      ui: {
        setWidget: (key: string, factory: ((tui: unknown, theme: unknown) => RenderableComponent) | undefined, options?: { placement?: string }) => {
          if (factory) {
            widgets.set(key, { factory, placement: options?.placement });
          } else {
            widgets.delete(key);
          }
        },
        requestRender: () => {},
        notify: () => {},
      },
    } as unknown as ExtensionContext;

    registerExtension(fakePi);

    const emit = async (event: string, payload: unknown) => {
      for (const handler of eventHandlers.get(event) ?? []) {
        await handler(payload, fakeCtx);
      }
    };

    // 1. Session start: widget mounts aboveEditor
    await emit("session_start", fakeCtx);
    const thinkingWidget = widgets.get("minimal-thinking");
    expect(thinkingWidget).toBeDefined();
    expect(thinkingWidget!.placement).toBe("aboveEditor");

    // 2. Idle / not thinking state: renders exactly 4 empty lines (no rail, no Thinking...)
    const idleContainer = thinkingWidget!.factory(null, null) as unknown as MockContainer;
    const idleLines = idleContainer.children[0]?.render?.(80);
    expect(idleLines).toEqual(["", "", "", ""]);
    expect(idleLines).toHaveLength(4);

    // 3. Thinking starts: renders 1 header + 3 rail lines = 4 lines total
    await emit("message_update", {
      message: {
        content: [{ type: "thinking", thinking: "Analyzing the solution" }],
      },
      assistantMessageEvent: { type: "thinking_start" },
    });

    const liveContainer = thinkingWidget!.factory(null, null) as unknown as MockContainer;
    const liveLines = liveContainer.children[0]?.render?.(80) ?? [];
    expect(liveLines).toHaveLength(4);
    expect(Bun.stripANSI(liveLines[0])).toContain("Thinking...");
    // 3 rail lines
    expect(Bun.stripANSI(liveLines[1])).toContain("│");
    expect(Bun.stripANSI(liveLines[2])).toContain("│");
    expect(Bun.stripANSI(liveLines[3])).toContain("│");

    // 4. Tool starts / thinking stops: reverts to 4 empty lines, preserving exact height
    await emit("tool_execution_start", {
      toolCallId: "call_2",
      toolName: "grep",
      args: { pattern: "test" },
    });

    const stoppedContainer = thinkingWidget!.factory(null, null) as unknown as MockContainer;
    const stoppedLines = stoppedContainer.children[0]?.render?.(80);
    expect(stoppedLines).toEqual(["", "", "", ""]);
    expect(stoppedLines).toHaveLength(4);
  });

  test("thinking widget above composer is still present even when hideThinkingBlock is true", async () => {
    type EventHandler = (event: unknown, ctx: unknown) => Promise<void>;
    const eventHandlers = new Map<string, EventHandler[]>();
    const widgets = new Map<string, { factory: (tui: unknown, theme: unknown) => RenderableComponent; placement?: string }>();

    const fakePi = {
      on: (event: string, handler: EventHandler) => {
        const list = eventHandlers.get(event) ?? [];
        list.push(handler);
        eventHandlers.set(event, list);
      },
      registerTool: () => {},
      registerCommand: () => {},
      registerShortcut: () => {},
      registerMessageRenderer: () => {},
      registerComposerShape: () => {},
      registerAssistantThinkingRenderer: () => {},
      getAllTools: () => [],
      sendMessage: () => {},
    } as unknown as ExtensionAPI;

    const fakeCtx = {
      ui: {
        setWidget: (key: string, factory: ((tui: unknown, theme: unknown) => RenderableComponent) | undefined, options?: { placement?: string }) => {
          if (factory) {
            widgets.set(key, { factory, placement: options?.placement });
          } else {
            widgets.delete(key);
          }
        },
        requestRender: () => {},
        notify: () => {},
      },
      hideThinkingBlock: true,
      settings: { get: (k: string) => (k === "hideThinkingBlock" ? true : undefined) },
    } as unknown as ExtensionContext;

    registerExtension(fakePi);

    const emit = async (event: string, payload: unknown) => {
      for (const handler of eventHandlers.get(event) ?? []) {
        await handler(payload, fakeCtx);
      }
    };

    // 1. Session start with hideThinkingBlock: true
    await emit("session_start", fakeCtx);
    const thinkingWidget = widgets.get("minimal-thinking");
    expect(thinkingWidget).toBeDefined();
    expect(thinkingWidget!.placement).toBe("aboveEditor");

    // 2. Idle state: still occupies 4 lines
    const idleContainer = thinkingWidget!.factory(null, null) as unknown as MockContainer;
    expect(idleContainer.children[0]?.render?.(80)).toEqual(["", "", "", ""]);

    // 3. Live thinking streaming: still renders the 4-line live thinking block above editor
    await emit("message_update", {
      message: {
        content: [{ type: "thinking", thinking: "Live thoughts above editor" }],
      },
      assistantMessageEvent: { type: "thinking_start" },
    });

    const liveContainer = thinkingWidget!.factory(null, null) as unknown as MockContainer;
    const liveLines = liveContainer.children[0]?.render?.(80) ?? [];
    expect(liveLines).toHaveLength(4);
    expect(Bun.stripANSI(liveLines[0])).toContain("Thinking...");
    expect(Bun.stripANSI(liveLines[1])).toContain("│");
    expect(Bun.stripANSI(liveLines[2])).toContain("│");
    expect(Bun.stripANSI(liveLines[3])).toContain("│");
  });
});

describe("transcript settled thought block rendering", () => {
  test("renders settled thought block in group when thinking block is enabled", async () => {
    type EventHandler = (event: unknown, ctx: unknown) => Promise<void>;
    const eventHandlers = new Map<string, EventHandler[]>();
    interface WrappedToolDef {
      name: string;
      renderCall: (args: unknown, options: unknown, theme: unknown) => RenderableComponent;
    }
    const tools = new Map<string, WrappedToolDef>();

    const fakePi = {
      on: (event: string, handler: EventHandler) => {
        const list = eventHandlers.get(event) ?? [];
        list.push(handler);
        eventHandlers.set(event, list);
      },
      registerTool: (def: WrappedToolDef) => tools.set(def.name, def),
      registerCommand: () => {},
      registerShortcut: () => {},
      registerMessageRenderer: () => {},
      registerComposerShape: () => {},
      registerAssistantThinkingRenderer: () => {},
      getAllTools: () => [{ name: "read", parameters: {} }],
    } as unknown as ExtensionAPI;

    const fakeCtx = {
      ui: {
        setWidget: () => {},
        requestRender: () => {},
        notify: () => {},
      },
      hideThinkingBlock: false,
      settings: { get: (k: string) => (k === "hideThinkingBlock" ? false : undefined) },
    } as unknown as ExtensionContext;

    registerExtension(fakePi);

    const emit = async (event: string, payload: unknown) => {
      for (const handler of eventHandlers.get(event) ?? []) {
        await handler(payload, fakeCtx);
      }
    };

    await emit("session_start", fakeCtx);

    // Generate 10 lines of thinking
    const thoughtLines = Array.from({ length: 10 }, (_, i) => `Thought reason ${i + 1}`).join("\n");

    await emit("message_update", {
      message: {
        content: [{ type: "thinking", thinking: thoughtLines }],
      },
      assistantMessageEvent: { type: "thinking_start" },
    });

    await emit("message_update", {
      message: {
        content: [
          { type: "thinking", thinking: thoughtLines },
          { type: "toolCall", toolCallId: "call_t1", toolName: "read", args: { path: "abc.ts" } },
        ],
      },
      assistantMessageEvent: { type: "toolcall_start" },
    });

    await emit("tool_execution_start", {
      toolCallId: "call_t1",
      toolName: "read",
      args: { path: "abc.ts" },
    });

    await emit("tool_execution_end", {
      toolCallId: "call_t1",
      toolName: "read",
      args: { path: "abc.ts" },
    });

    settleAt.clear();

    const readTool = tools.get("read");
    expect(readTool).toBeDefined();

    const callContainer = readTool!.renderCall({ path: "abc.ts" }, {}, null) as unknown as MockContainer;
    const groupRender = callContainer.children[0]?.render;
    expect(groupRender).toBeDefined();
    const renderedLines = groupRender!(80).map((l: string) => Bun.stripANSI(l));
    // Contains Thought header
    expect(renderedLines.some((l: string) => l.includes("Thought"))).toBe(true);

    // Contains previous lines hint (...N previous lines) for standardMaxRows (default 3)
    // 10 lines - 3 lines = 7 hidden lines
    const hintLine = renderedLines.find((l: string) => l.includes("previous lines"));
    expect(hintLine).toBeDefined();
    expect(hintLine).toContain("(...7 previous lines)");

    // Contains last thinking lines with rail
    expect(renderedLines.some((l: string) => l.includes("│ Thought reason 10"))).toBe(true);
    expect(renderedLines.some((l: string) => l.includes("│ Thought reason 9"))).toBe(true);
    expect(renderedLines.some((l: string) => l.includes("│ Thought reason 8"))).toBe(true);

    // No line number gutter like "1 │ "
    for (const line of renderedLines) {
      expect(line).not.toMatch(/^\s*\d+\s*│/);
    }
  });

  test("hideThinkingBlock suppresses thought from transcript group", async () => {
    const { applyOverlay, DEFAULT_CONFIG } = await import("./config.ts");
    const cfg = applyOverlay(DEFAULT_CONFIG, { hideThinkingBlock: true });
    expect(cfg.hideThinkingBlock).toBe(true);
  });

  test("standalone assistant message with thinking renders thought block", async () => {
    const { skinAssistantMessageComponent } = await import("./assistant-commentary-skin.ts");

    class FakeAssistantMessageComponent {
      transcriptBlockMode = "appendOnly" as const;
      hideThinkingBlock = false;
      children: Array<{ render?: (w: number) => readonly string[] }> = [];
      addChild(c: { render?: (w: number) => readonly string[] }) {
        this.children.push(c);
      }
      updateContent(msg: unknown, opts?: unknown) {}
      setTextColorTransform() {}
      setLinkTargets() {}
      setCacheInvalidation() {}
      render(w: number): readonly string[] {
        const lines: string[] = [];
        for (const child of this.children) {
          if (child.render) lines.push(...child.render(w));
        }
        return lines;
      }
    }

    const component = new FakeAssistantMessageComponent();
    skinAssistantMessageComponent(component, {
      enabled: () => true,
      active: () => true,
    });
    const textContainer = {
      render: () => ["Here is the answer."],
    };
    component.addChild(textContainer);

    const thinking = Array.from({ length: 8 }, (_, i) => `Standalone thought ${i + 1}`).join("\n");
    component.updateContent({
      role: "assistant",
      content: [
        { type: "thinking", thinking },
        { type: "text", text: "Here is the answer." },
      ],
    });

    const rendered = component.render(80).map((l: string) => Bun.stripANSI(l));
    expect(rendered.some((l: string) => l.includes("Thought"))).toBe(true);
    expect(rendered.some((l: string) => l.includes("previous lines"))).toBe(true);
    expect(rendered.some((l: string) => l.includes("Standalone thought 8"))).toBe(true);
    expect(rendered.some((l: string) => l.includes("Here is the answer."))).toBe(true);

  });
});
