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
const { runPluginDemo } = await import("./surfaces/demo-showcase.ts");

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
});
