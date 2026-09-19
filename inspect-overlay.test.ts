import { afterEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG, setPluginConfigForTest } from "./core/config.ts";

class MockContainer {
  children: Array<{ render?: (width: number) => readonly string[] }> = [];
  addChild(child: { render?: (width: number) => readonly string[] }) {
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

type InspectToolItem = import("./surfaces/inspect-overlay.ts").InspectToolItem;
const { collectInspectItems, inspectItemImage, InspectOverlay, openInspectOverlay } =
  await import("./surfaces/inspect-overlay.ts");
function strip(lines: readonly string[]): string[] {
  return lines.map((line) => Bun.stripANSI(line));
}

function joined(lines: readonly string[]): string {
  return strip(lines).join("\n");
}

function bashResult(text: string) {
  return {
    role: "toolResult",
    content: [{ type: "text", text }],
    details: { minimalFullText: text },
  };
}

function sessionWithTools(
  tools: Array<{ id: string; name: string; args: unknown; text: string; user?: string }>,
): unknown[] {
  const entries: unknown[] = [];
  let lastUser: string | undefined;
  for (const tool of tools) {
    if (tool.user && tool.user !== lastUser) {
      entries.push({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: tool.user }] },
      });
      lastUser = tool.user;
    }
    entries.push({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: tool.id, name: tool.name, arguments: tool.args }],
      },
    });
    entries.push({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: tool.id,
        toolName: tool.name,
        ...bashResult(tool.text),
      },
    });
  }
  return entries;
}

function overlayFor(items: InspectToolItem[], rows = 40) {
  let closed = false;
  const tui = { requestRender() {} };
  const view = new InspectOverlay({
    tui,
    theme: null,
    items,
    done: () => {
      closed = true;
    },
    rows,
  });
  return {
    view,
    closed: () => closed,
    paint: () => joined(view.render(80)),
  };
}

afterEach(() => setPluginConfigForTest(null));

describe("collectInspectItems", () => {
  test("pairs assistant tool calls with later tool results and keeps the user prompt", () => {
    const items = collectInspectItems(
      sessionWithTools([
        { id: "a", name: "bash", args: { command: "true" }, text: "ok", user: "run tests" },
        { id: "b", name: "grep", args: { pattern: "foo" }, text: "src/foo.ts:1:foo" },
      ]),
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: "a", toolName: "bash", userPrompt: "run tests" });
    expect(items[1]).toMatchObject({ id: "b", toolName: "grep" });
    expect(items[0]?.args).toEqual({ command: "true" });
  });

  test("accepts args as well as arguments on toolCall blocks", () => {
    const items = collectInspectItems([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "read", args: { path: "a.ts" } }],
        },
      },
      {
        type: "message",
        message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "hi" }] },
      },
    ]);
    expect(items[0]?.args).toEqual({ path: "a.ts" });
  });

  test("skips unpaired calls and non-message entries", () => {
    const items = collectInspectItems([
      { type: "model_change", model: "x" },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "pending", name: "bash", arguments: { command: "sleep 9" } }],
        },
      },
    ]);
    expect(items).toEqual([]);
  });
});

