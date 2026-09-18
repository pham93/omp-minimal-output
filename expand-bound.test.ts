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

const { boundedTextLines } = await import("./core/text.ts");
const { CARD_RENDER_PHASE } = await import("./cards/card-registry.ts");
const { GroupedToolManager, renderGroupedToolCard } = await import("./cards/grouped-tool-card.ts");
const { renderEvalCard } = await import("./cards/eval-card.ts");

function render(card: unknown, width = 120): string[] {
  const host = card as {
    render?: (width: number) => readonly string[];
    children?: Array<{ render?: (width: number) => readonly string[] }>;
  };
  return [...(host.render?.(width) ?? host.children?.[0]?.render?.(width) ?? [])].map(Bun.stripANSI);
}

afterEach(() => setPluginConfigForTest(null));

describe("boundedTextLines", () => {
  test("takes the head, strips trailing blanks, and reports the full total", () => {
    const text = "a\nb\nc\n\n";
    expect(boundedTextLines(text, 2)).toEqual({ lines: ["a", "b"], total: 3 });
    expect(boundedTextLines(text, 10)).toEqual({ lines: ["a", "b", "c"], total: 3 });
  });

  test("takes the tail for streaming windows", () => {
    expect(boundedTextLines("a\nb\nc\nd", 2, "tail")).toEqual({ lines: ["c", "d"], total: 4 });
  });

  test("treats CRLF as one line break", () => {
    expect(boundedTextLines("a\r\nb\r\n", 5)).toEqual({ lines: ["a", "b"], total: 2 });
  });
});

describe("Ctrl+O expand does not materialize omitted grouped lines", () => {
  test("bash cards keep the omission count without retaining the omitted body", () => {
    setPluginConfigForTest({ ...DEFAULT_CONFIG, standardOutputMaxRows: 2, detailedMaxRows: 4 });
    const lines = Array.from({ length: 5000 }, (_, i) => `line_${i}`);
    const text = lines.join("\n");
    const groups = new GroupedToolManager({
      rowIsLive: () => false,
      activityLabel: () => "Running tests",
      activityRunId: () => "expand-bound",
      activityStartedAt: () => 0,
    });
    const card = renderGroupedToolCard({
      toolName: "bash",
      phase: CARD_RENDER_PHASE.result,
      theme: null,
      args: { command: "bun test" },
      options: { expanded: true },
      result: { content: [{ type: "text", text }], details: { minimalFullText: text } },
      fingerprint: "bash:bun test",
      parentLabel: () => "",
      groupedTools: groups,
    });
    const painted = render(card);
    expect(painted.some((line) => line.includes("line_0"))).toBe(true);
    expect(painted.some((line) => line.includes("line_3"))).toBe(true);
    expect(painted.some((line) => line.includes("line_4"))).toBe(false);
    expect(painted.some((line) => line.includes("line_4999"))).toBe(false);
    expect(painted.some((line) => line.includes("4996 more lines"))).toBe(true);
  });

  test("grep highlights only the visible match window", () => {
    setPluginConfigForTest({ ...DEFAULT_CONFIG, detailedMaxRows: 3 });
    const text = Array.from({ length: 2000 }, (_, i) => `src/foo.ts:${i}:code_${i}`).join("\n");
    const groups = new GroupedToolManager({
      rowIsLive: () => false,
      activityLabel: () => "Searching",
      activityRunId: () => "expand-bound-grep",
      activityStartedAt: () => 0,
    });
    const card = renderGroupedToolCard({
      toolName: "grep",
      phase: CARD_RENDER_PHASE.result,
      theme: { fg: (_token: string, value: string) => value },
      args: { pattern: "code" },
      options: { expanded: true },
      result: { content: [{ type: "text", text }], details: { minimalFullText: text } },
      fingerprint: "grep:code",
      parentLabel: () => "",
      groupedTools: groups,
    });
    const painted = render(card);
    expect(painted.some((line) => line.includes("code_0"))).toBe(true);
    expect(painted.some((line) => line.includes("code_2"))).toBe(true);
    expect(painted.some((line) => line.includes("code_3"))).toBe(false);
    expect(painted.some((line) => line.includes("1997 more lines"))).toBe(true);
  });
});

describe("eval output windows without splitting the full buffer", () => {
  test("settled eval keeps the head and reports omitted lines", () => {
    setPluginConfigForTest({ ...DEFAULT_CONFIG, standardOutputMaxRows: 3 });
    const text = Array.from({ length: 400 }, (_, i) => `out_${i}`).join("\n");
    const painted = render(
      renderEvalCard(null, { language: "js", code: "1" }, { content: [{ type: "text", text }] }, {}, false),
    );
    expect(painted.filter((line) => /out_\d+/.test(line)).map((line) => line.trim())).toEqual([
      "out_0",
      "out_1",
      "out_2",
    ]);
    expect(painted.some((line) => line.includes("397 more lines"))).toBe(true);
  });

  test("partial eval keeps the tail", () => {
    setPluginConfigForTest({ ...DEFAULT_CONFIG, standardOutputMaxRows: 2 });
    const text = Array.from({ length: 10 }, (_, i) => `stream_${i}`).join("\n");
    const painted = render(
      renderEvalCard(
        null,
        { language: "js", code: "1" },
        { content: [{ type: "text", text }] },
        { isPartial: true },
        true,
      ),
    );
    expect(painted.filter((line) => /stream_\d+/.test(line)).map((line) => line.trim())).toEqual([
      "stream_8",
      "stream_9",
    ]);
    expect(painted.some((line) => line.includes("8 earlier lines"))).toBe(true);
  });
});
