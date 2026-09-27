import { describe, expect, mock, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { DEFAULT_CONFIG, setPluginConfigForTest } from "./core/config.ts";
import type { TodoHeaderState } from "./surfaces/todos-header.ts";

/*
 * Todos panel tests: the overlay component's frame, scroll clamp, and close key, plus the module-level
 * lifecycle that has to survive a host that never resolves `ui.custom`.
 *
 * pi-tui is mocked before the module loads, mirroring todos-header.test.ts. The width helpers have to
 * be ANSI-aware: the panel pads and truncates *painted* rows, so a naive `slice` would cut the frame
 * at the first color sequence and hide the bug the assertions are looking for.
 */
const ANSI_PART = String.raw`\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b\u009c]*(?:\x07|\x1b\\|\u009c)|\x1b[ -/]*[0-~]?`;

interface AnsiToken {
  ansi: boolean;
  text: string;
}

function tokenize(value: string): AnsiToken[] {
  const tokens: AnsiToken[] = [];
  const re = new RegExp(ANSI_PART, "g");
  let last = 0;
  for (let match = re.exec(value); match !== null; match = re.exec(value)) {
    if (match.index > last) for (const ch of value.slice(last, match.index)) tokens.push({ ansi: false, text: ch });
    tokens.push({ ansi: true, text: match[0] });
    last = match.index + match[0].length;
  }
  for (const ch of value.slice(last)) tokens.push({ ansi: false, text: ch });
  return tokens;
}

const mockVisibleWidth = (value: string): number => tokenize(value).filter((token) => !token.ansi).length;

function mockTruncateToWidth(text: string, maxWidth: number, ellipsis = ""): string {
  const out: string[] = [];
  let width = 0;
  let truncated = false;
  for (const token of tokenize(text)) {
    if (token.ansi) {
      out.push(token.text);
      continue;
    }
    if (width < maxWidth) {
      out.push(token.text);
      width += 1;
      continue;
    }
    truncated = true;
  }
  if (truncated && ellipsis) out.push(ellipsis);
  return out.join("");
}

mock.module("@oh-my-pi/pi-tui", () => ({
  Container: class {
    children: unknown[] = [];
    addChild(child: unknown) {
      this.children.push(child);
    }
  },
  visibleWidth: mockVisibleWidth,
  padding: (w: number) => " ".repeat(Math.max(0, w)),
  sliceByColumn: (s: string, start: number, len: number) => s.slice(start, start + len),
  truncateToWidth: mockTruncateToWidth,
  matchesKey: (data: string, key: string) => data === key,
}));

mock.module("@oh-my-pi/pi-coding-agent", () => ({
  CustomEditor: class {},
  theme: { fg: (_token: string, text: string) => text },
}));

const { TodoPanel, closeTodoPanel, isTodoPanelOpen, openTodoPanel } = await import("./surfaces/todo-panel.ts");
const { parseTodoPhases, renderDensityTodoHeader } = await import("./surfaces/todos-header.ts");

const WIDTH = 60;
const THEME = {
  boxRound: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
  fg: (_token: string, text: string) => text,
};

function state(count: number): TodoHeaderState {
  const tasks = Array.from({ length: count }, (_value, index) => ({
    content: `Task ${index + 1}`,
    status: index === 0 ? "in_progress" : "pending",
  }));
  return parseTodoPhases({ phases: [{ name: "Phase", tasks }] })!;
}

function panelFor(rows: TodoHeaderState | null, calls = { done: 0, renders: 0 }) {
  const panel = new TodoPanel(THEME, {
    state: () => rows,
    anim: () => ({ now: 1_000, completingAt: new Map(), running: true }),
    requestRender: () => {
      calls.renders += 1;
    },
    done: () => {
      calls.done += 1;
    },
  });
  return { panel, calls };
}

describe("todos panel", () => {
  test("frames the list and pads every row to the panel width", () => {
    const { panel } = panelFor(state(3));
    const lines = panel.render(WIDTH, 24);
    expect(Bun.stripANSI(lines[0]!)).toStartWith("╭─ Todos ");
    expect(Bun.stripANSI(lines.at(-1)!)).toBe(`╰${"─".repeat(WIDTH - 2)}╯`);
    const body = lines.slice(1, -1).map((line) => Bun.stripANSI(line));
    expect(body.some((row) => row.includes("Task 1"))).toBe(true);
    for (const row of lines) expect(Bun.stripANSI(row).length).toBe(WIDTH);
  });

  test("esc and the toggle shortcut close, other keys leave the panel open", () => {
    const first = panelFor(state(3));
    first.panel.handleInput("x");
    first.panel.handleInput("\x1b[B");
    expect(first.calls.done).toBe(0);
    first.panel.handleInput("\x1b");
    expect(first.calls.done).toBe(1);

    // The overlay owns the keyboard, so the shortcut that opened the panel must close it here too.
    const second = panelFor(state(3));
    second.panel.handleInput("\x1b\x14");
    expect(second.calls.done).toBe(1);
  });

  test("scrolling clamps to the list and repaints only when the offset moves", () => {
    const rows = state(20);
    const { panel, calls } = panelFor(rows);
    panel.render(WIDTH, 24);
    expect(panel.scrollOffset()).toBe(0);

    panel.handleInput("\x1b[A");
    expect(panel.scrollOffset(), "up at the top is a no-op").toBe(0);
    expect(calls.renders, "no repaint without movement").toBe(0);

    panel.handleInput("\x1b[B");
    expect(panel.scrollOffset()).toBe(1);
    expect(calls.renders).toBe(1);

    for (let index = 0; index < 60; index += 1) panel.handleInput("\x1b[B");
    const bodyHeight = panel.render(WIDTH, 24).length - 2;
    const listRows = renderDensityTodoHeader(THEME, WIDTH - 4, rows, true, undefined, "hint").length;
    expect(listRows, "fixture outgrows the panel").toBeGreaterThan(bodyHeight);
    expect(panel.scrollOffset(), "clamped to the last full window").toBe(listRows - bodyHeight);
  });

  test("an empty list renders the frame without rows", () => {
    const { panel } = panelFor(null);
    const lines = panel.render(WIDTH, 24);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const row of lines) expect(Bun.stripANSI(row).length).toBe(WIDTH);
  });
});