describe("InspectOverlay", () => {
  test("starts on the latest card, steps with j/k, and Esc closes", () => {
    const items = collectInspectItems(
      sessionWithTools([
        { id: "a", name: "bash", args: { command: "echo a" }, text: "a_out", user: "first" },
        { id: "b", name: "bash", args: { command: "echo b" }, text: "b_out", user: "second" },
      ]),
    );
    const { view, closed, paint } = overlayFor(items);
    expect(paint()).toContain("2/2");
    expect(paint()).toContain("Inspect");
    expect(paint()).toContain("❯ second");
    view.handleInput("k");
    expect(paint()).toContain("1/2");
    view.handleInput("k");
    expect(paint()).toContain("1/2");
    view.handleInput("j");
    expect(paint()).toContain("2/2");
    view.handleInput("\x1b");
    expect(closed()).toBe(true);
  });

  test("outline hugs a one-line card instead of filling the overlay", () => {
    const items = collectInspectItems(
      sessionWithTools([{ id: "a", name: "bash", args: { command: "true" }, text: "" }]),
    );
    const { view } = overlayFor(items, 24);
    const lines = strip(view.render(80));
    const top = lines.findIndex((line) => line.includes("┌"));
    const bottom = lines.findIndex((line) => line.includes("└"));
    expect(top).toBeGreaterThanOrEqual(0);
    expect(bottom).toBeGreaterThan(top);
    expect(bottom - top).toBeLessThanOrEqual(4);
    expect(lines.some((line) => line.includes("true"))).toBe(true);
    const railsAfter = lines.slice(bottom + 1, -1).filter((line) => line.includes("┆"));
    expect(railsAfter).toEqual([]);
  });

  test("stepping a long replica keeps the outlined card in view", () => {
    const tools = Array.from({ length: 40 }, (_, i) => ({
      id: `t${i}`,
      name: "bash" as const,
      args: { command: `echo card_${i}` },
      text: `out_${i}`,
    }));
    const items = collectInspectItems(sessionWithTools(tools));
    const { view, paint } = overlayFor(items, 16);
    expect(paint()).toContain("card_39");
    expect(paint()).toContain("40/40");
    view.handleInput("k");
    const stepped = paint();
    expect(stepped).toContain("39/40");
    expect(stepped).toContain("card_38");
    expect(stepped).toContain("┌");
    view.handleInput("k");
    expect(paint()).toContain("card_37");
  });

  test("Enter expands only the outlined card's Detailed window", () => {
    setPluginConfigForTest({ ...DEFAULT_CONFIG, standardOutputMaxRows: 2, detailedMaxRows: 4 });
    const linesA = Array.from({ length: 20 }, (_, i) => `alpha_${i}`).join("\n");
    const linesB = Array.from({ length: 20 }, (_, i) => `bravo_${i}`).join("\n");
    const items = collectInspectItems(
      sessionWithTools([
        { id: "a", name: "bash", args: { command: "echo a" }, text: linesA },
        { id: "b", name: "bash", args: { command: "echo b" }, text: linesB },
      ]),
    );
    const { view, paint } = overlayFor(items, 60);
    const collapsed = paint();
    expect(collapsed).toContain("bravo_0");
    expect(collapsed).toContain("bravo_1");
    expect(collapsed).not.toContain("bravo_3");
    expect(collapsed).not.toContain("alpha_3");
    expect(collapsed).toContain("┌");
    expect(collapsed).toContain("enter expand");

    view.handleInput("\n");
    const expandedB = paint();
    expect(expandedB).toContain("bravo_0");
    expect(expandedB).toContain("bravo_3");
    expect(expandedB).toContain("bravo_19");
    expect(expandedB).not.toContain("alpha_3");

    view.handleInput("k");
    const onA = paint();
    expect(onA).toContain("1/2");
    expect(onA).toContain("bravo_3");
    expect(onA).not.toContain("alpha_3");

    view.handleInput("\n");
    const expandedA = paint();
    expect(expandedA).toContain("alpha_3");
    expect(expandedA).toContain("bravo_3");

    view.handleInput("h");
    const collapsedA = paint();
    expect(collapsedA).not.toContain("alpha_3");
    expect(collapsedA).toContain("bravo_3");
  });

  test("Ctrl+O does not expand every inspect card", () => {
    setPluginConfigForTest({ ...DEFAULT_CONFIG, standardOutputMaxRows: 2, detailedMaxRows: 4 });
    const linesA = Array.from({ length: 20 }, (_, i) => `alpha_${i}`).join("\n");
    const linesB = Array.from({ length: 20 }, (_, i) => `bravo_${i}`).join("\n");
    const items = collectInspectItems(
      sessionWithTools([
        { id: "a", name: "bash", args: { command: "echo a" }, text: linesA },
        { id: "b", name: "bash", args: { command: "echo b" }, text: linesB },
      ]),
    );
    const { view, paint } = overlayFor(items, 60);
    view.handleInput("\x0f");
    const after = paint();
    expect(after).not.toContain("alpha_3");
    expect(after).not.toContain("bravo_3");
  });

  test("native-mode tools still render a one-line identity", () => {
    setPluginConfigForTest({ ...DEFAULT_CONFIG, nativeBash: true });
    const items = collectInspectItems(
      sessionWithTools([{ id: "a", name: "bash", args: { command: "uname" }, text: "Linux" }]),
    );
    const { paint } = overlayFor(items);
    expect(paint()).toContain("uname");
  });
});

describe("openInspectOverlay", () => {
  test("notifies and skips the overlay when the session has no tool cards", async () => {
    const notes: string[] = [];
    let customCalls = 0;
    await openInspectOverlay({
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      ui: {
        notify: (message: string) => notes.push(message),
        custom: async () => {
          customCalls += 1;
        },
      },
    } as never);
    expect(notes.some((note) => note.includes("No tool cards"))).toBe(true);
    expect(customCalls).toBe(0);
  });

  test("opens a fullscreen overlay for a session with tool cards", async () => {
    const options: Array<{ overlay?: boolean; overlayOptions?: { fullscreen?: boolean } }> = [];
    await openInspectOverlay({
      hasUI: true,
      sessionManager: {
        getBranch: () => sessionWithTools([{ id: "a", name: "bash", args: { command: "true" }, text: "ok" }]),
      },
      ui: {
        notify: () => {},
        custom: async (
          factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => InspectOverlay,
          opts: { overlay?: boolean; overlayOptions?: { fullscreen?: boolean } },
        ) => {
          options.push(opts);
          const overlay = factory({ requestRender() {}, setFocus() {} }, null, {}, () => {});
          overlay.handleInput("\x1b");
        },
      },
    } as never);
    expect(options[0]?.overlay).toBe(true);
    expect(options[0]?.overlayOptions?.fullscreen).toBe(true);
  });
});

