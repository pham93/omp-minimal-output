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
  matchesKey: (data: string, key: string) => data === key,
}));

mock.module("@oh-my-pi/pi-coding-agent", () => ({
  CustomEditor: class {},
  theme: { fg: () => "" },
}));
const { formatRowLine, advanceSpinFrame, setSpinFrame, settleAt } = await import("./core/theme.ts");
const indexModule = await import("./index.ts");
const registerExtension = indexModule.default;

interface WrappedToolDef {
  name: string;
  renderCall: (args: unknown, options: unknown, theme: unknown) => RenderableComponent;
  renderResult: (result: unknown, options: unknown, theme: unknown, args: unknown) => RenderableComponent;
}

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
      hasUI: true,
      ui: {
        setWidget: () => {},
        requestRender: () => {},
        notify: () => {},
        setEditorComponent: () => {},
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

    // Historical results can have no commentary label, even after another run.
    const renderResult = (pattern: string, text: string, gid: string, label = "", expanded = true, isError = false) => {
      const component = tools
        .get("grep")!
        .renderResult(
          { content: [{ type: "text", text }], details: { minimalGroupRun: gid, minimalGroupLabel: label }, isError },
          { expanded },
          null,
          { pattern },
        ) as unknown as MockContainer;
      return component.children[0]!.render!;
    };
    const standalone = renderResult("standalone", "  first\n\n    second\n  \n", "history-standalone");
    const standaloneRows = standalone(80).map(Bun.stripANSI);
    expect(standaloneRows[0]).toMatch(/^● /);
    expect(standaloneRows.slice(1)).toEqual(["       first", "     ", "         second"]);
    expect(standaloneRows).toHaveLength(4);

    const overflow = renderResult(
      "overflow",
      Array.from({ length: 10 }, (_, n) => `line ${n}`).join("\n"),
      "history-overflow",
      "",
      false,
    );
    const overflowRows = overflow(80).map(Bun.stripANSI);
    expect(overflowRows).toHaveLength(6);
    expect(overflowRows.slice(1)).toEqual([
      "     line 0",
      "     line 1",
      "     line 2",
      "     line 3",
      "     … 6 more lines",
    ]);

    const grouped = renderResult("first", "first output", "history-group", "Inspecting sources");
    renderResult("second", "second output", "history-group", "Inspecting sources");
    const groupedRows = grouped(80).map(Bun.stripANSI);
    expect(groupedRows[0]).toMatch(/^● /);
    expect(groupedRows[1]).toMatch(/^├─ /);
    expect(groupedRows[2]).toBe("│    first output");
    expect(groupedRows[3]).toMatch(/^╰─ /);
    expect(groupedRows[4]).toBe("     second output");

    const failed = renderResult("failed", "failure detail\n".repeat(10), "history-error", "", false, true);
    const failedRows = failed(80).map(Bun.stripANSI);
    expect(failedRows).toHaveLength(6);
    expect(failedRows[0]).toContain("failed");
    expect(failedRows.slice(1, 5).every((line) => line.includes("failure detail"))).toBe(true);
    expect(failedRows[5]).toContain("… 6 more lines");
    const narrowDetails = standalone(8).slice(1).map(Bun.stripANSI);
    expect(narrowDetails.every((line) => line.length <= 8)).toBe(true);
  });
});

