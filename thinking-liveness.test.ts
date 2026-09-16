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
