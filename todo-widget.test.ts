import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, setPluginConfigForTest } from "./core/config.ts";

/*
 * Todo session-state tests. The class owns the parsed snapshot, the completion transitions, and the
 * panel's pump gate; the inline segment and the panel are painted by their own modules, so these tests
 * drive it through the same entry points index.ts uses and assert what the rest of the plugin reads.
 */
const { TodoWidget } = await import("./surfaces/todo-widget.ts");
const { parseTodoPhases, TODO_DONE_ANIM_MS } = await import("./surfaces/todos-header.ts");

function snapshot(tasks: Array<{ content: string; status: string }>) {
  return parseTodoPhases({ phases: [{ name: "Phase", tasks }] })!;
}

function widget() {
  return new TodoWidget({ owns: () => true, kickPump: () => {} });
}

describe("todo session state", () => {
  test("tracks the snapshot and reports whether the inline segment has todos", () => {
    setPluginConfigForTest({ ...DEFAULT_CONFIG, todosHeader: true });
    try {
      const state = widget();
      state.sessionVisible = true;
      expect(state.showsTodos(), "nothing before the first snapshot").toBe(false);

      state.applyState(snapshot([{ content: "Ship it", status: "in_progress" }]));
      expect(state.showsTodos()).toBe(true);
      expect(state.headerState?.items[0]?.label).toBe("Ship it");

      // A cleared list is a real snapshot: the segment disappears without unmounting anything.
      state.applyState({ items: [], open: 0, done: 0, blocked: 0, activeLabel: "" });
      expect(state.showsTodos()).toBe(false);
      expect(state.headerState).toBeNull();

      state.resetSessionState();
      expect(state.headerState).toBeNull();
      expect(state.panelOpen).toBe(false);
    } finally {
      setPluginConfigForTest(null);
    }
  });

  test("the pump is driven by the panel, not by the inline segment", () => {
    setPluginConfigForTest({ ...DEFAULT_CONFIG, todosHeader: true });
    try {
      const state = widget();
      state.sessionVisible = true;
      state.agentRunning = true;
      state.applyState(snapshot([{ content: "Ship it", status: "in_progress" }]));

      // A live run with an active row animated the composer row before this change; the inline segment
      // is timer-free, so the pump must stay asleep while the panel is closed.
      expect(state.needsPump(), "inline segment never needs the pump").toBe(false);
      expect(state.hasFastAnimation()).toBe(false);

      state.panelOpen = true;
      expect(state.needsPump(), "panel animates the active row").toBe(true);

      // Settling rows drive the strike window only while the panel can show it.
      state.agentRunning = false;
      const settled = snapshot([{ content: "Ship it", status: "completed" }]);
      state.applyState(snapshot([{ content: "Ship it", status: "in_progress" }]));
      state.applyState(settled);
      expect(state.hasFastAnimation(), "strike window is live right after a settle").toBe(true);
      expect(state.needsPump()).toBe(true);

      state.panelOpen = false;
      expect(state.hasFastAnimation(), "closed panel stops the strike animation").toBe(false);
      expect(state.needsPump()).toBe(false);

      state.panelOpen = true;
      // Past the strike window the row is static again.
      const key = [...state.completingAt.keys()][0]!;
      state.completingAt.set(key, Date.now() - TODO_DONE_ANIM_MS - 1);
      expect(state.hasFastAnimation()).toBe(false);
    } finally {
      setPluginConfigForTest(null);
    }
  });
});
