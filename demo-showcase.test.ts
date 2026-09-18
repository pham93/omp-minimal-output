import { describe, expect, mock, test } from "bun:test";

class MockContainer {
  children: unknown[] = [];
  addChild(...children: unknown[]) {
    this.children.push(...children);
    return this;
  }
}

mock.module("@oh-my-pi/pi-tui", () => ({
  Container: MockContainer,
  visibleWidth: (s: string) => Bun.stripANSI(s).length,
  padding: (w: number) => " ".repeat(Math.max(0, w)),
  sliceByColumn: (s: string, start: number, len: number) => s.slice(start, start + len),
  truncateToWidth: (s: string, w: number) => s.slice(0, w),
}));
// Dynamic import required: mock.module("@oh-my-pi/pi-tui") must run before importing the module under test.
const { runPluginDemo, DEMO_OPTIONS } = await import("./surfaces/demo-showcase.ts");
const { formatSearchDetails } = await import("./cards/grouped-tool-card.ts");
const { cardDetailLine } = await import("./cards/card-primitives.ts");

function createMockCtx() {
  const notifications: Array<{ message: string; type?: string }> = [];
  const widgets = new Map<string, unknown>();
  let rendersRequested = 0;

  return {
    ctx: {
      hasUI: true,
      ui: {
        notify: (message: string, type?: "info" | "warning" | "error") => {
          notifications.push({ message, type });
        },
        setWidget: (key: string, content: unknown) => {
          if (content === undefined) {
            widgets.delete(key);
          } else {
            widgets.set(key, content);
          }
        },
        requestRender: () => {
          rendersRequested += 1;
        },
      },
    },
    notifications,
    widgets,
    getRendersRequested: () => rendersRequested,
  };
}

