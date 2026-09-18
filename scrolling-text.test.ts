import { describe, expect, mock, test } from "bun:test";

mock.module("@oh-my-pi/pi-tui", () => ({
  visibleWidth: (s: string) => Bun.stripANSI(s).length,
  padding: (w: number) => " ".repeat(Math.max(0, w)),
  sliceByColumn: (s: string, start: number, len: number) => s.slice(start, start + len),
  truncateToWidth: (s: string, w: number) => s.slice(0, w),
  matchesKey: (data: string, key: string) => data === key,
}));

const { TextScroller, createTextScroller, defaultSlotOpacities, formatSettledThought } = await import("./surfaces/scrolling-text.ts");

describe("defaultSlotOpacities", () => {
  test("returns empty array for 0 lines", () => {
    expect(defaultSlotOpacities(0)).toEqual([]);
  });

  test("returns [1.0] for 1 line", () => {
    expect(defaultSlotOpacities(1, 1.0)).toEqual([1.0]);
  });

  test("returns [0.55, 1.0] for 2 lines", () => {
    const ops = defaultSlotOpacities(2, 1.0);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toBeCloseTo(0.55, 2);
    expect(ops[1]).toBeCloseTo(1.0, 2);
  });

  test("returns [0.4, 0.7, 1.0] for 3 lines with baseOpacity 1.0", () => {
    const ops = defaultSlotOpacities(3, 1.0);
    expect(ops).toHaveLength(3);
    expect(ops[0]).toBeCloseTo(0.4, 2);
    expect(ops[1]).toBeCloseTo(0.7, 2);
    expect(ops[2]).toBeCloseTo(1.0, 2);
  });

  test("scales with baseOpacity", () => {
    const ops = defaultSlotOpacities(3, 0.5);
    expect(ops[0]).toBeCloseTo(0.2, 2);
    expect(ops[1]).toBeCloseTo(0.35, 2);
    expect(ops[2]).toBeCloseTo(0.5, 2);
  });
});

