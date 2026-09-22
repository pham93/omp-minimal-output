import { describe, expect, mock, test } from "bun:test";

/*
 * Todo header rendering tests.
 *
 * Mocks pi-tui before importing the module under test, mirroring scrolling-text.test.ts.
 */
mock.module("@oh-my-pi/pi-tui", () => ({
  Container: class {
    children: unknown[] = [];
    addChild(child: unknown) {
      this.children.push(child);
    }
  },
  visibleWidth: (s: string) => Bun.stripANSI(s).length,
  padding: (w: number) => " ".repeat(Math.max(0, w)),
  sliceByColumn: (s: string, start: number, len: number) => s.slice(start, start + len),
  truncateToWidth: (s: string, w: number) => s.slice(0, w),
  matchesKey: (data: string, key: string) => data === key,
}));

const { TODO_DONE_ANIM_MS, TODO_STRIKE_HOLD_MS, renderDensityTodoHeader, renderTodoHeader, todoItemKey, todoStatusBox } =
  await import("./surfaces/todos-header.ts");
const { paintAt } = await import("./core/theme.ts");
const { DEFAULT_CONFIG, setPluginConfigForTest } = await import("./core/config.ts");

/** Minimal theme shape the renderer uses: `fg(token, text)` plus the host's checkbox glyphs. */
const BOX_THEME = {
  fg: (_token: string, text: string) => text,
  checkbox: { checked: "\u2611", unchecked: "\u2610" },
} as unknown;

const ASCII_THEME = { fg: (_token: string, text: string) => text } as unknown;

function state() {
  return {
    items: [
      { label: "Settled item", status: "done" as const },
      { label: "Pending item", status: "open" as const },
      { label: "Running item", status: "active" as const },
      { label: "Blocked item", status: "blocked" as const, note: "needs input" },
      { label: "Dropped item", status: "dropped" as const },
    ],
    open: 3,
    done: 1,
    blocked: 1,
    activeLabel: "Running item",
  };
}

/** Unlimited phase window so every fixture row is rendered. */
function render(theme: unknown, anim?: Parameters<typeof renderTodoHeader>[4]): string[] {
  return renderTodoHeader(theme, 80, state(), false, anim, Number.POSITIVE_INFINITY);
}

function plainRows(theme: unknown, anim?: Parameters<typeof renderTodoHeader>[4]): string[] {
  return render(theme, anim).map((line) => Bun.stripANSI(line));
}

describe("todo status boxes", () => {
  test("uses the theme checkbox glyphs, with box-family intermediates", () => {
    expect(todoStatusBox(BOX_THEME, "open")).toBe("\u2610");
    expect(todoStatusBox(BOX_THEME, "done")).toBe("\u2611");
    // Intermediate states stay in the same box family: box with X / box with minus.
    expect(todoStatusBox(BOX_THEME, "blocked")).toBe("\u2612");
    expect(todoStatusBox(BOX_THEME, "dropped")).toBe("\u229f");
  });

  test("falls back to ascii boxes with the marker inside", () => {
    expect(todoStatusBox(ASCII_THEME, "open")).toBe("[ ]");
    expect(todoStatusBox(ASCII_THEME, "done")).toBe("[x]");
    expect(todoStatusBox(ASCII_THEME, "blocked")).toBe("[!]");
    expect(todoStatusBox(ASCII_THEME, "dropped")).toBe("[-]");
  });

  test("renders one box per row and keeps the active indicator", () => {
    const rows = plainRows(BOX_THEME);
    expect(rows.some((row) => row.includes("\u2611 Settled item"))).toBe(true);
    expect(rows.some((row) => row.includes("\u2610 Pending item"))).toBe(true);
    expect(rows.some((row) => row.includes("\u2612 Blocked item"))).toBe(true);
    expect(rows.some((row) => row.includes("\u229f Dropped item"))).toBe(true);
    // In-progress rows keep the existing indicator instead of a box.
    expect(rows.some((row) => row.includes("◐ Running item"))).toBe(true);
  });
});

