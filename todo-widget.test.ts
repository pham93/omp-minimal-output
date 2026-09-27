import { describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG, setPluginConfigForTest } from "./core/config.ts";

/*
 * Sticky todo summary tests.
 *
 * Mocks pi-tui's Container (the widget only needs `addChild`) and drives the widget through the same
 * entry points index.ts uses, so the composer-height and mount contracts are pinned at the surface
 * that paints them. The summary row itself is covered in todos-header.test.ts.
 */
mock.module("@oh-my-pi/pi-tui", () => ({
  Container: class {
    children: Array<{ render?: (width: number) => readonly string[] }> = [];
    addChild(child: { render?: (width: number) => readonly string[] }) {
      this.children.push(child);
    }
  },
  visibleWidth: (s: string) => Bun.stripANSI(s).length,
  padding: (w: number) => " ".repeat(Math.max(0, w)),
  sliceByColumn: (s: string, start: number, len: number) => s.slice(start, start + len),
  truncateToWidth: (s: string, w: number) => s.slice(0, w),
  matchesKey: (data: string, key: string) => data === key,
}));

mock.module("@oh-my-pi/pi-coding-agent", () => ({
  CustomEditor: class {},
  theme: { fg: (_token: string, text: string) => text },
}));

const { TodoWidget } = await import("./surfaces/todo-widget.ts");
const { parseTodoPhases } = await import("./surfaces/todos-header.ts");

const WIDTH = 80;
/** Minimal theme shape the row formatter reads. */
const THEME = { fg: (_token: string, text: string) => text } as unknown;

interface WidgetCalls {
  mounts: number;
  unmounts: number;
  renders: number;
}

function harness(calls: WidgetCalls) {
  const ui = {
    setWidget(key: string, value: unknown) {
      if (key !== "minimal-todos") return;
      if (value === undefined) calls.unmounts += 1;
      else calls.mounts += 1;
    },
    requestRender() {
      calls.renders += 1;
    },
  };
  const widget = new TodoWidget({ owns: () => true, kickPump: () => {} });
  widget.sessionVisible = true;
  widget.bindUi({ ui });
  return widget;
}

/** The widget's painted rows for the current state, as plain text. */
function paint(widget: InstanceType<typeof TodoWidget>): string[] {
  const container = widget.paintTodosWidget({}, THEME);
  const child = (container as unknown as { children: Array<{ render: (w: number) => string[] }> }).children[0]!;
  return child.render(WIDTH).map((line) => Bun.stripANSI(line));
}

function snapshot(tasks: Array<{ content: string; status: string }>) {
  return parseTodoPhases({ phases: [{ name: "Phase", tasks }] })!;
}

describe("sticky todo summary", () => {
  test("mounts once, keeps one row, and never unmounts on a cleared list", () => {
    setPluginConfigForTest({ ...DEFAULT_CONFIG, todosHeader: true });
    const calls: WidgetCalls = { mounts: 0, unmounts: 0, renders: 0 };
    try {
      const widget = harness(calls);
      widget.applyState(snapshot([{ content: "Ship it", status: "in_progress" }]));
      expect(calls.mounts, "first snapshot mounts the summary").toBe(1);
      expect(paint(widget), "one row while todos exist").toHaveLength(1);

      widget.applyState(snapshot([{ content: "Ship it", status: "completed" }]));
      expect(paint(widget), "still one row after an update").toHaveLength(1);

      // Clearing the list keeps the row (and the mount): unmounting would collapse the composer by a
      // row and hand the transcript card back in the same frame.
      widget.applyState({ items: [], open: 0, done: 0, blocked: 0, activeLabel: "" });
      expect(calls.unmounts, "cleared list does not unmount").toBe(0);
      expect(calls.mounts, "cleared list does not remount").toBe(1);
      expect(widget.showsTodos()).toBe(false);
      const cleared = paint(widget);
      expect(cleared, "cleared list keeps the row").toHaveLength(1);
      expect(cleared[0]).toContain("Todos — none");
    } finally {
      setPluginConfigForTest(null);
    }
  });

  test("the pump is driven by the panel, not by the summary", () => {
    setPluginConfigForTest({ ...DEFAULT_CONFIG, todosHeader: true });
    const calls: WidgetCalls = { mounts: 0, unmounts: 0, renders: 0 };
    try {
      const widget = harness(calls);
      widget.agentRunning = true;
      widget.applyState(snapshot([{ content: "Ship it", status: "in_progress" }]));

      // A live run with an active row animated the summary before this change; now it must not.
      expect(widget.needsPump(), "summary never needs the pump").toBe(false);
      expect(widget.hasFastAnimation()).toBe(false);

      widget.panelOpen = true;
      expect(widget.needsPump(), "panel animates the active row").toBe(true);
      widget.panelOpen = false;
      widget.agentRunning = false;
      expect(widget.needsPump()).toBe(false);
    } finally {
      setPluginConfigForTest(null);
    }
  });
});