describe("TextScroller basic operations", () => {
  test("initial render returns 3 placeholder lines", () => {
    const scroller = new TextScroller({ maxLines: 3 });
    const lines = scroller.render();
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.text).toBe("");
      expect(line.opacity).toBe(0);
      expect(line.isPlaceholder).toBe(true);
    }
  });

  test("configurable maxLines preserves placeholder count", () => {
    const scroller = new TextScroller({ maxLines: 5 });
    expect(scroller.render()).toHaveLength(5);
  });

  test("first line enters and begins fade-in", () => {
    const scroller = new TextScroller({ maxLines: 3, animationSpeed: 200 });
    const t0 = 1000;
    scroller.setLines(["Line 1"], t0);

    expect(scroller.isAnimating(t0)).toBe(true);
    const atStart = scroller.render(t0);
    expect(atStart[2].text).toBe("Line 1");
    // At t0, fade in is at start (0)
    expect(atStart[2].opacity).toBe(0);

    // Midway through transition
    const atMid = scroller.render(t0 + 100);
    expect(atMid[2].opacity).toBeGreaterThan(0);
    expect(atMid[2].opacity).toBeLessThan(1.0);

    // After transition completes
    const atEnd = scroller.render(t0 + 250);
    expect(scroller.isAnimating(t0 + 250)).toBe(false);
    expect(atEnd[2].text).toBe("Line 1");
    expect(atEnd[2].opacity).toBeCloseTo(1.0, 2);
  });

  test("extending current line does not restart transition", () => {
    const scroller = new TextScroller({ maxLines: 3, animationSpeed: 200 });
    const t0 = 1000;
    scroller.setLines(["Line 1"], t0);
    scroller.render(t0 + 250); // settle

    // Now user streams more text on the same line
    scroller.setLines(["Line 1 extended"], t0 + 300);
    expect(scroller.isAnimating(t0 + 300)).toBe(false);

    const rendered = scroller.render(t0 + 300);
    expect(rendered[2].text).toBe("Line 1 extended");
    expect(rendered[2].opacity).toBeCloseTo(1.0, 2);
  });

  test("new line shifting: line 1 shifts out, lines 2 & 3 shift up, line 4 enters", () => {
    const scroller = new TextScroller({
      maxLines: 3,
      animationSpeed: 200,
      opacities: [0.4, 0.7, 1.0],
    });

    // Populate with 3 lines and settle
    scroller.setLines(["Line 1", "Line 2", "Line 3"], 1000);
    const settled3 = scroller.render(1300);
    expect(settled3[0].text).toBe("Line 1");
    expect(settled3[0].opacity).toBeCloseTo(0.4, 2);
    expect(settled3[1].text).toBe("Line 2");
    expect(settled3[1].opacity).toBeCloseTo(0.7, 2);
    expect(settled3[2].text).toBe("Line 3");
    expect(settled3[2].opacity).toBeCloseTo(1.0, 2);

    // Now Line 4 enters!
    const tShift = 2000;
    scroller.setLines(["Line 1", "Line 2", "Line 3", "Line 4"], tShift);
    expect(scroller.isAnimating(tShift)).toBe(true);

    // Immediately at start of shift:
    // Slot 0 has Line 2 (shifted from slot 1)
    // Slot 1 has Line 3 (shifted from slot 2)
    // Slot 2 has Line 4 (new line entering with opacity 0)
    // Line 1 is shifted out of existence
    const shiftStart = scroller.render(tShift);
    expect(shiftStart).toHaveLength(3);
    expect(shiftStart[0].text).toBe("Line 2");
    expect(shiftStart[0].opacity).toBeCloseTo(0.7, 2); // coming from slot 1
    expect(shiftStart[1].text).toBe("Line 3");
    expect(shiftStart[1].opacity).toBeCloseTo(1.0, 2); // coming from slot 2
    expect(shiftStart[2].text).toBe("Line 4");
    expect(shiftStart[2].opacity).toBe(0); // fading in from 0

    // After shift completes:
    const shiftEnd = scroller.render(tShift + 250);
    expect(scroller.isAnimating(tShift + 250)).toBe(false);
    expect(shiftEnd[0].text).toBe("Line 2");
    expect(shiftEnd[0].opacity).toBeCloseTo(0.4, 2); // reached slot 0 target
    expect(shiftEnd[1].text).toBe("Line 3");
    expect(shiftEnd[1].opacity).toBeCloseTo(0.7, 2); // reached slot 1 target
    expect(shiftEnd[2].text).toBe("Line 4");
    expect(shiftEnd[2].opacity).toBeCloseTo(1.0, 2); // reached slot 2 target (highest opacity!)
  });

  test("update with wrapping text splits correctly and shifts", () => {
    const scroller = createTextScroller({ maxLines: 3, animationSpeed: 200 });
    // Width 20: words wrap
    scroller.update("One two three four five six seven eight nine ten eleven twelve", 20, 1000);
    const rendered = scroller.render(1300);
    expect(rendered).toHaveLength(3);
    expect(rendered[0].isPlaceholder).toBe(false);
    expect(rendered[1].isPlaceholder).toBe(false);
    expect(rendered[2].isPlaceholder).toBe(false);
    // Highest opacity on latest line
    expect(rendered[2].opacity).toBeGreaterThan(rendered[1].opacity);
    expect(rendered[1].opacity).toBeGreaterThan(rendered[0].opacity);
  });

  test("reset clears all state back to placeholders", () => {
    const scroller = new TextScroller({ maxLines: 3 });
    scroller.setLines(["Line 1", "Line 2", "Line 3"]);
    scroller.reset();

    const lines = scroller.render();
    expect(lines).toHaveLength(3);
    expect(lines[0].text).toBe("");
    expect(lines[0].isPlaceholder).toBe(true);
    expect(lines[1].text).toBe("");
    expect(lines[2].text).toBe("");
  });

  test("bottom-to-top fill direction pads at top", () => {
    const scroller = new TextScroller({ maxLines: 3, fillDirection: "bottom-to-top" });
    scroller.setLines(["Single line"], 1000);
    const lines = scroller.render(1300);
    expect(lines).toHaveLength(3);
    expect(lines[0].text).toBe("");
    expect(lines[0].isPlaceholder).toBe(true);
    expect(lines[1].text).toBe("");
    expect(lines[1].isPlaceholder).toBe(true);
    expect(lines[2].text).toBe("Single line");
    expect(lines[2].isPlaceholder).toBe(false);
  });

  test("multi-line jump in one update smoothly shifts window", () => {
    const scroller = new TextScroller({ maxLines: 3, animationSpeed: 200 });
    scroller.setLines(["L1", "L2", "L3"], 1000);
    scroller.render(1300);

    // Jump by 2 new lines at once (L4 and L5)
    scroller.setLines(["L1", "L2", "L3", "L4", "L5"], 2000);
    expect(scroller.isAnimating(2000)).toBe(true);

    // After settling
    const settled = scroller.render(2300);
    expect(settled[0].text).toBe("L3");
    expect(settled[1].text).toBe("L4");
    expect(settled[2].text).toBe("L5");
  });
});

