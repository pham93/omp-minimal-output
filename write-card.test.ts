import { describe, expect, mock, test } from "bun:test";
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
}));

// Dynamic import: mock.module() above must execute before write-card.ts
// loads, so a hoisted static import cannot work here.
const {
  cascadingLineOpacity,
  renderWriteCard,
  resetWriteCardFadesForTest,
  WRITE_CASCADE_STAGGER_MS,
  WRITE_LINE_FADE_DURATION_MS,
} = await import("./cards/write-card.ts");

function stripAnsi(text: string): string {
  return Bun.stripANSI(text);
}

interface RenderHost {
  render?: (width: number) => readonly string[];
  children?: Array<{ render?: (width: number) => readonly string[] }>;
}

function renderCard(container: unknown, width = 100): string[] {
  if (typeof container === "object" && container !== null) {
    const host = container as RenderHost;
    if (typeof host.render === "function") return [...host.render(width)];
    if (Array.isArray(host.children) && typeof host.children[0]?.render === "function") {
      return [...host.children[0].render(width)];
    }
  }
  return [];
}

describe("write-card latest lines and hint projection", () => {
  test("renders all lines without hint when content fits within row limit", () => {
    resetWriteCardFadesForTest();
    setPluginConfigForTest(null);
    const content = ["line 1", "line 2", "line 3"].join("\n");
    const container = renderWriteCard(null, { path: "src/short.ts", content }, "ok", {});
    const lines = renderCard(container, 100).map(stripAnsi);

    expect(lines[0]).toContain("Write src/short.ts — 3 lines");
    expect(lines.some((l) => l.includes("previous lines"))).toBe(false);
    expect(lines[1]).toContain("1 │ line 1");
    expect(lines[2]).toContain("2 │ line 2");
    expect(lines[3]).toContain("3 │ line 3");
  });

  test("renders latest lines with Thought-style hint at top when content exceeds limit", () => {
    resetWriteCardFadesForTest();
    setPluginConfigForTest(null);
    const all = Array.from({ length: 30 }, (_, i) => `content row ${i + 1}`);
    const content = all.join("\n");
    const container = renderWriteCard(null, { path: "src/long.ts", content }, "ok", {});
    const lines = renderCard(container, 100).map(stripAnsi);

    expect(lines[0]).toContain("Write src/long.ts — 30 lines");
    const hintIndex = lines.findIndex((l) => l.includes("previous lines"));
    expect(hintIndex).toBe(1);
    expect(lines[1]).toContain("│ (...");
    expect(lines[1]).toContain("previous lines)");

    // Must NOT contain early lines (word boundary ensures row 23 doesn't falsely match row 2)
    expect(lines.some((l) => /\bcontent row 1\b/.test(l))).toBe(false);
    expect(lines.some((l) => /\bcontent row 2\b/.test(l))).toBe(false);
    const lastLine = lines[lines.length - 1] ?? "";
    expect(lastLine).toContain("30 │ content row 30");

    // Line numbers in the gutter must be accurate 1-based numbers
    const visibleRows = lines.slice(2);
    for (const row of visibleRows) {
      const match = /(\d+)\s*│\s*content row (\d+)/.exec(row);
      expect(match).not.toBeNull();
      expect(match![1]).toBe(match![2]);
    }
  });

  test("dynamically adapts window and previous lines hint as streaming chunks arrive", () => {
    resetWriteCardFadesForTest();
    setPluginConfigForTest(null);

    // Frame 1: 5 lines arrive (fits in available rows)
    const chunk1 = Array.from({ length: 5 }, (_, i) => `streaming line ${i + 1}`).join("\n");
    const card1 = renderWriteCard(null, { path: "src/stream.ts", content: chunk1 }, "ok", {});
    const lines1 = renderCard(card1, 100).map(stripAnsi);
    expect(lines1[0]).toContain("Write src/stream.ts — 5 lines");
    expect(lines1.some((l) => l.includes("previous lines"))).toBe(false);

    // Frame 2: 25 lines have arrived (exceeds standard 10 rows: 1 header + 1 hint + 8 content)
    const chunk2 = Array.from({ length: 25 }, (_, i) => `streaming line ${i + 1}`).join("\n");
    const card2 = renderWriteCard(null, { path: "src/stream.ts", content: chunk2 }, "ok", {});
    const lines2 = renderCard(card2, 100).map(stripAnsi);
    expect(lines2[0]).toContain("Write src/stream.ts — 25 lines");
    // 25 - 8 = 17 previous lines
    expect(lines2[1]).toContain("│ (...17 previous lines)");
    expect(lines2[lines2.length - 1]).toContain("25 │ streaming line 25");

    // Frame 3: 50 lines have arrived (hint adapts to 50 - 8 = 42 previous lines)
    const chunk3 = Array.from({ length: 50 }, (_, i) => `streaming line ${i + 1}`).join("\n");
    const card3 = renderWriteCard(null, { path: "src/stream.ts", content: chunk3 }, "ok", {});
    const lines3 = renderCard(card3, 100).map(stripAnsi);
    expect(lines3[0]).toContain("Write src/stream.ts — 50 lines");
    expect(lines3[1]).toContain("│ (...42 previous lines)");
    expect(lines3[lines3.length - 1]).toContain("50 │ streaming line 50");
  });

  test("preserves syntax highlighting on written content lines", () => {
    resetWriteCardFadesForTest();
    setPluginConfigForTest(null);
    const code = 'export function hello(name: string): string {\n  return "hi " + name;\n}';
    const container = renderWriteCard(null, { path: "src/hello.ts", content: code }, "ok", {});
    const rendered = renderCard(container, 100);

    const hasAnsi = rendered.some((l) => l.includes("\x1b["));
    expect(hasAnsi).toBe(true);

    const plain = rendered.map(stripAnsi);
    expect(plain[0]).toContain("Write src/hello.ts — 3 lines");
    expect(plain[1]).toContain("1 │ export function hello");
    expect(plain[2]).toContain('2 │   return "hi " + name;');
    expect(plain[3]).toContain("3 │ }");
  });

  test("renders single line header in minimal mode", () => {
    resetWriteCardFadesForTest();
    setPluginConfigForTest({ ...DEFAULT_CONFIG, detailLevel: "minimal" });
    const container = renderWriteCard(null, { path: "src/test.ts", content: "const a = 1;\nconst b = 2;" }, "ok", {});
    const lines = renderCard(container, 100).map(stripAnsi);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Write src/test.ts — 2 lines");
    setPluginConfigForTest(null);
  });
});