describe("thinking widget 4-line placeholder above editor", () => {
  test("always reserves 4 lines whether idle or thinking to prevent composer jumping", async () => {
    type EventHandler = (event: unknown, ctx: unknown) => Promise<void>;
    const eventHandlers = new Map<string, EventHandler[]>();
    const widgets = new Map<
      string,
      { factory: (tui: unknown, theme: unknown) => RenderableComponent; placement?: string }
    >();

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
      hasUI: true,
      ui: {
        setWidget: (
          key: string,
          factory: ((tui: unknown, theme: unknown) => RenderableComponent) | undefined,
          options?: { placement?: string },
        ) => {
          if (factory) {
            widgets.set(key, { factory, placement: options?.placement });
          } else {
            widgets.delete(key);
          }
        },
        requestRender: () => {},
        notify: () => {},
        setEditorComponent: () => {},
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
    const widgets = new Map<
      string,
      { factory: (tui: unknown, theme: unknown) => RenderableComponent; placement?: string }
    >();

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
      hasUI: true,
      ui: {
        setWidget: (
          key: string,
          factory: ((tui: unknown, theme: unknown) => RenderableComponent) | undefined,
          options?: { placement?: string },
        ) => {
          if (factory) {
            widgets.set(key, { factory, placement: options?.placement });
          } else {
            widgets.delete(key);
          }
        },
        requestRender: () => {},
        notify: () => {},
        setEditorComponent: () => {},
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
      hasUI: true,
      ui: {
        setWidget: () => {},
        requestRender: () => {},
        notify: () => {},
        setEditorComponent: () => {},
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

  test("when hideThinkingBlock is true, settled thought renders exactly 1 line (Thought with duration)", async () => {
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
      hasUI: true,
      ui: {
        setWidget: () => {},
        requestRender: () => {},
        notify: () => {},
        setEditorComponent: () => {},
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

    await emit("session_start", fakeCtx);

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
          { type: "toolCall", toolCallId: "call_t2", toolName: "read", args: { path: "xyz.ts" } },
        ],
      },
      assistantMessageEvent: { type: "toolcall_start" },
    });

    await emit("tool_execution_start", {
      toolCallId: "call_t2",
      toolName: "read",
      args: { path: "xyz.ts" },
    });

    await emit("tool_execution_end", {
      toolCallId: "call_t2",
      toolName: "read",
      args: { path: "xyz.ts" },
    });

    settleAt.clear();

    const readTool = tools.get("read");
    expect(readTool).toBeDefined();

    const callContainer = readTool!.renderCall({ path: "xyz.ts" }, {}, null) as unknown as MockContainer;
    const groupRender = callContainer.children[0]?.render;
    expect(groupRender).toBeDefined();
    const renderedLines = groupRender!(80).map((l: string) => Bun.stripANSI(l));

    // Contains Thought header with duration
    const thoughtRow = renderedLines.find((l: string) => l.includes("Thought"));
    expect(thoughtRow).toBeDefined();

    // With hideThinkingBlock: true, must NOT contain any thought detail lines or previous lines hint
    expect(renderedLines.some((l: string) => l.includes("previous lines"))).toBe(false);
    expect(renderedLines.some((l: string) => l.includes("Thought reason"))).toBe(false);
  });
  test("standalone assistant message with thinking renders thought block", async () => {
    const { skinAssistantMessageComponent } = await import("./surfaces/assistant-commentary-skin.ts");

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

  test("standalone assistant message with hideThinkingBlock: true renders exactly 1 line", async () => {
    const { skinAssistantMessageComponent } = await import("./surfaces/assistant-commentary-skin.ts");

    class FakeAssistantMessageComponent {
      transcriptBlockMode = "appendOnly" as const;
      hideThinkingBlock = true;
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
      thoughtDuration: () => " (15s)",
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
    // Contains Thought header with duration
    expect(rendered.some((l: string) => l.includes("Thought"))).toBe(true);
    expect(rendered.some((l: string) => l.includes("(15s)"))).toBe(true);
    // Does NOT contain any thought detail lines or previous lines hint
    expect(rendered.some((l: string) => l.includes("previous lines"))).toBe(false);
    expect(rendered.some((l: string) => l.includes("Standalone thought"))).toBe(false);
    expect(rendered.some((l: string) => l.includes("Here is the answer."))).toBe(true);
  });

  test("ensureThinkingAboveStatus reorders hookWidgetContainerAbove before statusContainer, and restoreStatusOrder restores it", async () => {
    const { ensureThinkingAboveStatus, restoreStatusOrder } = await import("./surfaces/thinking-widget.ts");

    class StatusHudContainer {
      render() {
        return ["Working..."];
      }
    }
    class EditorTopGap {
      render() {
        return [""];
      }
    }
    class HookContainer {
      children = [new EditorTopGap()];
      render() {
        return ["Thinking..."];
      }
    }
    class EditorContainer {
      render() {
        return ["Prompt box"];
      }
    }

    const status = new StatusHudContainer();
    const hookAbove = new HookContainer();
    const editor = new EditorContainer();

    let invalidated = false;
    const mockTui = {
      children: [status, hookAbove, editor],
      invalidate() {
        invalidated = true;
      },
    };

    // Initial native OMP order: statusContainer is before hookWidgetContainerAbove
    expect(mockTui.children[0]).toBe(status);
    expect(mockTui.children[1]).toBe(hookAbove);

    // Reorder: hookWidgetContainerAbove should now be before statusContainer!
    ensureThinkingAboveStatus(mockTui);
    expect(invalidated).toBe(true);
    expect(mockTui.children[0]).toBe(hookAbove);
    expect(mockTui.children[1]).toBe(status);
    expect(mockTui.children[2]).toBe(editor);

    // Calling again when already reordered is a no-op
    invalidated = false;
    ensureThinkingAboveStatus(mockTui);
    expect(mockTui.children[0]).toBe(hookAbove);
    expect(mockTui.children[1]).toBe(status);

    // Restore: should put hookWidgetContainerAbove back after statusContainer
    restoreStatusOrder(mockTui);
    expect(mockTui.children[0]).toBe(status);
    expect(mockTui.children[1]).toBe(hookAbove);
    expect(mockTui.children[2]).toBe(editor);
  });

  test("ensureThinkingAboveStatus reorders with minified class names using visualContainer and mode", async () => {
    const { ensureThinkingAboveStatus, restoreStatusOrder } = await import("./surfaces/thinking-widget.ts");

    // Minified class names in real bun binary: constructor.name is "e", "t", etc.
    class e {
      mode = { statusRowOccupied: false, statusContainer: this };
      render() {
        return ["Working..."];
      }
    }
    class t {
      children: unknown[] = [];
      render() {
        return ["Thinking..."];
      }
    }
    class n {
      children = [{ getText: () => "" }];
      render() {
        return ["Prompt box"];
      }
    }

    const visual = { isThinkingWidget: true };
    const status = new e();
    const hookAbove = new t();
    hookAbove.children.push(visual);
    const editor = new n();

    let invalidated = false;
    const mockTui = {
      children: [status, hookAbove, editor],
      invalidate() {
        invalidated = true;
      },
    };

    // Even with minified class names, ensureThinkingAboveStatus finds visualContainer and mode!
    ensureThinkingAboveStatus(mockTui, visual);
    expect(invalidated).toBe(true);
    expect(mockTui.children[0]).toBe(hookAbove);
    expect(mockTui.children[1]).toBe(status);
    expect(mockTui.children[2]).toBe(editor);

    // Restore also works with minified class names!
    restoreStatusOrder(mockTui, visual);
    expect(mockTui.children[0]).toBe(status);
    expect(mockTui.children[1]).toBe(hookAbove);
    expect(mockTui.children[2]).toBe(editor);
  });
});

test("headless bindings never acquire or tear down the interactive UI", async () => {
  type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
  const createHost = (hasUI: boolean) => {
    const handlers = new Map<string, Handler[]>();
    const widgets = new Map<string, (tui: unknown, theme: unknown) => RenderableComponent>();
    const tools = new Map<string, WrappedToolDef>();
    let editor: unknown;
    let editorRemovals = 0;
    const pi = {
      on(name: string, handler: Handler) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      registerTool: (tool: WrappedToolDef) => tools.set(tool.name, tool),
      registerCommand: () => {},
      registerShortcut: () => {},
      registerMessageRenderer: () => {},
      registerComposerShape: () => {},
      registerAssistantThinkingRenderer: () => {},
      getAllTools: () => [{ name: "grep", parameters: {} }],
      sendMessage: () => {},
    } as unknown as ExtensionAPI;
    const ctx = {
      hasUI,
      session: {
        getTodoPhases: () => [{ name: "Work", tasks: [{ content: "Keep parent alive", status: "in_progress" }] }],
      },
      getContextUsage: () => undefined,
      ui: {
        setWidget(key: string, factory: ((tui: unknown, theme: unknown) => RenderableComponent) | undefined) {
          if (factory) widgets.set(key, factory);
          else widgets.delete(key);
        },
        setEditorComponent(value: unknown) {
          editor = value;
          if (value === undefined) editorRemovals += 1;
        },
        requestRender: () => {},
        notify: () => {},
      },
    } as unknown as ExtensionContext;
    registerExtension(pi);
    return {
      widgets,
      tools,
      get editor() {
        return editor;
      },
      get editorRemovals() {
        return editorRemovals;
      },
      async emit(name: string, event: unknown = {}) {
        for (const handler of [...(handlers.get(name) ?? [])]) await handler(event, ctx);
      },
    };
  };
  const earlyChild = createHost(false);
  await earlyChild.emit("session_start");
  expect(earlyChild.widgets.size).toBe(0);
  const parent = createHost(true);
  await parent.emit("session_start");
  const editor = parent.editor;
  expect(typeof editor).toBe("function");
  expect(parent.widgets.has("minimal-todos")).toBe(true);
  expect(parent.tools.has("grep")).toBe(true);
  const child = createHost(false);
  try {
    await child.emit("session_start");
    await child.emit("tool_execution_start", { toolName: "grep", toolCallId: "child", args: { pattern: "child" } });
    await child.emit("session_shutdown");
    await earlyChild.emit("session_shutdown");
    expect(parent.editor).toBe(editor);
    expect(parent.editorRemovals).toBe(0);
    expect(parent.widgets.has("minimal-todos")).toBe(true);
    const todoComponent = parent.widgets.get("minimal-todos")!(null, null) as unknown as MockContainer;
    expect(todoComponent.children[0]!.render!(100).map(Bun.stripANSI).join("\n")).toContain("Keep parent alive");
    const transcript = parent.tools.get("grep")!.renderResult(
      {
        content: [{ type: "text", text: "parent output" }],
        details: { minimalGroupRun: "parent-replay", minimalGroupLabel: "" },
      },
      { expanded: true },
      null,
      { pattern: "parent replay" },
    ) as unknown as MockContainer;
    expect(transcript.children[0]!.render!(80).map(Bun.stripANSI)).toEqual([
      "● Search `parent replay`",
      "     parent output",
    ]);
    await parent.emit("message_update", {
      message: { content: [{ type: "thinking", thinking: "Parent still working" }] },
      assistantMessageEvent: { type: "thinking_start" },
    });
    const component = parent.widgets.get("minimal-thinking")!(null, null) as unknown as MockContainer;
    expect(component.children[0]!.render!(80).map(Bun.stripANSI).join("\n")).toContain("Thinking...");
    const replacement = createHost(true);
    await replacement.emit("session_start");
    expect(parent.editorRemovals).toBe(1);
    expect(typeof replacement.editor).toBe("function");
    expect(replacement.tools.has("grep")).toBe(true);
    await parent.emit("session_shutdown");
    expect(replacement.widgets.has("minimal-todos")).toBe(true);
    await replacement.emit("session_shutdown");
    expect(replacement.editorRemovals).toBe(1);
  } finally {
    await parent.emit("session_shutdown");
  }
});

test("extension registers all commands and shortcuts on initial load", async () => {
  const { default: registerExtension } = await import("./index.ts");
  const registeredCommands = new Map<string, unknown>();
  const registeredShortcuts = new Map<string, unknown>();

  const mockPi = {
    on: () => {},
    registerTool: () => {},
    registerCommand: (name: string, options: unknown) => {
      registeredCommands.set(name, options);
    },
    registerShortcut: (shortcut: string, options: unknown) => {
      registeredShortcuts.set(shortcut, options);
    },
    registerMessageRenderer: () => {},
    registerComposerShape: () => {},
  };
  registerExtension(mockPi as unknown as ExtensionAPI);

  expect(registeredCommands.has("minimal-on")).toBe(true);
  expect(registeredCommands.has("minimal-off")).toBe(true);
  expect(registeredCommands.has("todos-show")).toBe(true);
  expect(registeredCommands.has("todos")).toBe(true);
  expect(registeredCommands.has("demo-write")).toBe(true);
  expect(registeredCommands.has("demo")).toBe(true);
  expect(registeredCommands.has("demo-all")).toBe(true);
  expect(registeredCommands.has("minimal-status")).toBe(true);
  expect(registeredCommands.has("inspect")).toBe(true);
  expect(registeredShortcuts.has("ctrl+alt+i")).toBe(true);
  expect(registeredShortcuts.has("ctrl+alt+t")).toBe(true);
});

test("images are collapsed by default in transcript and render pleasing placeholder", async () => {
  const { skinAssistantMessageComponent, areImagesCollapsed, resetImagesStateForTest } =
    await import("./surfaces/assistant-commentary-skin.ts");
  const { renderImagePlaceholderBox } = await import("./cards/card-primitives.ts");

  resetImagesStateForTest();
  expect(areImagesCollapsed()).toBe(true);

  let imagesVisible: boolean | undefined = undefined;
  let toolImagesVisible: boolean | undefined = undefined;

  const component = {
    transcriptBlockMode: "appendOnly" as const,
    updateContent: () => {},
    setTextColorTransform: () => {},
    setLinkTargets: () => {},
    setCacheInvalidation: () => {},
    setImagesVisible: (v: boolean) => {
      imagesVisible = v;
    },
    setToolResultImagesVisible: (v: boolean) => {
      toolImagesVisible = v;
    },
  };

  skinAssistantMessageComponent(component, { enabled: () => true, active: () => true });
  expect(imagesVisible).toBe(false);
  expect(toolImagesVisible).toBe(false);

  // Verify pleasing placeholder box has borders, image icon, and inspect hint
  const placeholder = renderImagePlaceholderBox(null, 50, { mimeType: "image/webp" });
  expect(placeholder).toHaveLength(4);
  expect(placeholder[0]).toContain("╭");
  expect(placeholder[0]).toContain("╮");
  expect(placeholder[1]).toContain("🖼");
  expect(placeholder[1]).toContain("image/webp");
  expect(placeholder[2]).toContain("inspect to view image");
  expect(placeholder[3]).toContain("╰");
  expect(placeholder[3]).toContain("╯");

  resetImagesStateForTest();
});

test("wrapped cards propagate adapter failures and request native fallback when disabled", async () => {
  const { ToolWrapper } = await import("./core/tool-wrapper.ts");
  const { GroupedToolManager } = await import("./cards/grouped-tool-card.ts");
  const { ActivityTracker } = await import("./core/activity-tracker.ts");
  const tools = new Map<string, WrappedToolDef>();
  let enabled = true;
  const pi = {
    registerTool: (tool: WrappedToolDef) => tools.set(tool.name, tool),
    sendMessage: () => {},
  } as unknown as ExtensionAPI;
  const groups = new GroupedToolManager({
    rowIsLive: () => false,
    activityLabel: () => "",
    activityRunId: () => null,
    activityStartedAt: () => 0,
  });
  const tracker = new ActivityTracker({ pi, owns: () => true, enabled: () => enabled });
  const wrapper = new ToolWrapper(pi, {
    owns: () => true,
    enabled: () => enabled,
    activityTracker: tracker,
    groupedTools: groups,
  });
  wrapper.tryWrapTool("grep", { parameters: {} });
  const tool = tools.get("grep")!;
  const result = { content: [{ type: "text", text: "visible output" }] };
  const render = () => tool.renderResult(result, { expanded: true }, null, { pattern: "needle" });
  const nativeRender = groups.renderToolVisual;
  const failure = new Error("forced adapter failure");
  try {
    groups.renderToolVisual = () => {
      throw failure;
    };
    // Host catches this exact error to render its native transcript. Undefined hides it.
    expect(render).toThrow(failure);
    groups.renderToolVisual = nativeRender;
    const card = render() as MockContainer;
    expect(card.children[0]!.render!(80).map(Bun.stripANSI).join("\n")).toContain("visible output");
    enabled = false;
    expect(render).toThrow();
    enabled = true;
    expect((render() as MockContainer).children[0]!.render!(80).map(Bun.stripANSI).join("\n")).toContain(
      "visible output",
    );
  } finally {
    groups.renderToolVisual = nativeRender;
    tracker.dispose();
    groups.clear();
  }
});