describe("formatSettledThought", () => {
  test("returns empty array for empty or whitespace text", () => {
    expect(formatSettledThought("", { maxLines: 5, width: 80 })).toEqual([]);
    expect(formatSettledThought("   \n  \n  ", { maxLines: 5, width: 80 })).toEqual([]);
  });

  test("renders short thoughts without previous lines hint", () => {
    const text = "Line one\nLine two\nLine three";
    const lines = formatSettledThought(text, { maxLines: 5, width: 80 }).map(Bun.stripANSI);
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe("");
    expect(lines[0]).toContain("│ Line one");
    expect(lines[1]).toContain("│ Line two");
    expect(lines[2]).toContain("│ Line three");
    // No line number gutter
    expect(lines[0]).not.toMatch(/\d+\s*│/);
    // No previous lines hint
    expect(lines.some((l: string) => l.includes("previous lines"))).toBe(false);
  });

  test("standard mode truncates to maxLines and prepends (...N previous lines)", () => {
    // 15 lines of thought, maxLines = 5
    const thought = Array.from({ length: 15 }, (_, i) => `Thought step ${i + 1}`).join("\n");
    const lines = formatSettledThought(thought, { maxLines: 5, width: 80 }).map(Bun.stripANSI);

    // 1 hint line + 5 visible lines = 6 lines
    expect(lines).toHaveLength(7);
    expect(lines[6]).toBe("");
    expect(lines[0]).toContain("│ (...10 previous lines)");
    expect(lines[1]).toContain("│ Thought step 11");
    expect(lines[2]).toContain("│ Thought step 12");
    expect(lines[3]).toContain("│ Thought step 13");
    expect(lines[4]).toContain("│ Thought step 14");
    expect(lines[5]).toContain("│ Thought step 15");

    // No line numbers like "1 │ "
    for (const l of lines) {
      expect(l).not.toMatch(/^\s*\d+\s*│/);
    }
  });

  test("minimal mode displays exactly 1 line with truncation hint", () => {
    const thought = "Step A\nStep B\nStep C\nStep D";
    const lines = formatSettledThought(thought, { maxLines: 1, width: 80 }).map(Bun.stripANSI);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("");
    expect(lines[0]).toContain("│ (...3 previous lines)");
    expect(lines[1]).toContain("│ Step D");
  });

  test("detailed mode displays up to detailedMaxRows (20 lines)", () => {
    const thought = Array.from({ length: 25 }, (_, i) => `Step ${i + 1}`).join("\n");
    const lines = formatSettledThought(thought, { maxLines: 20, width: 80 }).map(Bun.stripANSI);
    expect(lines).toHaveLength(22);
    expect(lines[21]).toBe("");
    expect(lines[0]).toContain("│ (...5 previous lines)");
    expect(lines[1]).toContain("│ Step 6");
    expect(lines[20]).toContain("│ Step 25");
  });

  test("custom indentation is applied to rail bar", () => {
    const text = "Single thought line";
    const lines = formatSettledThought(text, { maxLines: 5, width: 80, indent: "    " }).map(Bun.stripANSI);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("");
    expect(lines[0]).toBe("    │ Single thought line");
  });
});