describe("todos panel lifecycle", () => {
  test("opens once, closes through the host's done callback, and gates the pump", async () => {
    setPluginConfigForTest({ ...DEFAULT_CONFIG });
    const opens: boolean[] = [];
    let options: { overlay?: boolean; overlayOptions?: Record<string, unknown> } | undefined;
    let closeFromHost: (() => void) | undefined;
    const ctx = {
      ui: {
        custom: (factory: unknown, customOptions: unknown) => {
          options = customOptions as typeof options;
          const { promise, resolve } = Promise.withResolvers<unknown>();
          closeFromHost = () => resolve(undefined);
          (factory as (tui: unknown, theme: unknown, keys: unknown, done: (r: unknown) => void) => unknown)(
            { requestRender() {} },
            THEME,
            {},
            () => resolve(undefined),
          );
          return promise;
        },
      },
    } as unknown as ExtensionContext;

    const deps = {
      state: () => state(2),
      anim: () => ({ now: 1_000, completingAt: new Map(), running: true }),
      onOpenChange: (open: boolean) => opens.push(open),
    };
    try {
      const opening = openTodoPanel(ctx, deps);
      expect(isTodoPanelOpen(), "open flag set synchronously").toBe(true);
      expect(options?.overlay, "overlay route").toBe(true);
      expect(options?.overlayOptions?.anchor).toBe("bottom-center");

      // A second open while the panel is up must not stack a second overlay.
      await openTodoPanel(ctx, deps);
      expect(opens).toEqual([true]);

      closeTodoPanel();
      await opening;
      expect(isTodoPanelOpen()).toBe(false);
      expect(opens, "pump gate released").toEqual([true, false]);
      expect(typeof closeFromHost).toBe("function");
    } finally {
      closeTodoPanel();
      setPluginConfigForTest(null);
    }
  });

  test("a host without ui.custom leaves the summary as the only todo surface", async () => {
    const opens: boolean[] = [];
    await openTodoPanel({} as unknown as ExtensionContext, {
      state: () => state(1),
      anim: () => ({ now: 0, completingAt: new Map(), running: false }),
      onOpenChange: (open: boolean) => opens.push(open),
    });
    expect(isTodoPanelOpen()).toBe(false);
    expect(opens).toEqual([]);
  });
});
