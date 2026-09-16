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
    expect(overflowRows).toHaveLength(4);
    expect(overflowRows.slice(1)).toEqual(["     line 0", "     line 1", "     … 8 more rows"]);

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
    expect(failedRows).toHaveLength(4);
    expect(failedRows[3]).toContain("failed");
    expect(failedRows[3]).not.toContain("more rows");
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
