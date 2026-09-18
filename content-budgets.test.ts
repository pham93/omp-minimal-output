import { afterEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG, setPluginConfigForTest } from "./core/config.ts";
import { detailProfile } from "./core/density.ts";

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
const { GroupedToolManager } = await import("./cards/grouped-tool-card.ts");
const { renderEvalCard } = await import("./cards/eval-card.ts");
const { renderWebSearchCard } = await import("./cards/web-search-card.ts");
const { paintReadGroupLines } = await import("./surfaces/read-group.ts");

function render(card: unknown, width = 100): string[] {
  const host = card as {
    render?: (width: number) => readonly string[];
    children?: Array<{ render?: (width: number) => readonly string[] }>;
  };
  return [...(host.render?.(width) ?? host.children?.[0]?.render?.(width) ?? [])].map(Bun.stripANSI);
}
const resultText = (text: string) => ({ content: [{ type: "text", text }] });
afterEach(() => setPluginConfigForTest(null));

describe("content allowances exclude card chrome", () => {
  test("each grouped execution retains its output even after a verbose sibling", () => {
    setPluginConfigForTest({ ...DEFAULT_CONFIG, standardOutputMaxRows: 2, hideThinkingBlock: true });
    const groups = new GroupedToolManager({
      rowIsLive: () => false,
      activityLabel: () => "Inspecting files",
      activityRunId: () => "content-budget",
      activityStartedAt: () => 0,
    });
    const profile = detailProfile({});
    const first = groups.renderToolVisual(null, "read:a", {
      body: "Read a.ts",
      live: false,
      error: false,
      detail: profile,
      details: ["a1", "", "a3", "a4"],
    });
    groups.renderToolVisual(null, "read:b", {
      body: "Read b.ts",
      live: false,
      error: false,
      detail: profile,
      details: ["b1", "b2", "b3"],
    });
    const lines = render(first);
    expect(lines.some((line) => line.includes("Read a.ts"))).toBe(true);
    expect(lines.some((line) => line.includes("Read b.ts"))).toBe(true);
    expect(lines.some((line) => line.trim() === "b1")).toBe(true);
    expect(lines.some((line) => line.trim() === "b2")).toBe(true);
    expect(lines.some((line) => line.includes("a3") || line.includes("b3"))).toBe(false);
    expect(lines.some((line) => line.includes("2 more lines"))).toBe(true);
    expect(lines.some((line) => line.includes("1 more lines"))).toBe(true);
  });

  test("Eval input and output retain independent allowances with a parent", () => {
    setPluginConfigForTest({ ...DEFAULT_CONFIG, standardMaxRows: 2, standardOutputMaxRows: 3 });
    const args = { language: "js", title: "Budget probe", code: "input_one\ninput_two\ninput_three" };
    const result = resultText("output_one\noutput_two\noutput_three\noutput_four");
    const lines = render(renderEvalCard(null, args, result, {}, false, undefined, "Evaluating"));
    expect(lines.filter((line) => /input_(one|two|three)/.test(line)).map((line) => line.trim())).toEqual([
      "input_one",
      "input_two",
    ]);
    expect(lines.filter((line) => /output_(one|two|three|four)/.test(line)).map((line) => line.trim())).toEqual([
      "output_one",
      "output_two",
      "output_three",
    ]);
    const partial = render(renderEvalCard(null, args, result, { isPartial: true }, true, undefined, "Evaluating"));
    expect(partial.filter((line) => /output_(one|two|three|four)/.test(line)).map((line) => line.trim())).toEqual([
      "output_two",
      "output_three",
      "output_four",
    ]);
  });

  test("Search retains complete selected source pairs even with a one-line output setting", () => {
    setPluginConfigForTest({ ...DEFAULT_CONFIG, standardOutputMaxRows: 1, webSearchMaxResults: 2 });
    const sources = Array.from({ length: 3 }, (_, i) => ({
      title: `Source ${i + 1}`,
      url: `https://example.test/${i + 1}`,
    }));
    const lines = render(
      renderWebSearchCard(
        null,
        { query: "budget" },
        {
          details: { response: { sources } },
        },
        {},
        undefined,
        "Finding sources",
      ),
    );
    expect(lines.some((line) => line.includes("Source 1"))).toBe(true);
    expect(lines.some((line) => line.includes("https://example.test/1"))).toBe(true);
    expect(lines.some((line) => line.includes("Source 2"))).toBe(true);
    expect(lines.some((line) => line.includes("https://example.test/2"))).toBe(true);
    expect(lines.some((line) => line.includes("Source 3"))).toBe(false);
    expect(lines.some((line) => line.includes("1 more source"))).toBe(true);
  });

  test("native read group counts entries without spending one on the header or hint", () => {
    setPluginConfigForTest({ ...DEFAULT_CONFIG, standardMaxRows: 1 });
    const lines = paintReadGroupLines(null, 100, [
      { id: "a", path: "first.ts", pending: false, error: false },
      { id: "b", path: "second.ts", pending: false, error: true },
    ]).map(Bun.stripANSI);
    expect(lines.some((line) => line.includes("Read 2 files"))).toBe(true);
    expect(lines.some((line) => line.includes("first.ts"))).toBe(true);
    expect(lines.some((line) => line.includes("1 more file"))).toBe(true);
  });
});