describe("inspectItemImage and image tool card rendering", () => {
  test("detects image in read tool result and renders placeholder collapsed and full image expanded", () => {
    const fakeImageItem: InspectToolItem = {
      id: "call-img",
      toolName: "read",
      args: { path: "attachment://1" },
      result: {
        role: "toolResult",
        toolCallId: "call-img",
        content: [
          { type: "text", text: "Read image file [image/png]\n1231x788" },
          { type: "image", data: "base64data", mimeType: "image/png" },
        ],
      },
    };

    const imageInfo = inspectItemImage(fakeImageItem);
    expect(imageInfo).toBeDefined();
    expect(imageInfo?.mimeType).toBe("image/png");
    expect(imageInfo?.data).toBe("base64data");

    // In overlay: when collapsed, shows placeholder box
    const { view, paint } = overlayFor([fakeImageItem], 60);
    const collapsedView = paint();
    expect(collapsedView).toContain("attachment://1");
    expect(collapsedView).toContain("🖼");
    expect(collapsedView).toContain("inspect to view image");

    // Press Enter to expand -> expands card
    view.handleInput("\r");
    const expandedView = paint();
    expect(expandedView).toContain("attachment://1");
  });
});

describe("InspectOverlay card minimization and fast search", () => {
  test("m key toggles 1-line minimization on the focused card", () => {
    const tools = [
      { id: "a", name: "bash", args: { command: "git status" }, text: "line 1\nline 2\nline 3\nline 4" },
      { id: "b", name: "read", args: { path: "src/server.ts" }, text: "line A\nline B\nline C" },
    ];
    const items = collectInspectItems(sessionWithTools(tools));
    const { view, paint } = overlayFor(items, 60);

    // Starts on card b (standard view with details)
    const normalB = paint();
    expect(normalB).toContain("line A");
    expect(view.isMinimized(1)).toBe(false);

    // Press m -> minimizes card b to 1-line header
    view.handleInput("m");
    expect(view.isMinimized(1)).toBe(true);
    const minB = paint();
    expect(minB).not.toContain("line A");
    expect(minB).toContain("src/server.ts");

    // Press m again -> restores standard view
    view.handleInput("m");
    expect(view.isMinimized(1)).toBe(false);
    const restoredB = paint();
    expect(restoredB).toContain("line A");
  });

  test("M key toggles 1-line minimization on all session cards", () => {
    const tools = [
      { id: "a", name: "bash", args: { command: "git status" }, text: "status output" },
      { id: "b", name: "read", args: { path: "src/server.ts" }, text: "server output" },
    ];
    const items = collectInspectItems(sessionWithTools(tools));
    const { view, paint } = overlayFor(items, 60);

    expect(view.isMinimized(0)).toBe(false);
    expect(view.isMinimized(1)).toBe(false);

    // Press M -> minimizes all cards
    view.handleInput("M");
    expect(view.isMinimized(0)).toBe(true);
    expect(view.isMinimized(1)).toBe(true);
    const minAll = paint();
    expect(minAll).not.toContain("status output");
    expect(minAll).not.toContain("server output");

    // Press M again -> restores all cards
    view.handleInput("M");
    expect(view.isMinimized(0)).toBe(false);
    expect(view.isMinimized(1)).toBe(false);
  });

  test("/ opens search, types query in real time, n/N steps matches, and esc clears", () => {
    const tools = [
      { id: "a", name: "bash", args: { command: "git diff" }, text: "diff content" },
      { id: "b", name: "read", args: { path: "src/config.ts" }, text: "config content" },
      { id: "c", name: "bash", args: { command: "git log" }, text: "log commit" },
    ];
    const items = collectInspectItems(sessionWithTools(tools));
    const { view, paint } = overlayFor(items, 60);

    expect(view.isSearching()).toBe(false);

    // Press / to enter search mode
    view.handleInput("/");
    expect(view.isSearching()).toBe(true);
    const searchPrompt = paint();
    expect(searchPrompt).toContain("/ █");

    // Type "git"
    view.handleInput("g");
    view.handleInput("i");
    view.handleInput("t");
    expect(view.searchQuery()).toBe("git");
    expect(view.matchingIndices()).toEqual([0, 2]); // Matches cards a and c

    // Press Enter to commit search
    view.handleInput("\r");
    expect(view.isSearching()).toBe(false);
    const searchCommitted = paint();
    expect(searchCommitted).toContain("match 2/2");

    // Step next match with n (wraps to first match)
    view.handleInput("n");
    const stepNext = paint();
    expect(stepNext).toContain("match 1/2");
    expect(stepNext).toContain("git diff");

    // Step previous match with N (wraps back to second match)
    view.handleInput("N");
    const stepPrev = paint();
    expect(stepPrev).toContain("match 2/2");
    expect(stepPrev).toContain("git log");

    // Press esc -> clears search and restores normal footer
    view.handleInput("\x1b");
    const cleared = paint();
    expect(cleared).not.toContain("match");
    expect(cleared).toContain("/ search");
  });
});