describe("todo row painting", () => {
  test("pending rows keep the unchanged label color at the configured opacity", () => {
    setPluginConfigForTest({ ...DEFAULT_CONFIG, opacity: 0.75 });
    try {
      const rows = render(BOX_THEME);
      const pending = rows.find((row) => row.includes("Pending item"));
      expect(pending).toBeDefined();
      expect(pending!.endsWith(paintAt(BOX_THEME, "Pending item", "toolOutput", 0.75))).toBe(true);
    } finally {
      setPluginConfigForTest(null);
    }
  });

  test("historical settled rows are struck through without an animation", () => {
    const rows = render(BOX_THEME);
    const settled = rows.find((row) => row.includes("Settled item"));
    expect(settled).toContain("\x1b[9m");
    expect(settled).toContain("\x1b[29m");
    // Fully covered: the strike wraps the whole label.
    expect(Bun.stripANSI(/\x1b\[9m(.*?)\x1b\[29m/.exec(settled!)?.[1] ?? "")).toBe("Settled item");
  });

  test("the strike line sweeps across a just-settled row", () => {
    const startedAt = 10_000;
    const key = todoItemKey({ label: "Settled item", status: "done" });
    const anim = (now: number) => ({ now, completingAt: new Map([[key, startedAt]]), running: false });
    // A partially struck label is split by SGR 9, so locate rows on the stripped text.
    const find = (lines: string[]) => lines.find((row) => Bun.stripANSI(row).includes("Settled item")) ?? "";
    const struck = (row: string) => Bun.stripANSI(/\x1b\[9m(.*?)\x1b\[29m/.exec(row)?.[1] ?? "");

    const held = find(render(BOX_THEME, anim(startedAt)));
    expect(held).not.toBe("");
    expect(held).not.toContain("\x1b[9m");

    const mid = find(render(BOX_THEME, anim(startedAt + TODO_STRIKE_HOLD_MS + TODO_DONE_ANIM_MS / 4)));
    expect(struck(mid).length).toBeGreaterThan(0);
    expect(struck(mid).length).toBeLessThan("Settled item".length);

    const swept = find(render(BOX_THEME, anim(startedAt + TODO_DONE_ANIM_MS)));
    expect(struck(swept)).toBe("Settled item");
  });

  test("abandoned rows are struck through too", () => {
    const rows = render(BOX_THEME);
    const dropped = rows.find((row) => row.includes("Dropped item"));
    expect(dropped).toContain("\x1b[9m");
  });

  test("rows share the card content column", async () => {
    const { cardDetailLine } = await import("./cards/card-primitives.ts");
    const contentColumn = Bun.stripANSI(cardDetailLine(BOX_THEME, 100, "detail text")).indexOf("detail text");

    // The parent row carries its padding before the mark, so the mark is never flush left.
    const expanded = Bun.stripANSI(renderTodoHeader(BOX_THEME, 100, state(), false)[0]!);
    const collapsed = Bun.stripANSI(renderTodoHeader(BOX_THEME, 100, state(), true)[0]!);
    expect(collapsed.startsWith(" ")).toBe(true);
    expect(expanded.startsWith(" ")).toBe(true);
    expect(expanded.indexOf("Todos")).toBe(contentColumn);

    // Task labels land on the content column too (glyph boxes are one cell wide).
    const row = renderTodoHeader(BOX_THEME, 100, state(), false).find((line) =>
      Bun.stripANSI(line).includes("Pending item"),
    )!;
    expect(Bun.stripANSI(row).indexOf("Pending item")).toBe(contentColumn);
  });

  test("the expanded overflow row keeps the header row's indent", () => {
    setPluginConfigForTest({ ...DEFAULT_CONFIG, detailedMaxRows: 2 });
    try {
      const rows = renderDensityTodoHeader(BOX_THEME, 100, state(), true).map((line) => Bun.stripANSI(line));
      const lead = (row: string) => row.length - row.trimStart().length;
      // `capRenderedRows` replaces the tail, so the overflow row is a peer of the header row.
      expect(rows.at(-1)).toContain("more rows");
      expect(lead(rows.at(-1)!)).toBe(lead(rows[0]!));
    } finally {
      setPluginConfigForTest(null);
    }
  });
});
