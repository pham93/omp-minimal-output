import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, setPluginConfigForTest } from "./core/config.ts";
import { collapseToolText, MAX_LINES } from "./core/filters.ts";

/*
 * `core/filters.ts` rewrites tool results into the collapsed one-liner every tool without a card
 * shows — lsp, ast_grep, debug, mcp__*, checkpoint, retain, recall, reflect, learn, and the rest.
 * Those rows are host-rendered, so this text *is* the row: the mark it carries and the detail budget
 * behind it are the visible contract.
 */

const firstLine = (toolName: string, input: unknown, text: string): string =>
  collapseToolText(toolName, input, text).text.split("\n")[0] ?? "";

describe("collapsed one-liners take their mark from the indicator setting", () => {
  const samples: Array<[string, unknown, string]> = [
    ["lsp", { action: "references" }, "src/a.ts:12\nsrc/b.ts:3"],
    ["ast_grep", { pattern: "renderCall" }, "src/a.ts:1"],
    ["debug", { action: "attach", target: "pid 1" }, "attached"],
    ["retain", {}, "ok"],
    ["recall", { query: "width" }, "one\ntwo"],
    ["mcp__slack__list", {}, '{"content":[{"type":"text","text":"hello"}]}'],
  ];

  test("diamond, dot and none all reach every tool without a card", () => {
    try {
      for (const [mark, indicator] of [["◆", "diamond"], ["●", "dot"], [" ", "none"]] as const) {
        setPluginConfigForTest({ ...DEFAULT_CONFIG, indicator });
        for (const [toolName, input, text] of samples) {
          const line = firstLine(toolName, input, text);
          expect(line.trimStart().startsWith(mark.trim()) || mark === " ").toBe(true);
          // The tool label survives whatever mark is configured.
          expect(line.replace(/^[^A-Za-z]*/u, "").length).toBeGreaterThan(0);
        }
      }
    } finally {
      setPluginConfigForTest(null);
    }
  });

  test("the mark is the configured one, not a fixed glyph", () => {
    try {
      setPluginConfigForTest({ ...DEFAULT_CONFIG, indicator: "dot" });
      const line = firstLine("lsp", { action: "references" }, "src/a.ts:12");
      expect(line.startsWith("●")).toBe(true);
      expect(line.includes("◆")).toBe(false);
    } finally {
      setPluginConfigForTest(null);
    }
  });
});

describe("collapsed one-liners summarise the result", () => {
  test("a test command reports its outcome, not its transcript", () => {
    const line = firstLine("bash", { command: "bun test" }, "12 pass\n0 fail\nRan 12 tests");
    expect(line).toContain("bun test");
    expect(line).toContain("done");
    expect(line).not.toContain("Ran 12 tests");
  });

  test("grep counts files and hits", () => {
    const line = firstLine("grep", { pattern: "foo" }, "src/a.ts:1:foo\nsrc/b.ts:2:foo");
    expect(line).toContain("foo");
    expect(line).toContain("2 files");
    expect(line).toContain("2 hits");
  });

  test("an MCP envelope is unwrapped and named from the tool id", () => {
    const line = firstLine("mcp__slack__list_channels", {}, '{"content":[{"type":"text","text":"hello"}]}');
    expect(line).toContain("Slack List Channels");
    expect(line).toContain("hello");
  });
});

describe("collapsed one-liners stay bounded and preserve the original", () => {
  test("output longer than the cap keeps head and tail around an omission marker", () => {
    const text = Array.from({ length: MAX_LINES + 40 }, (_, i) => `line ${i}`).join("\n");
    const result = collapseToolText("bash", { command: "cat big.txt" }, text);
    const lines = result.text.split("\n");
    expect(lines.length).toBeLessThanOrEqual(MAX_LINES + 1);
    expect(result.text).toContain(`… [40 lines omitted] …`);
    expect(result.text).toContain("line 0\n");
    expect(lines.at(-1)).toBe(`line ${MAX_LINES + 39}`);
    // The full text survives for expansion and spill.
    expect(result.fullText).toBe(text);
  });

  test("a tool that opts out is left byte-identical", () => {
    const text = "line one\nline two";
    const result = collapseToolText("ast_edit", {}, text);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(text);
  });

  test("a rewritten result is reported as changed so the host replaces it", () => {
    const result = collapseToolText("bash", { command: "bun test" }, "12 pass\n0 fail");
    expect(result.changed).toBe(true);
    expect(result.fullText).toBe("12 pass\n0 fail");
  });
});