describe("runPluginDemo", () => {
  test("exits early without UI", async () => {
    const { ctx, widgets } = createMockCtx();
    (ctx as { hasUI: boolean }).hasUI = false;

    await runPluginDemo(ctx as never, "edit");
    expect(widgets.size).toBe(0);
  });

  test("runs stop target to immediately clear widget", async () => {
    const { ctx, widgets, notifications } = createMockCtx();
    widgets.set("minimal-demo", "existing");

    await runPluginDemo(ctx as never, "stop");
    expect(widgets.has("minimal-demo")).toBe(false);
    expect(notifications.some((n) => n.message.includes("dismissed"))).toBe(true);
  });

  test("renders edit demo card and cleans up", async () => {
    const { ctx, widgets, notifications } = createMockCtx();

    const promise = runPluginDemo(ctx as never, "edit");
    // Widget should be mounted during demo
    expect(widgets.has("minimal-demo")).toBe(true);
    const factory = widgets.get("minimal-demo") as (_tui: unknown, theme: unknown) => unknown;
    expect(typeof factory).toBe("function");

    const component = factory({}, {});
    expect(component).toBeDefined();

    // Immediately stop so we don't wait 3.5s
    await runPluginDemo(ctx as never, "stop");
    await promise;

    expect(widgets.has("minimal-demo")).toBe(false);
    expect(notifications.some((n) => n.message.includes("Edit card"))).toBe(true);
  });

  test("renders eval demo card", async () => {
    const { ctx, widgets } = createMockCtx();
    const promise = runPluginDemo(ctx as never, "eval");

    expect(widgets.has("minimal-demo")).toBe(true);
    const factory = widgets.get("minimal-demo") as (_tui: unknown, theme: unknown) => unknown;
    const component = factory({}, {});
    expect(component).toBeDefined();

    await runPluginDemo(ctx as never, "stop");
    await promise;
  });

  test("renders grouped tools demo card", async () => {
    const { ctx, widgets } = createMockCtx();
    const promise = runPluginDemo(ctx as never, "grouped");

    expect(widgets.has("minimal-demo")).toBe(true);
    const factory = widgets.get("minimal-demo") as (_tui: unknown, theme: unknown) => unknown;
    const component = factory({}, {});
    expect(component).toBeDefined();

    await runPluginDemo(ctx as never, "stop");
    await promise;
  });

  test("renders task and hub demo cards", async () => {
    const { ctx, widgets } = createMockCtx();
    const taskPromise = runPluginDemo(ctx as never, "task");
    expect(widgets.has("minimal-demo")).toBe(true);
    await runPluginDemo(ctx as never, "stop");
    await taskPromise;

    const hubPromise = runPluginDemo(ctx as never, "hub");
    expect(widgets.has("minimal-demo")).toBe(true);
    await runPluginDemo(ctx as never, "stop");
    await hubPromise;
  });

  test("renders todo and web search demo cards", async () => {
    const { ctx, widgets } = createMockCtx();
    const todoPromise = runPluginDemo(ctx as never, "todo");
    expect(widgets.has("minimal-demo")).toBe(true);
    const todoFactory = widgets.get("minimal-demo") as (_tui: unknown, theme: unknown) => { render?: (w: number) => unknown; children?: unknown[] };
    const todoComp = todoFactory({}, {});
    expect(todoComp).toBeDefined();

    // Verify render does not throw even if called directly
    const lines = (todoComp as { children?: Array<{ render?: (w: number) => unknown }> })?.children?.[0]?.render?.(100);
    expect(Array.isArray(lines)).toBe(true);

    await runPluginDemo(ctx as never, "stop");
    await todoPromise;

    const searchPromise = runPluginDemo(ctx as never, "web_search");
    expect(widgets.has("minimal-demo")).toBe(true);
    const searchFactory = widgets.get("minimal-demo") as (_tui: unknown, theme: unknown) => unknown;
    expect(searchFactory({}, {})).toBeDefined();

    await runPluginDemo(ctx as never, "stop");
    await searchPromise;

    const grepPromise = runPluginDemo(ctx as never, "grep");
    expect(widgets.has("minimal-demo")).toBe(true);
    const grepFactory = widgets.get("minimal-demo") as (_tui: unknown, theme: unknown) => unknown;
    expect(grepFactory({}, {})).toBeDefined();
    await runPluginDemo(ctx as never, "stop");
    await grepPromise;
  });

  test("renders thinking and warning demo targets", async () => {
    const { ctx, widgets } = createMockCtx();
    const thinkingPromise = runPluginDemo(ctx as never, "thinking");
    expect(widgets.has("minimal-demo")).toBe(true);
    const thinkingFactory = widgets.get("minimal-demo") as (_tui: unknown, theme: unknown) => { children?: Array<{ render?: (w: number) => unknown }> };
    const thinkingComp = thinkingFactory({}, {});
    const thinkingLines = thinkingComp?.children?.[0]?.render?.(100);
    expect(Array.isArray(thinkingLines)).toBe(true);
    await runPluginDemo(ctx as never, "stop");
    await thinkingPromise;

    const warningPromise = runPluginDemo(ctx as never, "warning");
    expect(widgets.has("minimal-demo")).toBe(true);
    const warningFactory = widgets.get("minimal-demo") as (_tui: unknown, theme: unknown) => { children?: Array<{ render?: (w: number) => unknown }> };
    const warningComp = warningFactory({}, {});
    const warningLines = warningComp?.children?.[0]?.render?.(100);
    expect(Array.isArray(warningLines)).toBe(true);
    await runPluginDemo(ctx as never, "stop");
    await warningPromise;
  });

  test("formatSearchDetails syntax-highlights code lines and patterns", () => {
    const mockTheme = {
      fg: (_token: string, text: string) => text,
    };
    const rawLines = [
      "src/config.ts: 1 hit (first 1 shown)",
      "src/config.ts:14:export const DEFAULT_PORT = 3000;",
    ];

    const formatted = formatSearchDetails(mockTheme, rawLines, "DEFAULT_PORT");
    expect(formatted).toHaveLength(2);
    // File header line formatted
    expect(formatted[0]).toContain("src/config.ts");
    expect(formatted[0]).toContain("1 hit");
    // Match line formatted with coordinate and highlighted pattern
    expect(formatted[1]).toContain("src/config.ts");
    expect(formatted[1]).toContain(":14:");
    expect(formatted[1]).toContain("DEFAULT_PORT");
    // Pattern highlight escape sequences applied
    expect(formatted[1]).toContain("\x1b[1m");
  });
  test("formatSearchDetails parses real OMP grouped grep output with directory and file headers", () => {
    const mockTheme = {
      fg: (_token: string, text: string) => text,
    };
    const ompGrepLines = [
      "      # /home/redbull/.bun/install/cache/@oh-my-pi/pi-coding-agent@18.2.4@@@1/src/modes/",
      "      ## interactive-mode.ts#CDE3",
      "       1290:                    icon: getSlashCommandTypeIcon(\"extension\"),",
      "      *1291:                    getArgumentCompletions: cmd.getArgumentCompletions,",
      "      … 3 more lines",
      "",
      "      ## autocomplete.ts#C99C",
      "       182:",
      "      *183:export interface AutocompleteItem {",
      "      … 3 more lines",
    ];

    const formatted = formatSearchDetails(mockTheme, ompGrepLines, "getArgumentCompletions");
    expect(formatted).toHaveLength(ompGrepLines.length);

    // Directory line formatted
    expect(formatted[0]).toContain("#");
    expect(formatted[0]).toContain("src/modes/");

    // File line formatted with file name and tag
    expect(formatted[1]).toContain("interactive-mode.ts");
    expect(formatted[1]).toContain("#CDE3");

    // Context line has line number 1290
    expect(formatted[2]).toContain("1290");
    expect(formatted[2]).toContain("getSlashCommandTypeIcon");

    // Match line has * marker, line number 1291, and highlighted pattern
    expect(formatted[3]).toContain("1291");
    expect(formatted[3]).toContain("getArgumentCompletions");
    expect(formatted[3]).toContain("\x1b[1m");

    // Second file header
    expect(formatted[6]).toContain("autocomplete.ts");
    expect(formatted[6]).toContain("#C99C");

    // Second match line
    expect(formatted[8]).toContain("183");
    expect(formatted[8]).toContain("AutocompleteItem");
  });
  test("cardDetailLine preserves TTY/ANSI colors using dimAnsi", () => {
    const mockTheme = {
      bg: () => [20, 20, 20] as [number, number, number],
      token: () => [120, 120, 120] as [number, number, number],
    };
    // Colored TTY text: green check, red fail
    const coloredTtyText = "\x1b[32m✔ pass\x1b[0m \x1b[31m✖ fail\x1b[0m";
    const rendered = cardDetailLine(mockTheme, 100, coloredTtyText);

    // Should preserve SGR color codes rather than stripping to plain text
    expect(rendered).toContain("\x1b[38;2;");
    expect(Bun.stripANSI(rendered)).toContain("✔ pass ✖ fail");
  });
  test("runPluginDemo lists all available options on help or question mark", async () => {
    const { ctx, notifications } = createMockCtx();
    await runPluginDemo(ctx as never, "help");

    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe("info");
    expect(notifications[0].message).toContain("Available /demo targets:");
    expect(notifications[0].message).toContain("grouped");
    expect(notifications[0].message).toContain("write");
    expect(notifications[0].message).toContain("grep");
    expect(notifications[0].message).toContain("stop");

    const { ctx: ctxQuestion, notifications: notifsQuestion } = createMockCtx();
    await runPluginDemo(ctxQuestion as never, "?");
    expect(notifsQuestion[0].message).toContain("Available /demo targets:");
  });

  test("runPluginDemo warns and lists valid targets on unknown target", async () => {
    const { ctx, notifications } = createMockCtx();
    await runPluginDemo(ctx as never, "unknown_tool");

    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe("warning");
    expect(notifications[0].message).toContain('Unknown demo target "unknown_tool"');
    expect(notifications[0].message).toContain("Available targets:");
  });

  test("DEMO_OPTIONS provides complete labels, values, and descriptions for autocomplete", () => {
    expect(DEMO_OPTIONS.length).toBeGreaterThanOrEqual(10);
    for (const opt of DEMO_OPTIONS) {
      expect(typeof opt.value).toBe("string");
      expect(typeof opt.label).toBe("string");
      expect(typeof opt.description).toBe("string");
      expect(opt.description.length).toBeGreaterThan(0);
    }
  });
});