describe("cascading line opacity animation (Option 1)", () => {
  test("returns restOpacity when startedAt is undefined (historical / settled)", () => {
    const rest = 0.7;
    expect(cascadingLineOpacity(0, 5, undefined, rest)).toBe(rest);
    expect(cascadingLineOpacity(4, 5, undefined, rest)).toBe(rest);
  });

  test("line 0 appears immediately at 1.0 opacity while subsequent lines stream in", () => {
    const started = 1000;
    const now = 1000;
    const rest = 0.7;
    const totalLines = 5;

    // Line 0 is visible immediately at full brightness
    expect(cascadingLineOpacity(0, totalLines, started, rest, now)).toBe(1.0);

    // Lines 1..4 have not streamed in yet
    for (let i = 1; i < totalLines; i++) {
      expect(cascadingLineOpacity(i, totalLines, started, rest, now)).toBeNull();
    }
  });

  test("lines stream in sequentially, each starting at 1.0 and cascading down", () => {
    const started = 1000;
    const rest = 0.7;
    const totalLines = 5;

    // At t = 1270ms (270ms elapsed, stagger = 90ms):
    // lines 0, 1, 2, 3 have appeared; line 4 has not
    const now = 1270;

    const op0 = cascadingLineOpacity(0, totalLines, started, rest, now);
    const op1 = cascadingLineOpacity(1, totalLines, started, rest, now);
    const op2 = cascadingLineOpacity(2, totalLines, started, rest, now);
    const op3 = cascadingLineOpacity(3, totalLines, started, rest, now);
    const op4 = cascadingLineOpacity(4, totalLines, started, rest, now);

    expect(op0).not.toBeNull();
    expect(op1).not.toBeNull();
    expect(op2).not.toBeNull();
    expect(op3).not.toBeNull();

    // Earlier lines have been fading longer -> lower opacity
    expect(op0!).toBeLessThan(op1!);
    expect(op1!).toBeLessThan(op2!);
    expect(op2!).toBeLessThan(op3!);
    expect(op3!).toBe(1.0); // Line 3 just arrived at 1.0

    // Line 4 hasn't arrived yet
    expect(op4).toBeNull();
  });

  test("all lines settle to restOpacity once duration and stagger have elapsed", () => {
    const started = 1000;
    const rest = 0.7;
    const totalLines = 5;
    const now = 1000 + WRITE_LINE_FADE_DURATION_MS + totalLines * WRITE_CASCADE_STAGGER_MS + 100;

    for (let i = 0; i < totalLines; i++) {
      const op = cascadingLineOpacity(i, totalLines, started, rest, now);
      expect(op).toBe(rest);
    }
  });
});
